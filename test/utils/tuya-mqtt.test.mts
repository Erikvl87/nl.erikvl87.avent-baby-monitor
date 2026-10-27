import crypto from 'node:crypto';
import { describe, it, expect } from 'vitest';
import {
	decodeDeviceMessage,
	encodeDeviceMessage,
	mqttCredentials,
	newSessionId,
	readDpsReport,
	readSignalReply,
	signalMessage,
} from '../../utils/tuya-mqtt.mjs';
import { crc32, decryptEcb } from '../../utils/tuya-lan-protocol.mjs';
import { signingKey } from '../../utils/tuya-sign.mjs';

const md5 = (value: string): string => crypto.createHash('md5').update(value).digest('hex');

const account = {
	sid: 'eu1234sid',
	uid: 'eu5678uid',
	ecode: 'ecode-abc',
	partnerIdentity: 'p1000001',
	phoneId: '0123456789abcdef0123456789abcdef',
};

describe('mqttCredentials', () => {
	// Expected values follow aventproxy's DeriveMQTTConfig, DeriveMQTTUsername and DeriveMQTTClientID.
	it('derives the password from the signing key and ecode', () => {
		expect(mqttCredentials(account).password).toBe(md5(md5(signingKey) + account.ecode).slice(8, 24));
	});

	it('derives the username from the partner, app key, channel key, session and ecode', () => {
		const tail = md5(md5('wx3at9qprkhskvkcsyhm') + account.ecode).slice(-16);
		expect(mqttCredentials(account).username).toBe(
			`p1000001_v1_wx3at9qprkhskvkcsyhm_071d81fa_mb_${account.sid}${tail}`,
		);
	});

	it('derives the client id from the package, phone id and user id', () => {
		expect(mqttCredentials(account).clientId).toBe(
			`com.philips.ph.babymonitorplus_mb_${account.phoneId}_${md5(account.uid + 'sdkfasodifca')}_DEFAULT`,
		);
	});

	it('listens on the user topic', () => {
		expect(mqttCredentials(account).topic).toBe('/av/u/eu5678uid');
	});
});

describe('signalMessage', () => {
	it('wraps a message in the envelope the camera expects', () => {
		const message = signalMessage(
			302,
			'offer',
			{ uid: 'u1', deviceId: 'd1', sessionId: 's1', motoId: 'm1' },
			{ mode: 'webrtc' },
			1234,
		);
		expect(message).toEqual({
			protocol: 302,
			pv: '2.2',
			t: 1234,
			data: {
				header: {
					type: 'offer',
					from: 'u1',
					to: 'd1',
					// eslint-disable-next-line @typescript-eslint/naming-convention
					sub_dev_id: '',
					sessionid: 's1',
					// eslint-disable-next-line @typescript-eslint/naming-convention
					moto_id: 'm1',
					tid: '',
					seq: 0,
					rtx: 0,
				},
				msg: { mode: 'webrtc' },
			},
		});
	});
});

describe('newSessionId', () => {
	it('is 32 hex characters and different each time', () => {
		expect(newSessionId()).toMatch(/^[0-9a-f]{32}$/);
		expect(newSessionId()).not.toBe(newSessionId());
	});
});

describe('device channel messages', () => {
	const key = Buffer.from('0123456789abcdef', 'latin1');

	it('lays out the 2.2 envelope: version, CRC32 of the rest, sequence, source, ECB body', () => {
		const source = Buffer.from([1, 2, 3, 4]);
		const message = encodeDeviceMessage(key, 22, { reqType: 'sigQry' }, 7, source, 1_700_000_000_000);
		expect(message.subarray(0, 3).toString()).toBe('2.2');
		expect(message.readUInt32BE(3)).toBe(crc32(message.subarray(7)));
		expect(message.readUInt32BE(7)).toBe(7);
		expect(message.subarray(11, 15)).toEqual(source);
		expect(JSON.parse(decryptEcb(key, message.subarray(15)).toString())).toEqual({
			data: { reqType: 'sigQry' },
			protocol: 22,
			t: 1_700_000_000,
		});
	});

	it('reads one back, and refuses a damaged one', () => {
		const message = encodeDeviceMessage(key, 23, { reqType: 'sigQry', data: { signal: 98 } }, 1);
		expect(decodeDeviceMessage(key, message)).toEqual({
			protocol: 23,
			data: { reqType: 'sigQry', data: { signal: 98 } },
		});
		const damaged = Buffer.from(message);
		damaged[20] ^= 1;
		expect(() => decodeDeviceMessage(key, damaged)).toThrow(/CRC/);
		expect(() => decodeDeviceMessage(key, Buffer.from('{"protocol":23}'))).toThrow();
	});

	it('takes the percentage from a signal reply only', () => {
		expect(readSignalReply({ protocol: 23, data: { reqType: 'sigQry', data: { signal: 87 } } })).toBe(87);
		expect(readSignalReply({ protocol: 23, data: { reqType: 'sigQry', data: { signal: '98' } } })).toBe(98);
		expect(readSignalReply({ protocol: 4, data: { reqType: 'sigQry', data: { signal: 87 } } })).toBeUndefined();
		expect(readSignalReply({ protocol: 23, data: { reqType: 'other', data: { signal: 87 } } })).toBeUndefined();
		expect(readSignalReply({ protocol: 23, data: { reqType: 'sigQry', data: { signal: -75 } } })).toBeUndefined();
	});

	it('takes the data points from a report only', () => {
		// eslint-disable-next-line @typescript-eslint/naming-convention
		expect(readDpsReport({ protocol: 4, data: { dps: { '207': 1860 } } })).toEqual({ '207': 1860 });
		expect(readDpsReport({ protocol: 4, data: { dps: [1] } })).toBeUndefined();
		expect(readDpsReport({ protocol: 4, data: null })).toBeUndefined();
		// eslint-disable-next-line @typescript-eslint/naming-convention
		expect(readDpsReport({ protocol: 23, data: { dps: { '207': 1860 } } })).toBeUndefined();
	});
});
