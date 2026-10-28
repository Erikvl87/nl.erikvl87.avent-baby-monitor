import v8 from 'node:v8';
import type * as Werift from 'werift';
import type { Logger } from './Logger.mjs';
import type { IceServer } from './types/tuya.mjs';
import { AudioRestamper, VideoRestamper, type RtpLike } from './utils/rtp-restamp.mjs';
import { ReorderBuffer } from './utils/rtp-reorder.mjs';
import { codecSummary, forWerift, h264Parameters, sdpForLog, splitCandidates } from './utils/sdp.mjs';
import { gathered, loadWerift, ViewerConnection, watchPeerState } from './VideoRelay.mjs';

export interface CameraSessionOptions {
	logger: Logger;
	/** Tuya's ICE servers for this camera; only the STUN ones are used, the camera is normally on the same network. */
	iceServers: () => Promise<IceServer[]>;
	/** Sends the session's offer and its ICE candidates to the camera, and returns the camera's answer. */
	signal: (offer: { sdp: string; candidates: string[] }) => Promise<string>;
	/** Called once when the session ends, from either side. */
	onClose?: () => void;
	/** For tests: replaces `loadWerift()`. */
	loadWerift?: () => Promise<typeof Werift>;
	/** How long the first viewers' answer may wait for the camera's first video; see `cameraVideoWaitMs`. */
	cameraVideoWaitMs?: number;
	/** How many viewers may watch at once; see `maxViewers`. */
	maxViewers?: number;
	/** How long the camera stream stays open after the last viewer left; see `lingerMs`. */
	lingerMs?: number;
}

/**
 * The camera's video only starts about 2 s after it answers, as its own connection completes. The first viewers get
 * their answer once that video flows, at most this long after: Homey shows its spinner until then instead of a black
 * picture.
 */
const cameraVideoWaitMs = 8_000;
/** Keyframe requests, from every viewer together, are passed to the camera at most this often. */
const keyframeRequestIntervalMs = 1_000;
/** Each viewer costs Homey CPU, mostly for encryption; a new viewer past this many closes the oldest. */
const maxViewers = 3;
/**
 * After the last viewer leaves, the camera stream stays open this long: reopening the device in that time skips the
 * camera's startup, and an SCD973 doesn't stop its lullaby again. The camera's "someone is watching" light stays on
 * as long.
 */
const lingerMs = 5_000;

/**
 * One stream from a camera, shared by every Homey viewer of it. A camera accepts only a few viewers at once, depending
 * on the model (three on the SCD923 and SCD973), counting the Philips app on every phone; one session per camera keeps
 * Homey to one of them.
 *
 * The camera sends every frame with the same RTP timestamp, which makes players stutter; the session receives the
 * stream, puts it back in order (utils/rtp-reorder.mts), restamps it from the wall clock (utils/rtp-restamp.mts), and
 * passes it to each viewer (ViewerConnection in VideoRelay.mts), which werift encrypts and numbers per viewer.
 * Nothing is decoded or re-encoded.
 */
export default class CameraSession {
	private readonly logger: Logger;
	private readonly options: CameraSessionOptions;
	private werift: typeof Werift | undefined;
	private camera: Werift.RTCPeerConnection | undefined;
	/** The H.264 variant the camera sends, offered to viewers first. */
	private cameraH264: string | undefined;
	/** Oldest first. */
	private readonly viewers = new Set<ViewerConnection>();
	private viewersAdded = 0;
	private starting: Promise<void> | undefined;
	private lingerTimer: NodeJS.Timeout | undefined;
	private readonly timers = new Set<NodeJS.Timeout>();
	/** What flowed, for the log: a black or stuttering picture's cause shows here. */
	private readonly stats = {
		videoIn: 0,
		videoOut: 0,
		audioIn: 0,
		lost: 0,
		late: 0,
		reordered: 0,
		ssrcs: new Set<number>(),
	};
	private lastKeyframeRequest = 0;
	/** The stream id the camera's video currently arrives with; it changes when the camera switches streams. */
	private currentVideoSsrc: number | undefined;
	private closed = false;
	/** Resolves when the first video arrives from the camera. */
	private cameraVideoArrived!: () => void;
	private readonly cameraVideo = new Promise<void>(resolve => {
		this.cameraVideoArrived = resolve;
	});
	private cameraVideoFlowing = false;

	public constructor(options: CameraSessionOptions) {
		this.options = options;
		this.logger = options.logger;
	}

	public isClosed(): boolean {
		return this.closed;
	}

	/** Whether the camera side is still connecting: its video hasn't arrived yet and the session is open. */
	public isConnecting(): boolean {
		return !this.closed && !this.cameraVideoFlowing;
	}

	/** Resolves once the camera's video arrives, or the session closes. */
	public async connected(): Promise<void> {
		await this.cameraVideo;
	}

	/** Viewers watching or connecting. */
	public get viewerCount(): number {
		return this.viewers.size;
	}

	/**
	 * Adds a viewer. The first one starts the camera side; later ones are answered at once, or once the camera's video
	 * flows while it is still starting.
	 * @param viewerOfferSdp The viewer's offer, as Homey hands it over.
	 * @returns The answer for the viewer.
	 */
	public async addViewer(viewerOfferSdp: string): Promise<string> {
		if (this.closed) throw new Error('The camera stream has closed');
		this.cancelLinger();
		const max = this.options.maxViewers ?? maxViewers;
		while (this.viewers.size >= max) {
			const oldest = this.viewers.values().next().value;
			if (!oldest) break;
			this.logger.log('Closing the oldest viewer to make room');
			oldest.close();
		}
		const viewer = new ViewerConnection({
			logger: this.logger.createChildLogger({ prefix: `Viewer ${++this.viewersAdded}` }),
			requestKeyframe: (): void => this.requestKeyframe(),
			onClose: (closed): void => this.viewerClosed(closed),
		});
		this.viewers.add(viewer);
		this.logger.log(`Adding a viewer (${this.viewers.size} now)`);
		try {
			await (this.starting ??= this.start());
			return await viewer.answer(this.werift!, viewerOfferSdp, this.viewerCodecs());
		} catch (error) {
			viewer.close();
			throw error;
		}
	}

	/** Ends the camera stream and every viewer. Safe to call more than once. */
	public close(): void {
		if (this.closed) return;
		this.closed = true;
		this.cameraVideoArrived();
		this.cancelLinger();
		for (const timer of this.timers) {
			clearTimeout(timer);
			clearInterval(timer);
		}
		this.timers.clear();
		for (const viewer of [...this.viewers]) viewer.close();
		this.viewers.clear();
		const camera = this.camera;
		this.camera = undefined;
		camera?.close().catch(error => this.logger.log(`Closing the camera side failed: ${(error as Error).message ?? error}`));
		this.logger.log('Camera stream closed');
		this.options.onClose?.();
	}

	/** Sets up the camera side and waits for its video, `cameraVideoWaitMs` at most. */
	private async start(): Promise<void> {
		try {
			const werift = await (this.options.loadWerift?.() ?? loadWerift());
			this.werift = werift;
			const iceServers = await this.options.iceServers();
			if (this.closed) throw new Error('The camera stream was closed while starting');
			// One lean entry, since the camera truncates a long SDP.
			const camera = new werift.RTCPeerConnection({
				codecs: {
					video: [werift.useH264({ payloadType: 96, rtcpFeedback: [werift.useNACK(), werift.usePLI()] })],
					audio: [werift.usePCMU()],
				},
				headerExtensions: { video: [], audio: [] },
				bundlePolicy: 'max-bundle',
				iceServers: iceServers.filter(server => server.urls.startsWith('stun:')).map(server => ({ urls: server.urls })),
			});
			this.camera = camera;
			this.wireCamera(camera);

			// Audio first, as the phone app and aventproxy's bridge do: with video first, the camera leaves the video
			// section of its answer empty.
			camera.addTransceiver('audio', { direction: 'recvonly' });
			camera.addTransceiver('video', { direction: 'recvonly' });
			await camera.setLocalDescription(await camera.createOffer());
			await gathered(camera);
			const offer = splitCandidates(camera.localDescription!.sdp);
			this.logger.debug(`Offering the camera ${offer.sdp.length} bytes and ${offer.candidates.length} candidate(s)`);
			const cameraAnswer = await this.options.signal(offer);
			if (this.closed) throw new Error('The camera stream was closed while starting');
			try {
				await camera.setRemoteDescription({ type: 'answer', sdp: forWerift(cameraAnswer) });
			} catch (error) {
				this.logger.log(`The camera's answer could not be read: ${sdpForLog(cameraAnswer)}`);
				throw error;
			}
			this.logger.debug(`Camera side negotiated; camera sends ${codecSummary(cameraAnswer, 'video')}`);
			this.cameraH264 = h264Parameters(cameraAnswer);
			await this.waitForCameraVideo();
		} catch (error) {
			this.close();
			throw error;
		}
	}

	/** For Homey, everything it may offer, the camera's own H.264 variant first: a decoder may refuse a higher profile. */
	private viewerCodecs(): { video: Werift.RTCRtpCodecParameters[]; audio: Werift.RTCRtpCodecParameters[] } {
		const werift = this.werift!;
		const video = [
			werift.useH264({ payloadType: 96 }),
			werift.useH264({
				payloadType: 97,
				parameters: 'profile-level-id=42001f;packetization-mode=1;level-asymmetry-allowed=1',
			}),
			werift.useH264({
				payloadType: 98,
				parameters: 'profile-level-id=640032;packetization-mode=1;level-asymmetry-allowed=1',
			}),
		];
		if (this.cameraH264) video.unshift(werift.useH264({ payloadType: 99, parameters: this.cameraH264 }));
		return { video, audio: [werift.usePCMU()] };
	}

	private viewerClosed(viewer: ViewerConnection): void {
		this.viewers.delete(viewer);
		if (this.closed || this.viewers.size > 0) return;
		const linger = this.options.lingerMs ?? lingerMs;
		this.logger.log(`Nobody is watching; closing the camera stream in ${linger} ms unless someone opens it`);
		this.lingerTimer = setTimeout(() => {
			this.lingerTimer = undefined;
			this.close();
		}, linger);
	}

	private cancelLinger(): void {
		clearTimeout(this.lingerTimer);
		this.lingerTimer = undefined;
	}

	/** Restamps the camera's packets once and passes them to every viewer. */
	private wireCamera(camera: Werift.RTCPeerConnection): void {
		const video = new VideoRestamper();
		const audio = new AudioRestamper();
		const stats = this.stats;
		let reorder = new ReorderBuffer<Werift.RtpPacket>();
		let lastVideoSsrc: number | undefined;
		this.followNewStreams(camera);
		this.scheduleStats(() => {
			const viewers = [...this.viewers];
			const sent = viewers.map(viewer => viewer.describeSent()).join(' / ') || 'none';
			const keyframeRequests = viewers.reduce((sum, viewer) => sum + viewer.stats.keyframeRequests, 0);
			const resendRequests = viewers.reduce((sum, viewer) => sum + viewer.stats.resendRequests, 0);
			const silence = Math.max(0, ...viewers.map(viewer => viewer.stats.longestSilenceMs));
			return (
				`video ${stats.videoIn} in (${stats.reordered} put back in order, ${stats.lost} lost, ${stats.late} too late) / ` +
				`${stats.videoOut} restamped / ` +
				`${viewers.length} viewer(s), sent ${sent}, ${video.keyframes} keyframe(s), ` +
				`viewers asked ${keyframeRequests} keyframe(s) and ${resendRequests} resend(s), ` +
				`longest viewer silence ${silence} ms, ` +
				`stream id(s) ${[...stats.ssrcs].join(', ') || 'none'}; audio ${stats.audioIn} in`
			);
		});

		camera.onTrack.subscribe(track => {
			track.onReceiveRtp.subscribe(rtp => {
				if (this.closed) return;
				if (track.kind === 'video') {
					stats.videoIn++;
					stats.ssrcs.add(rtp.header.ssrc);
					if (rtp.header.ssrc !== lastVideoSsrc) {
						// New video from the camera, at the start or after a switch: a keyframe gets the picture going.
						this.logger.log(
							lastVideoSsrc === undefined ? 'Receiving video from the camera' : 'Camera switched video streams',
						);
						this.cameraVideoFlowing = true;
						this.cameraVideoArrived();
						lastVideoSsrc = rtp.header.ssrc;
						this.currentVideoSsrc = rtp.header.ssrc;
						this.lastKeyframeRequest = 0;
						this.requestKeyframe(rtp.header.ssrc);
						reorder = new ReorderBuffer<Werift.RtpPacket>();
					}
					// Back in order first: restamping a packet out of place would break the picture it lands in.
					const sorted = reorder.push(rtp);
					stats.lost += sorted.skipped;
					if (sorted.late) stats.late++;
					if (sorted.reordered) stats.reordered++;
					for (const inOrder of sorted.ready) {
						for (const packet of video.process(inOrder as unknown as RtpLike)) {
							// Each viewer's track copies the packet before werift renumbers it for that viewer.
							for (const viewer of this.viewers) viewer.send('video', packet as unknown as Werift.RtpPacket);
							stats.videoOut++;
						}
					}
				} else {
					stats.audioIn++;
					const packet = audio.process(rtp as unknown as RtpLike) as unknown as Werift.RtpPacket;
					for (const viewer of this.viewers) viewer.send('audio', packet);
				}
			});
		});
		watchPeerState(camera, 'camera', this.timers, reason => {
			if (!this.closed) this.logger.log(reason);
			this.close();
		});
	}

	private requestKeyframe(knownSsrc?: number): void {
		const now = Date.now();
		if (now - this.lastKeyframeRequest < keyframeRequestIntervalMs) return;
		const transceiver = this.camera?.getTransceivers().find(item => item.kind === 'video');
		const ssrc = knownSsrc ?? this.currentVideoSsrc ?? transceiver?.receiver.tracks[0]?.ssrc;
		if (!transceiver || ssrc === undefined) return;
		this.lastKeyframeRequest = now;
		transceiver.receiver.sendRtcpPLI(ssrc).catch(error => {
			this.logger.log(`Asking the camera for a keyframe failed: ${(error as Error).message ?? error}`);
		});
	}

	/**
	 * werift drops RTP whose stream id (SSRC) the camera's answer didn't announce, and the camera starts a new one
	 * when it switches streams, as on the switch to HD. This hands such packets to the receiver of their kind
	 * (audio is PCMU, payload type 0; everything else is video) so the stream carries on.
	 */
	private followNewStreams(camera: Werift.RTCPeerConnection): void {
		type Router = {
			ssrcTable: Record<number, unknown>;
			routeRtp: (packet: Werift.RtpPacket) => void;
			registerRtpReceiver: (receiver: unknown, ssrc: number) => void;
		};
		const router = (camera as unknown as { router?: Router }).router;
		if (!router || typeof router.routeRtp !== 'function') {
			this.logger.log('Cannot follow stream switches: werift has no router to hook into');
			return;
		}
		const route = router.routeRtp;
		router.routeRtp = (packet): void => {
			const ssrc = packet.header.ssrc;
			if (!router.ssrcTable[ssrc]) {
				const kind = packet.header.payloadType === 0 ? 'audio' : 'video';
				const receiver = camera.getTransceivers().find(item => item.kind === kind)?.receiver;
				const track = receiver?.tracks[0];
				if (receiver && track) {
					this.logger.debug(`Following the camera's new ${kind} stream id ${ssrc}`);
					router.registerRtpReceiver(receiver, ssrc);
					(receiver as unknown as { trackBySSRC: Record<number, unknown> }).trackBySSRC[ssrc] = track;
				}
			}
			route(packet);
		};
	}

	/**
	 * With the debug setting on, logs what flowed every 10 seconds, with the app's CPU use and heap: a black or
	 * stuttering picture's cause shows here, and so does a session that costs more than Homey allows.
	 */
	private scheduleStats(describe: () => string): void {
		let lastCpu = CameraSession.cpuMicros();
		let lastWall = Date.now();
		const log = (): void => {
			if (this.closed) return;
			// Statistics are a nicety; an error here must never take the app down.
			try {
				const cpu = CameraSession.cpuMicros();
				const now = Date.now();
				const load =
					cpu !== undefined && lastCpu !== undefined
						? `${Math.round((cpu - lastCpu) / ((now - lastWall) * 10))}%`
						: '?';
				lastCpu = cpu;
				lastWall = now;
				this.logger.debug(`Relay: ${describe()}; app CPU ${load}, heap ${CameraSession.heapMegabytes()} MB`);
			} catch (error) {
				this.logger.debug(`Relay statistics failed: ${(error as Error).message ?? error}`);
			}
		};
		this.timers.add(setTimeout(log, 5_000));
		this.timers.add(setInterval(log, 10_000));
	}

	/** CPU time the app has used, in microseconds; undefined where the sandbox doesn't tell. */
	private static cpuMicros(): number | undefined {
		try {
			const usage = process.cpuUsage();
			return usage.user + usage.system;
		} catch {
			return undefined;
		}
	}

	private static heapMegabytes(): string {
		try {
			return String(Math.round(v8.getHeapStatistics().used_heap_size / 1048576));
		} catch {
			return '?';
		}
	}

	/** Waits for the camera's first video, or `cameraVideoWaitMs` at most; the first viewers get their answer after. */
	private async waitForCameraVideo(): Promise<void> {
		const limit = this.options.cameraVideoWaitMs ?? cameraVideoWaitMs;
		const started = Date.now();
		let timer: NodeJS.Timeout | undefined;
		const arrived = await Promise.race([
			this.cameraVideo.then(() => true),
			new Promise<boolean>(resolve => {
				timer = setTimeout(() => resolve(false), limit);
			}),
		]);
		clearTimeout(timer);
		if (this.closed) throw new Error('The camera stream was closed while waiting for its video');
		const waited = Date.now() - started;
		this.logger.log(
			arrived
				? `Camera video after ${waited} ms; answering the viewer`
				: `No camera video after ${waited} ms; answering the viewer anyway`,
		);
	}
}
