import { createRequire } from 'node:module';
import type * as Werift from 'werift';
import type { Logger } from './Logger.mjs';
import { codecSummary, forWerift, sdpForLog } from './utils/sdp.mjs';
import { addCbcSupport } from './utils/werift-cbc.mjs';

/** How long gathering our own ICE candidates may take before the description goes out with what it has. */
const gatheringTimeoutMs = 3_000;
/** How long a peer may stay disconnected before it is given up. */
const disconnectGraceMs = 10_000;
/** A viewer that hasn't connected this long after the answer isn't coming. */
const viewerConnectTimeoutMs = 20_000;
/**
 * A viewer sends RTCP reports every second or so; this long without one means it left. Homey doesn't say when a viewer
 * leaves (its keep-alive listener never fires), and its connection only fails about a minute later.
 */
const viewerSilenceMs = 2_500;

/**
 * Loads werift's CommonJS build, with the AES-CBC suite some cameras need added (see utils/werift-cbc.mts); that only
 * works on the CommonJS build. werift, a WebRTC implementation in plain JavaScript, is loaded on the first stream, so
 * an idle app doesn't carry it.
 */
export async function loadWerift(): Promise<typeof Werift> {
	const requireWerift = createRequire(createRequire(import.meta.url).resolve('werift'));
	addCbcSupport(requireWerift);
	return requireWerift('werift') as typeof Werift;
}

/** Waits until a peer has gathered its ICE candidates, or a few seconds at most. */
export async function gathered(peer: Werift.RTCPeerConnection): Promise<void> {
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

/**
 * Calls `onEnd` with the reason when a peer fails, closes, or stays disconnected too long. Its timer goes into `timers`.
 */
export function watchPeerState(
	peer: Werift.RTCPeerConnection,
	side: string,
	timers: Set<NodeJS.Timeout>,
	onEnd: (reason: string) => void,
): void {
	let grace: NodeJS.Timeout | undefined;
	peer.connectionStateChange.subscribe(state => {
		if (grace) {
			clearTimeout(grace);
			timers.delete(grace);
			grace = undefined;
		}
		if (state === 'failed' || state === 'closed') {
			onEnd(`The ${side} side ${state}`);
		} else if (state === 'disconnected') {
			grace = setTimeout(() => {
				onEnd(`The ${side} side stayed disconnected`);
			}, disconnectGraceMs);
			timers.add(grace);
		}
	});
}

export interface ViewerConnectionOptions {
	logger: Logger;
	/** Asks the camera for a keyframe; the camera session limits how often. */
	requestKeyframe: () => void;
	/** Called once when this viewer's connection ends, from either side. */
	onClose: (viewer: ViewerConnection) => void;
}

/**
 * One Homey viewer of a camera session (see CameraSession.mts): its own peer connection, which werift encrypts for
 * and numbers with its own stream id, fed the packets the session restamped once for every viewer. Closing it leaves
 * the camera alone.
 */
export class ViewerConnection {
	/** What the viewer asked for, for the session's statistics. */
	public readonly stats = {
		keyframeRequests: 0,
		resendRequests: 0,
		/** The longest the viewer went without sending RTCP, to check `viewerSilenceMs` against. */
		longestSilenceMs: 0,
	};
	private readonly logger: Logger;
	private readonly options: ViewerConnectionOptions;
	private peer: Werift.RTCPeerConnection | undefined;
	private video: Werift.MediaStreamTrack | undefined;
	private audio: Werift.MediaStreamTrack | undefined;
	private readonly timers = new Set<NodeJS.Timeout>();
	private lastRtcp = 0;
	private closed = false;

	public constructor(options: ViewerConnectionOptions) {
		this.options = options;
		this.logger = options.logger;
	}

	public isClosed(): boolean {
		return this.closed;
	}

	/** Passes a packet from the camera, already restamped, on to this viewer. */
	public send(kind: 'video' | 'audio', packet: Werift.RtpPacket): void {
		if (this.closed) return;
		(kind === 'video' ? this.video : this.audio)?.writeRtp(packet);
	}

	/** Packets sent to the viewer, and the codec they went out as, for the session's statistics. */
	public describeSent(): string {
		const sender = this.peer?.getTransceivers().find(item => item.kind === 'video')?.sender as
			{ packetCount?: number; codec?: { mimeType?: string; payloadType?: number } } | undefined;
		const codec = sender?.codec ? `${sender.codec.mimeType}/${sender.codec.payloadType}` : 'no codec';
		return `${sender?.packetCount ?? 'unknown'} (${codec})`;
	}

	/**
	 * Answers the viewer's offer.
	 * @param codecs What the viewer may be offered, the camera's own H.264 variant first.
	 * @returns The answer for the viewer.
	 */
	public async answer(
		werift: typeof Werift,
		offerSdp: string,
		codecs: { video: Werift.RTCRtpCodecParameters[]; audio: Werift.RTCRtpCodecParameters[] },
	): Promise<string> {
		if (this.closed) throw new Error('The viewer was closed before it was answered');
		this.logger.debug(`Viewer offers ${codecSummary(offerSdp, 'video')}`);
		// No header extensions: computing them for every packet (and their feedback) costs CPU the relay doesn't need.
		const peer = new werift.RTCPeerConnection({ codecs, headerExtensions: { video: [], audio: [] } });
		this.peer = peer;
		this.video = new werift.MediaStreamTrack({ kind: 'video' });
		this.audio = new werift.MediaStreamTrack({ kind: 'audio' });
		peer.connectionStateChange.subscribe(state => {
			if (state !== 'connected') return;
			this.logger.log('Viewer connected');
			this.options.requestKeyframe();
			this.watchSilence();
		});
		watchPeerState(peer, 'viewer', this.timers, reason => {
			if (!this.closed) this.logger.log(reason);
			this.close();
		});
		try {
			await peer.setRemoteDescription({ type: 'offer', sdp: forWerift(offerSdp) });
		} catch (error) {
			this.logger.log(`The viewer's offer could not be read: ${sdpForLog(offerSdp)}`);
			throw error;
		}
		for (const transceiver of peer.getTransceivers()) {
			await transceiver.sender.replaceTrack(transceiver.kind === 'video' ? this.video : this.audio);
			transceiver.setDirection('sendonly');
			if (transceiver.kind === 'video') this.watchFeedback(werift, transceiver.sender);
		}
		await peer.setLocalDescription(await peer.createAnswer());
		await gathered(peer);
		if (this.closed) throw new Error('The viewer was closed before it was answered');
		this.logger.debug(`Answering the viewer with ${codecSummary(peer.localDescription!.sdp, 'video')}`);
		const connectTimer = setTimeout(() => {
			if (peer.connectionState === 'connected') return;
			this.logger.log('The viewer never connected; closing it');
			this.close();
		}, viewerConnectTimeoutMs);
		this.timers.add(connectTimer);
		return peer.localDescription!.sdp;
	}

	/** Ends this viewer's connection. Safe to call more than once. */
	public close(): void {
		if (this.closed) return;
		this.closed = true;
		for (const timer of this.timers) {
			clearTimeout(timer);
			clearInterval(timer);
		}
		this.timers.clear();
		const peer = this.peer;
		this.peer = undefined;
		peer?.close().catch(error => this.logger.log(`Closing the viewer failed: ${(error as Error).message ?? error}`));
		this.logger.log('Viewer closed');
		this.options.onClose(this);
	}

	/** Passes the viewer's keyframe requests on to the camera, and counts them and its resend requests. */
	private watchFeedback(werift: typeof Werift, sender: Werift.RTCRtpSender): void {
		sender.onRtcp.subscribe(rtcp => {
			const now = Date.now();
			if (this.lastRtcp > 0) this.stats.longestSilenceMs = Math.max(this.stats.longestSilenceMs, now - this.lastRtcp);
			this.lastRtcp = now;
			if (rtcp instanceof werift.RtcpPayloadSpecificFeedback) {
				// werift doesn't export its FIR class, so that one goes by name.
				if (
					rtcp.feedback instanceof werift.PictureLossIndication ||
					rtcp.feedback.constructor.name === 'FullIntraRequest'
				) {
					this.stats.keyframeRequests++;
					this.options.requestKeyframe();
				}
			} else if (rtcp.type === 205) {
				// werift resends from this viewer's own packet history; this only counts the requests.
				this.stats.resendRequests++;
			}
		});
	}

	/** Closes the viewer once it stops sending reports; one that never sent any is left to the connect timeout. */
	private watchSilence(): void {
		const timer = setInterval(() => {
			if (this.lastRtcp === 0 || Date.now() - this.lastRtcp < viewerSilenceMs) return;
			this.logger.log(`The viewer sent nothing for ${Date.now() - this.lastRtcp} ms; closing it`);
			this.close();
		}, 500);
		this.timers.add(timer);
	}
}
