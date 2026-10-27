import { randomBytes } from 'node:crypto';
import net from 'node:net';
import type { Logger } from './Logger.mjs';
import {
	decodeFrame,
	decodePayload,
	decryptEcb,
	deriveSessionKey,
	deriveSessionKey34,
	encodeCommand33,
	encodeCommand34,
	encodeCommand35,
	extractDps,
	heartbeatBody,
	hmacSha256,
	splitFrames,
	tuyaCommand,
	type TuyaLanVersion,
} from './utils/tuya-lan-protocol.mjs';

export type { TuyaLanVersion } from './utils/tuya-lan-protocol.mjs';

export interface TuyaLanSessionOptions {
	logger: Logger;
	deviceId: string;
	localKey: string;
	host: string;
	version: TuyaLanVersion;
	/** Called with every dps object pushed by the camera. */
	onDps: (dps: Record<string, unknown>) => void;
	/** Called when the session connects (after handshake) or drops. */
	onConnectionChange?: (connected: boolean) => void;
	/** Called when the camera's first readable frame proves the protocol version works, so the caller can keep it. */
	onVersionVerified?: (version: TuyaLanVersion) => void;
	/** For tests: replaces net.connect. */
	connect?: (port: number, host: string) => net.Socket;
}

const TUYA_PORT = 6668;
/** The monitor drops a silent socket after 30-45 s, so ping well inside that. */
const HEARTBEAT_INTERVAL_MS = 8_000;
/** Heartbeats are acked, so total silence for this long means a wedged socket. */
const DATA_TIMEOUT_MS = 600_000;
/** Covers the TCP connect plus, on 3.4 and 3.5, the session key negotiation. */
const HANDSHAKE_TIMEOUT_MS = 10_000;
/** Delay between attempts from the second consecutive failure on. */
const RECONNECT_DELAY_MS = 15_000;
/** When neither version gets a readable answer, the camera likely speaks one we don't; retry rarely, not every 15 s. */
const UNSUPPORTED_RETRY_DELAY_MS = 10 * 60_000;
/** Unreadable frames in a row before the session is considered broken. */
const MAX_PAYLOAD_ERRORS = 3;
/** Failed attempts on one version in a row before the next is tried; see `fallbackOrder`. */
const MAX_HANDSHAKE_FAILURES = 2;
/** Guard against a peer that streams bytes without ever completing a frame. */
const MAX_BUFFERED_BYTES = 256 * 1024;

type SessionState = 'idle' | 'connecting' | 'negotiating' | 'connected' | 'waiting';

/** The versions to try, in turn, when one keeps failing: the given one first, then 3.3, the common one. */
function fallbackOrder(first: TuyaLanVersion): TuyaLanVersion[] {
	const others: TuyaLanVersion[] = first === '3.5' ? ['3.3', '3.4'] : first === '3.4' ? ['3.3', '3.5'] : ['3.5', '3.4'];
	return [first, ...others];
}

/**
 * Persistent Tuya LAN session with the monitor on TCP 6668, used purely to
 * receive DPS pushes in real time.
 *
 * The session only ever sends the handshake and heartbeats. Querying status
 * (DP_QUERY) returns nothing on this firmware and UPDATEDPS for the lullaby
 * DPs has crashed and rebooted the camera, so neither is sent; the camera
 * pushes what changes on its own.
 *
 * Failure handling follows the Home Assistant integration this app is based
 * on: connection and handshake errors reconnect at once, unreadable frames
 * only after several in a row (the camera sends the odd frame no decoder can
 * read), the first retry is immediate and later ones are spaced out.
 */
export default class TuyaLanSession {
	private readonly logger: Logger;
	private readonly deviceId: string;
	private readonly localKey: Buffer;
	private readonly host: string;
	private readonly onDps: (dps: Record<string, unknown>) => void;
	private readonly onConnectionChange?: (connected: boolean) => void;
	private readonly onVersionVerified?: (version: TuyaLanVersion) => void;
	private readonly connectSocket: (port: number, host: string) => net.Socket;

	private version: TuyaLanVersion;
	private readonly versions: TuyaLanVersion[];
	private running = false;
	private state: SessionState = 'idle';
	private socket: net.Socket | null = null;
	private buffer: Buffer = Buffer.alloc(0);
	private seqno = 1;
	private localNonce: Buffer | null = null;
	private sessionKey: Buffer | null = null;
	private lastReceivedAt = 0;
	/** Whether a frame has been read on the current connection. */
	private sessionVerified = false;

	private consecutiveFailures = 0;
	private consecutivePayloadErrors = 0;
	private consecutiveHandshakeFailures = 0;
	/** Version switches since the last readable frame; as many as there are versions mean they all failed. */
	private versionSwitches = 0;

	private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
	private handshakeTimer: ReturnType<typeof setTimeout> | null = null;
	private heartbeatTimer: ReturnType<typeof setInterval> | null = null;

	public constructor(options: TuyaLanSessionOptions) {
		this.logger = options.logger;
		this.deviceId = options.deviceId;
		this.localKey = Buffer.from(options.localKey, 'latin1');
		this.host = options.host;
		this.version = options.version;
		this.versions = fallbackOrder(options.version);
		this.onDps = options.onDps;
		this.onConnectionChange = options.onConnectionChange;
		this.onVersionVerified = options.onVersionVerified;
		this.connectSocket = options.connect ?? ((port, host): net.Socket => net.connect({ port, host }));
	}

	/** Connects and keeps reconnecting until stop(). Never throws. */
	public start(): void {
		if (this.running) {
			return;
		}
		if (this.localKey.length !== 16) {
			this.logger.error(new Error(`Local key has ${this.localKey.length} bytes instead of 16; not connecting`));
			return;
		}
		this.running = true;
		this.consecutiveFailures = 0;
		this.consecutiveHandshakeFailures = 0;
		this.connect();
	}

	/**
	 * Closes the socket and clears every timer. Safe to call twice. Does not
	 * call `onConnectionChange`: the caller asked for the session to end.
	 */
	public stop(): void {
		this.running = false;
		this.clearReconnectTimer();
		this.teardownSocket();
		this.state = 'idle';
	}

	public isConnected(): boolean {
		return this.state === 'connected';
	}

	private connect(): void {
		this.reconnectTimer = null;
		if (!this.running) {
			return;
		}

		this.state = 'connecting';
		this.buffer = Buffer.alloc(0);
		this.seqno = 1;
		this.localNonce = null;
		this.sessionKey = null;
		this.consecutivePayloadErrors = 0;
		this.sessionVerified = false;

		let socket: net.Socket;
		try {
			socket = this.connectSocket(TUYA_PORT, this.host);
		} catch (error) {
			this.handleFailure(`could not open a socket (${describe(error)})`);
			return;
		}
		this.socket = socket;

		socket.on('connect', () => {
			if (this.socket === socket) this.onSocketConnected();
		});
		socket.on('data', (chunk: Buffer) => {
			if (this.socket === socket) this.onSocketData(chunk);
		});
		// The error listener stays attached after teardown so a late error on a
		// discarded socket can never become an uncaught exception.
		socket.on('error', (error: Error) => {
			if (this.socket === socket) this.handleFailure(`socket error (${describe(error)})`);
		});
		socket.on('close', () => {
			if (this.socket === socket) this.handleFailure('socket closed by the camera');
		});

		this.handshakeTimer = setTimeout(() => {
			this.handshakeTimer = null;
			this.handleFailure(this.state === 'negotiating' ? 'session key negotiation timed out' : 'connection timed out');
		}, HANDSHAKE_TIMEOUT_MS);
	}

	private onSocketConnected(): void {
		if (this.version === '3.3') {
			this.markConnected();
			return;
		}
		this.state = 'negotiating';
		this.localNonce = randomBytes(16);
		const encode = this.version === '3.4' ? encodeCommand34 : encodeCommand35;
		this.send(encode(this.nextSeqno(), tuyaCommand.sessKeyNegStart, this.localNonce, this.localKey));
	}

	private onSocketData(chunk: Buffer): void {
		this.lastReceivedAt = Date.now();
		this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);

		const { frames, rest } = splitFrames(this.buffer);
		this.buffer = Buffer.from(rest);

		for (const frame of frames) {
			// A frame can end the session (or the caller can stop it from onDps).
			if (this.state !== 'negotiating' && this.state !== 'connected') {
				return;
			}
			if (this.state === 'negotiating') {
				this.handleNegotiationFrame(frame);
			} else {
				this.handleSessionFrame(frame);
			}
		}

		if (this.buffer.length > MAX_BUFFERED_BYTES && this.socket) {
			this.buffer = Buffer.alloc(0);
			this.handleFailure('stream out of sync, no complete frame received');
		}
	}

	/**
	 * Step 2 of the 3.4/3.5 negotiation. The camera answers with its nonce and
	 * an HMAC of ours, which proves it holds the same localKey; we answer with an
	 * HMAC of its nonce and both sides derive the session key. On 3.4 the
	 * messages are ECB-encrypted in HMAC-checked 55AA frames, on 3.5 they are GCM.
	 */
	private handleNegotiationFrame(frame: Buffer): void {
		const localNonce = this.localNonce;
		if (!localNonce) {
			return;
		}
		let remoteNonce: Buffer;
		try {
			const is34 = this.version === '3.4';
			const decoded = decodeFrame(frame, {
				key: this.localKey,
				hmacKey: is34 ? this.localKey : undefined,
				hasRetcode: true,
			});
			if (decoded.cmd !== tuyaCommand.sessKeyNegResp) {
				throw new Error(`expected command ${tuyaCommand.sessKeyNegResp}, got ${decoded.cmd}`);
			}
			const payload = is34 ? decryptEcb(this.localKey, decoded.payload) : decoded.payload;
			if (payload.length < 48) {
				throw new Error('response too short');
			}
			if (!hmacSha256(this.localKey, localNonce).equals(payload.subarray(16, 48))) {
				throw new Error('HMAC check failed, the local key may be wrong');
			}
			remoteNonce = Buffer.from(payload.subarray(0, 16));
		} catch (error) {
			this.handleFailure(`session key negotiation failed (${describe(error)})`);
			return;
		}

		const is34 = this.version === '3.4';
		const encode = is34 ? encodeCommand34 : encodeCommand35;
		this.send(
			encode(this.nextSeqno(), tuyaCommand.sessKeyNegFinish, hmacSha256(this.localKey, remoteNonce), this.localKey),
		);
		this.sessionKey = (is34 ? deriveSessionKey34 : deriveSessionKey)(this.localKey, localNonce, remoteNonce);
		this.markConnected();
	}

	private handleSessionFrame(frame: Buffer): void {
		let dps: Record<string, unknown> | null;
		try {
			const is34 = this.version === '3.4' && this.sessionKey !== null;
			const decoded = decodeFrame(frame, {
				key: this.sessionKey ?? this.localKey,
				hmacKey: is34 ? this.sessionKey! : undefined,
			});
			dps = extractDps(decodePayload(decoded, is34 ? this.sessionKey! : this.localKey));
		} catch (error) {
			this.consecutivePayloadErrors++;
			if (this.consecutivePayloadErrors >= MAX_PAYLOAD_ERRORS) {
				this.handleFailure(`${this.consecutivePayloadErrors} unreadable frames in a row (${describe(error)})`);
			} else {
				this.logger.log(`Ignoring a frame that could not be read (${describe(error)})`);
			}
			return;
		}

		// A readable frame means the connection is healthy and, on 3.4 and 3.5, that
		// both sides derived the same session key.
		this.consecutivePayloadErrors = 0;
		this.consecutiveFailures = 0;
		this.consecutiveHandshakeFailures = 0;
		this.versionSwitches = 0;
		if (!this.sessionVerified) {
			this.sessionVerified = true;
			try {
				this.onVersionVerified?.(this.version);
			} catch (error) {
				this.logger.error(error);
			}
		}

		if (dps && Object.keys(dps).length > 0) {
			try {
				this.onDps(dps);
			} catch (error) {
				this.logger.error(error);
			}
		}
	}

	private markConnected(): void {
		this.clearHandshakeTimer();
		this.state = 'connected';
		this.lastReceivedAt = Date.now();
		this.logger.log(`Connected to ${this.host} with protocol ${this.version}`);
		this.heartbeatTimer = setInterval(() => this.onHeartbeatTick(), HEARTBEAT_INTERVAL_MS);
		this.notifyConnectionChange(true);
	}

	private onHeartbeatTick(): void {
		if (Date.now() - this.lastReceivedAt > DATA_TIMEOUT_MS) {
			this.handleFailure(`nothing received for ${DATA_TIMEOUT_MS / 1000} s`);
			return;
		}
		const body = heartbeatBody(this.deviceId);
		const seqno = this.nextSeqno();
		const sessionKey = this.sessionKey;
		this.send(
			!sessionKey
				? encodeCommand33(seqno, tuyaCommand.heartBeat, body, this.localKey)
				: this.version === '3.4'
					? encodeCommand34(seqno, tuyaCommand.heartBeat, body, sessionKey)
					: encodeCommand35(seqno, tuyaCommand.heartBeat, body, sessionKey),
		);
	}

	/**
	 * Ends the current attempt and schedules the next. Each call corresponds to
	 * one lost connection or failed attempt, guarded by the socket check in the
	 * listeners so a single drop is never counted twice.
	 *
	 * A drop before any frame could be read counts as a failed attempt on the
	 * version: on 3.4/3.5 a camera that accepts the handshake but derives
	 * another session key produces only unreadable frames, on 3.3 a camera that
	 * speaks another version hangs up on the first heartbeat. After two such
	 * attempts the next version is tried (see `fallbackOrder`). A refused TCP
	 * connection says nothing about the protocol and does not count.
	 */
	private handleFailure(reason: string): void {
		if (!this.running) {
			return;
		}
		const wasConnected = this.state === 'connected';
		// A drop before anything readable came back says the version may be wrong: on 3.4/3.5 a failed negotiation, on
		// 3.3 a camera that hangs up on the first heartbeat because it speaks another version.
		const negotiationFailed =
			this.version === '3.3'
				? wasConnected && !this.sessionVerified
				: this.state === 'negotiating' || (wasConnected && !this.sessionVerified);
		this.teardownSocket();

		this.logger.log(wasConnected ? `Disconnected: ${reason}` : `Connection attempt failed: ${reason}`);

		if (negotiationFailed) {
			this.consecutiveHandshakeFailures++;
			if (this.consecutiveHandshakeFailures >= MAX_HANDSHAKE_FAILURES) {
				const failed = this.version;
				this.version = this.versions[(this.versions.indexOf(failed) + 1) % this.versions.length];
				this.logger.log(
					`Protocol ${failed} failed ${this.consecutiveHandshakeFailures} times in a row; ${this.version === '3.3' ? 'falling back to' : 'trying'} ${this.version}`,
				);
				this.consecutiveHandshakeFailures = 0;
				this.versionSwitches++;
			}
		}

		this.consecutiveFailures++;
		let delay = this.consecutiveFailures <= 1 ? 0 : RECONNECT_DELAY_MS;
		if (this.versionSwitches >= this.versions.length) {
			delay = UNSUPPORTED_RETRY_DELAY_MS;
			this.versionSwitches = 0;
			this.logger.log(
				`None of protocols ${this.versions.join(', ')} works with this camera; trying again in 10 minutes`,
			);
		}
		this.state = 'waiting';
		this.reconnectTimer = setTimeout(() => this.connect(), delay);

		if (wasConnected) {
			this.notifyConnectionChange(false);
		}
	}

	private send(frame: Buffer): void {
		const socket = this.socket;
		if (!socket || socket.destroyed) {
			return;
		}
		// Write failures also surface as an 'error' event, which drives the reconnect.
		socket.write(frame);
	}

	private nextSeqno(): number {
		return this.seqno++;
	}

	private teardownSocket(): void {
		this.clearHandshakeTimer();
		if (this.heartbeatTimer) {
			clearInterval(this.heartbeatTimer);
			this.heartbeatTimer = null;
		}
		const socket = this.socket;
		this.socket = null;
		this.buffer = Buffer.alloc(0);
		this.sessionKey = null;
		this.localNonce = null;
		if (socket) {
			socket.destroy();
		}
	}

	private clearHandshakeTimer(): void {
		if (this.handshakeTimer) {
			clearTimeout(this.handshakeTimer);
			this.handshakeTimer = null;
		}
	}

	private clearReconnectTimer(): void {
		if (this.reconnectTimer) {
			clearTimeout(this.reconnectTimer);
			this.reconnectTimer = null;
		}
	}

	private notifyConnectionChange(connected: boolean): void {
		try {
			this.onConnectionChange?.(connected);
		} catch (error) {
			this.logger.error(error);
		}
	}
}

function describe(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
