import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Pure helpers for the Tuya LAN protocol on TCP 6668 and the UDP discovery
 * broadcasts on 6666/6667. Only the versions the monitors speak are covered:
 * 3.3 (0x55AA framing, AES-128-ECB with the localKey, CRC32), 3.4 (0x55AA
 * framing with an HMAC-SHA256 instead of the CRC, AES-128-ECB with a
 * negotiated session key; an SCD951 announces it) and 3.5 (0x6699 framing,
 * AES-128-GCM with a negotiated session key). Byte layouts follow tinytuya's
 * `message_helper.py` and `XenonDevice.py`; the 3.3 and 3.5 ones are checked
 * against vectors generated with tinytuya in the tests.
 *
 * Nothing here touches a socket or a timer, so every function can be tested
 * with plain buffers.
 */

export type TuyaLanVersion = '3.3' | '3.4' | '3.5';

export type TuyaFrameFormat = '55aa' | '6699';

/** Command numbers used on the wire (tinytuya `command_types.py`). */
export const tuyaCommand = {
	sessKeyNegStart: 3,
	sessKeyNegResp: 4,
	sessKeyNegFinish: 5,
	control: 7,
	status: 8,
	heartBeat: 9,
	dpQuery: 10,
	controlNew: 13,
	dpQueryNew: 16,
	updateDps: 18,
} as const;

const PREFIX_55AA = 0x000055aa;
const SUFFIX_55AA = 0x0000aa55;
const PREFIX_6699 = 0x00006699;
const SUFFIX_6699 = 0x00009966;
const PREFIX_55AA_BYTES = Buffer.from([0x00, 0x00, 0x55, 0xaa]);
const PREFIX_6699_BYTES = Buffer.from([0x00, 0x00, 0x66, 0x99]);
const HEADER_LENGTH_55AA = 16;
const HEADER_LENGTH_6699 = 18;
const HMAC_LENGTH = 32;
const GCM_IV_LENGTH = 12;
const GCM_TAG_LENGTH = 16;
const VERSION_HEADER_LENGTH = 15;
/**
 * Commands that never carry the 15-byte "3.x" version header, mirroring
 * tinytuya's `NO_PROTOCOL_HEADER_CMDS`.
 */
const NO_VERSION_HEADER_COMMANDS: ReadonlySet<number> = new Set([
	tuyaCommand.dpQuery,
	tuyaCommand.dpQueryNew,
	tuyaCommand.updateDps,
	tuyaCommand.heartBeat,
	tuyaCommand.sessKeyNegStart,
	tuyaCommand.sessKeyNegResp,
	tuyaCommand.sessKeyNegFinish,
	64, // LAN_EXT_STREAM
]);

/**
 * Upper bound on the length a header may claim. tinytuya uses 1440, but the
 * camera's IPC_LAN_302 signalling frames are larger than that, and dropping
 * them would desync the stream. Anything past 64 KiB is treated as corrupt.
 */
export const maxFrameLength = 0x10000;

/** Key used to encrypt discovery broadcasts: md5('yGAdlopoPVldABfn'). */
export const udpKey: Buffer = createHash('md5').update('yGAdlopoPVldABfn').digest();

/** Raised for any frame or payload that cannot be read. */
export class TuyaProtocolError extends Error {
	public constructor(message: string) {
		super(message);
		this.name = 'TuyaProtocolError';
	}
}

export interface DecodedFrame {
	format: TuyaFrameFormat;
	seqno: number;
	cmd: number;
	/** The 4-byte return code devices put in front of their replies, or null when absent. */
	retcode: number | null;
	/** Plaintext body for 6699 frames; for 55AA frames the body as sent (still ECB-encrypted for 3.3). */
	payload: Buffer;
}

export interface SplitFramesResult {
	/** Complete frames, each including prefix and suffix. */
	frames: Buffer[];
	/** Bytes to keep for the next chunk: a partial frame, or a possible partial prefix. */
	rest: Buffer;
	/** Bytes discarded because they did not belong to any frame. */
	discarded: number;
}

// --- CRC32 -------------------------------------------------------------------

const crcTable: Uint32Array = ((): Uint32Array => {
	const table = new Uint32Array(256);
	for (let n = 0; n < 256; n++) {
		let c = n;
		for (let k = 0; k < 8; k++) {
			c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
		}
		table[n] = c >>> 0;
	}
	return table;
})();

/** Standard CRC-32 (IEEE 802.3), as Python's `binascii.crc32`. */
export function crc32(data: Uint8Array): number {
	let crc = 0xffffffff;
	for (const byte of data) {
		crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
	}
	return (crc ^ 0xffffffff) >>> 0;
}

// --- AES helpers ---------------------------------------------------------------

/** AES-128-ECB with PKCS#7 padding, as tinytuya's `AESCipher.encrypt(pad=True)`. */
export function encryptEcb(key: Buffer, data: Buffer): Buffer {
	const cipher = createCipheriv('aes-128-ecb', key, null);
	return Buffer.concat([cipher.update(data), cipher.final()]);
}

/**
 * AES-128-ECB decryption. Padding is stripped leniently, like tinytuya with
 * `verify_padding=False`: only the final byte is checked for a sane length.
 */
export function decryptEcb(key: Buffer, data: Buffer): Buffer {
	if (data.length === 0 || data.length % 16 !== 0) {
		throw new TuyaProtocolError(`ECB ciphertext length ${data.length} is not a multiple of 16`);
	}
	const decipher = createDecipheriv('aes-128-ecb', key, null);
	decipher.setAutoPadding(false);
	const plain = Buffer.concat([decipher.update(data), decipher.final()]);
	const padLength = plain[plain.length - 1];
	if (padLength < 1 || padLength > 16) {
		throw new TuyaProtocolError('Invalid ECB padding');
	}
	return plain.subarray(0, plain.length - padLength);
}

export interface GcmResult {
	ciphertext: Buffer;
	tag: Buffer;
}

export function encryptGcm(key: Buffer, iv: Buffer, plaintext: Buffer, aad?: Buffer): GcmResult {
	const cipher = createCipheriv('aes-128-gcm', key, iv);
	if (aad) {
		cipher.setAAD(aad);
	}
	const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
	return { ciphertext, tag: cipher.getAuthTag() };
}

/** Throws when the tag does not authenticate, which is how a wrong key shows up. */
export function decryptGcm(key: Buffer, iv: Buffer, ciphertext: Buffer, tag: Buffer, aad?: Buffer): Buffer {
	const decipher = createDecipheriv('aes-128-gcm', key, iv);
	if (aad) {
		decipher.setAAD(aad);
	}
	decipher.setAuthTag(tag);
	try {
		return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
	} catch {
		throw new TuyaProtocolError('GCM authentication failed');
	}
}

export function hmacSha256(key: Buffer, data: Buffer): Buffer {
	return createHmac('sha256', key).update(data).digest();
}

/**
 * Session key for protocol 3.5: the XOR of both nonces, GCM-encrypted with the
 * localKey and the first 12 bytes of the local nonce as IV. tinytuya keeps
 * bytes [12:28] of `iv + ciphertext + tag`, which is exactly the ciphertext.
 */
export function deriveSessionKey(localKey: Buffer, localNonce: Buffer, remoteNonce: Buffer): Buffer {
	if (localNonce.length < 16 || remoteNonce.length < 16) {
		throw new TuyaProtocolError('Session nonces must be 16 bytes');
	}
	const mixed = Buffer.alloc(16);
	for (let i = 0; i < 16; i++) {
		mixed[i] = localNonce[i] ^ remoteNonce[i];
	}
	return encryptGcm(localKey, localNonce.subarray(0, GCM_IV_LENGTH), mixed).ciphertext;
}

/**
 * Session key for protocol 3.4: the XOR of both nonces, ECB-encrypted with the localKey without padding (tinytuya's
 * `_negotiate_session_key_generate_finalize`). One block, so it is the first block of the padded encryption.
 */
export function deriveSessionKey34(localKey: Buffer, localNonce: Buffer, remoteNonce: Buffer): Buffer {
	if (localNonce.length < 16 || remoteNonce.length < 16) {
		throw new TuyaProtocolError('Session nonces must be 16 bytes');
	}
	const mixed = Buffer.alloc(16);
	for (let i = 0; i < 16; i++) {
		mixed[i] = localNonce[i] ^ remoteNonce[i];
	}
	return encryptEcb(localKey, mixed).subarray(0, 16);
}

// --- Framing -------------------------------------------------------------------

/**
 * Builds a 55AA frame. The CRC covers header and payload; with an `hmacKey` (protocol 3.4) a 32-byte HMAC-SHA256 of
 * the same bytes takes its place. A retcode is only included when given, since devices send one and apps do not.
 */
export function encodeFrame55aa(
	seqno: number,
	cmd: number,
	payload: Buffer,
	retcode?: number,
	hmacKey?: Buffer,
): Buffer {
	const body = retcode === undefined ? payload : Buffer.concat([uint32(retcode), payload]);
	const checkLength = hmacKey ? HMAC_LENGTH : 4;
	const header = Buffer.alloc(HEADER_LENGTH_55AA);
	header.writeUInt32BE(PREFIX_55AA, 0);
	header.writeUInt32BE(seqno >>> 0, 4);
	header.writeUInt32BE(cmd, 8);
	header.writeUInt32BE(body.length + checkLength + 4, 12);
	const data = Buffer.concat([header, body]);
	const check = hmacKey ? hmacSha256(hmacKey, data) : uint32(crc32(data));
	return Buffer.concat([data, check, uint32(SUFFIX_55AA)]);
}

/**
 * Builds a 6699 frame: header, 12-byte IV, GCM ciphertext, 16-byte tag, suffix.
 * The GCM additional data is the header without its prefix (bytes 4..18).
 */
export function encodeFrame6699(
	seqno: number,
	cmd: number,
	payload: Buffer,
	key: Buffer,
	iv: Buffer = randomBytes(GCM_IV_LENGTH),
	retcode?: number,
): Buffer {
	if (iv.length !== GCM_IV_LENGTH) {
		throw new TuyaProtocolError('GCM IV must be 12 bytes');
	}
	const plaintext = retcode === undefined ? payload : Buffer.concat([uint32(retcode), payload]);
	const header = Buffer.alloc(HEADER_LENGTH_6699);
	header.writeUInt32BE(PREFIX_6699, 0);
	header.writeUInt16BE(0, 4);
	header.writeUInt32BE(seqno >>> 0, 6);
	header.writeUInt32BE(cmd, 10);
	header.writeUInt32BE(GCM_IV_LENGTH + plaintext.length + GCM_TAG_LENGTH, 14);
	const { ciphertext, tag } = encryptGcm(key, iv, plaintext, header.subarray(4));
	return Buffer.concat([header, iv, ciphertext, tag, uint32(SUFFIX_6699)]);
}

/**
 * Cuts a TCP byte stream into complete frames. Partial frames are returned in
 * `rest` to be prepended to the next chunk. Bytes before a recognised prefix,
 * and headers claiming an implausible length, are skipped so a desynced stream
 * recovers at the next frame instead of stalling.
 */
export function splitFrames(buffer: Buffer): SplitFramesResult {
	const frames: Buffer[] = [];
	let discarded = 0;
	let pos = 0;

	while (pos < buffer.length) {
		const start = findPrefix(buffer, pos);
		if (start < 0) {
			// Keep the last three bytes: they may be the start of a prefix.
			const keepFrom = Math.max(pos, buffer.length - 3);
			discarded += keepFrom - pos;
			return { frames, rest: buffer.subarray(keepFrom), discarded };
		}
		discarded += start - pos;
		pos = start;

		const is6699 = buffer.readUInt32BE(pos) === PREFIX_6699;
		const headerLength = is6699 ? HEADER_LENGTH_6699 : HEADER_LENGTH_55AA;
		if (buffer.length - pos < headerLength) {
			break;
		}
		const length = buffer.readUInt32BE(pos + headerLength - 4);
		const minimum = is6699 ? GCM_IV_LENGTH + GCM_TAG_LENGTH : 8;
		if (length < minimum || length > maxFrameLength) {
			// Not a real header: skip this prefix and look for the next one.
			discarded += 4;
			pos += 4;
			continue;
		}
		const total = headerLength + length + (is6699 ? 4 : 0);
		if (buffer.length - pos < total) {
			break;
		}
		frames.push(buffer.subarray(pos, pos + total));
		pos += total;
	}

	return { frames, rest: buffer.subarray(pos), discarded };
}

export interface DecodeFrameOptions {
	/** Required for 6699 frames: the localKey during negotiation, the session key after. */
	key?: Buffer;
	/**
	 * For 55AA frames on protocol 3.4: the key their HMAC-SHA256 trailer is checked with (the localKey during
	 * negotiation, the session key after). Without it the trailer is a CRC32.
	 */
	hmacKey?: Buffer;
	/**
	 * Whether a 4-byte return code precedes the payload. Devices add one to
	 * their frames and apps do not, but not every device frame is consistent,
	 * so the default detects it: a word whose top three bytes are zero cannot
	 * be the start of JSON, a "3.x" version header or (realistically) ciphertext.
	 */
	hasRetcode?: boolean;
}

/** Validates and unwraps a single complete frame from {@link splitFrames}. */
export function decodeFrame(frame: Buffer, options: DecodeFrameOptions = {}): DecodedFrame {
	if (frame.length < 4) {
		throw new TuyaProtocolError('Frame too short');
	}
	const prefix = frame.readUInt32BE(0);
	if (prefix === PREFIX_55AA) {
		return decodeFrame55aa(frame, options.hasRetcode, options.hmacKey);
	}
	if (prefix === PREFIX_6699) {
		if (!options.key) {
			throw new TuyaProtocolError('A key is required to decode a 6699 frame');
		}
		return decodeFrame6699(frame, options.key, options.hasRetcode);
	}
	throw new TuyaProtocolError(`Unknown frame prefix 0x${prefix.toString(16).padStart(8, '0')}`);
}

function decodeFrame55aa(frame: Buffer, hasRetcode: boolean | undefined, hmacKey: Buffer | undefined): DecodedFrame {
	const checkLength = hmacKey ? HMAC_LENGTH : 4;
	if (frame.length < HEADER_LENGTH_55AA + checkLength + 4) {
		throw new TuyaProtocolError('55AA frame too short');
	}
	const seqno = frame.readUInt32BE(4);
	const cmd = frame.readUInt32BE(8);
	const length = frame.readUInt32BE(12);
	if (frame.length !== HEADER_LENGTH_55AA + length) {
		throw new TuyaProtocolError('55AA frame length does not match its header');
	}
	const crcOffset = frame.length - 4 - checkLength;
	if (hmacKey) {
		const expected = hmacSha256(hmacKey, frame.subarray(0, crcOffset));
		if (!timingSafeEqual(expected, frame.subarray(crcOffset, crcOffset + HMAC_LENGTH))) {
			throw new TuyaProtocolError('55AA frame HMAC mismatch');
		}
	} else if (crc32(frame.subarray(0, crcOffset)) !== frame.readUInt32BE(crcOffset)) {
		throw new TuyaProtocolError('55AA frame CRC mismatch');
	}
	if (frame.readUInt32BE(frame.length - 4) !== SUFFIX_55AA) {
		throw new TuyaProtocolError('55AA frame suffix mismatch');
	}
	const { retcode, payload } = splitRetcode(frame.subarray(HEADER_LENGTH_55AA, crcOffset), hasRetcode);
	return { format: '55aa', seqno, cmd, retcode, payload };
}

function decodeFrame6699(frame: Buffer, key: Buffer, hasRetcode: boolean | undefined): DecodedFrame {
	if (frame.length < HEADER_LENGTH_6699 + GCM_IV_LENGTH + GCM_TAG_LENGTH + 4) {
		throw new TuyaProtocolError('6699 frame too short');
	}
	const seqno = frame.readUInt32BE(6);
	const cmd = frame.readUInt32BE(10);
	const length = frame.readUInt32BE(14);
	if (frame.length !== HEADER_LENGTH_6699 + length + 4) {
		throw new TuyaProtocolError('6699 frame length does not match its header');
	}
	if (frame.readUInt32BE(frame.length - 4) !== SUFFIX_6699) {
		throw new TuyaProtocolError('6699 frame suffix mismatch');
	}
	const ivStart = HEADER_LENGTH_6699;
	const tagStart = frame.length - 4 - GCM_TAG_LENGTH;
	const plaintext = decryptGcm(
		key,
		frame.subarray(ivStart, ivStart + GCM_IV_LENGTH),
		frame.subarray(ivStart + GCM_IV_LENGTH, tagStart),
		frame.subarray(tagStart, tagStart + GCM_TAG_LENGTH),
		frame.subarray(4, HEADER_LENGTH_6699),
	);
	const { retcode, payload } = splitRetcode(plaintext, hasRetcode);
	return { format: '6699', seqno, cmd, retcode, payload };
}

function splitRetcode(body: Buffer, hasRetcode: boolean | undefined): { retcode: number | null; payload: Buffer } {
	const present = hasRetcode ?? (body.length >= 4 && (body.readUInt32BE(0) & 0xffffff00) === 0);
	if (!present) {
		return { retcode: null, payload: body };
	}
	if (body.length < 4) {
		throw new TuyaProtocolError('Frame too short for a return code');
	}
	return { retcode: body.readUInt32BE(0), payload: body.subarray(4) };
}

// --- Payloads ------------------------------------------------------------------

/** "3.1" through "3.5", the start of a 15-byte version header. */
function hasVersionHeader(payload: Buffer): boolean {
	return (
		payload.length >= VERSION_HEADER_LENGTH &&
		payload[0] === 0x33 && // '3'
		payload[1] === 0x2e && // '.'
		payload[2] >= 0x31 &&
		payload[2] <= 0x35
	);
}

function stripVersionHeader(payload: Buffer): Buffer {
	return hasVersionHeader(payload) ? payload.subarray(VERSION_HEADER_LENGTH) : payload;
}

function parseJson(data: Buffer): unknown {
	// Some firmware pads with NUL bytes after the JSON.
	let end = data.length;
	while (end > 0 && data[end - 1] === 0) {
		end--;
	}
	const text = data.subarray(0, end).toString('utf8');
	try {
		return JSON.parse(text) as unknown;
	} catch {
		throw new TuyaProtocolError('Payload is not valid JSON');
	}
}

/**
 * Turns the payload of a decoded frame into JSON, or null when the frame has
 * no body (heartbeat acks and other bare replies). For 55AA frames the body is
 * ECB-encrypted unless it is already plain JSON: with the localKey on 3.3, with
 * the session key on 3.4 (pass that as `key`; the version header is inside the
 * encryption there). A "3.x" version header is dropped whatever version it
 * names, because the camera has been seen sending "3.5" headers to a session
 * negotiated at 3.3.
 */
export function decodePayload(frame: DecodedFrame, key: Buffer): unknown {
	let data = stripVersionHeader(frame.payload);
	if (data.length === 0) {
		return null;
	}
	if (frame.format === '55aa' && data[0] !== 0x7b /* '{' */) {
		data = stripVersionHeader(decryptEcb(key, data));
		if (data.length === 0) {
			return null;
		}
	}
	return parseJson(data);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Finds the DPS object in a decoded payload: `{"dps":{...}}` on 3.3, and
 * `{"protocol":4,"data":{"dps":{...}}}` on 3.5.
 */
export function extractDps(json: unknown): Record<string, unknown> | null {
	if (!isRecord(json)) {
		return null;
	}
	if (isRecord(json.dps)) {
		return json.dps;
	}
	if (isRecord(json.data) && isRecord(json.data.dps)) {
		return json.data.dps;
	}
	return null;
}

// --- Messages the app sends ----------------------------------------------------------

/**
 * Builds a 3.3 command frame: JSON body ECB-encrypted with the localKey, with
 * the version header in front for commands that carry one.
 */
export function encodeCommand33(seqno: number, cmd: number, body: Buffer, localKey: Buffer): Buffer {
	let payload = encryptEcb(localKey, body);
	if (!NO_VERSION_HEADER_COMMANDS.has(cmd)) {
		payload = Buffer.concat([versionHeader('3.3'), payload]);
	}
	return encodeFrame55aa(seqno, cmd, payload);
}

/**
 * Builds a 3.4 command frame on the given key (localKey while negotiating, session key afterwards): the version
 * header goes inside the ECB encryption, and the frame ends in an HMAC on the same key.
 */
export function encodeCommand34(seqno: number, cmd: number, body: Buffer, key: Buffer): Buffer {
	const plain = NO_VERSION_HEADER_COMMANDS.has(cmd) ? body : Buffer.concat([versionHeader('3.4'), body]);
	return encodeFrame55aa(seqno, cmd, encryptEcb(key, plain), undefined, key);
}

/** Builds a 3.5 command frame on the given key (localKey while negotiating, session key afterwards). */
export function encodeCommand35(seqno: number, cmd: number, body: Buffer, key: Buffer, iv?: Buffer): Buffer {
	const payload = NO_VERSION_HEADER_COMMANDS.has(cmd) ? body : Buffer.concat([versionHeader('3.5'), body]);
	return encodeFrame6699(seqno, cmd, payload, key, iv);
}

/** The heartbeat body tinytuya sends for a default device. */
export function heartbeatBody(deviceId: string): Buffer {
	return Buffer.from(JSON.stringify({ gwId: deviceId, devId: deviceId }), 'utf8');
}

function versionHeader(version: TuyaLanVersion): Buffer {
	return Buffer.concat([Buffer.from(version, 'latin1'), Buffer.alloc(12)]);
}

function uint32(value: number): Buffer {
	const buffer = Buffer.alloc(4);
	buffer.writeUInt32BE(value >>> 0, 0);
	return buffer;
}

function findPrefix(buffer: Buffer, from: number): number {
	const a = buffer.indexOf(PREFIX_55AA_BYTES, from);
	const b = buffer.indexOf(PREFIX_6699_BYTES, from);
	if (a < 0) return b;
	if (b < 0) return a;
	return Math.min(a, b);
}

// --- Discovery -----------------------------------------------------------------

/**
 * Decodes a UDP discovery broadcast into its JSON object, or null when it is
 * not one. Handles the three forms tinytuya's `decrypt_udp` does: plain JSON in
 * a 55AA frame (6666, protocol 3.1), ECB with {@link udpKey} in a 55AA frame
 * (6667, 3.3) and GCM with {@link udpKey} in a 6699 frame (6667, 3.5). A bare
 * ECB blob without framing is accepted too.
 */
export function decodeBroadcast(message: Buffer): Record<string, unknown> | null {
	try {
		const json = decodeBroadcastJson(message);
		return isRecord(json) ? json : null;
	} catch {
		return null;
	}
}

function decodeBroadcastJson(message: Buffer): unknown {
	if (message.length < 4) {
		return null;
	}
	const prefix = message.readUInt32BE(0);
	if (prefix === PREFIX_6699) {
		const frame = decodeFrame(message, { key: udpKey });
		return parseJson(frame.payload);
	}
	if (prefix === PREFIX_55AA) {
		const frame = decodeFrame(message);
		const body = frame.payload;
		if (body[0] === 0x7b /* '{' */) {
			return parseJson(body);
		}
		return parseJson(decryptEcb(udpKey, body));
	}
	return parseJson(decryptEcb(udpKey, message));
}

/**
 * Maps the `version` announced in a broadcast to a session version: "3.4" and "3.5" select themselves, anything else
 * (including a missing field) uses 3.3.
 */
export function parseAnnouncedVersion(value: unknown): TuyaLanVersion {
	const text = typeof value === 'number' ? value.toFixed(1) : typeof value === 'string' ? value.trim() : '';
	return text === '3.5' || text === '3.4' ? text : '3.3';
}
