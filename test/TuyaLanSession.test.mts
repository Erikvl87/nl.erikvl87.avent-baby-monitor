/* eslint-disable @typescript-eslint/naming-convention -- DPS ids are numeric object keys */
import { EventEmitter } from 'node:events';
import type net from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import TuyaLanSession, { type TuyaLanSessionOptions, type TuyaLanVersion } from '../TuyaLanSession.mjs';
import {
	decodeFrame,
	decodePayload,
	decryptEcb,
	deriveSessionKey,
	deriveSessionKey34,
	encodeFrame55aa,
	encodeFrame6699,
	encryptEcb,
	hmacSha256,
	tuyaCommand,
} from '../utils/tuya-lan-protocol.mjs';
import { createFakeLogger, type FakeLogger } from './helpers/fake-logger.mjs';

const localKeyText = '0123456789abcdef';
const localKey = Buffer.from(localKeyText, 'latin1');
const deviceId = 'bf1234567890abcdefgh';
const remoteNonce = Buffer.from('a0a1a2a3a4a5a6a7a8a9aaabacadaeaf', 'hex');

/** Stands in for a net.Socket: records writes and lets the test play the camera. */
class FakeSocket extends EventEmitter {
	public readonly written: Buffer[] = [];
	public destroyed = false;

	public write(data: Buffer): boolean {
		this.written.push(Buffer.from(data));
		return true;
	}

	public destroy(): this {
		if (!this.destroyed) {
			this.destroyed = true;
			// A real socket emits 'close' after destroy; the session must ignore it.
			this.emit('close');
		}
		return this;
	}

	public receive(data: Buffer): void {
		this.emit('data', data);
	}

	/** Commands of everything the session wrote. */
	public commands(): number[] {
		return this.written.map(frame => frame.readUInt32BE(frame.readUInt32BE(0) === 0x6699 ? 10 : 8));
	}
}

interface Harness {
	session: TuyaLanSession;
	logger: FakeLogger;
	sockets: FakeSocket[];
	dps: Record<string, unknown>[];
	connection: boolean[];
	connect: ReturnType<typeof vi.fn>;
	latest: () => FakeSocket;
}

function createHarness(version: TuyaLanVersion, overrides: Partial<TuyaLanSessionOptions> = {}): Harness {
	const logger = createFakeLogger();
	const sockets: FakeSocket[] = [];
	const dps: Record<string, unknown>[] = [];
	const connection: boolean[] = [];
	const connect = vi.fn((_port: number, _host: string) => {
		const socket = new FakeSocket();
		sockets.push(socket);
		return socket as unknown as net.Socket;
	});
	const session = new TuyaLanSession({
		logger,
		deviceId,
		localKey: localKeyText,
		host: '192.0.2.10',
		version,
		onDps: (value): void => {
			dps.push(value);
		},
		onConnectionChange: (value): void => {
			connection.push(value);
		},
		connect,
		...overrides,
	});
	return { session, logger, sockets, dps, connection, connect, latest: () => sockets[sockets.length - 1]! };
}

/** A 3.3 STATUS push as the camera sends it: retcode, version header, ECB body. */
function statusFrame33(body: object, seqno = 1): Buffer {
	const header = Buffer.concat([Buffer.from('3.3'), Buffer.alloc(12)]);
	const payload = Buffer.concat([header, encryptEcb(localKey, Buffer.from(JSON.stringify(body)))]);
	return encodeFrame55aa(seqno, tuyaCommand.status, payload, 0);
}

/** Plays the camera's side of the 3.5 negotiation on the latest socket and returns the session key. */
function completeNegotiation(socket: FakeSocket): Buffer {
	const start = decodeFrame(socket.written[0]!, { key: localKey, hasRetcode: false });
	expect(start.cmd).toBe(tuyaCommand.sessKeyNegStart);
	const localNonce = start.payload;
	const response = Buffer.concat([remoteNonce, hmacSha256(localKey, localNonce)]);
	socket.receive(encodeFrame6699(1, tuyaCommand.sessKeyNegResp, response, localKey, undefined, 0));

	const finish = decodeFrame(socket.written[1]!, { key: localKey, hasRetcode: false });
	expect(finish.cmd).toBe(tuyaCommand.sessKeyNegFinish);
	expect(finish.payload).toEqual(hmacSha256(localKey, remoteNonce));
	return deriveSessionKey(localKey, localNonce, remoteNonce);
}

/** A 3.5 STATUS push: retcode, "3.5" header and the protocol 4 JSON shape. */
function statusFrame35(sessionKey: Buffer, dps: Record<string, unknown>, seqno = 2): Buffer {
	const header = Buffer.concat([Buffer.from('3.5'), Buffer.alloc(12)]);
	const json = Buffer.from(JSON.stringify({ protocol: 4, t: 1700000000, data: { dps } }));
	return encodeFrame6699(seqno, tuyaCommand.status, Buffer.concat([header, json]), sessionKey, undefined, 0);
}

/** Plays the camera's side of the 3.4 negotiation on the latest socket and returns the session key. */
function completeNegotiation34(socket: FakeSocket): Buffer {
	const start = decodeFrame(socket.written[0]!, { hmacKey: localKey, hasRetcode: false });
	expect(start.format).toBe('55aa');
	expect(start.cmd).toBe(tuyaCommand.sessKeyNegStart);
	const localNonce = decryptEcb(localKey, start.payload);
	const response = Buffer.concat([remoteNonce, hmacSha256(localKey, localNonce)]);
	socket.receive(encodeFrame55aa(1, tuyaCommand.sessKeyNegResp, encryptEcb(localKey, response), 0, localKey));

	const finish = decodeFrame(socket.written[1]!, { hmacKey: localKey, hasRetcode: false });
	expect(finish.cmd).toBe(tuyaCommand.sessKeyNegFinish);
	expect(decryptEcb(localKey, finish.payload)).toEqual(hmacSha256(localKey, remoteNonce));
	return deriveSessionKey34(localKey, localNonce, remoteNonce);
}

/** A 3.4 STATUS push: retcode, then ECB on the session key of the "3.4" header and protocol 4 JSON. */
function statusFrame34(sessionKey: Buffer, dps: Record<string, unknown>, seqno = 2): Buffer {
	const header = Buffer.concat([Buffer.from('3.4'), Buffer.alloc(12)]);
	const json = Buffer.from(JSON.stringify({ protocol: 4, t: 1700000000, data: { dps } }));
	return encodeFrame55aa(
		seqno,
		tuyaCommand.status,
		encryptEcb(sessionKey, Buffer.concat([header, json])),
		0,
		sessionKey,
	);
}

describe('TuyaLanSession', () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	describe('on protocol 3.3', () => {
		it('connects to port 6668 and reports the connection once the socket is open', () => {
			const h = createHarness('3.3');
			h.session.start();
			expect(h.connect).toHaveBeenCalledWith(6668, '192.0.2.10');
			expect(h.session.isConnected()).toBe(false);

			h.latest().emit('connect');
			expect(h.session.isConnected()).toBe(true);
			expect(h.connection).toEqual([true]);
			h.session.stop();
		});

		it('delivers dps from pushes, including frames split across chunks and several per chunk', () => {
			const h = createHarness('3.3');
			h.session.start();
			h.latest().emit('connect');

			const first = statusFrame33({ dps: { '207': 2150 } }, 1);
			const second = statusFrame33({ dps: { '250': 'motion_detection' } }, 2);
			const third = statusFrame33({ dps: { '141': 'decibel_upload' } }, 3);
			const stream = Buffer.concat([first, second, third]);
			h.latest().receive(stream.subarray(0, 10));
			h.latest().receive(stream.subarray(10, first.length + second.length + 5));
			h.latest().receive(stream.subarray(first.length + second.length + 5));

			expect(h.dps).toEqual([{ '207': 2150 }, { '250': 'motion_detection' }, { '141': 'decibel_upload' }]);
			h.session.stop();
		});

		it('passes base64 values through untouched', () => {
			const h = createHarness('3.3');
			h.session.start();
			h.latest().emit('connect');
			h.latest().receive(statusFrame33({ dps: { '212': 'eyJjbWQiOiJpcGNfbW90aW9uIn0=' } }));
			expect(h.dps).toEqual([{ '212': 'eyJjbWQiOiJpcGNfbW90aW9uIn0=' }]);
			h.session.stop();
		});

		it('sends a heartbeat every 8 seconds and nothing else', () => {
			const h = createHarness('3.3');
			h.session.start();
			const socket = h.latest();
			socket.emit('connect');
			expect(socket.written).toHaveLength(0);

			vi.advanceTimersByTime(8_000);
			expect(socket.written).toHaveLength(1);
			const heartbeat = decodeFrame(socket.written[0]!, { hasRetcode: false });
			expect(heartbeat.cmd).toBe(tuyaCommand.heartBeat);
			expect(decodePayload(heartbeat, localKey)).toEqual({ gwId: deviceId, devId: deviceId });

			vi.advanceTimersByTime(8_000 * 4);
			expect(socket.commands()).toEqual([9, 9, 9, 9, 9]);
			h.session.stop();
		});

		it('treats a heartbeat ack without body as a healthy frame', () => {
			const h = createHarness('3.3');
			h.session.start();
			h.latest().emit('connect');
			h.latest().receive(encodeFrame55aa(1, tuyaCommand.heartBeat, Buffer.alloc(0), 0));
			expect(h.dps).toEqual([]);
			expect(h.session.isConnected()).toBe(true);
			h.session.stop();
		});
	});

	describe('on protocol 3.4', () => {
		it('negotiates a session key in HMAC-checked 55AA frames and only then reports the connection', () => {
			const h = createHarness('3.4');
			h.session.start();
			h.latest().emit('connect');
			expect(h.session.isConnected()).toBe(false);
			completeNegotiation34(h.latest());
			expect(h.session.isConnected()).toBe(true);
			expect(h.connection).toEqual([true]);
			h.session.stop();
		});

		it('delivers dps from pushes on the session key, and sends heartbeats on it', () => {
			const verified: string[] = [];
			const h = createHarness('3.4', { onVersionVerified: version => verified.push(version) });
			h.session.start();
			h.latest().emit('connect');
			const sessionKey = completeNegotiation34(h.latest());
			h.latest().receive(statusFrame34(sessionKey, { '212': 'record' }));
			expect(h.dps).toEqual([{ '212': 'record' }]);
			expect(verified).toEqual(['3.4']);

			vi.advanceTimersByTime(8_000);
			const heartbeat = decodeFrame(h.latest().written[2]!, { hmacKey: sessionKey, hasRetcode: false });
			expect(heartbeat.cmd).toBe(tuyaCommand.heartBeat);
			expect(JSON.parse(decryptEcb(sessionKey, heartbeat.payload).toString())).toEqual({
				gwId: deviceId,
				devId: deviceId,
			});
			h.session.stop();
		});

		it('falls back to 3.3 after two failed negotiations in a row', () => {
			const h = createHarness('3.4');
			h.session.start();
			h.latest().emit('connect');
			h.latest().emit('close');
			vi.advanceTimersByTime(1);
			h.latest().emit('connect');
			vi.advanceTimersByTime(10_000);
			expect(h.logger.logs.flat().join('\n')).toMatch(/Protocol 3\.4 failed 2 times in a row; falling back to 3\.3/);
			vi.advanceTimersByTime(15_000);
			h.latest().emit('connect');
			expect(h.latest().written).toHaveLength(0);
			expect(h.session.isConnected()).toBe(true);
			h.session.stop();
		});
	});

	describe('on protocol 3.5', () => {
		it('negotiates a session key and only then reports the connection', () => {
			const h = createHarness('3.5');
			h.session.start();
			h.latest().emit('connect');
			expect(h.session.isConnected()).toBe(false);
			expect(h.latest().commands()).toEqual([tuyaCommand.sessKeyNegStart]);

			completeNegotiation(h.latest());
			expect(h.session.isConnected()).toBe(true);
			expect(h.connection).toEqual([true]);
			h.session.stop();
		});

		it('delivers dps from protocol 4 pushes encrypted with the session key', () => {
			const h = createHarness('3.5');
			h.session.start();
			h.latest().emit('connect');
			const sessionKey = completeNegotiation(h.latest());

			h.latest().receive(statusFrame35(sessionKey, { '212': 'eyJ2IjoxfQ==' }));
			expect(h.dps).toEqual([{ '212': 'eyJ2IjoxfQ==' }]);
			h.session.stop();
		});

		it('sends heartbeats on the session key', () => {
			const h = createHarness('3.5');
			h.session.start();
			h.latest().emit('connect');
			const sessionKey = completeNegotiation(h.latest());

			vi.advanceTimersByTime(8_000);
			const frames = h.latest().written;
			expect(h.latest().commands()).toEqual([3, 5, 9]);
			const heartbeat = decodeFrame(frames[2]!, { key: sessionKey, hasRetcode: false });
			expect(heartbeat.seqno).toBe(3);
			expect(JSON.parse(heartbeat.payload.toString())).toEqual({ gwId: deviceId, devId: deviceId });
			h.session.stop();
		});

		it('reconnects when the camera fails the HMAC check', () => {
			const h = createHarness('3.5');
			h.session.start();
			h.latest().emit('connect');
			const badResponse = Buffer.concat([remoteNonce, Buffer.alloc(32)]);
			h.latest().receive(encodeFrame6699(1, tuyaCommand.sessKeyNegResp, badResponse, localKey, undefined, 0));

			expect(h.session.isConnected()).toBe(false);
			expect(h.sockets[0]!.destroyed).toBe(true);
			expect(h.connection).toEqual([]);
			vi.advanceTimersByTime(1);
			expect(h.sockets).toHaveLength(2);
			h.session.stop();
		});

		it('falls back to 3.3 after two failed negotiations in a row', () => {
			const h = createHarness('3.5');
			h.session.start();

			// First attempt: the camera closes the socket during negotiation.
			h.latest().emit('connect');
			h.latest().emit('close');
			vi.advanceTimersByTime(1);

			// Second attempt: the camera never answers.
			h.latest().emit('connect');
			expect(h.latest().commands()).toEqual([tuyaCommand.sessKeyNegStart]);
			vi.advanceTimersByTime(10_000);
			expect(h.logger.logs.flat().join('\n')).toMatch(/falling back to 3\.3/);

			vi.advanceTimersByTime(15_000);
			expect(h.sockets).toHaveLength(3);
			h.latest().emit('connect');
			expect(h.latest().written).toHaveLength(0);
			expect(h.session.isConnected()).toBe(true);
			h.latest().receive(statusFrame33({ dps: { '207': 2000 } }));
			expect(h.dps).toEqual([{ '207': 2000 }]);
			h.session.stop();
		});

		it('keeps 3.5 when a failed negotiation is followed by a successful one', () => {
			const h = createHarness('3.5');
			h.session.start();
			h.latest().emit('connect');
			h.latest().emit('close');
			vi.advanceTimersByTime(1);
			h.latest().emit('connect');
			const sessionKey = completeNegotiation(h.latest());
			h.latest().receive(statusFrame35(sessionKey, { '207': 2000 }));
			h.latest().emit('close');
			vi.advanceTimersByTime(15_000);

			h.latest().emit('connect');
			h.latest().emit('close');
			vi.advanceTimersByTime(15_000);
			h.latest().emit('connect');
			expect(h.latest().commands()).toEqual([tuyaCommand.sessKeyNegStart]);
			h.session.stop();
		});

		it('falls back to 3.3 when frames on a negotiated session never authenticate', () => {
			const h = createHarness('3.5');
			h.session.start();
			const wrongKey = Buffer.alloc(16, 7);
			for (let attempt = 0; attempt < 2; attempt++) {
				h.latest().emit('connect');
				completeNegotiation(h.latest());
				expect(h.session.isConnected()).toBe(true);
				for (let i = 0; i < 3; i++) {
					h.latest().receive(statusFrame35(wrongKey, { '207': 1 }));
				}
				expect(h.session.isConnected()).toBe(false);
				// The first retry is immediate, the second waits 15 seconds.
				vi.advanceTimersByTime(attempt === 0 ? 1 : 15_000);
			}
			expect(h.sockets).toHaveLength(3);
			expect(h.logger.logs.flat().join('\n')).toMatch(/falling back to 3\.3/);
			h.latest().emit('connect');
			expect(h.latest().written).toHaveLength(0);
			expect(h.dps).toEqual([]);
			h.session.stop();
		});

		it('tries 3.5 when a 3.3 camera hangs up twice before sending anything', () => {
			const h = createHarness('3.3');
			h.session.start();
			h.latest().emit('connect');
			expect(h.session.isConnected()).toBe(true);
			h.latest().emit('close');
			vi.advanceTimersByTime(1);
			h.latest().emit('connect');
			h.latest().emit('close');
			expect(h.logger.logs.flat().join('\n')).toMatch(/Protocol 3\.3 failed 2 times in a row; trying 3\.5/);

			vi.advanceTimersByTime(15_000);
			h.latest().emit('connect');
			expect(h.latest().commands()).toEqual([tuyaCommand.sessKeyNegStart]);
			h.session.stop();
		});

		it('waits 10 minutes once none of 3.3, 3.5 and 3.4 gets an answer', () => {
			const h = createHarness('3.3');
			h.session.start();
			// 3.3: the camera hangs up twice.
			h.latest().emit('connect');
			h.latest().emit('close');
			vi.advanceTimersByTime(1);
			h.latest().emit('connect');
			h.latest().emit('close');
			vi.advanceTimersByTime(15_000);
			// 3.5, then 3.4: the camera never answers the negotiation, twice each.
			for (let attempt = 0; attempt < 4; attempt++) {
				h.latest().emit('connect');
				expect(h.latest().written[0]!.readUInt32BE(0)).toBe(attempt < 2 ? 0x6699 : 0x55aa);
				vi.advanceTimersByTime(10_000);
				if (attempt < 3) vi.advanceTimersByTime(15_000);
			}
			expect(h.logger.logs.flat().join('\n')).toMatch(/Protocol 3\.5 failed 2 times in a row; trying 3\.4/);
			expect(h.logger.logs.flat().join('\n')).toMatch(
				/None of protocols 3\.3, 3\.5, 3\.4 works with this camera; trying again in 10 minutes/,
			);
			const sockets = h.sockets.length;
			vi.advanceTimersByTime(9 * 60_000);
			expect(h.sockets).toHaveLength(sockets);
			vi.advanceTimersByTime(60_000);
			expect(h.sockets).toHaveLength(sockets + 1);
			h.session.stop();
		});

		it('keeps 3.3 when the camera answered before the connection dropped', () => {
			const h = createHarness('3.3');
			h.session.start();
			for (let attempt = 0; attempt < 2; attempt++) {
				h.latest().emit('connect');
				h.latest().receive(statusFrame33({ dps: { '207': 2000 } }));
				h.latest().emit('close');
				vi.advanceTimersByTime(15_000);
			}
			h.latest().emit('connect');
			expect(h.latest().written).toHaveLength(0);
			expect(h.logger.logs.flat().join('\n')).not.toMatch(/trying 3\.5/);
			h.session.stop();
		});

		it('does not count a refused TCP connection as a failed negotiation', () => {
			const h = createHarness('3.5');
			h.session.start();
			h.latest().emit('error', Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }));
			vi.advanceTimersByTime(1);
			h.latest().emit('error', Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }));
			vi.advanceTimersByTime(15_000);
			h.latest().emit('connect');
			expect(h.latest().commands()).toEqual([tuyaCommand.sessKeyNegStart]);
			h.session.stop();
		});
	});

	describe('reconnecting', () => {
		it('retries at once after the first failure and every 15 seconds after that', () => {
			const h = createHarness('3.3');
			h.session.start();
			h.latest().emit('error', new Error('connect EHOSTUNREACH'));
			expect(h.sockets).toHaveLength(1);
			vi.advanceTimersByTime(1);
			expect(h.sockets).toHaveLength(2);

			h.latest().emit('error', new Error('connect EHOSTUNREACH'));
			vi.advanceTimersByTime(14_999);
			expect(h.sockets).toHaveLength(2);
			vi.advanceTimersByTime(1);
			expect(h.sockets).toHaveLength(3);
			h.session.stop();
		});

		it('reports a drop and resets the backoff once a frame was read', () => {
			const h = createHarness('3.3');
			h.session.start();
			h.latest().emit('error', new Error('boom'));
			vi.advanceTimersByTime(1);
			h.latest().emit('connect');
			h.latest().receive(statusFrame33({ dps: { '207': 1 } }));
			h.latest().emit('close');

			expect(h.connection).toEqual([true, false]);
			expect(h.session.isConnected()).toBe(false);
			vi.advanceTimersByTime(1);
			expect(h.sockets).toHaveLength(3);
			h.session.stop();
		});

		it('handles a close and an error on the same socket as one drop', () => {
			const h = createHarness('3.3');
			h.session.start();
			h.latest().emit('connect');
			h.latest().emit('error', new Error('read ECONNRESET'));
			h.latest().emit('close');
			expect(h.connection).toEqual([true, false]);
			vi.advanceTimersByTime(1);
			expect(h.sockets).toHaveLength(2);
			h.session.stop();
		});

		it('times out a connection that never opens', () => {
			const h = createHarness('3.3');
			h.session.start();
			vi.advanceTimersByTime(10_000);
			expect(h.sockets[0]!.destroyed).toBe(true);
			vi.advanceTimersByTime(1);
			expect(h.sockets).toHaveLength(2);
			h.session.stop();
		});

		it('ignores up to two unreadable frames in a row and reconnects on the third', () => {
			const h = createHarness('3.3');
			h.session.start();
			h.latest().emit('connect');
			const garbage = encodeFrame55aa(1, tuyaCommand.status, Buffer.alloc(16, 0x41));

			h.latest().receive(garbage);
			h.latest().receive(garbage);
			h.latest().receive(statusFrame33({ dps: { '207': 1 } }));
			h.latest().receive(garbage);
			h.latest().receive(garbage);
			expect(h.session.isConnected()).toBe(true);

			h.latest().receive(garbage);
			expect(h.session.isConnected()).toBe(false);
			expect(h.connection).toEqual([true, false]);
			expect(h.dps).toEqual([{ '207': 1 }]);
			h.session.stop();
		});

		it('reconnects when nothing at all has been received for 600 seconds', () => {
			const h = createHarness('3.3');
			h.session.start();
			h.latest().emit('connect');
			vi.advanceTimersByTime(600_000);
			expect(h.session.isConnected()).toBe(true);
			vi.advanceTimersByTime(8_000);
			expect(h.session.isConnected()).toBe(false);
			expect(h.sockets[0]!.destroyed).toBe(true);
			h.session.stop();
		});

		it('stays connected while the camera answers heartbeats', () => {
			const h = createHarness('3.3');
			h.session.start();
			h.latest().emit('connect');
			for (let i = 0; i < 100; i++) {
				vi.advanceTimersByTime(8_000);
				h.latest().receive(encodeFrame55aa(i, tuyaCommand.heartBeat, Buffer.alloc(0), 0));
			}
			expect(h.session.isConnected()).toBe(true);
			expect(h.sockets).toHaveLength(1);
			h.session.stop();
		});

		it('retries when opening the socket throws', () => {
			let calls = 0;
			const h = createHarness('3.3', {
				connect: () => {
					calls++;
					throw new Error('bad host');
				},
			});
			expect(() => h.session.start()).not.toThrow();
			expect(calls).toBe(1);
			vi.advanceTimersByTime(1);
			expect(calls).toBe(2);
			h.session.stop();
		});
	});

	describe('stopping', () => {
		it('destroys the socket and leaves no timers behind', () => {
			const h = createHarness('3.3');
			h.session.start();
			h.latest().emit('connect');
			expect(vi.getTimerCount()).toBeGreaterThan(0);

			h.session.stop();
			expect(h.latest().destroyed).toBe(true);
			expect(vi.getTimerCount()).toBe(0);
			expect(h.session.isConnected()).toBe(false);
		});

		it('clears a pending reconnect', () => {
			const h = createHarness('3.3');
			h.session.start();
			h.latest().emit('error', new Error('boom'));
			vi.advanceTimersByTime(1);
			h.latest().emit('error', new Error('boom'));
			expect(vi.getTimerCount()).toBe(1);
			h.session.stop();
			expect(vi.getTimerCount()).toBe(0);
			vi.advanceTimersByTime(60_000);
			expect(h.sockets).toHaveLength(2);
		});

		it('is safe to call twice and ignores late socket events', () => {
			const h = createHarness('3.3');
			h.session.start();
			const socket = h.latest();
			socket.emit('connect');
			h.session.stop();
			h.session.stop();
			expect(() => socket.emit('error', new Error('late'))).not.toThrow();
			socket.emit('close');
			socket.receive(statusFrame33({ dps: { '207': 1 } }));
			expect(h.dps).toEqual([]);
			expect(h.sockets).toHaveLength(1);
			expect(vi.getTimerCount()).toBe(0);
		});

		it('can stop from inside the dps callback', () => {
			const h = createHarness('3.3', {
				onDps: () => h.session.stop(),
			});
			h.session.start();
			h.latest().emit('connect');
			h.latest().receive(Buffer.concat([statusFrame33({ dps: { '1': 1 } }), statusFrame33({ dps: { '2': 2 } })]));
			expect(vi.getTimerCount()).toBe(0);
			expect(h.latest().destroyed).toBe(true);
		});

		it('can start again after stopping', () => {
			const h = createHarness('3.3');
			h.session.start();
			h.session.stop();
			h.session.start();
			expect(h.sockets).toHaveLength(2);
			h.latest().emit('connect');
			expect(h.session.isConnected()).toBe(true);
			h.session.stop();
		});
	});

	describe('robustness', () => {
		it('opens only one socket when started twice', () => {
			const h = createHarness('3.3');
			h.session.start();
			h.session.start();
			expect(h.sockets).toHaveLength(1);
			h.session.stop();
		});

		it('reports a throwing dps callback without dropping the connection', () => {
			const h = createHarness('3.3', {
				onDps: () => {
					throw new Error('callback failed');
				},
			});
			h.session.start();
			h.latest().emit('connect');
			h.latest().receive(statusFrame33({ dps: { '207': 1 } }));
			expect(h.logger.errors).toHaveLength(1);
			expect(h.session.isConnected()).toBe(true);
			h.session.stop();
		});

		it('refuses to connect with a local key of the wrong length', () => {
			const h = createHarness('3.3', { localKey: 'short' });
			h.session.start();
			expect(h.sockets).toHaveLength(0);
			expect(h.logger.errors).toHaveLength(1);
			expect(vi.getTimerCount()).toBe(0);
		});

		it('never logs the local key', () => {
			const h = createHarness('3.5');
			h.session.start();
			h.latest().emit('connect');
			h.latest().emit('close');
			vi.advanceTimersByTime(1);
			h.latest().emit('connect');
			vi.advanceTimersByTime(10_000);
			vi.advanceTimersByTime(15_000);
			h.latest().emit('connect');
			h.latest().receive(encodeFrame55aa(1, tuyaCommand.status, Buffer.alloc(16, 0x41)));
			h.latest().emit('close');
			h.session.stop();

			const logged = JSON.stringify([...h.logger.logs, ...h.logger.errors].map(args => args.map(String)));
			expect(logged).not.toContain(localKeyText);
			expect(h.logger.logs.length).toBeGreaterThan(0);
		});
	});
});
