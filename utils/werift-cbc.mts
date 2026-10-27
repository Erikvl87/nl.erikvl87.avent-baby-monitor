import { createCipheriv, createDecipheriv, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * TLS_ECDHE_ECDSA_WITH_AES_128_CBC_SHA256 (RFC 5289). werift's DTLS only speaks AES-GCM, but an SCD973 on camera SDK
 * 4.8.8 offers nothing but AES-CBC suites, so the relay's handshake with it can never complete without this one.
 */
export const cbcSuite = 0xc023;
const gcmEcdsaSuite = 0xc02b;
const gcmSuites = [gcmEcdsaSuite, 0xc02f];
const ecdsaSignature = 3;

const blockSize = 16;
const keyLength = 16;
const macLength = 32;

/** The record fields the MAC covers, as werift's record layer hands them over. */
export interface RecordHeader {
	type: number;
	version: number;
	epoch: number;
	sequenceNumber: number;
}

/** werift's session types: 1 is the client, 2 the server. */
const clientSession = 1;

/**
 * AES-128-CBC with HMAC-SHA256, MAC-then-encrypt with a random IV per record (RFC 5246 6.2.3.2), and the 8-byte
 * epoch + sequence number DTLS puts in the MAC (RFC 6347 4.1.2.1). It has the same shape as werift's `AEADCipher`.
 */
export class CbcCipher {
	public readonly id = cbcSuite;
	public readonly name = 'TLS_ECDHE_ECDSA_WITH_AES_128_CBC_SHA256';
	private clientMacKey?: Buffer;
	private serverMacKey?: Buffer;
	private clientWriteKey?: Buffer;
	private serverWriteKey?: Buffer;

	public get summary(): Record<string, unknown> {
		return { id: this.id, name: this.name };
	}

	/** Derives the key block (RFC 5246 6.3); TLS 1.2 CBC has no IVs in it, every record carries its own. */
	public init(masterSecret: Buffer, serverRandom: Buffer, clientRandom: Buffer): void {
		const seed = Buffer.concat([Buffer.from('key expansion'), serverRandom, clientRandom]);
		const block = pHash(masterSecret, seed, 2 * macLength + 2 * keyLength);
		this.clientMacKey = block.subarray(0, macLength);
		this.serverMacKey = block.subarray(macLength, 2 * macLength);
		this.clientWriteKey = block.subarray(2 * macLength, 2 * macLength + keyLength);
		this.serverWriteKey = block.subarray(2 * macLength + keyLength);
	}

	public encrypt(sessionType: number, data: Buffer, header: RecordHeader): Buffer {
		const isClient = sessionType === clientSession;
		const macKey = isClient ? this.clientMacKey : this.serverMacKey;
		const key = isClient ? this.clientWriteKey : this.serverWriteKey;
		if (!macKey || !key) throw new Error('CBC cipher used before init');

		const mac = this.mac(macKey, header, data);
		const padLength = blockSize - ((data.length + mac.length + 1) % blockSize);
		const padding = Buffer.alloc(padLength + 1, padLength);
		const iv = randomBytes(blockSize);
		const cipher = createCipheriv('aes-128-cbc', key, iv).setAutoPadding(false);
		return Buffer.concat([iv, cipher.update(Buffer.concat([data, mac, padding])), cipher.final()]);
	}

	public decrypt(sessionType: number, data: Buffer, header: RecordHeader): Buffer {
		const isClient = sessionType === clientSession;
		const macKey = isClient ? this.serverMacKey : this.clientMacKey;
		const key = isClient ? this.serverWriteKey : this.clientWriteKey;
		if (!macKey || !key) throw new Error('CBC cipher used before init');
		if (data.length < 2 * blockSize || data.length % blockSize !== 0) throw new Error('Bad CBC record length');

		const decipher = createDecipheriv('aes-128-cbc', key, data.subarray(0, blockSize)).setAutoPadding(false);
		const plain = Buffer.concat([decipher.update(data.subarray(blockSize)), decipher.final()]);
		const padLength = plain[plain.length - 1];
		const contentEnd = plain.length - padLength - 1 - macLength;
		const paddingOk = contentEnd >= 0 && plain.subarray(plain.length - padLength - 1).every(byte => byte === padLength);
		// Check the MAC even when the padding is wrong, so both fail alike.
		const content = plain.subarray(0, Math.max(contentEnd, 0));
		const mac = plain.subarray(Math.max(contentEnd, 0), Math.max(contentEnd, 0) + macLength);
		const expected = this.mac(macKey, header, content);
		const macOk = mac.length === macLength && timingSafeEqual(mac, expected);
		if (!paddingOk || !macOk) throw new Error('Bad CBC record');
		return content;
	}

	private mac(key: Buffer, header: RecordHeader, data: Buffer): Buffer {
		const prefix = Buffer.alloc(13);
		prefix.writeUInt16BE(header.epoch, 0);
		prefix.writeUIntBE(header.sequenceNumber, 2, 6);
		prefix.writeUInt8(header.type, 8);
		prefix.writeUInt16BE(header.version, 9);
		prefix.writeUInt16BE(data.length, 11);
		return createHmac('sha256', key).update(prefix).update(data).digest();
	}
}

/** TLS 1.2's P_SHA256 (RFC 5246 5). */
function pHash(secret: Buffer, seed: Buffer, length: number): Buffer {
	const out: Buffer[] = [];
	let a = seed;
	let total = 0;
	while (total < length) {
		a = createHmac('sha256', secret).update(a).digest();
		const chunk = createHmac('sha256', secret).update(a).update(seed).digest();
		out.push(chunk);
		total += chunk.length;
	}
	return Buffer.concat(out).subarray(0, length);
}

/* eslint-disable @typescript-eslint/no-explicit-any */
let added = false;

/**
 * Teaches werift's DTLS server the CBC suite above. werift has no hook for cipher suites, so this replaces two of its
 * module functions: `createCipher`, which makes the record cipher, and the server's flight 2, which picks the suite.
 * Only a client that offers no AES-GCM suite gets CBC. This works on werift's CommonJS build; its ES module bundle
 * keeps these internal, so the relay loads werift through `require`.
 *
 * @param requireFromWerift a `require` that resolves relative to werift's main file
 */
export function addCbcSupport(requireFromWerift: (id: string) => any): void {
	if (added) return;
	const base = '../../dtls/src/';
	const create = requireFromWerift(`${base}cipher/create.js`);
	const flight2Module = requireFromWerift(`${base}flight/server/flight2.js`);

	const createCipher = create.createCipher;
	create.createCipher = (suite: number): unknown => (suite === cbcSuite ? new CbcCipher() : createCipher(suite));

	const flight2 = flight2Module.flight2;
	flight2Module.flight2 =
		(udp: unknown, dtls: unknown, cipher: any, srtp: unknown) =>
			(clientHello: any): unknown => {
				const suites: number[] = clientHello.cipherSuites ?? [];
				const cbcOnly =
				!suites.some(suite => gcmSuites.includes(suite)) &&
				suites.includes(cbcSuite) &&
				cipher.signatureHashAlgorithm?.signature === ecdsaSignature;
				if (!cbcOnly) return flight2(udp, dtls, cipher, srtp)(clientHello);
				// Flight 2 only accepts the GCM suite: let it settle everything else, then switch to CBC.
				clientHello.cipherSuites = [...suites, gcmEcdsaSuite];
				const result = flight2(udp, dtls, cipher, srtp)(clientHello);
				clientHello.cipherSuites = suites;
				cipher.cipherSuite = cbcSuite;
				return result;
			};
	added = true;
}
