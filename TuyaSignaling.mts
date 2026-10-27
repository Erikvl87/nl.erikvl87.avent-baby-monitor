import mqtt, { type IClientOptions, type MqttClient } from 'mqtt';
import type { Logger } from './Logger.mjs';
import type { RtcConfig, TuyaSession } from './types/tuya.mjs';
import {
	decodeDeviceMessage,
	encodeDeviceMessage,
	mqttCredentials,
	newSessionId,
	readSignalReply,
	signalMessage,
	signalQuery,
	type SignalMessage,
} from './utils/tuya-mqtt.mjs';
import { addCandidates, normalizeCandidate } from './utils/sdp.mjs';

/** Signalling messages about WebRTC streams. */
const webrtcProtocol = 302;
/** Stream control, like switching to the HD stream. */
const controlProtocol = 312;

export interface StreamRequest {
	deviceId: string;
	offerSdp: string;
	rtc: RtcConfig;
	streamType: number;
	/** Which stream to ask for once the viewer is connected; HD unless told otherwise. */
	quality?: 'hd' | 'sd';
	/** ICE candidates to send after the offer, as `candidate:...`, for an offer that doesn't carry them itself. */
	candidates?: string[];
}

export interface StreamAnswer {
	answerSdp: string;
	/** Tuya's id for this stream's signalling. */
	sessionId: string;
}

/** What it takes to end a stream without the connection that started it. */
export interface StaleStream {
	deviceId: string;
	motoId: string;
	sessionId: string;
}

export interface TuyaSignalingOptions {
	logger: Logger;
	session: TuyaSession;
	/** For tests: replaces `mqtt.connectAsync`. */
	connect?: (url: string, options: IClientOptions) => Promise<MqttClient>;
	/** How long the camera gets to answer an offer. */
	answerTimeoutMs?: number;
	/** How long to collect the camera's ICE candidates after its answer. */
	candidateWaitMs?: number;
	/** How long the connection stays open after the last stream started. */
	idleCloseMs?: number;
}

interface PendingStream {
	onMessage: (message: SignalMessage) => void;
}

/**
 * Sets up video streams with the cameras of one account. The camera is reached through Tuya's MQTT broker: the
 * viewer's WebRTC offer goes to the camera, and its answer and ICE candidates come back. The video itself then flows
 * between the camera and the viewer; nothing passes through here.
 */
export default class TuyaSignaling {
	public readonly sid: string;
	private readonly logger: Logger;
	private readonly session: TuyaSession;
	private readonly connect: (url: string, options: IClientOptions) => Promise<MqttClient>;
	private readonly answerTimeoutMs: number;
	private readonly candidateWaitMs: number;
	private readonly idleCloseMs: number;
	private readonly streams = new Map<string, PendingStream>();
	/** Streams the camera answered, to tell it when one ends. */
	private readonly active = new Map<string, { topic: string; ids: Parameters<typeof signalMessage>[2] }>();
	private client: MqttClient | undefined;
	private connecting: Promise<MqttClient> | undefined;
	private idleTimer: NodeJS.Timeout | undefined;
	/** Sequence numbers of device channel messages; see requestWifiSignal(). */
	private deviceSequence = 0;

	/**
	 * @internal Prefer `getApp(this.homey).getSignaling(session, logger)`, which keeps one per account.
	 */
	public constructor(options: TuyaSignalingOptions) {
		this.logger = options.logger;
		this.session = options.session;
		this.sid = options.session.sid;
		this.connect = options.connect ?? mqtt.connectAsync;
		this.answerTimeoutMs = options.answerTimeoutMs ?? 15_000;
		this.candidateWaitMs = options.candidateWaitMs ?? 1_500;
		this.idleCloseMs = options.idleCloseMs ?? 5 * 60_000;
	}

	/** Whether the session carries what the broker needs; sessions from before video support don't. */
	public static canSignal(session: TuyaSession): boolean {
		return Boolean(session.ecode && session.partnerIdentity);
	}

	/**
	 * Sends a viewer's offer to a camera and returns the camera's answer, with the ICE candidates it sent in the
	 * moments after.
	 */
	public async startStream(request: StreamRequest): Promise<StreamAnswer> {
		const client = await this.ensureConnected();
		this.scheduleIdleClose();

		const sessionId = newSessionId();
		const ids = { uid: this.session.uid, deviceId: request.deviceId, sessionId, motoId: request.rtc.motoId };
		const topic = `/av/moto/${request.rtc.motoId}/u/${request.deviceId}`;

		const answer = new Promise<StreamAnswer>((resolve, reject) => {
			let answerSdp: string | undefined;
			const candidates: string[] = [];
			const timeout = setTimeout(() => finish(new Error('The camera did not answer')), this.answerTimeoutMs);

			const finish = (error?: Error): void => {
				clearTimeout(timeout);
				this.streams.delete(sessionId);
				if (error || answerSdp === undefined) reject(error ?? new Error('The camera did not answer'));
				else resolve({ answerSdp: addCandidates(answerSdp, candidates), sessionId });
			};

			this.streams.set(sessionId, {
				onMessage: message => {
					const type = message.data.header.type;
					if (type === 'answer' && answerSdp === undefined) {
						answerSdp = String(message.data.msg.sdp ?? '');
						clearTimeout(timeout);
						setTimeout(() => finish(), this.candidateWaitMs);
					} else if (type === 'candidate' && typeof message.data.msg.candidate === 'string') {
						const candidate = normalizeCandidate(message.data.msg.candidate);
						if (candidate) candidates.push(candidate);
					} else if (type === 'disconnect') {
						finish(new Error('The camera ended the stream'));
					}
				},
			});
		});

		const offer = signalMessage(webrtcProtocol, 'offer', ids, {
			mode: 'webrtc',
			sdp: request.offerSdp,
			// eslint-disable-next-line @typescript-eslint/naming-convention
			stream_type: request.streamType,
			auth: request.rtc.auth,
			token: request.rtc.p2pConfig?.ices ?? [],
			replay: { is_replay: 0 }, // eslint-disable-line @typescript-eslint/naming-convention
			// eslint-disable-next-line @typescript-eslint/naming-convention
			datachannel_enable: false,
		});
		this.logger.debug(`Sending offer for stream type ${request.streamType}`);
		await client.publishAsync(topic, JSON.stringify(offer), { qos: 1 });
		for (const candidate of request.candidates ?? []) {
			const message = signalMessage(webrtcProtocol, 'candidate', ids, { mode: 'webrtc', candidate: `a=${candidate}` });
			await client.publishAsync(topic, JSON.stringify(message), { qos: 1 });
		}

		const result = await answer;
		this.logger.debug('Camera answered');
		this.active.set(sessionId, { topic, ids });

		// Ask for the wanted stream once the viewer has had a moment to connect: 0 is HD, 1 is SD.
		const quality = request.quality ?? 'hd';
		setTimeout(() => {
			this.logger.debug(`Asking for ${quality.toUpperCase()}`);
			const cmdValue = quality === 'sd' ? 1 : 0;
			const resolution = signalMessage(controlProtocol, 'resolution', ids, { mode: 'webrtc', cmdValue });
			client.publishAsync(topic, JSON.stringify(resolution), { qos: 1 }).catch(error => {
				this.logger.log(`Asking for ${quality.toUpperCase()} failed: ${(error as Error).message ?? String(error)}`);
			});
		}, 3_000);

		return result;
	}

	/**
	 * Tells the camera a stream ended, so it stops sending and turns its "someone is watching" light off; it doesn't
	 * notice a viewer leaving on its own. Resolves whether the message went out.
	 */
	public async endStream(sessionId: string): Promise<boolean> {
		const stream = this.active.get(sessionId);
		this.active.delete(sessionId);
		const client = this.client;
		if (!stream || !client?.connected) return false;
		return this.publishDisconnect(client, stream.topic, stream.ids);
	}

	/** Ends a stream an earlier run of the app started and couldn't end, as after a restart. Connects if needed. */
	public async endStaleStream(stream: StaleStream): Promise<boolean> {
		const ids = {
			uid: this.session.uid,
			deviceId: stream.deviceId,
			sessionId: stream.sessionId,
			motoId: stream.motoId,
		};
		try {
			const client = await this.ensureConnected();
			this.scheduleIdleClose();
			return await this.publishDisconnect(client, `/av/moto/${stream.motoId}/u/${stream.deviceId}`, ids);
		} catch (error) {
			this.logger.log(`Ending an earlier stream failed: ${(error as Error).message ?? String(error)}`);
			return false;
		}
	}

	private async publishDisconnect(
		client: MqttClient,
		topic: string,
		ids: Parameters<typeof signalMessage>[2],
	): Promise<boolean> {
		const disconnect = signalMessage(webrtcProtocol, 'disconnect', ids, { mode: 'webrtc' });
		try {
			await client.publishAsync(topic, JSON.stringify(disconnect), { qos: 1 });
			return true;
		} catch (error) {
			this.logger.log(`Ending the stream failed: ${(error as Error).message ?? String(error)}`);
			return false;
		}
	}

	/** Closes the connection and clears every timer. */
	public close(): void {
		clearTimeout(this.idleTimer);
		this.idleTimer = undefined;
		this.streams.clear();
		this.active.clear();
		const client = this.client;
		this.client = undefined;
		this.connecting = undefined;
		client?.end(true);
	}

	private scheduleIdleClose(): void {
		clearTimeout(this.idleTimer);
		this.idleTimer = setTimeout(() => {
			this.logger.log('No streams for a while; closing the signalling connection');
			this.close();
		}, this.idleCloseMs);
	}

	private async ensureConnected(): Promise<MqttClient> {
		if (this.client?.connected) return this.client;
		this.connecting ??= this.open().finally(() => {
			this.connecting = undefined;
		});
		return this.connecting;
	}

	private async open(): Promise<MqttClient> {
		const { ecode, partnerIdentity } = this.session;
		if (!ecode || !partnerIdentity) throw new Error('The session has no MQTT credentials');

		const credentials = mqttCredentials({
			sid: this.session.sid,
			uid: this.session.uid,
			ecode,
			partnerIdentity,
			phoneId: this.session.phoneId,
		});
		const host = this.session.mqttHost ?? this.session.apiHost.replace(/^a1\./, 'm1.');
		this.logger.log(`Connecting to ${host}`);

		const client = await this.connect(`mqtts://${host}:8883`, {
			clientId: credentials.clientId,
			username: credentials.username,
			password: credentials.password,
			protocolVersion: 4,
			keepalive: 60,
			clean: true,
			connectTimeout: 10_000,
			// A reconnect with the same client id would kick the connection it replaces; connect again on demand.
			reconnectPeriod: 0,
		});
		client.on('message', (topic, payload) => {
			if (!topic.startsWith('smart/')) this.onMessage(payload);
		});
		client.on('close', () => {
			if (this.client === client) this.client = undefined;
		});
		client.on('error', error => this.logger.log(`Signalling connection error: ${error.message}`));
		await client.subscribeAsync(credentials.topic, { qos: 1 });

		this.client = client;
		return client;
	}

	/**
	 * Asks a camera for its Wi-Fi signal, as the Philips app's device page does: a query on the camera's device channel
	 * (`smart/mb/out/<devId>`), answered on `smart/mb/in/<devId>` within a second or so. Resolves with the percentage,
	 * or undefined when no answer came. The cloud's own value (`tuya.m.device.upgrade.rssi.info.query`) stays at -75 dBm
	 * on these monitors, so it isn't used.
	 */
	public async requestWifiSignal(deviceId: string, localKey: string, waitMs = 8_000): Promise<number | undefined> {
		const client = await this.ensureConnected();
		this.scheduleIdleClose();
		const key = Buffer.from(localKey, 'latin1');
		const inTopic = `smart/mb/in/${deviceId}`;
		let onMessage: ((topic: string, payload: Buffer) => void) | undefined;
		let timer: NodeJS.Timeout | undefined;
		const reply = new Promise<number | undefined>(resolve => {
			timer = setTimeout(() => resolve(undefined), waitMs);
			onMessage = (topic, payload): void => {
				if (topic !== inTopic) return;
				try {
					const signal = readSignalReply(decodeDeviceMessage(key, payload));
					if (signal !== undefined) resolve(signal);
				} catch {
					// Other device messages, or ones under another key: not the answer.
				}
			};
			client.on('message', onMessage);
		});
		try {
			await client.subscribeAsync(inTopic, { qos: 1 });
			this.deviceSequence += 1;
			const query = encodeDeviceMessage(key, signalQuery.protocol, signalQuery.data, this.deviceSequence);
			await client.publishAsync(`smart/mb/out/${deviceId}`, query, { qos: 1 });
			return await reply;
		} finally {
			clearTimeout(timer);
			if (onMessage) client.off('message', onMessage);
			await client.unsubscribeAsync(inTopic).catch(() => undefined);
		}
	}

	private onMessage(payload: Buffer): void {
		let message: SignalMessage;
		try {
			message = JSON.parse(payload.toString('utf8')) as SignalMessage;
		} catch {
			this.logger.log('Ignoring an unreadable signalling message');
			return;
		}
		const sessionId = message?.data?.header?.sessionid;
		this.streams.get(sessionId)?.onMessage(message);
	}
}
