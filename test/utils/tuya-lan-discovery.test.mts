import dgram from 'node:dgram';
import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { discoverTuyaDevice, discoveryPorts } from '../../utils/tuya-lan-discovery.mjs';
import { encodeFrame55aa, encodeFrame6699, encryptEcb, udpKey } from '../../utils/tuya-lan-protocol.mjs';
import { createFakeLogger } from '../helpers/fake-logger.mjs';

const deviceId = 'bf1234567890abcdefgh';

/** Stands in for a bound dgram socket. */
class FakeUdpSocket extends EventEmitter {
	public closed = false;

	public constructor(public readonly port: number) {
		super();
	}

	public close(): void {
		if (this.closed) {
			throw new Error('Not running');
		}
		this.closed = true;
	}

	public deliver(message: Buffer, address = '192.0.2.99'): void {
		this.emit('message', message, { address, family: 'IPv4', port: 49152, size: message.length });
	}
}

function broadcast33(body: object): Buffer {
	return encodeFrame55aa(0, 19, encryptEcb(udpKey, Buffer.from(JSON.stringify(body))), 0);
}

function broadcast35(body: object): Buffer {
	return encodeFrame6699(0, 0x23, Buffer.from(JSON.stringify(body)), udpKey);
}

function createFakeBind(): { bind: (port: number) => dgram.Socket; sockets: Map<number, FakeUdpSocket> } {
	const sockets = new Map<number, FakeUdpSocket>();
	return {
		sockets,
		bind: (port: number): dgram.Socket => {
			const socket = new FakeUdpSocket(port);
			sockets.set(port, socket);
			return socket as unknown as dgram.Socket;
		},
	};
}

describe('discoverTuyaDevice', () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it('listens on ports 6666 and 6667', async () => {
		const { bind, sockets } = createFakeBind();
		const promise = discoverTuyaDevice(deviceId, { logger: createFakeLogger(), bind });
		expect([...sockets.keys()]).toEqual([6666, 6667]);
		expect(discoveryPorts).toEqual([6666, 6667]);
		vi.advanceTimersByTime(20_000);
		await promise;
	});

	it('finds a 3.5 monitor from its GCM broadcast and closes both sockets', async () => {
		const { bind, sockets } = createFakeBind();
		const promise = discoverTuyaDevice(deviceId, { logger: createFakeLogger(), bind });
		sockets.get(6667)!.deliver(broadcast35({ ip: '192.0.2.11', gwId: deviceId, version: '3.5' }));

		await expect(promise).resolves.toEqual({ host: '192.0.2.11', version: '3.5' });
		expect(sockets.get(6666)!.closed).toBe(true);
		expect(sockets.get(6667)!.closed).toBe(true);
		expect(vi.getTimerCount()).toBe(0);
	});

	it('finds a 3.3 monitor from its ECB broadcast', async () => {
		const { bind, sockets } = createFakeBind();
		const promise = discoverTuyaDevice(deviceId, { logger: createFakeLogger(), bind });
		sockets.get(6667)!.deliver(broadcast33({ ip: '192.0.2.10', gwId: deviceId, version: '3.3' }));
		await expect(promise).resolves.toEqual({ host: '192.0.2.10', version: '3.3' });
	});

	it('uses 3.3 for any version other than 3.5', async () => {
		const { bind, sockets } = createFakeBind();
		const promise = discoverTuyaDevice(deviceId, { logger: createFakeLogger(), bind });
		const plain = encodeFrame55aa(
			0,
			19,
			Buffer.from(JSON.stringify({ ip: '192.0.2.12', gwId: deviceId, version: '3.1' })),
			0,
		);
		sockets.get(6666)!.deliver(plain);
		await expect(promise).resolves.toEqual({ host: '192.0.2.12', version: '3.3' });
	});

	it('falls back to the sender address when the broadcast has no ip', async () => {
		const { bind, sockets } = createFakeBind();
		const promise = discoverTuyaDevice(deviceId, { logger: createFakeLogger(), bind });
		sockets.get(6667)!.deliver(broadcast35({ gwId: deviceId, version: '3.5' }), '192.0.2.50');
		await expect(promise).resolves.toEqual({ host: '192.0.2.50', version: '3.5' });
	});

	it('ignores other devices and unreadable packets', async () => {
		const { bind, sockets } = createFakeBind();
		const promise = discoverTuyaDevice(deviceId, { logger: createFakeLogger(), bind });
		sockets.get(6667)!.deliver(broadcast33({ ip: '192.0.2.20', gwId: 'someone-else', version: '3.3' }));
		sockets.get(6666)!.deliver(Buffer.from('not a tuya packet'));
		sockets.get(6667)!.deliver(broadcast35({ ip: '192.0.2.11', gwId: deviceId, version: '3.5' }));
		await expect(promise).resolves.toEqual({ host: '192.0.2.11', version: '3.5' });
	});

	it('gives up after 20 seconds by default', async () => {
		const { bind, sockets } = createFakeBind();
		const logger = createFakeLogger();
		const promise = discoverTuyaDevice(deviceId, { logger, bind });
		vi.advanceTimersByTime(19_999);
		expect(sockets.get(6667)!.closed).toBe(false);
		vi.advanceTimersByTime(1);
		await expect(promise).resolves.toBeNull();
		expect(sockets.get(6666)!.closed).toBe(true);
		expect(sockets.get(6667)!.closed).toBe(true);
		expect(logger.errors).toHaveLength(0);
	});

	it('honours a custom timeout', async () => {
		const { bind } = createFakeBind();
		const promise = discoverTuyaDevice(deviceId, { logger: createFakeLogger(), bind, timeoutMs: 1_000 });
		vi.advanceTimersByTime(1_000);
		await expect(promise).resolves.toBeNull();
	});

	it('returns null and logs when both ports are in use', async () => {
		const { bind, sockets } = createFakeBind();
		const logger = createFakeLogger();
		const promise = discoverTuyaDevice(deviceId, { logger, bind });
		for (const socket of sockets.values()) {
			socket.emit('error', Object.assign(new Error('bind EADDRINUSE'), { code: 'EADDRINUSE' }));
		}
		await expect(promise).resolves.toBeNull();
		expect(logger.logs.flat().join('\n')).toMatch(/in use/);
		expect(logger.errors).toHaveLength(0);
		expect(vi.getTimerCount()).toBe(0);
	});

	it('keeps listening on the other port when one is in use', async () => {
		const { bind, sockets } = createFakeBind();
		const promise = discoverTuyaDevice(deviceId, { logger: createFakeLogger(), bind });
		sockets.get(6666)!.emit('error', Object.assign(new Error('bind EADDRINUSE'), { code: 'EADDRINUSE' }));
		expect(sockets.get(6666)!.closed).toBe(true);
		sockets.get(6667)!.deliver(broadcast35({ ip: '192.0.2.11', gwId: deviceId, version: '3.5' }));
		await expect(promise).resolves.toEqual({ host: '192.0.2.11', version: '3.5' });
	});

	it('reports unexpected socket errors', async () => {
		const { bind, sockets } = createFakeBind();
		const logger = createFakeLogger();
		const promise = discoverTuyaDevice(deviceId, { logger, bind });
		sockets.get(6666)!.emit('error', Object.assign(new Error('bind EACCES'), { code: 'EACCES' }));
		sockets.get(6667)!.emit('error', Object.assign(new Error('bind EACCES'), { code: 'EACCES' }));
		await expect(promise).resolves.toBeNull();
		expect(logger.errors).toHaveLength(2);
	});

	it('returns null when creating a socket throws', async () => {
		const logger = createFakeLogger();
		const result = await discoverTuyaDevice(deviceId, {
			logger,
			bind: () => {
				throw new Error('no sockets');
			},
		});
		expect(result).toBeNull();
		expect(vi.getTimerCount()).toBe(0);
	});

	it('stops early when aborted', async () => {
		const { bind, sockets } = createFakeBind();
		const controller = new AbortController();
		const promise = discoverTuyaDevice(deviceId, { logger: createFakeLogger(), bind, signal: controller.signal });
		controller.abort();
		await expect(promise).resolves.toBeNull();
		expect(sockets.get(6667)!.closed).toBe(true);
		expect(vi.getTimerCount()).toBe(0);
	});

	it('does not open sockets when already aborted', async () => {
		const { bind, sockets } = createFakeBind();
		const result = await discoverTuyaDevice(deviceId, {
			logger: createFakeLogger(),
			bind,
			signal: AbortSignal.abort(),
		});
		expect(result).toBeNull();
		expect(sockets.size).toBe(0);
	});
});

describe('discoverTuyaDevice with real sockets', () => {
	it('receives a broadcast over UDP and releases the sockets', async () => {
		const bound: dgram.Socket[] = [];
		const ready: Promise<void>[] = [];
		const bind = (_port: number): dgram.Socket => {
			// Bind to an ephemeral loopback port instead of the real broadcast ports.
			const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
			ready.push(new Promise(resolve => socket.once('listening', () => resolve())));
			socket.bind(0, '127.0.0.1');
			bound.push(socket);
			return socket;
		};
		const promise = discoverTuyaDevice(deviceId, { logger: createFakeLogger(), bind, timeoutMs: 5_000 });
		await Promise.all(ready);

		const sender = dgram.createSocket('udp4');
		const message = broadcast35({ gwId: deviceId, version: '3.5' });
		await new Promise<void>((resolve, reject) =>
			sender.send(message, bound[1]!.address().port, '127.0.0.1', error => (error ? reject(error) : resolve())),
		);
		sender.close();

		await expect(promise).resolves.toEqual({ host: '127.0.0.1', version: '3.5' });
		for (const socket of bound) {
			expect(() => socket.address()).toThrow();
		}
	});
});
