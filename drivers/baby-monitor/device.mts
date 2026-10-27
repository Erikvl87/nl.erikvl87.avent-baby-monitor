import Homey from 'homey';
import AppLogger from '../../Logger.mjs';
import { getApp } from '../../app.mjs';
import type TuyaClient from '../../TuyaClient.mjs';
import type { DeviceDetails, TuyaSession } from '../../TuyaClient.mjs';
import TuyaLanSession, { type TuyaLanVersion } from '../../TuyaLanSession.mjs';
import TuyaError from '../../errors/tuya-error.mjs';
import HttpError from '../../errors/http-error.mjs';
import TuyaSignaling, { type StaleStream, type StreamRequest } from '../../TuyaSignaling.mjs';
import VideoRelay from '../../VideoRelay.mjs';
import type { DeviceWithVideo, HomeyWithVideos, WebRtcAnswer } from '../../types/homey-video.mjs';
import { prepareOffer, streamTypeFor } from '../../utils/sdp.mjs';
import { AvailabilityTracker } from '../../utils/availability-tracker.mjs';
import { discoverTuyaDevice } from '../../utils/tuya-lan-discovery.mjs';
import { decodeAlarmRecord, isNewAlarm, pushedAlarms, type AlarmKind } from '../../utils/alarm-events.mjs';
import { decodeSenseIqStatus, statusStaleAfterMs } from '../../utils/senseiq.mjs';
import {
	blockOf,
	blockStarts,
	lullabyForTrackId,
	readTrackId,
	trackIdInBlock,
	trackValue,
} from '../../utils/lullaby.mjs';
import {
	Dp,
	isSenseIq,
	modelName,
	readBoolean,
	readPercentage,
	readSensitivity,
	readTemperature,
	toPercentage,
	toSensitivity,
	type DpValue,
} from '../../utils/dps.mjs';

/** Without a local connection the cloud poll is the only source, so it runs often. */
const fastPollMs = 30_000;
/** With a local connection most changes arrive as they happen, and the poll is only the floor. */
const slowPollMs = 120_000;
const signalPollMs = 5 * 60_000;
/** The camera only says that something happened, so an alarm turns itself off again after this long. */
const alarmDurationMs = 30_000;
/** When a lullaby ends the camera briefly reports "stopping" then "playing", so a state has to hold this long. */
const lullabyStateSettleMs = 2_000;
/** The cloud's copy of a data point lags behind a command, so for this long after one only the local connection counts. */
const cloudLagMs = 15_000;
/** Scrolling the lullaby picker sets every sound it passes, so a pick has to stay put this long before it plays. */
const lullabyPickSettleMs = 1_000;
/** How long a play waits for a video stream that's still connecting; see waitForConnectingStreams(). */
const streamConnectWaitMs = 8_000;
/** How long the local connection may stay down before the camera's address is looked up again. */
const lanRediscoverAfterMs = 5 * 60_000;
const lanRetryMs = 10 * 60_000;

const alarmCapabilities: Record<AlarmKind, string> = {
	motion: 'alarm_motion',
	sound: 'alarm_noise',
	crying: 'alarm_crying',
};

/** Capabilities only the SenseIQ models have. */
const senseIqCapabilities = ['alarm_presence', 'measure_breathing_rate', 'alarm_crying'];

/** Device settings that mirror a data point on the camera. */
const settingDps: Record<string, { dp: Dp; read: (value: unknown) => unknown; write: (value: unknown) => DpValue }> = {
	// eslint-disable-next-line @typescript-eslint/naming-convention
	motion_detection: { dp: Dp.motionDetection, read: readBoolean, write: Boolean },
	// eslint-disable-next-line @typescript-eslint/naming-convention
	motion_sensitivity: { dp: Dp.motionSensitivity, read: readSensitivity, write: value => toSensitivity(String(value)) },
	// eslint-disable-next-line @typescript-eslint/naming-convention
	sound_detection: { dp: Dp.soundDetection, read: readBoolean, write: Boolean },
	// eslint-disable-next-line @typescript-eslint/naming-convention
	sound_sensitivity: { dp: Dp.soundSensitivity, read: readSensitivity, write: value => toSensitivity(String(value)) },
	// eslint-disable-next-line @typescript-eslint/naming-convention
	status_led: { dp: Dp.statusLed, read: readBoolean, write: Boolean },
};

/**
 * A Philips Avent baby monitor. State comes from polling the Tuya cloud and, when the camera can be reached on the
 * home network, from what it pushes over a local connection; commands go through the cloud.
 */
export default class BabyMonitorDevice extends Homey.Device {
	private logger!: AppLogger;
	private client: TuyaClient | undefined;
	private availability!: AvailabilityTracker;
	private readonly dps: Record<string, unknown> = {};
	private pollTimer: NodeJS.Timeout | undefined;
	private signalTimer: NodeJS.Timeout | undefined;
	private lanRetryTimer: NodeJS.Timeout | undefined;
	private lullabyStateTimer: NodeJS.Timeout | undefined;
	/** The lullaby state the cloud last reported, to tell its changes from a stale copy. */
	private cloudLullabyState: unknown;
	private lastTrackId: number | undefined;
	/** When each data point was last commanded, to ignore the cloud's stale copy for a while; see `cloudLagMs`. */
	private readonly commandedAt = new Map<string, number>();
	/** Counts lullaby picks and plays, so a newer one cancels what an older one still had to do. */
	private lullabyPicks = 0;
	private lullabyPlays = 0;
	private lullabyPickerListening = false;
	private senseIqStaleTimer: NodeJS.Timeout | undefined;
	private readonly alarmTimers = new Map<AlarmKind, NodeJS.Timeout>();
	private lan: TuyaLanSession | undefined;
	/** Streams being relayed to viewers; see VideoRelay.mts. */
	private readonly relays = new Set<VideoRelay>();
	private lanDiscovery: AbortController | undefined;
	private lanConnected = false;
	private lanDownSince = 0;
	private localKey: string | undefined;
	private lastSenseIqPush: number | undefined;
	private stopped = false;

	/**
	 * This method is called when the device is initialized.
	 */
	override async onInit(): Promise<void> {
		this.logger = AppLogger.create(this.homey, this.log, this.error);
		this.availability = new AvailabilityTracker({
			setAvailable: (): Promise<void> => this.setAvailable(),
			setUnavailable: (message: string): Promise<void> => this.setUnavailable(message),
			logger: this.logger,
			messages: {
				apiError: this.homey.__('device.unavailable.apiError'),
				offline: this.homey.__('device.unavailable.offline'),
				sessionExpired: this.homey.__('device.unavailable.sessionExpired'),
			},
		});

		if (this.getStoreValue('lullabyProbeFailed') === true) {
			await this.setStoreValue('lullabyCatalogueUnknown', true);
			await this.unsetStoreValue('lullabyProbeFailed');
		}
		await this.ensureCapabilities();
		this.registerCapabilityListeners();
		await this.syncLullabyPicker();
		await this.setupVideo();
		this.logger.log(`${this.constructor.name} has been initialized`);

		const session = getApp(this.homey).unpackSession(this.getStoreValue('session'));
		if (!session) {
			await this.availability.onSessionExpired();
			return;
		}
		await this.start(session);
		await this.endStaleVideoStreams(session);
	}

	/**
	 * Device addition - called when the user adds the device, just after pairing
	 */
	override async onAdded(): Promise<void> {
		this.logger.log(`${this.constructor.name} has been added`);
	}

	override async onRenamed(name: string): Promise<void> {
		this.logger.log(`${this.constructor.name} was renamed to ${name}`);
	}

	override async onDeleted(): Promise<void> {
		this.stop();
		this.logger.log(`${this.constructor.name} has been deleted`);
	}

	override async onUninit(): Promise<void> {
		this.stop();
	}

	/**
	 * Settings change handler: sends changed camera settings to the camera, and starts or stops the local connection.
	 */
	override async onSettings({
		newSettings,
		changedKeys,
	}: {
		oldSettings: Record<string, unknown>;
		newSettings: Record<string, unknown>;
		changedKeys: string[];
	}): Promise<string | void> {
		this.logger.log(`${this.constructor.name} settings where changed`, changedKeys);

		const dps: Record<string, DpValue> = {};
		for (const key of changedKeys) {
			const mapping = settingDps[key];
			if (mapping) dps[mapping.dp] = mapping.write(newSettings[key]);
		}
		if (Object.keys(dps).length > 0) await this.setDps(dps);

		if (changedKeys.includes('local_connection')) {
			if (newSettings.local_connection === true)
				this.homey.setTimeout(() => this.startLan().catch(error => this.logger.error(error)), 0);
			else this.stopLan();
		}
	}

	/** The e-mail address of the account the device was added with, to pre-fill the repair form. */
	public getAccountEmail(): string | undefined {
		return getApp(this.homey).unpackSession(this.getStoreValue('session'))?.email;
	}

	/** Takes a new session after the user signed in again through Repair. */
	public async updateSession(session: TuyaSession): Promise<void> {
		this.logger.log('Received a new session');
		await this.setStoreValue('session', getApp(this.homey).packSession(session));
		this.stop();
		await this.availability.onSessionRestored();
		await this.start(session);
	}

	/**
	 * Plays one of the sounds. Track ids come in blocks that differ per unit, and a camera ignores ids outside its own
	 * block and replays its current sound, so the block is learned from what the camera reports playing. While it
	 * isn't known yet, each block is tried once, checking what the camera then reports. A camera that reports an id
	 * outside every block, or ignored all of them, has a catalogue the app doesn't know: picking would only replay.
	 */
	public async playLullaby(lullaby: string): Promise<void> {
		if (trackIdInBlock(lullaby, blockStarts[0]) === undefined) throw new Error(this.homey.__('errors.unknownLullaby'));
		await this.waitForConnectingStreams();

		const play = ++this.lullabyPlays;
		const known = this.lullabyBlock();
		if (known === undefined) {
			const reported = readTrackId(this.dps[Dp.lullabyCurrent]);
			if (reported !== undefined) {
				this.logger.log(`Camera reports track ${reported}, outside every known block`);
				await this.setStoreValue('lullabyCatalogueUnknown', true).catch(error => this.logger.error(error));
				throw this.unknownCatalogue();
			}
			if (this.getStoreValue('lullabyCatalogueUnknown') === true) throw this.unknownCatalogue();
		}

		const candidates = known !== undefined ? [known] : [...blockStarts];
		let confirmed = known !== undefined;
		for (let attempt = 0; attempt < candidates.length; attempt++) {
			if (play !== this.lullabyPlays) return;
			const id = trackIdInBlock(lullaby, candidates[attempt])!;
			this.logger.log(`Playing ${lullaby} as track ${id}`);
			// Separately: the camera ignores a track and a play command that arrive together.
			await this.setDps({ [Dp.lullabyTrack]: trackValue(id) });
			await this.setLullabyControl('play');
			if (known !== undefined) break;

			const playing = await this.reportedTrackId();
			if (play !== this.lullabyPlays) return;
			if (playing === id) {
				confirmed = true;
				break;
			}
			const block = blockOf(playing);
			if (block !== undefined && block !== candidates[attempt]) {
				// The camera told us its block; one more try in that block.
				this.logger.log(`Camera plays from block ${block}; trying again there`);
				candidates.splice(attempt + 1, candidates.length, block);
			} else if (playing !== undefined && block === undefined) {
				this.logger.log(`Camera reports track ${playing}, outside every known block`);
				break;
			}
		}
		if (!confirmed) {
			this.logger.log('The camera took no known track id; not trying again until it reports one');
			await this.setStoreValue('lullabyCatalogueUnknown', true).catch(error => this.logger.error(error));
			throw this.unknownCatalogue();
		}
		await this.updateCapability('lullaby_track', lullaby);
		await this.updateCapability('speaker_playing', true);
	}

	/** The error for a camera whose catalogue isn't known; also hides the picker, which can't do anything there. */
	private unknownCatalogue(): Error {
		// Not right away: this runs inside the picker's own listener.
		this.homey.setTimeout(() => this.syncLullabyPicker().catch(error => this.logger.error(error)), 0);
		return new Error(this.homey.__('errors.unknownCatalogue'));
	}

	/** Shows the lullaby picker only when picking can work, and brings it back once the catalogue is learned. */
	private async syncLullabyPicker(): Promise<void> {
		const unknown = this.lullabyBlock() === undefined && this.getStoreValue('lullabyCatalogueUnknown') === true;
		if (unknown && this.hasCapability('lullaby_track')) {
			this.logger.log('Hiding the lullaby picker: this camera uses a catalogue the app does not know');
			await this.removeCapability('lullaby_track');
		} else if (!unknown && !this.hasCapability('lullaby_track')) {
			this.logger.log('Showing the lullaby picker again: the catalogue is known');
			await this.addCapability('lullaby_track');
			this.registerLullabyPickerListener();
		}
	}

	/** The block this camera's track ids are in, learned from what it reported playing. */
	private lullabyBlock(): number | undefined {
		const stored = this.getStoreValue('lullabyBlock') as number | undefined;
		return blockOf(stored) ?? blockOf(readTrackId(this.dps[Dp.lullabyCurrent]));
	}

	/** Waits a moment, then asks the cloud which track the camera reports playing. */
	private async reportedTrackId(): Promise<number | undefined> {
		await new Promise(resolve => this.homey.setTimeout(resolve, 2_500));
		try {
			const details = await this.client?.getDevice(this.getData().id);
			if (details?.dps) await this.applyDps(details.dps, 'cloud');
		} catch (error) {
			this.logger.log(`Checking the track failed: ${(error as Error).message ?? String(error)}`);
		}
		return readTrackId(this.dps[Dp.lullabyCurrent]);
	}

	/** Sets the lullaby or night light timer in seconds; 0 turns the timer off. */
	public async setTimer(timer: 'lullaby' | 'nightLight', seconds: number): Promise<void> {
		const [enable, duration] =
			timer === 'lullaby' ? [Dp.lullabyTimerSwitch, Dp.lullabyTimer] : [Dp.nightLightTimerSwitch, Dp.nightLightTimer];
		await this.setDps(seconds > 0 ? { [enable]: true, [duration]: seconds } : { [enable]: false });
	}

	public async setDetection(kind: 'motion' | 'sound', on: boolean): Promise<void> {
		const key = `${kind}_detection`;
		await this.setDps({ [settingDps[key].dp]: on });
		await this.setSettings({ [key]: on });
	}

	/**
	 * Offers the camera's live video to Homey. Homey asks for a stream when someone opens it, with a WebRTC offer from
	 * the viewer; the camera's answer goes back, and the video flows between the two.
	 */
	private async setupVideo(): Promise<void> {
		const videos = (this.homey as unknown as HomeyWithVideos).videos;
		if (!videos) {
			this.logger.log('This Homey has no video support');
			return;
		}
		try {
			const video = await videos.createVideoWebRTC({ dataChannel: false });
			video.registerOfferListener(offerSdp => this.startStream(offerSdp));
			await (this as unknown as DeviceWithVideo).setCameraVideo('main', this.homey.__('video.title'), video);
		} catch (error) {
			this.logger.error(error);
		}
	}

	private async startStream(offerSdp: string): Promise<WebRtcAnswer> {
		const session = getApp(this.homey).unpackSession(this.getStoreValue('session'));
		const client = this.client;
		if (!session || !client) throw new Error(this.homey.__('device.unavailable.sessionExpired'));
		if (!TuyaSignaling.canSignal(session)) throw new Error(this.homey.__('errors.videoNeedsRepair'));
		if (this.getCapabilityValue('privacy_mode') === true) throw new Error(this.homey.__('errors.privacyMode'));

		const relayed = this.getSetting('video_relay') !== false;
		this.logger.log(`Starting a ${relayed ? 'relayed' : 'direct'} video stream (${this.relays.size} already running)`);
		try {
			const rtc = await client.getRtcConfig(this.getData().id);
			const signaling = getApp(this.homey).getSignaling(session);
			const quality = this.getSetting('video_quality') === 'sd' ? 'sd' : 'hd';
			const streamType = streamTypeFor(rtc.skill, quality);
			this.logger.debug(`Asking for the ${quality.toUpperCase()} stream (type ${streamType})`);
			const request = (sdp: string, candidates?: string[]): StreamRequest => ({
				deviceId: this.getData().id,
				offerSdp: prepareOffer(sdp),
				candidates,
				rtc,
				streamType,
				quality,
			});

			if (!relayed) {
				const answer = await signaling.startStream(request(offerSdp));
				return { answerSdp: answer.answerSdp, streamId: answer.sessionId };
			}

			let stream: StaleStream | undefined;
			const relay = new VideoRelay({
				logger: this.logger.createChildLogger({ prefix: 'Video' }),
				iceServers: rtc.p2pConfig?.ices ?? [],
				signal: async (offer): Promise<string> => {
					const answer = await signaling.startStream(request(offer.sdp, offer.candidates));
					stream = { deviceId: this.getData().id, motoId: rtc.motoId, sessionId: answer.sessionId };
					await this.rememberVideoStream(stream);
					return answer.answerSdp;
				},
				onClose: (): void => {
					this.relays.delete(relay);
					if (stream) this.endVideoStream(signaling, stream).catch(error => this.logger.error(error));
				},
			});
			this.limitRelays();
			this.relays.add(relay);
			const answerSdp = await relay.answer(offerSdp);
			return { answerSdp, streamId: stream?.sessionId };
		} catch (error) {
			const stack = (error as Error).stack?.split('\n').slice(0, 3).join(' / ');
			this.logger.log(`Starting the video stream failed: ${(error as Error).message ?? String(error)} (${stack})`);
			if (error instanceof TuyaError && error.isSessionExpired) await this.handleApiError(error, 'Video');
			throw new Error(this.homey.__('errors.videoFailed'), { cause: error });
		}
	}

	/**
	 * Camera streams this device started and hasn't ended yet, kept in the store: a stream the app couldn't end, as
	 * when it restarts mid-stream, keeps the camera's "someone is watching" light on until it gets its disconnect.
	 */
	private videoStreams(): StaleStream[] {
		return (this.getStoreValue('videoStreams') as StaleStream[] | undefined) ?? [];
	}

	private async rememberVideoStream(stream: StaleStream): Promise<void> {
		await this.setStoreValue('videoStreams', [...this.videoStreams(), stream]).catch(error => this.logger.error(error));
	}

	private async forgetVideoStream(sessionId: string): Promise<void> {
		const remaining = this.videoStreams().filter(stream => stream.sessionId !== sessionId);
		await this.setStoreValue('videoStreams', remaining).catch(error => this.logger.error(error));
	}

	/** Tells the camera a stream ended; it stays remembered until that message went out. */
	private async endVideoStream(signaling: TuyaSignaling, stream: StaleStream): Promise<void> {
		const ended = (await signaling.endStream(stream.sessionId)) || (await signaling.endStaleStream(stream));
		if (ended) await this.forgetVideoStream(stream.sessionId);
	}

	/** Ends the camera streams an earlier run of the app left open. */
	private async endStaleVideoStreams(session: TuyaSession): Promise<void> {
		const stale = this.videoStreams();
		if (stale.length === 0 || !TuyaSignaling.canSignal(session)) return;
		this.logger.log(`Ending ${stale.length} video stream(s) left open before the app restarted`);
		const signaling = getApp(this.homey).getSignaling(session);
		for (const stream of stale) {
			if (await signaling.endStaleStream(stream)) await this.forgetVideoStream(stream.sessionId);
		}
	}

	/**
	 * Waits for video streams to this camera that are still connecting, `streamConnectWaitMs` at most. An SCD973 on
	 * camera SDK 4.8.8 stops its lullaby when a stream's media starts, so a play sent in those seconds would only be
	 * stopped again; opening the device page starts a stream, so this is when a play button gets pressed.
	 */
	private async waitForConnectingStreams(): Promise<void> {
		const connecting = [...this.relays].filter(relay => relay.isConnecting());
		if (connecting.length === 0) return;
		this.logger.log('Waiting for the video stream to connect before playing');
		await Promise.race([
			Promise.all(connecting.map(relay => relay.connected())),
			new Promise(resolve => this.homey.setTimeout(resolve, streamConnectWaitMs)),
		]);
	}

	/** Keeps at most two relayed streams per camera, closing the oldest: each one is a stream from the camera. */
	private limitRelays(): void {
		while (this.relays.size >= 2) {
			const oldest = this.relays.values().next().value;
			if (!oldest) break;
			this.logger.log('Closing the oldest video stream to make room');
			oldest.close();
			this.relays.delete(oldest);
		}
	}

	private async start(session: TuyaSession): Promise<void> {
		this.stopped = false;
		this.client = getApp(this.homey).createTuyaClient(this.logger.createChildLogger({ prefix: 'TuyaClient' }), session);
		await this.poll();
		await this.pollSignalStrength();
		if (this.getSetting('local_connection') !== false)
			this.homey.setTimeout(() => this.startLan().catch(error => this.logger.error(error)), 0);
	}

	/** Clears every timer and closes the local connection. */
	private stop(): void {
		this.stopped = true;
		for (const timer of [
			this.pollTimer,
			this.signalTimer,
			this.lanRetryTimer,
			this.lullabyStateTimer,
			this.senseIqStaleTimer,
		]) {
			this.homey.clearTimeout(timer);
		}
		for (const relay of [...this.relays]) relay.close();
		this.relays.clear();
		for (const timer of this.alarmTimers.values()) this.homey.clearTimeout(timer);
		this.alarmTimers.clear();
		this.stopLan();
	}

	/** Adds capabilities that came after the device was paired, and the SenseIQ ones on SenseIQ models. */
	private async ensureCapabilities(): Promise<void> {
		const required = [
			'measure_temperature',
			'alarm_motion',
			'alarm_noise',
			'onoff',
			'dim',
			'speaker_playing',
			'speaker_prev',
			'speaker_next',
			// Only where picking can work; see syncLullabyPicker().
			...(this.getStoreValue('lullabyCatalogueUnknown') === true ? [] : ['lullaby_track']),
			'volume_set',
			'privacy_mode',
			'measure_signal_strength',
			...(isSenseIq(this.getStoreValue('productId')) ? senseIqCapabilities : []),
		];
		for (const capability of required) {
			if (!this.hasCapability(capability)) {
				this.logger.log(`Adding missing capability: ${capability}`);
				await this.addCapability(capability);
			}
		}
		// An alarm is only ever set when one fires; until then Homey shows it empty rather than off. One still on is left
		// from before a restart, which dropped the timer that would have turned it off.
		for (const capability of Object.values(alarmCapabilities)) {
			if (this.hasCapability(capability) && this.getCapabilityValue(capability) !== false) {
				await this.setCapabilityValue(capability, false).catch(error => this.logger.error(error));
			}
		}
	}

	private registerCapabilityListeners(): void {
		// Together, so a slider drag and the switch that comes with it go out as one command.
		this.registerMultipleCapabilityListener(
			['onoff', 'dim'],
			async ({ onoff, dim }: { onoff?: boolean; dim?: number }) => {
				if (dim === undefined || onoff === false) {
					await this.setDps({ [Dp.nightLight]: onoff === true });
					return;
				}
				await this.setDps({ [Dp.nightLight]: true, [Dp.nightLightBrightness]: toPercentage(dim) });
				// Always set, even when the cached value already says on, so the device page follows.
				await this.setCapabilityValue('onoff', true).catch(error => this.logger.error(error));
			},
			500,
		);
		this.registerCapabilityListener('speaker_playing', async (value: boolean) => {
			await this.setLullabyControl(value ? 'play' : 'stop');
		});
		this.registerCapabilityListener('speaker_next', async () => {
			await this.setDps({ [Dp.lullabyControl]: 'next' });
		});
		this.registerCapabilityListener('speaker_prev', async () => {
			await this.setDps({ [Dp.lullabyControl]: 'prev' });
		});
		this.registerCapabilityListener('volume_set', async (value: number) => {
			await this.setDps({ [Dp.lullabyVolume]: toPercentage(value) });
		});
		this.registerLullabyPickerListener();
		this.registerCapabilityListener('privacy_mode', async (value: boolean) => {
			await this.setDps({ [Dp.privacyMode]: value ? '1' : '0' });
		});
	}

	/** Registered once, and only while the picker exists; it can come and go, see syncLullabyPicker(). */
	private registerLullabyPickerListener(): void {
		if (this.lullabyPickerListening || !this.hasCapability('lullaby_track')) return;
		this.lullabyPickerListening = true;
		this.registerCapabilityListener('lullaby_track', async (value: string) => {
			const pick = ++this.lullabyPicks;
			await new Promise(resolve => this.homey.setTimeout(resolve, lullabyPickSettleMs));
			if (pick !== this.lullabyPicks) return;
			await this.playLullaby(value);
		});
	}

	/** Sends data points to the camera through the cloud, and keeps them as the known state. */
	private async setDps(dps: Record<string, DpValue>): Promise<void> {
		const client = this.client;
		if (!client) throw new Error(this.homey.__('device.unavailable.sessionExpired'));
		try {
			await client.setDps(this.getData().id, dps);
			await this.availability.onApiSuccess();
		} catch (error) {
			await this.handleApiError(error, 'Sending a command failed');
			throw error;
		}
		Object.assign(this.dps, dps);
		for (const dp of Object.keys(dps)) this.commandedAt.set(dp, Date.now());
	}

	/** Whether a cloud report of a data point comes so soon after a command that it may predate it. */
	private isStale(dp: Dp, source: 'cloud' | 'lan'): boolean {
		return source === 'cloud' && Date.now() - (this.commandedAt.get(dp) ?? 0) < cloudLagMs;
	}

	/** Polls the cloud for the camera's state, then schedules the next poll. */
	private async poll(): Promise<void> {
		this.homey.clearTimeout(this.pollTimer);
		const client = this.client;
		if (!client || this.stopped) return;

		try {
			const details = await client.getDevice(this.getData().id);
			await this.availability.onApiSuccess();

			this.localKey = details.localKey ?? this.localKey;
			if (details.productId && details.productId !== this.getStoreValue('productId')) {
				await this.setStoreValue('productId', details.productId);
				await this.ensureCapabilities();
			}
			await this.syncDeviceInfo(details);
			if (details.isOnline === false) await this.availability.onCameraOffline();
			else await this.availability.onCameraOnline();
			await this.noteOnline(details.isOnline !== false);

			await this.applyDps(details.dps ?? {}, 'cloud');
		} catch (error) {
			await this.handleApiError(error, 'Polling failed');
		}

		if (this.stopped || !this.client) return;
		const alarmRecordsOverLan = this.lanConnected && this.dps[Dp.alarmRecord] === undefined;
		this.pollTimer = this.homey.setTimeout(
			() => this.poll().catch(error => this.logger.error(error)),
			alarmRecordsOverLan ? slowPollMs : fastPollMs,
		);
	}

	/** Shows the model family, product id and firmware in the device settings. */
	private async syncDeviceInfo(details: DeviceDetails): Promise<void> {
		const info: Record<string, string> = {
			model: modelName(details.productId) ?? this.homey.__('device.unknownModel'),
			// eslint-disable-next-line @typescript-eslint/naming-convention
			product_id: details.productId ?? '',
			firmware: [details.verSw, details.bv && `base ${details.bv}`].filter(Boolean).join(', '),
		};
		const changed = Object.fromEntries(Object.entries(info).filter(([key, value]) => this.getSetting(key) !== value));
		if (Object.keys(changed).length > 0) await this.setSettings(changed).catch(error => this.logger.error(error));
	}

	private async pollSignalStrength(): Promise<void> {
		this.homey.clearTimeout(this.signalTimer);
		const client = this.client;
		if (!client || this.stopped) return;

		// The camera's own reading, as the Philips app shows it; Tuya's cloud value never changes on these monitors.
		const session = getApp(this.homey).unpackSession(this.getStoreValue('session'));
		if (session && this.localKey && TuyaSignaling.canSignal(session)) {
			try {
				const signal = await getApp(this.homey)
					.getSignaling(session)
					.requestWifiSignal(this.getData().id, this.localKey);
				if (signal !== undefined) await this.updateCapability('measure_signal_strength', signal);
				else this.logger.log('The camera did not report its Wi-Fi signal');
			} catch (error) {
				this.logger.log('Reading the Wi-Fi signal failed', error);
			}
		}
		this.checkLan();
		this.signalTimer = this.homey.setTimeout(
			() => this.pollSignalStrength().catch(error => this.logger.error(error)),
			signalPollMs,
		);
	}

	private async handleApiError(error: unknown, context: string): Promise<void> {
		if (error instanceof TuyaError && error.isSessionExpired) {
			this.logger.log(`${context}: session expired`, error.code);
			this.stop();
			this.client = undefined;
			await this.availability.onSessionExpired();
			return;
		}
		if (error instanceof TuyaError || error instanceof HttpError || error instanceof TypeError) {
			// Network trouble and refused requests happen with any cloud API; the tracker decides when it's an outage.
			this.logger.log(context, error);
		} else {
			this.logger.error(error);
		}
		await this.availability.onApiFailure();
	}

	/** Applies data points from the cloud or the local connection to the capabilities and settings. */
	private async applyDps(dps: Record<string, unknown>, source: 'cloud' | 'lan'): Promise<void> {
		Object.assign(this.dps, dps);

		const temperature = readTemperature(dps[Dp.temperature]);
		if (temperature !== undefined) await this.updateCapability('measure_temperature', temperature);

		const nightLight = readBoolean(dps[Dp.nightLight]);
		if (nightLight !== undefined && !this.isStale(Dp.nightLight, source))
			await this.updateCapability('onoff', nightLight);
		const brightness = readPercentage(dps[Dp.nightLightBrightness]);
		if (brightness !== undefined && !this.isStale(Dp.nightLightBrightness, source)) {
			await this.updateCapability('dim', brightness);
		}

		const volume = readPercentage(dps[Dp.lullabyVolume]);
		if (volume !== undefined && !this.isStale(Dp.lullabyVolume, source))
			await this.updateCapability('volume_set', volume);
		const trackId = readTrackId(dps[Dp.lullabyCurrent]);
		const lullaby = lullabyForTrackId(trackId);
		if (trackId !== undefined && trackId !== this.lastTrackId) {
			this.lastTrackId = trackId;
			this.logger.log(`Camera reports track ${trackId} (${lullaby ?? 'unknown'}, ${source})`);
		}
		const block = blockOf(trackId);
		if (block !== undefined && block !== this.getStoreValue('lullabyBlock')) {
			await this.setStoreValue('lullabyBlock', block).catch(error => this.logger.error(error));
			await this.unsetStoreValue('lullabyCatalogueUnknown').catch(error => this.logger.error(error));
		}
		if (lullaby !== undefined) await this.updateCapability('lullaby_track', lullaby);
		if (trackId !== undefined && block === undefined && this.getStoreValue('lullabyCatalogueUnknown') !== true) {
			await this.setStoreValue('lullabyCatalogueUnknown', true).catch(error => this.logger.error(error));
		}
		if (trackId !== undefined) await this.syncLullabyPicker().catch(error => this.logger.error(error));
		const lullabyState = dps[Dp.lullabyState];
		if (typeof lullabyState === 'string') {
			// The cloud's copy can lag behind or stay put after a command, so only its changes count; pushes are live.
			const changed = source === 'lan' || lullabyState !== this.cloudLullabyState;
			if (source === 'cloud') this.cloudLullabyState = lullabyState;
			if (changed && !this.isStale(Dp.lullabyState, source)) {
				this.logger.log(`Lullaby ${lullabyState} (${source})`);
				this.settleLullabyState(lullabyState === 'playing');
			}
		}

		const privacy = readBoolean(dps[Dp.privacyMode]);
		if (privacy !== undefined) await this.updateCapability('privacy_mode', privacy);

		await this.syncSettings(dps);
		await this.applyAlarms(dps, source);
		await this.applySenseIq(dps, source);
	}

	/**
	 * Plays or stops the lullaby, and takes the state that follows as known right away, the way the phone app does:
	 * a poll that still says otherwise must not flip the switch back.
	 */
	private async setLullabyControl(command: 'play' | 'stop'): Promise<void> {
		if (command === 'play') await this.waitForConnectingStreams();
		await this.setDps({ [Dp.lullabyControl]: command });
		this.homey.clearTimeout(this.lullabyStateTimer);
		this.dps[Dp.lullabyState] = command === 'play' ? 'playing' : 'stopping';
		this.commandedAt.set(Dp.lullabyState, Date.now());
	}

	/** The camera flickers between "stopping" and "playing" when a track ends, so only a state that holds counts. */
	private settleLullabyState(playing: boolean): void {
		this.homey.clearTimeout(this.lullabyStateTimer);
		if (this.getCapabilityValue('speaker_playing') === playing) return;
		this.lullabyStateTimer = this.homey.setTimeout(() => {
			this.updateCapability('speaker_playing', playing).catch(error => this.logger.error(error));
		}, lullabyStateSettleMs);
	}

	private async syncSettings(dps: Record<string, unknown>): Promise<void> {
		const changed: Record<string, unknown> = {};
		for (const [key, mapping] of Object.entries(settingDps)) {
			const value = mapping.read(dps[mapping.dp]);
			if (value !== undefined && value !== this.getSetting(key)) changed[key] = value;
		}
		if (Object.keys(changed).length === 0) return;
		await this.setSettings(changed).catch(error => this.logger.error(error));
	}

	private async applyAlarms(dps: Record<string, unknown>, source: 'cloud' | 'lan'): Promise<void> {
		const kinds = new Set<AlarmKind>();

		const record = decodeAlarmRecord(dps[Dp.alarmRecord]);
		if (record) {
			const lastSeen = this.getStoreValue('lastAlarmTime') as number | undefined;
			if (isNewAlarm(record.time, lastSeen, Date.now() / 1000)) {
				this.logger.log(`Alarm ${record.command} from ${source}`);
				record.kinds.forEach(kind => kinds.add(kind));
			}
			if (lastSeen === undefined || record.time > lastSeen) await this.setStoreValue('lastAlarmTime', record.time);
		}

		// These carry no time and the cloud keeps the last one forever, so only a push counts.
		if (source === 'lan') {
			const motionDetectionOn = readBoolean(this.dps[Dp.motionDetection]) !== false;
			pushedAlarms(dps, motionDetectionOn).forEach(kind => kinds.add(kind));
		}

		for (const kind of kinds) await this.raiseAlarm(kind);
	}

	private async raiseAlarm(kind: AlarmKind): Promise<void> {
		const capability = alarmCapabilities[kind];
		if (!this.hasCapability(capability)) return;

		this.homey.clearTimeout(this.alarmTimers.get(kind));
		await this.updateCapability(capability, true);
		this.alarmTimers.set(
			kind,
			this.homey.setTimeout(() => {
				this.alarmTimers.delete(kind);
				this.updateCapability(capability, false).catch(error => this.logger.error(error));
			}, alarmDurationMs),
		);
	}

	private async applySenseIq(dps: Record<string, unknown>, source: 'cloud' | 'lan'): Promise<void> {
		if (!this.hasCapability('alarm_presence')) return;
		const status = decodeSenseIqStatus(dps[Dp.senseIqStatus]);
		if (!status) return;

		if (source === 'lan') {
			this.lastSenseIqPush = Date.now();
			this.homey.clearTimeout(this.senseIqStaleTimer);
			this.senseIqStaleTimer = this.homey.setTimeout(() => {
				this.logger.log('SenseIQ status went quiet; the baby has left the crib');
				this.updateCapability('alarm_presence', false).catch(error => this.logger.error(error));
				this.updateCapability('measure_breathing_rate', null).catch(error => this.logger.error(error));
			}, statusStaleAfterMs);
		} else if (this.lanConnected && this.lastSenseIqPush !== undefined) {
			// The pushes are the live signal; the cloud's copy may be older than the last push, or stale.
			return;
		}

		if (status.babyPresent !== undefined) await this.updateCapability('alarm_presence', status.babyPresent);
		await this.updateCapability('measure_breathing_rate', status.breathingRate ?? null);
	}

	/**
	 * Runs the offline and online triggers when the camera's online state changes. The last state is kept in the store,
	 * so a restart while the camera is offline doesn't report it going offline again.
	 */
	private async noteOnline(online: boolean): Promise<void> {
		const previous = this.getStoreValue('cameraOnline') as boolean | undefined;
		if (previous === online) return;
		await this.setStoreValue('cameraOnline', online).catch(error => this.logger.error(error));
		if (previous === undefined) return;

		this.logger.log(online ? 'Camera came back online' : 'Camera went offline');
		await this.homey.flow
			.getDeviceTriggerCard(online ? 'came-online' : 'went-offline')
			.trigger(this)
			.catch(error => this.logger.error(error));
	}

	/** The name of a sound in the user's language, from the `lullaby_track` capability's values. */
	private lullabyTitle(lullaby: string): string {
		const language = this.homey.i18n.getLanguage();
		const values = (
			this.homey.manifest as {
				capabilities?: Record<string, { values?: Array<{ id: string; title: Record<string, string> }> }>;
			}
		).capabilities?.lullaby_track?.values;
		const title = values?.find(value => value.id === lullaby)?.title;
		return title?.[language] ?? title?.en ?? lullaby;
	}

	/** Sets a capability only when its value changes, so flows and insights don't see repeats. */
	private async updateCapability(capability: string, value: unknown): Promise<void> {
		if (!this.hasCapability(capability) || this.getCapabilityValue(capability) === value) return;
		await this.setCapabilityValue(capability, value).catch(error => this.logger.error(error));
		if (capability === 'lullaby_track' && typeof value === 'string') {
			await this.homey.flow
				.getDeviceTriggerCard('lullaby-changed')
				.trigger(this, { name: this.lullabyTitle(value), id: value })
				.catch(error => this.logger.error(error));
		}
	}

	/**
	 * Opens the local connection. Finds the camera on the network first, unless its address is known from earlier;
	 * the cloud only reports the household's public address.
	 */
	private async startLan(): Promise<void> {
		this.homey.clearTimeout(this.lanRetryTimer);
		if (this.lan || this.stopped || this.getSetting('local_connection') === false) return;
		if (!this.localKey) {
			this.logger.log('No local key yet; the local connection waits for the next poll');
			this.lanRetryTimer = this.homey.setTimeout(
				() => this.startLan().catch(error => this.logger.error(error)),
				fastPollMs,
			);
			return;
		}

		let host = this.getStoreValue('lanHost') as string | undefined;
		let version = this.getStoreValue('lanVersion') as TuyaLanVersion | undefined;
		if (!host || !version) {
			if (this.lanDiscovery) return;
			this.lanDiscovery = new AbortController();
			const found = await discoverTuyaDevice(this.getData().id, {
				logger: this.logger.createChildLogger({ prefix: 'Discovery' }),
				signal: this.lanDiscovery.signal,
			});
			this.lanDiscovery = undefined;
			if (this.stopped || this.getSetting('local_connection') === false) return;
			if (!found) {
				this.logger.log('Camera not found on the local network; trying again later');
				this.lanRetryTimer = this.homey.setTimeout(
					() => this.startLan().catch(error => this.logger.error(error)),
					lanRetryMs,
				);
				return;
			}
			({ host, version } = found);
			await this.setStoreValue('lanHost', host);
			await this.setStoreValue('lanVersion', version);
		}
		if (this.lan || this.stopped) return;

		this.lanDownSince = Date.now();
		this.lan = new TuyaLanSession({
			logger: this.logger.createChildLogger({ prefix: 'LAN' }),
			deviceId: this.getData().id,
			localKey: this.localKey,
			host,
			version,
			onDps: (dps): void => {
				this.applyDps(dps, 'lan').catch(error => this.logger.error(error));
			},
			onVersionVerified: (verified): void => {
				if (verified === this.getStoreValue('lanVersion')) return;
				this.logger.log(`Local connection works with protocol ${verified}; keeping it`);
				this.setStoreValue('lanVersion', verified).catch(error => this.logger.error(error));
			},
			onConnectionChange: (connected): void => {
				this.lanConnected = connected;
				if (!connected) this.lanDownSince = Date.now();
			},
		});
		this.lan.start();
	}

	private stopLan(): void {
		this.homey.clearTimeout(this.lanRetryTimer);
		this.lanDiscovery?.abort();
		this.lanDiscovery = undefined;
		this.lan?.stop();
		this.lan = undefined;
		this.lanConnected = false;
	}

	/** Looks the camera up again when the local connection has been down for a while, in case its address changed. */
	private checkLan(): void {
		if (!this.lan || this.lanConnected || Date.now() - this.lanDownSince < lanRediscoverAfterMs) return;
		this.logger.log('Local connection has been down for a while; looking the camera up again');
		this.stopLan();
		this.unsetStoreValue('lanHost')
			.then(() => this.startLan())
			.catch(error => this.logger.error(error));
	}
}
