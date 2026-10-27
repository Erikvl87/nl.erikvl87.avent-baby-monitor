import crypto from 'node:crypto';
import { describe, it, expect } from 'vitest';
import { encryptPassword, md5Hex, signRequest, signingKey } from '../../utils/tuya-sign.mjs';

/** A request captured from the reference implementation, with the signature it produced. */
const referenceParams: Record<string, string> = {
	a: 'smartlife.p.time.get',
	v: '1.0',
	et: '0.0.1',
	time: '1776696747',
	requestId: 'test-1234',
	sid: 'eu166195w4946940N8j46e73ef27267bf8e9b205b8e052debb5e1683',
	deviceId: '4ea1245dcfe5ebfaae4fe06ed2c7344fd1aab9698a1f',
	appVersion: '1.8.0',
	ttid: 'sdk_international@wx3at9qprkhskvkcsyhm',
	os: 'Android',
	lang: 'en_US',
	chKey: '071d81fa',
};
const referenceSign = '02995e4c41e8bdd0d81d0b041d864668aecca6abef3576cbfdfa8add16b816d8';

function generatePublicKey(): { publicKey: string; privateKey: crypto.KeyObject } {
	const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 1024 });
	return { publicKey: publicKey.export({ type: 'spki', format: 'der' }).toString('base64'), privateKey };
}

describe('md5Hex', () => {
	it('returns the lowercase hex md5 digest', () => {
		expect(md5Hex('password')).toBe('5f4dcc3b5aa765d61d8327deb882cf99');
	});
});

describe('signRequest', () => {
	it('signs the reference request to the known signature', () => {
		expect(signRequest(referenceParams)).toBe(referenceSign);
	});

	it('uses the app signing key by default', () => {
		expect(signRequest(referenceParams, signingKey)).toBe(referenceSign);
		expect(signRequest(referenceParams, 'another-key')).not.toBe(referenceSign);
	});

	it('does not depend on the order the fields were added in', () => {
		const reversed = Object.fromEntries(Object.entries(referenceParams).reverse());
		expect(signRequest(reversed)).toBe(referenceSign);
	});

	it('ignores fields that are not on the signing whitelist', () => {
		const params = { ...referenceParams, gid: '12345', platform: 'homey', cp: 'gzip', timeZoneId: 'Europe/Amsterdam' };
		expect(signRequest(params)).toBe(referenceSign);
	});

	it('ignores whitelisted fields that are empty', () => {
		expect(signRequest({ ...referenceParams, lat: '', lon: '', clientId: '' })).toBe(referenceSign);
	});

	it('changes when a whitelisted field changes', () => {
		expect(signRequest({ ...referenceParams, time: '1776696748' })).not.toBe(referenceSign);
		expect(signRequest({ ...referenceParams, clientId: 'wx3at9qprkhskvkcsyhm' })).not.toBe(referenceSign);
	});

	it('includes postData in the signature', () => {
		const withPostData = signRequest({ ...referenceParams, postData: '{"devId":"abc"}' });
		const withOtherPostData = signRequest({ ...referenceParams, postData: '{"devId":"abd"}' });
		expect(withPostData).not.toBe(referenceSign);
		expect(withOtherPostData).not.toBe(withPostData);
	});

	it('signs postData as its md5 with the quarters swapped, not as the raw value', () => {
		const postData = '{"devId":"abc"}';
		const digest = md5Hex(postData);
		const swapped = digest.slice(8, 16) + digest.slice(0, 8) + digest.slice(24, 32) + digest.slice(16, 24);
		const expected = crypto.createHmac('sha256', signingKey).update(`a=x||postData=${swapped}`).digest('hex');
		expect(signRequest({ a: 'x', postData })).toBe(expected);
	});

	it('produces a 64-character hex string', () => {
		expect(signRequest(referenceParams)).toMatch(/^[0-9a-f]{64}$/);
	});
});

describe('encryptPassword', () => {
	it('encrypts the md5 hex of the password so the private key can recover it', () => {
		const { publicKey, privateKey } = generatePublicKey();
		const encrypted = encryptPassword('hunter2', publicKey);
		const decrypted = crypto
			.privateDecrypt({ key: privateKey, padding: crypto.constants.RSA_PKCS1_PADDING }, Buffer.from(encrypted, 'hex'))
			.toString('utf8');
		expect(decrypted).toBe(md5Hex('hunter2'));
	});

	it('returns hex the length of the key modulus', () => {
		const { publicKey } = generatePublicKey();
		expect(encryptPassword('hunter2', publicKey)).toMatch(/^[0-9a-f]{256}$/);
	});

	it('uses random padding, so encrypting twice gives different output', () => {
		const { publicKey } = generatePublicKey();
		expect(encryptPassword('hunter2', publicKey)).not.toBe(encryptPassword('hunter2', publicKey));
	});

	it('throws on a key that is not a valid public key', () => {
		expect(() => encryptPassword('hunter2', 'bm90LWEta2V5')).toThrow();
	});
});
