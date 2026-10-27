/* eslint-disable @typescript-eslint/naming-convention -- DPS ids are numeric object keys */
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
	crc32,
	decodeBroadcast,
	decodeFrame,
	decodePayload,
	decryptEcb,
	deriveSessionKey,
	deriveSessionKey34,
	encodeCommand33,
	encodeCommand34,
	encodeCommand35,
	encodeFrame55aa,
	encodeFrame6699,
	encryptEcb,
	extractDps,
	heartbeatBody,
	hmacSha256,
	parseAnnouncedVersion,
	splitFrames,
	tuyaCommand,
	TuyaProtocolError,
	udpKey,
} from '../../utils/tuya-lan-protocol.mjs';

/**
 * Frames produced by tinytuya 1.20.0 (pack_message / Device._encode_message /
 * the session key negotiation) with the key, device id, nonces and IV below,
 * and checked to decode with tinytuya's own unpack_message/_decode_payload.
 * Encoders here must reproduce them byte for byte.
 */
const tinytuya = {
	localKey: Buffer.from('0123456789abcdef', 'latin1'),
	deviceId: 'bf1234567890abcdefgh',
	iv: Buffer.from('404142434445464748494a4b', 'hex'),
	localNonce: Buffer.from('101112131415161718191a1b1c1d1e1f', 'hex'),
	remoteNonce: Buffer.from('a0a1a2a3a4a5a6a7a8a9aaabacadaeaf', 'hex'),
	sessionKey: '2179df88b4173621da9ba82cc559011a',
	v33Heartbeat:
		'000055aa00000001000000090000004805008afd0d6b71c01e3489f2007668ce66b6ebab24ddd1c10aec0d538811f254eed06a13ec5bfb4813c07e843aacad8c2c6f7c6e3917dc76909ae10a4999a2b7871cd50f0000aa55',
	// Camera STATUS without retcode: "3.3" header + ECB(JSON).
	v33Status:
		'000055aa000000070000000800000057332e33000000000000000000000000861c4d31957fc6c80b8624c66a56e73d331de4d4dccf3f7862e6e71a20f7b14f3ddc324e8ef2e0181ad58b21bb0336c50a35860627ed1a0a3cf3574ac0322a602e0347a70000aa55',
	// Camera STATUS with retcode and no version header.
	v33StatusWithRetcode:
		'000055aa00000008000000080000003c00000000f94f0b9fb449c5903a8564629992b36578c3795cb0ac257ce8da75a31f07c57c377222e061a924c591cd9c27ea163ed430a5d8870000aa55',
	// Camera STATUS with retcode and "3.3" header, the form tinytuya expects.
	v33StatusWithRetcodeAndHeader:
		'000055aa00000009000000080000004b00000000332e330000000000000000000000005b3c5761944342abe535658f8ede351cb09ca19273022c307af713ec0fc5f42f617ecebd4e82a3886691418a946d6766c14fae140000aa55',
	v35SessStart:
		'00006699000000000001000000030000002c404142434445464748494a4b4a95d4ef74b64c0a30755206df3375048998d8a8409c079946bce2c3122224c600009966',
	v35SessResp:
		'000066990000000000640000000400000050404142434445464748494a4b5a84c6fcc002f8be8cc9eeba6b87c1b00c662ca97fe561080d7f79a735f0954fb0e29ddd530392c73e1288be05e916e9a393cb70b73ccd374a17c5fadffa5c4b36f08e2900009966',
	v35SessFinish:
		'00006699000000000002000000050000003c404142434445464748494a4b1735fff03c80c71585c9e4cfc8861001b88a7ded6e13f8256745de882e5a839eedaf1a655c9a8ca60191d53f65cc8d6200009966',
	v35Heartbeat:
		'00006699000000000003000000090000005a404142434445464748494a4b075473f27db63db1c43d1487fa6b3b6f4d058df0acc173e9195531a3d02c1b442f0ad6733a1bd7a88ac511a1a24d75d18f5d918bf53b961ccedc670c30cab3082ceaf2b674f24e3722c85cacd81f00009966',
	// Camera STATUS on the session key: retcode + "3.5" header + protocol 4 JSON.
	v35Status:
		'000066990000000000650000000800000072404142434445464748494a4b7c76148507fc2a8be65f72b6c8580f5a7b32b5b2bed063e5095f34abd42c0d52674dd4186408dabad89310a3a14970cb9a01c9cff57bcf0389de7017308de7d12987d4770079715c1aff09521ace996bb6e1e4660fc4778ebd4b282690ddee0888a5c248193600009966',
	udp31:
		'000055aa00000000000000130000004d000000007b226970223a223139322e302e322e3132222c2267774964223a226266313233343536373839306162636465666768222c2276657273696f6e223a22332e31227d62d800200000aa55',
	udp33:
		'000055aa00000000000000130000008c00000000cddda4297c2b7461ec80733893dbcd0dba9061aa880d75a28aa9155687682f89534b2cc2a64376729c04a512ae205f1918ca0c1babd743880b08c3cd80e660c66ba37c67c2338d7b888a78353cf5c51ced2e82450cdafed37bc9435f8d19e953538afb3325260822a49426417eb29d4449d7c04d4bd0e855432b819cbf4452f6b4f51d4d0000aa55',
	udp35:
		'000066990000000000000000002300000096404142434445464748494a4be02989911d7c4c75d2adabe9b095f3d3976210cf1811a85383627c00912e5c3af594c324c5c8cac1965af94ec8f6b88d9f4610166ef56c6bd6368964b9b3a629a2bc70b21459c067aba93ba868676508fc28ce65f85bd5e915ce8fa4c5edc5c56ca114b67f54be71ddcb5ae737e50f73f0b1425dc52f8679badcf1e9cf3ed12f431bfa93f203042d9c4400009966',
};

const hex = (value: string): Buffer => Buffer.from(value, 'hex');

describe('crc32', () => {
	it('matches the standard check value', () => {
		expect(crc32(Buffer.from('123456789'))).toBe(0xcbf43926);
	});

	it('returns zero for empty input', () => {
		expect(crc32(Buffer.alloc(0))).toBe(0);
	});
});

describe('AES helpers', () => {
	it('round-trips ECB with PKCS#7 padding', () => {
		const plain = Buffer.from('{"dps":{"1":true}}');
		const encrypted = encryptEcb(tinytuya.localKey, plain);
		expect(encrypted.length % 16).toBe(0);
		expect(decryptEcb(tinytuya.localKey, encrypted)).toEqual(plain);
	});

	it('rejects ECB ciphertext that is not a whole number of blocks', () => {
		expect(() => decryptEcb(tinytuya.localKey, Buffer.alloc(15))).toThrow(TuyaProtocolError);
	});

	it('derives the same 3.5 session key as tinytuya', () => {
		const key = deriveSessionKey(tinytuya.localKey, tinytuya.localNonce, tinytuya.remoteNonce);
		expect(key.toString('hex')).toBe(tinytuya.sessionKey);
	});

	it('uses the md5 of the well-known string as the discovery key', () => {
		expect(udpKey).toEqual(createHash('md5').update('yGAdlopoPVldABfn').digest());
		expect(udpKey.toString('hex')).toBe('6c1ec8e2bb9bb59ab50b0daf649b410a');
	});
});

describe('3.3 encoding', () => {
	it('builds a heartbeat identical to tinytuya', () => {
		const frame = encodeCommand33(1, tuyaCommand.heartBeat, heartbeatBody(tinytuya.deviceId), tinytuya.localKey);
		expect(frame.toString('hex')).toBe(tinytuya.v33Heartbeat);
	});

	it('adds the version header for commands that carry one', () => {
		const frame = encodeCommand33(4, tuyaCommand.control, Buffer.from('{}'), tinytuya.localKey);
		const decoded = decodeFrame(frame, { hasRetcode: false });
		expect(decoded.payload.subarray(0, 3).toString()).toBe('3.3');
		expect(decodePayload(decoded, tinytuya.localKey)).toEqual({});
	});

	it('round-trips a frame with a retcode', () => {
		const frame = encodeFrame55aa(42, tuyaCommand.status, Buffer.from('{"dps":{"1":1}}'), 0);
		const decoded = decodeFrame(frame);
		expect(decoded).toMatchObject({ format: '55aa', seqno: 42, cmd: tuyaCommand.status, retcode: 0 });
		expect(decoded.payload.toString()).toBe('{"dps":{"1":1}}');
	});
});

describe('3.3 decoding', () => {
	it('reads a status frame without retcode', () => {
		const decoded = decodeFrame(hex(tinytuya.v33Status));
		expect(decoded).toMatchObject({ seqno: 7, cmd: 8, retcode: null });
		const json = decodePayload(decoded, tinytuya.localKey);
		expect(json).toEqual({ dps: { '207': 2150, '250': 'motion_detection' }, t: 1700000000 });
	});

	it('reads a status frame with retcode', () => {
		const decoded = decodeFrame(hex(tinytuya.v33StatusWithRetcode));
		expect(decoded.retcode).toBe(0);
		expect(extractDps(decodePayload(decoded, tinytuya.localKey))).toEqual({ '141': 'decibel_upload' });
	});

	it('reads a status frame with retcode and version header', () => {
		const decoded = decodeFrame(hex(tinytuya.v33StatusWithRetcodeAndHeader));
		expect(extractDps(decodePayload(decoded, tinytuya.localKey))).toEqual({ '207': 1980 });
	});

	it('rejects a frame whose CRC does not match', () => {
		const frame = hex(tinytuya.v33Status);
		frame[20] ^= 0xff;
		expect(() => decodeFrame(frame)).toThrow(/CRC/);
	});

	it('fails to decrypt with the wrong key', () => {
		const decoded = decodeFrame(hex(tinytuya.v33Status));
		expect(() => decodePayload(decoded, Buffer.from('ffffffffffffffff'))).toThrow(TuyaProtocolError);
	});

	it('returns null for a bare retcode such as a heartbeat ack', () => {
		const decoded = decodeFrame(encodeFrame55aa(3, tuyaCommand.heartBeat, Buffer.alloc(0), 0));
		expect(decodePayload(decoded, tinytuya.localKey)).toBeNull();
	});
});

describe('3.5 encoding', () => {
	it('builds the negotiation start frame identical to tinytuya', () => {
		const frame = encodeCommand35(1, tuyaCommand.sessKeyNegStart, tinytuya.localNonce, tinytuya.localKey, tinytuya.iv);
		expect(frame.toString('hex')).toBe(tinytuya.v35SessStart);
	});

	it('builds the negotiation finish frame identical to tinytuya', () => {
		const frame = encodeCommand35(
			2,
			tuyaCommand.sessKeyNegFinish,
			hmacSha256(tinytuya.localKey, tinytuya.remoteNonce),
			tinytuya.localKey,
			tinytuya.iv,
		);
		expect(frame.toString('hex')).toBe(tinytuya.v35SessFinish);
	});

	it('builds a heartbeat on the session key identical to tinytuya', () => {
		const frame = encodeCommand35(
			3,
			tuyaCommand.heartBeat,
			heartbeatBody(tinytuya.deviceId),
			hex(tinytuya.sessionKey),
			tinytuya.iv,
		);
		expect(frame.toString('hex')).toBe(tinytuya.v35Heartbeat);
	});

	it('builds a camera-side frame with retcode identical to tinytuya', () => {
		const payload = Buffer.concat([tinytuya.remoteNonce, hmacSha256(tinytuya.localKey, tinytuya.localNonce)]);
		const frame = encodeFrame6699(100, tuyaCommand.sessKeyNegResp, payload, tinytuya.localKey, tinytuya.iv, 0);
		expect(frame.toString('hex')).toBe(tinytuya.v35SessResp);
	});

	it('uses a fresh random IV when none is given', () => {
		const a = encodeCommand35(1, tuyaCommand.heartBeat, Buffer.from('{}'), tinytuya.localKey);
		const b = encodeCommand35(1, tuyaCommand.heartBeat, Buffer.from('{}'), tinytuya.localKey);
		expect(a.subarray(18, 30)).not.toEqual(b.subarray(18, 30));
	});
});

describe('3.5 decoding', () => {
	it('reads the negotiation response with its retcode', () => {
		const decoded = decodeFrame(hex(tinytuya.v35SessResp), { key: tinytuya.localKey, hasRetcode: true });
		expect(decoded).toMatchObject({ format: '6699', seqno: 100, cmd: 4, retcode: 0 });
		expect(decoded.payload.subarray(0, 16)).toEqual(tinytuya.remoteNonce);
		expect(decoded.payload.subarray(16, 48)).toEqual(hmacSha256(tinytuya.localKey, tinytuya.localNonce));
	});

	it('reads a protocol 4 status push behind the 3.5 header', () => {
		const decoded = decodeFrame(hex(tinytuya.v35Status), { key: hex(tinytuya.sessionKey) });
		expect(decoded.retcode).toBe(0);
		const json = decodePayload(decoded, tinytuya.localKey);
		expect(json).toEqual({ protocol: 4, t: 1700000000, data: { dps: { '212': 'eyJ2IjoxfQ==' } } });
		expect(extractDps(json)).toEqual({ '212': 'eyJ2IjoxfQ==' });
	});

	it('rejects a frame encrypted with another key', () => {
		expect(() => decodeFrame(hex(tinytuya.v35Status), { key: tinytuya.localKey })).toThrow(/GCM/);
	});

	it('rejects a frame whose header was tampered with', () => {
		const frame = hex(tinytuya.v35Status);
		frame[9] ^= 0x01; // seqno is part of the additional data
		expect(() => decodeFrame(frame, { key: hex(tinytuya.sessionKey) })).toThrow(/GCM/);
	});

	it('requires a key', () => {
		expect(() => decodeFrame(hex(tinytuya.v35Status))).toThrow(/key is required/);
	});
});

describe('splitFrames', () => {
	const a = hex(tinytuya.v33Status);
	const b = hex(tinytuya.v35Status);

	it('returns several frames from one chunk', () => {
		const { frames, rest, discarded } = splitFrames(Buffer.concat([a, b, a]));
		expect(frames).toEqual([a, b, a]);
		expect(rest.length).toBe(0);
		expect(discarded).toBe(0);
	});

	it('keeps a partial frame for the next chunk', () => {
		const stream = Buffer.concat([a, b]);
		const cut = a.length + 10;
		const first = splitFrames(stream.subarray(0, cut));
		expect(first.frames).toEqual([a]);
		expect(first.rest).toEqual(b.subarray(0, 10));
		const second = splitFrames(Buffer.concat([first.rest, stream.subarray(cut)]));
		expect(second.frames).toEqual([b]);
		expect(second.rest.length).toBe(0);
	});

	it('reassembles a stream fed one byte at a time', () => {
		const stream = Buffer.concat([a, b]);
		const frames: Buffer[] = [];
		let pending = Buffer.alloc(0);
		for (const byte of stream) {
			const result = splitFrames(Buffer.concat([pending, Buffer.from([byte])]));
			frames.push(...result.frames);
			pending = Buffer.from(result.rest);
		}
		expect(frames).toEqual([a, b]);
		expect(pending.length).toBe(0);
	});

	it('skips garbage before a frame', () => {
		const { frames, discarded } = splitFrames(Buffer.concat([Buffer.from('noise!'), a]));
		expect(frames).toEqual([a]);
		expect(discarded).toBe(6);
	});

	it('keeps a possible partial prefix at the end of garbage', () => {
		const { frames, rest, discarded } = splitFrames(Buffer.from([1, 2, 3, 4, 5, 0x00, 0x00, 0x55]));
		expect(frames).toEqual([]);
		expect(rest).toEqual(Buffer.from([0x00, 0x00, 0x55]));
		expect(discarded).toBe(5);
	});

	it('skips a prefix whose header claims an implausible length', () => {
		const bogus = Buffer.from('000055aa00000001000000080fffffff', 'hex');
		const { frames, discarded } = splitFrames(Buffer.concat([bogus, a]));
		expect(frames).toEqual([a]);
		expect(discarded).toBe(bogus.length);
	});

	it('waits for a complete header', () => {
		const { frames, rest } = splitFrames(b.subarray(0, 10));
		expect(frames).toEqual([]);
		expect(rest).toEqual(b.subarray(0, 10));
	});
});

describe('extractDps', () => {
	it('reads the 3.3 shape', () => {
		expect(extractDps({ dps: { '207': 2100 } })).toEqual({ '207': 2100 });
	});

	it('reads the 3.5 shape', () => {
		expect(extractDps({ protocol: 4, data: { dps: { '250': 'motion_detection' } } })).toEqual({
			'250': 'motion_detection',
		});
	});

	it('returns null when there is no dps object', () => {
		expect(extractDps({ t: 1 })).toBeNull();
		expect(extractDps(null)).toBeNull();
		expect(extractDps([1])).toBeNull();
		expect(extractDps({ dps: 'nope' })).toBeNull();
	});
});

describe('decodeBroadcast', () => {
	it('reads a plain 3.1 broadcast from port 6666', () => {
		expect(decodeBroadcast(hex(tinytuya.udp31))).toMatchObject({ gwId: tinytuya.deviceId, version: '3.1' });
	});

	it('reads an ECB-encrypted 3.3 broadcast from port 6667', () => {
		expect(decodeBroadcast(hex(tinytuya.udp33))).toMatchObject({
			gwId: tinytuya.deviceId,
			ip: '192.0.2.10',
			version: '3.3',
		});
	});

	it('reads a GCM-framed 3.5 broadcast from port 6667', () => {
		expect(decodeBroadcast(hex(tinytuya.udp35))).toMatchObject({
			gwId: tinytuya.deviceId,
			ip: '192.0.2.11',
			version: '3.5',
		});
	});

	it('reads a bare ECB blob without framing', () => {
		const blob = encryptEcb(udpKey, Buffer.from('{"gwId":"x","version":"3.3"}'));
		expect(decodeBroadcast(blob)).toEqual({ gwId: 'x', version: '3.3' });
	});

	it('returns null for anything else', () => {
		expect(decodeBroadcast(Buffer.from('hello world, not tuya'))).toBeNull();
		expect(decodeBroadcast(Buffer.alloc(0))).toBeNull();
		const corrupted = hex(tinytuya.udp35);
		corrupted[40] ^= 0xff;
		expect(decodeBroadcast(corrupted)).toBeNull();
	});
});

describe('3.4', () => {
	// Laid out after tinytuya's XenonDevice._encode_message / pack_message for version 3.4.
	it('builds a heartbeat: ECB body without version header, HMAC-SHA256 trailer on the key', () => {
		const key = tinytuya.localKey;
		const body = heartbeatBody(tinytuya.deviceId);
		const frame = encodeCommand34(3, tuyaCommand.heartBeat, body, key);
		const encrypted = encryptEcb(key, body);
		expect(frame.readUInt32BE(0)).toBe(0x55aa);
		expect(frame.readUInt32BE(4)).toBe(3);
		expect(frame.readUInt32BE(8)).toBe(tuyaCommand.heartBeat);
		expect(frame.readUInt32BE(12)).toBe(encrypted.length + 32 + 4);
		expect(frame.subarray(16, 16 + encrypted.length)).toEqual(encrypted);
		const hmacStart = 16 + encrypted.length;
		expect(frame.subarray(hmacStart, hmacStart + 32)).toEqual(hmacSha256(key, frame.subarray(0, hmacStart)));
		expect(frame.readUInt32BE(frame.length - 4)).toBe(0xaa55);
	});

	it('puts the version header inside the encryption for commands that carry one', () => {
		const frame = encodeCommand34(4, tuyaCommand.control, Buffer.from('{}'), tinytuya.localKey);
		const decoded = decodeFrame(frame, { hmacKey: tinytuya.localKey, hasRetcode: false });
		const plain = decryptEcb(tinytuya.localKey, decoded.payload);
		expect(plain.subarray(0, 3).toString()).toBe('3.4');
		expect(decodePayload(decoded, tinytuya.localKey)).toEqual({});
	});

	it('rejects a frame whose HMAC was made with another key', () => {
		const frame = encodeCommand34(1, tuyaCommand.heartBeat, Buffer.from('{}'), Buffer.alloc(16, 9));
		expect(() => decodeFrame(frame, { hmacKey: tinytuya.localKey })).toThrow(/HMAC/);
	});

	it('derives the session key as ECB of the nonces XORed, without padding', () => {
		const key = deriveSessionKey34(tinytuya.localKey, tinytuya.localNonce, tinytuya.remoteNonce);
		const mixed = Buffer.from(tinytuya.localNonce.map((byte, i) => byte ^ tinytuya.remoteNonce[i]));
		expect(key).toHaveLength(16);
		expect(key).toEqual(encryptEcb(tinytuya.localKey, mixed).subarray(0, 16));
		expect(key).not.toEqual(deriveSessionKey(tinytuya.localKey, tinytuya.localNonce, tinytuya.remoteNonce));
	});

	it('reads a STATUS push: retcode, then ECB of the version header and protocol 4 JSON', () => {
		const sessionKey = deriveSessionKey34(tinytuya.localKey, tinytuya.localNonce, tinytuya.remoteNonce);
		const header = Buffer.concat([Buffer.from('3.4'), Buffer.alloc(12)]);
		const json = Buffer.from(JSON.stringify({ protocol: 4, t: 1700000000, data: { dps: { '212': 'x' } } }));
		const frame = encodeFrame55aa(
			9,
			tuyaCommand.status,
			encryptEcb(sessionKey, Buffer.concat([header, json])),
			0,
			sessionKey,
		);
		const decoded = decodeFrame(frame, { hmacKey: sessionKey });
		expect(decoded.retcode).toBe(0);
		expect(extractDps(decodePayload(decoded, sessionKey))).toEqual({ '212': 'x' });
	});
});

describe('parseAnnouncedVersion', () => {
	it('selects 3.4 and 3.5 when announced', () => {
		expect(parseAnnouncedVersion('3.5')).toBe('3.5');
		expect(parseAnnouncedVersion(' 3.5 ')).toBe('3.5');
		expect(parseAnnouncedVersion(3.5)).toBe('3.5');
		expect(parseAnnouncedVersion('3.4')).toBe('3.4');
		expect(parseAnnouncedVersion(3.4)).toBe('3.4');
	});

	it('falls back to 3.3 for everything else', () => {
		expect(parseAnnouncedVersion('3.3')).toBe('3.3');
		expect(parseAnnouncedVersion(undefined)).toBe('3.3');
		expect(parseAnnouncedVersion('garbage')).toBe('3.3');
	});
});
