import dgram from 'node:dgram';
import type { Logger } from '../Logger.mjs';
import { decodeBroadcast, parseAnnouncedVersion, type TuyaLanVersion } from './tuya-lan-protocol.mjs';

/**
 * UDP ports Tuya devices broadcast their presence on: 6666 for unencrypted
 * (3.1) announcements, 6667 for encrypted ones (3.3 in 55AA/ECB framing, 3.5 in
 * 6699/GCM framing).
 */
export const discoveryPorts: readonly number[] = [6666, 6667];

export interface DiscoverTuyaDeviceOptions {
	logger: Logger;
	/** How long to listen before giving up. Devices broadcast every few seconds. Defaults to 20 s. */
	timeoutMs?: number;
	/** Stops listening early, resolving with null. */
	signal?: AbortSignal;
	/** For tests: creates a socket bound to the given port. Errors (e.g. EADDRINUSE) must surface as 'error' events. */
	bind?: (port: number) => dgram.Socket;
}

export interface DiscoveredTuyaDevice {
	host: string;
	version: TuyaLanVersion;
}

function bindDiscoverySocket(port: number): dgram.Socket {
	// reuseAddr so other listeners on the same Homey (or another app) do not
	// lock us out of the broadcast ports.
	const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
	socket.bind(port);
	return socket;
}

/**
 * Listens for the device's discovery broadcast and returns its address and
 * the protocol version it announces, or null when it is not heard within the
 * timeout or the ports cannot be opened. Never rejects, and always closes the
 * sockets it opened.
 */
export async function discoverTuyaDevice(
	deviceId: string,
	options: DiscoverTuyaDeviceOptions,
): Promise<DiscoveredTuyaDevice | null> {
	const { logger, signal } = options;
	const timeoutMs = options.timeoutMs ?? 20_000;
	const bind = options.bind ?? bindDiscoverySocket;

	if (signal?.aborted) {
		return null;
	}

	return new Promise<DiscoveredTuyaDevice | null>(resolve => {
		const sockets = new Set<dgram.Socket>();
		let settled = false;
		let timer: ReturnType<typeof setTimeout> | null = null;

		const closeSocket = (socket: dgram.Socket): void => {
			sockets.delete(socket);
			try {
				socket.close();
			} catch {
				// Already closed or never bound; nothing left to release.
			}
		};

		const finish = (result: DiscoveredTuyaDevice | null): void => {
			if (settled) {
				return;
			}
			settled = true;
			if (timer) {
				clearTimeout(timer);
				timer = null;
			}
			signal?.removeEventListener('abort', onAbort);
			for (const socket of [...sockets]) {
				closeSocket(socket);
			}
			resolve(result);
		};

		const onAbort = (): void => finish(null);

		const onMessage = (message: Buffer, remote: dgram.RemoteInfo): void => {
			const announcement = decodeBroadcast(message);
			if (!announcement || announcement.gwId !== deviceId) {
				return;
			}
			const host = typeof announcement.ip === 'string' && announcement.ip ? announcement.ip : remote.address;
			const version = parseAnnouncedVersion(announcement.version);
			logger.log(
				`Found device at ${host}, announcing protocol ${String(announcement.version ?? 'unknown')} (using ${version})`,
			);
			finish({ host, version });
		};

		for (const port of discoveryPorts) {
			let socket: dgram.Socket;
			try {
				socket = bind(port);
			} catch (error) {
				logger.error(error);
				continue;
			}
			sockets.add(socket);
			socket.on('message', onMessage);
			socket.on('error', (error: NodeJS.ErrnoException) => {
				if (settled || !sockets.has(socket)) {
					return;
				}
				if (error.code === 'EADDRINUSE') {
					logger.log(`UDP port ${port} is in use, not listening on it for discovery`);
				} else {
					logger.error(error);
				}
				closeSocket(socket);
				if (sockets.size === 0) {
					finish(null);
				}
			});
		}

		if (sockets.size === 0) {
			finish(null);
			return;
		}

		signal?.addEventListener('abort', onAbort, { once: true });
		timer = setTimeout(() => {
			logger.log(`Device not heard on the LAN within ${Math.round(timeoutMs / 1000)} s`);
			finish(null);
		}, timeoutMs);
	});
}
