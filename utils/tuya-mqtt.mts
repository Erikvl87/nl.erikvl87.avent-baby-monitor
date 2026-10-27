import crypto from 'node:crypto';
import { md5Hex, signingKey } from './tuya-sign.mjs';
import { crc32, decryptEcb, encryptEcb } from './tuya-lan-protocol.mjs';

/** The Philips Avent Baby Monitor+ app's Tuya client id, channel key and package name. */
export const appKey = 'wx3at9qprkhskvkcsyhm';
export const channelKey = '071d81fa';
const packageName = 'com.philips.ph.babymonitorplus';

export interface MqttAccount {
	sid: string;
	uid: string;
	ecode: string;
	partnerIdentity: string;
	phoneId: string;
}

export interface MqttCredentials {
	clientId: string;
	username: string;
	password: string;
	/** The topic the camera answers on. */
	topic: string;
}

/**
 * The credentials the phone app connects to Tuya's MQTT broker with, derived from the session the way the Tuya SDK
 * does. The same client id kicks an earlier connection, so there must only be one connection per account.
 */
export function mqttCredentials(account: MqttAccount): MqttCredentials {
	const msid = md5Hex(md5Hex(appKey) + account.ecode).slice(-16);
	return {
		clientId: `${packageName}_mb_${account.phoneId}_${md5Hex(account.uid + 'sdkfasodifca')}_DEFAULT`,
		username: `${account.partnerIdentity}_v1_${appKey}_${channelKey}_mb_${account.sid}${msid}`,
		password: md5Hex(md5Hex(signingKey) + account.ecode).slice(8, 24),
		topic: `/av/u/${account.uid}`,
	};
}

/** A random 32-character hex id for one stream's signalling. */
export function newSessionId(): string {
	return crypto.randomBytes(16).toString('hex');
}

/** The envelope Tuya wraps every WebRTC signalling message in, both ways. */
export interface SignalMessage {
	protocol: number;
	pv: string;
	t: number;
	data: {
		header: {
			type: string;
			from: string;
			to: string;
			// eslint-disable-next-line @typescript-eslint/naming-convention
			sub_dev_id: string;
			sessionid: string;
			// eslint-disable-next-line @typescript-eslint/naming-convention
			moto_id: string;
			tid: string;
			seq: number;
			rtx: number;
		};
		msg: Record<string, unknown>;
	};
}

export function signalMessage(
	protocol: number,
	type: string,
	ids: { uid: string; deviceId: string; sessionId: string; motoId: string },
	msg: Record<string, unknown>,
	now: number = Date.now(),
): SignalMessage {
	return {
		protocol,
		pv: '2.2',
		t: now,
		data: {
			header: {
				type,
				from: ids.uid,
				to: ids.deviceId,
				// eslint-disable-next-line @typescript-eslint/naming-convention
				sub_dev_id: '',
				sessionid: ids.sessionId,
				// eslint-disable-next-line @typescript-eslint/naming-convention
				moto_id: ids.motoId,
				tid: '',
				seq: 0,
				rtx: 0,
			},
			msg,
		},
	};
}

/**
 * The "2.2" envelope of a device channel message (`smart/mb/out/<devId>` and `smart/mb/in/<devId>`): "2.2", the CRC32
 * of the rest, a sequence number, a 4-byte source id, then `{"data","protocol","t"}` AES-128-ECB'd with the device's
 * local key. Layout from github.com/roquerodrigo/tuya-ipc-p2p-sdk (`signaling/envelope.py`).
 */
export function encodeDeviceMessage(
	localKey: Buffer,
	protocol: number,
	data: unknown,
	sequence: number,
	source: Buffer = crypto.randomBytes(4),
	now: number = Date.now(),
): Buffer {
	const plain = Buffer.from(JSON.stringify({ data, protocol, t: Math.floor(now / 1000) }), 'utf8');
	const sequenceBytes = Buffer.alloc(4);
	sequenceBytes.writeUInt32BE(sequence >>> 0);
	const tail = Buffer.concat([sequenceBytes, source.subarray(0, 4), encryptEcb(localKey, plain)]);
	const crc = Buffer.alloc(4);
	crc.writeUInt32BE(crc32(tail));
	return Buffer.concat([Buffer.from('2.2', 'latin1'), crc, tail]);
}

export interface DeviceMessage {
	protocol: number;
	data: unknown;
}

/** Reads a "2.2" device channel message; throws when it isn't one or doesn't decrypt. */
export function decodeDeviceMessage(localKey: Buffer, payload: Buffer): DeviceMessage {
	if (payload.length < 15 + 16 || payload.subarray(0, 3).toString('latin1') !== '2.2') {
		throw new Error('Not a 2.2 device message');
	}
	if (crc32(payload.subarray(7)) !== payload.readUInt32BE(3)) throw new Error('Device message CRC mismatch');
	const json = JSON.parse(decryptEcb(localKey, payload.subarray(15)).toString('utf8')) as {
		protocol?: unknown;
		data?: unknown;
	};
	return { protocol: Number(json.protocol), data: json.data };
}

/**
 * The Wi-Fi signal query Tuya's camera panels send (protocol 22, `{"reqType":"sigQry"}`, as in tuya-panel-kit's
 * `sendMqttData`). The camera answers with protocol 23, `{"reqType":"sigQry","data":{"signal":<percent>}}`.
 */
export const signalQuery = { protocol: 22, data: { reqType: 'sigQry' } } as const;

/** The signal percentage in a reply to {@link signalQuery}, or undefined when the message is something else. */
export function readSignalReply(message: DeviceMessage): number | undefined {
	const data = message.data as { reqType?: unknown; data?: { signal?: unknown } } | null;
	if (message.protocol !== 23 || data?.reqType !== 'sigQry') return undefined;
	const signal = Number(data.data?.signal);
	return Number.isFinite(signal) && signal >= 0 && signal <= 100 ? signal : undefined;
}

/**
 * The data points in a camera's report on its device channel (protocol 4, `{"dps":{...}}`), as it sends them on every
 * change it makes itself, or undefined when the message is something else.
 */
export function readDpsReport(message: DeviceMessage): Record<string, unknown> | undefined {
	const dps = (message.data as { dps?: unknown } | null)?.dps;
	if (message.protocol !== 4 || !dps || typeof dps !== 'object' || Array.isArray(dps)) return undefined;
	return dps as Record<string, unknown>;
}
