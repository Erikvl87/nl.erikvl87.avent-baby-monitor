import { createRequire } from 'node:module';
import v8 from 'node:v8';
import type * as Werift from 'werift';
import type { Logger } from './Logger.mjs';
import type { IceServer } from './types/tuya.mjs';
import { AudioRestamper, VideoRestamper, type RtpLike } from './utils/rtp-restamp.mjs';
import { ReorderBuffer } from './utils/rtp-reorder.mjs';
import { codecSummary, forWerift, h264Parameters, sdpForLog, splitCandidates } from './utils/sdp.mjs';
import { addCbcSupport } from './utils/werift-cbc.mjs';

export interface VideoRelayOptions {
	logger: Logger;
	/** Tuya's ICE servers for this camera; only the STUN ones are used, the camera is normally on the same network. */
	iceServers: IceServer[];
	/** Sends the relay's offer and its ICE candidates to the camera, and returns the camera's answer. */
	signal: (offer: { sdp: string; candidates: string[] }) => Promise<string>;
	/** Called once when the stream ends, from either side. */
	onClose?: () => void;
	/** For tests: replaces `loadWerift()`. */
	loadWerift?: () => Promise<typeof Werift>;
	/** How long the viewer's answer may wait for the camera's first video; see `cameraVideoWaitMs`. */
	cameraVideoWaitMs?: number;
}

/** How long gathering our own ICE candidates may take before the description goes out with what it has. */
const gatheringTimeoutMs = 3_000;
/** How long a peer may stay disconnected before the stream is given up. */
const disconnectGraceMs = 10_000;
/** A viewer that hasn't connected this long after the answer isn't coming; the camera stream is closed. */
const viewerConnectTimeoutMs = 20_000;
/**
 * A viewer sends RTCP reports every second or so; this long without one means it left. Homey doesn't say when a viewer
 * leaves (its keep-alive listener never fires), its connection only fails about a minute later, and until the camera
 * gets a disconnect its "someone is watching" light stays on.
 */
const viewerSilenceMs = 2_500;
/**
 * The camera's video only starts about 2 s after it answers, as its own connection completes. The viewer gets its
 * answer once that video flows, at most this long after: Homey shows its spinner until then instead of a black picture.
 */
const cameraVideoWaitMs = 8_000;
/** Keyframe requests are passed to the camera at most this often. */
const keyframeRequestIntervalMs = 1_000;

/**
 * Relays a camera's video to a Homey viewer and fixes its timestamps on the way. The camera sends every frame with
 * the same RTP timestamp, which makes players stutter; the relay receives the stream from the camera, restamps it
 * from the wall clock (see utils/rtp-restamp.mts), and sends it on to the viewer. Nothing is decoded or re-encoded.
 *
 * werift, a WebRTC implementation in plain JavaScript, is only loaded when a stream starts.
 */
/**
 * Loads werift's CommonJS build, with the AES-CBC suite some cameras need added (see utils/werift-cbc.mts); that only
 * works on the CommonJS build. Loaded on the first stream, so an idle app doesn't carry werift.
 */
export async function loadWerift(): Promise<typeof Werift> {
	const requireWerift = createRequire(createRequire(import.meta.url).resolve('werift'));
	addCbcSupport(requireWerift);
	return requireWerift('werift') as typeof Werift;
}

export default class VideoRelay {
	private readonly logger: Logger;
	private readonly options: VideoRelayOptions;
	private camera: Werift.RTCPeerConnection | undefined;
	private viewer: Werift.RTCPeerConnection | undefined;
	private readonly timers = new Set<NodeJS.Timeout>();
	/** What flowed, for the log: a black or stuttering picture's cause shows here. */
	private readonly stats = {
		videoIn: 0,
		videoOut: 0,
		audioIn: 0,
		lost: 0,
		late: 0,
		reordered: 0,
		keyframeRequests: 0,
		resendRequests: 0,
		/** The longest the viewer went without sending RTCP, to check `viewerSilenceMs` against. */
		longestViewerSilenceMs: 0,
		ssrcs: new Set<number>(),
	};
	private lastKeyframeRequest = 0;
	private lastViewerRtcp = 0;
	/** The stream id the camera's video currently arrives with; it changes when the camera switches streams. */
	private currentVideoSsrc: number | undefined;
	private closed = false;
	/** Resolves when the first video arrives from the camera. */
	private cameraVideoArrived!: () => void;
	private readonly cameraVideo = new Promise<void>(resolve => {
		this.cameraVideoArrived = resolve;
	});
	private cameraVideoFlowing = false;

	public constructor(options: VideoRelayOptions) {
		this.options = options;
		this.logger = options.logger;
	}

	public isClosed(): boolean {
		return this.closed;
	}

	/** Whether the camera side is still connecting: its video hasn't arrived yet and the relay is open. */
	public isConnecting(): boolean {
		return !this.closed && !this.cameraVideoFlowing;
	}

	/** Resolves once the camera's video arrives, or the relay closes. */
	public async connected(): Promise<void> {
		await this.cameraVideo;
	}

	/**
	 * Sets up both sides: first the camera, so its codec choice is known, then the viewer.
	 * @param viewerOfferSdp The viewer's offer, as Homey hands it over.
	 * @returns The answer for the viewer.
	 */
	public async answer(viewerOfferSdp: string): Promise<string> {
		const werift = await (this.options.loadWerift?.() ?? loadWerift());
		// For Homey, everything it may offer; for the camera, one lean entry, since the camera truncates a long SDP.
		const viewerCodecs = {
			video: [
				werift.useH264({ payloadType: 96 }),
				werift.useH264({
					payloadType: 97,
					parameters: 'profile-level-id=42001f;packetization-mode=1;level-asymmetry-allowed=1',
				}),
				werift.useH264({
					payloadType: 98,
					parameters: 'profile-level-id=640032;packetization-mode=1;level-asymmetry-allowed=1',
				}),
			],
			audio: [werift.usePCMU()],
		};
		const cameraCodecs = {
			video: [werift.useH264({ payloadType: 96, rtcpFeedback: [werift.useNACK(), werift.usePLI()] })],
			audio: [werift.usePCMU()],
		};

		try {
			const camera = new werift.RTCPeerConnection({
				codecs: cameraCodecs,
				headerExtensions: { video: [], audio: [] },
				bundlePolicy: 'max-bundle',
				iceServers: this.options.iceServers
					.filter(server => server.urls.startsWith('stun:'))
					.map(server => ({ urls: server.urls })),
			});
			this.camera = camera;
			const viewerVideo = new werift.MediaStreamTrack({ kind: 'video' });
			const viewerAudio = new werift.MediaStreamTrack({ kind: 'audio' });
			this.wireCamera(werift, camera, viewerVideo, viewerAudio);

			// Audio first, as the phone app and aventproxy's bridge do: with video first, the camera leaves the video
			// section of its answer empty.
			camera.addTransceiver('audio', { direction: 'recvonly' });
			camera.addTransceiver('video', { direction: 'recvonly' });
			await camera.setLocalDescription(await camera.createOffer());
			await this.gathered(camera);
			const offer = splitCandidates(camera.localDescription!.sdp);
			this.logger.debug(`Offering the camera ${offer.sdp.length} bytes and ${offer.candidates.length} candidate(s)`);
			const cameraAnswer = await this.options.signal(offer);
			try {
				await camera.setRemoteDescription({ type: 'answer', sdp: forWerift(cameraAnswer) });
			} catch (error) {
				this.logger.log(`The camera's answer could not be read: ${sdpForLog(cameraAnswer)}`);
				throw error;
			}
			this.logger.debug(`Camera side negotiated; camera sends ${codecSummary(cameraAnswer, 'video')}`);
			await this.waitForCameraVideo();

			// Offer Homey the camera's own H.264 variant first: a decoder may refuse a stream whose profile is above
			// the one agreed on.
			const cameraH264 = h264Parameters(cameraAnswer);
			if (cameraH264) viewerCodecs.video.unshift(werift.useH264({ payloadType: 99, parameters: cameraH264 }));
			this.logger.debug(`Viewer offers ${codecSummary(viewerOfferSdp, 'video')}`);

			// No header extensions: computing them for every packet (and their feedback) costs CPU the relay doesn't need.
			const viewer = new werift.RTCPeerConnection({ codecs: viewerCodecs, headerExtensions: { video: [], audio: [] } });
			this.viewer = viewer;
			this.wireViewer(werift, viewer);
			try {
				await viewer.setRemoteDescription({ type: 'offer', sdp: forWerift(viewerOfferSdp) });
			} catch (error) {
				this.logger.log(`The viewer's offer could not be read: ${sdpForLog(viewerOfferSdp)}`);
				throw error;
			}
			for (const transceiver of viewer.getTransceivers()) {
				const track = transceiver.kind === 'video' ? viewerVideo : viewerAudio;
				await transceiver.sender.replaceTrack(track);
				transceiver.setDirection('sendonly');
				if (transceiver.kind === 'video') this.watchViewerFeedback(werift, transceiver.sender);
			}
			await viewer.setLocalDescription(await viewer.createAnswer());
			await this.gathered(viewer);
			this.logger.debug(`Answering the viewer with ${codecSummary(viewer.localDescription!.sdp, 'video')}`);
			const connectTimer = setTimeout(() => {
				if (viewer.connectionState === 'connected') return;
				this.logger.log('The viewer never connected; closing the stream');
				this.close();
			}, viewerConnectTimeoutMs);
			this.timers.add(connectTimer);
			return viewer.localDescription!.sdp;
		} catch (error) {
			this.close();
			throw error;
		}
	}

	/** Ends the stream on both sides. Safe to call more than once. */
	public close(): void {
		if (this.closed) return;
		this.closed = true;
		this.cameraVideoArrived();
		for (const timer of this.timers) {
			clearTimeout(timer);
			clearInterval(timer);
		}
		this.timers.clear();
		const peers = [this.camera, this.viewer];
		this.camera = undefined;
		this.viewer = undefined;
		for (const peer of peers) {
			peer?.close().catch(error => this.logger.log(`Closing a peer failed: ${(error as Error).message ?? error}`));
		}
		this.logger.log('Video relay closed');
		this.options.onClose?.();
	}

	/** Forwards the camera's tracks to the viewer's, restamped. */
	private wireCamera(
		werift: typeof Werift,
		camera: Werift.RTCPeerConnection,
		viewerVideo: Werift.MediaStreamTrack,
		viewerAudio: Werift.MediaStreamTrack,
	): void {
		const video = new VideoRestamper();
		const audio = new AudioRestamper();
		const stats = this.stats;
		let reorder = new ReorderBuffer<Werift.RtpPacket>();
		let lastVideoSsrc: number | undefined;
		this.followNewStreams(camera);
		this.scheduleStats(() => {
			const sender = this.viewer?.getTransceivers().find(item => item.kind === 'video')?.sender as
				{ packetCount?: number; codec?: { mimeType?: string; payloadType?: number } } | undefined;
			const sent = sender?.packetCount ?? 'unknown';
			const codec = sender?.codec ? `${sender.codec.mimeType}/${sender.codec.payloadType}` : 'no codec';
			return (
				`video ${stats.videoIn} in (${stats.reordered} put back in order, ${stats.lost} lost, ${stats.late} too late) / ` +
				`${stats.videoOut} to the track / ` +
				`${sent} sent to the viewer (${codec}), ${video.keyframes} keyframe(s), ` +
				`viewer asked ${stats.keyframeRequests} keyframe(s) and ${stats.resendRequests} resend(s), ` +
				`longest viewer silence ${stats.longestViewerSilenceMs} ms, ` +
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
							viewerVideo.writeRtp(packet as unknown as Werift.RtpPacket);
							stats.videoOut++;
						}
					}
				} else {
					stats.audioIn++;
					viewerAudio.writeRtp(audio.process(rtp as unknown as RtpLike) as unknown as Werift.RtpPacket);
				}
			});
		});
		this.watchState(werift, camera, 'camera');
	}

	/** Passes the viewer's keyframe requests on to the camera, and counts them and its resend requests. */
	private watchViewerFeedback(werift: typeof Werift, sender: Werift.RTCRtpSender): void {
		sender.onRtcp.subscribe(rtcp => {
			const now = Date.now();
			if (this.lastViewerRtcp > 0) {
				this.stats.longestViewerSilenceMs = Math.max(this.stats.longestViewerSilenceMs, now - this.lastViewerRtcp);
			}
			this.lastViewerRtcp = now;
			if (rtcp instanceof werift.RtcpPayloadSpecificFeedback) {
				// werift doesn't export its FIR class, so that one goes by name.
				if (
					rtcp.feedback instanceof werift.PictureLossIndication ||
					rtcp.feedback.constructor.name === 'FullIntraRequest'
				) {
					this.stats.keyframeRequests++;
					this.requestKeyframe();
				}
			} else if (rtcp.type === 205) {
				this.stats.resendRequests++;
			}
		});
	}

	/** Asks the camera for a keyframe as soon as the viewer connects. */
	private wireViewer(werift: typeof Werift, viewer: Werift.RTCPeerConnection): void {
		viewer.connectionStateChange.subscribe(state => {
			if (state === 'connected') {
				this.logger.log('Viewer connected');
				this.requestKeyframe();
				this.watchViewerSilence();
			}
		});
		this.watchState(werift, viewer, 'viewer');
	}

	/** Closes the stream once a viewer that sent reports stops sending them; one that never sent any is left alone. */
	private watchViewerSilence(): void {
		const timer = setInterval(() => {
			if (this.lastViewerRtcp === 0 || Date.now() - this.lastViewerRtcp < viewerSilenceMs) return;
			this.logger.log(`The viewer sent nothing for ${Date.now() - this.lastViewerRtcp} ms; closing the stream`);
			this.close();
		}, 500);
		this.timers.add(timer);
	}

	private requestKeyframe(knownSsrc?: number): void {
		const now = Date.now();
		if (now - this.lastKeyframeRequest < keyframeRequestIntervalMs) return;
		this.lastKeyframeRequest = now;

		const transceiver = this.camera?.getTransceivers().find(item => item.kind === 'video');
		const ssrc = knownSsrc ?? this.currentVideoSsrc ?? transceiver?.receiver.tracks[0]?.ssrc;
		if (!transceiver || ssrc === undefined) return;
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
	 * stuttering picture's cause shows here, and so does a relay that costs more than Homey allows.
	 */
	private scheduleStats(describe: () => string): void {
		let lastCpu = VideoRelay.cpuMicros();
		let lastWall = Date.now();
		const log = (): void => {
			if (this.closed) return;
			// Statistics are a nicety; an error here must never take the app down.
			try {
				const cpu = VideoRelay.cpuMicros();
				const now = Date.now();
				const load =
					cpu !== undefined && lastCpu !== undefined
						? `${Math.round((cpu - lastCpu) / ((now - lastWall) * 10))}%`
						: '?';
				lastCpu = cpu;
				lastWall = now;
				this.logger.debug(`Relay: ${describe()}; app CPU ${load}, heap ${VideoRelay.heapMegabytes()} MB`);
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

	/** Closes the stream when a side fails, closes, or stays disconnected too long. */
	private watchState(_werift: typeof Werift, peer: Werift.RTCPeerConnection, side: string): void {
		let grace: NodeJS.Timeout | undefined;
		peer.connectionStateChange.subscribe(state => {
			if (grace) {
				clearTimeout(grace);
				this.timers.delete(grace);
				grace = undefined;
			}
			if (state === 'failed' || state === 'closed') {
				if (!this.closed) this.logger.log(`The ${side} side ${state}`);
				this.close();
			} else if (state === 'disconnected') {
				grace = setTimeout(() => {
					this.logger.log(`The ${side} side stayed disconnected`);
					this.close();
				}, disconnectGraceMs);
				this.timers.add(grace);
			}
		});
	}

	/** Waits for the camera's first video, or `cameraVideoWaitMs` at most; the viewer gets its answer after. */
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
		if (this.closed) throw new Error('The stream was closed while waiting for the camera');
		const waited = Date.now() - started;
		this.logger.log(
			arrived
				? `Camera video after ${waited} ms; answering the viewer`
				: `No camera video after ${waited} ms; answering the viewer anyway`,
		);
	}

	/** Waits until a peer has gathered its ICE candidates, or a few seconds at most. */
	private async gathered(peer: Werift.RTCPeerConnection): Promise<void> {
		if (peer.iceGatheringState === 'complete') return;
		await new Promise<void>(resolve => {
			const timer = setTimeout(done, gatheringTimeoutMs);
			const subscription = peer.iceGatheringStateChange.subscribe(state => {
				if (state === 'complete') done();
			});
			function done(): void {
				clearTimeout(timer);
				subscription.unSubscribe();
				resolve();
			}
		});
	}
}
