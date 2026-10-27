import crypto from 'node:crypto';

/**
 * The key the Philips Avent Baby Monitor+ app signs its Tuya requests with: package name, signing certificate hash,
 * embedded key and app secret, joined by underscores. It identifies the app, not the user, and is the same for every
 * install of a given app version.
 */
export const signingKey =
	'com.philips.ph.babymonitorplus_D2:D6:95:A1:1D:1B:84:F9:25:A9:45:6E:27:F4:45:E9:FD:87:C3:74:63:AA:8A:34:32:A6:6A:23:3B:0F:D5:0F_8n459nxk9g98gqgcwrpk3csv97uuwajm_a3nfht4ufwfw9cmkspaftv4x89cx58qx';

/** Only these request fields are part of the signature; anything else (like `gid`) may be added after signing. */
const signedFields = new Set([
	'a',
	'v',
	'lat',
	'lon',
	'lang',
	'deviceId',
	'appVersion',
	'ttid',
	'isH5',
	'h5Token',
	'os',
	'clientId',
	'postData',
	'time',
	'requestId',
	'et',
	'n4h5',
	'sid',
	'chKey',
	'sp',
]);

/** Swaps the 8-character quarters of an md5 hex digest the way the Tuya SDK does before signing `postData`. */
function swapDigest(digest: string): string {
	if (digest.length !== 32) return digest;
	return digest.slice(8, 16) + digest.slice(0, 8) + digest.slice(24, 32) + digest.slice(16, 24);
}

export function md5Hex(value: string): string {
	return crypto.createHash('md5').update(value).digest('hex');
}

/**
 * Signs a Tuya mobile API request: the whitelisted, non-empty fields sorted by name, joined as `key=value` with `||`,
 * HMAC-SHA256'd with the app's signing key. `postData` is replaced by its swapped md5 first.
 */
export function signRequest(params: Record<string, string>, key: string = signingKey): string {
	const parts = Object.keys(params)
		.filter(name => signedFields.has(name) && params[name])
		.sort()
		.map(name => `${name}=${name === 'postData' ? swapDigest(md5Hex(params[name])) : params[name]}`);
	return crypto.createHmac('sha256', key).update(parts.join('||')).digest('hex');
}

/** Encrypts the password for login: the md5 hex of the password, RSA PKCS#1 v1.5 encrypted with Tuya's one-time key. */
export function encryptPassword(password: string, publicKey: string): string {
	const pem = `-----BEGIN PUBLIC KEY-----\n${publicKey}\n-----END PUBLIC KEY-----`;
	return crypto
		.publicEncrypt({ key: pem, padding: crypto.constants.RSA_PKCS1_PADDING }, Buffer.from(md5Hex(password)))
		.toString('hex');
}
