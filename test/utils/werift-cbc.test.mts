import { execFileSync, spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import { addCbcSupport, CbcCipher, cbcSuite } from '../../utils/werift-cbc.mjs';

const header = { type: 23, version: 0xfefd, epoch: 1, sequenceNumber: 7 };

function pair(): { client: CbcCipher; server: CbcCipher } {
	const master = Buffer.alloc(48, 1);
	const serverRandom = Buffer.alloc(32, 2);
	const clientRandom = Buffer.alloc(32, 3);
	const client = new CbcCipher();
	const server = new CbcCipher();
	client.init(master, serverRandom, clientRandom);
	server.init(master, serverRandom, clientRandom);
	return { client, server };
}

const client = 1;
const server = 2;

describe('CbcCipher', () => {
	it.each([0, 1, 15, 16, 17, 1200])('round-trips %i bytes in both directions', size => {
		const ciphers = pair();
		const data = Buffer.alloc(size, 0xab);
		const fromClient = ciphers.client.encrypt(client, data, header);
		expect(fromClient.length % 16).toBe(0);
		expect(ciphers.server.decrypt(server, fromClient, header)).toEqual(data);
		const fromServer = ciphers.server.encrypt(server, data, header);
		expect(ciphers.client.decrypt(client, fromServer, header)).toEqual(data);
	});

	it('rejects a tampered record, and one under another sequence number', () => {
		const ciphers = pair();
		const record = ciphers.client.encrypt(client, Buffer.from('hello'), header);
		const tampered = Buffer.from(record);
		tampered[tampered.length - 20] ^= 1;
		expect(() => ciphers.server.decrypt(server, tampered, header)).toThrow();
		expect(() => ciphers.server.decrypt(server, record, { ...header, sequenceNumber: 8 })).toThrow();
	});
});

function hasOpenssl(): boolean {
	try {
		execFileSync('openssl', ['version']);
		return true;
	} catch {
		return false;
	}
}

describe('werift with CBC support', () => {
	// A real DTLS 1.2 client that only offers the CBC suite, as the SCD973 on camera SDK 4.8.8 does.
	it.skipIf(!hasOpenssl())(
		'completes a handshake and exchanges data with a client that offers only AES-CBC',
		async () => {
			const requireWerift = createRequire(createRequire(import.meta.url).resolve('werift'));
			addCbcSupport(requireWerift);
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			const werift = requireWerift('werift') as any;
			// eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/naming-convention
			const { DtlsServer } = requireWerift('../../dtls/src/index.js') as any;
			// eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/naming-convention
			const { UdpTransport } = requireWerift('../../common/src/transport.js') as any;

			const keys = await werift.CipherContext.createSelfSignedCertificateWithKey(
				{ signature: werift.SignatureAlgorithm.ecdsa_3, hash: werift.HashAlgorithm.sha256_4 },
				werift.NamedCurveAlgorithm.secp256r1_23,
			);
			const transport = await UdpTransport.init('udp4');
			const dtls = new DtlsServer({
				transport,
				cert: keys.certPem,
				key: keys.keyPem,
				signatureHash: keys.signatureHash,
				certificateRequest: false,
			});
			const received: string[] = [];
			dtls.onData.subscribe((data: Buffer) => {
				received.push(data.toString());
				void dtls.send(Buffer.from('pong\n'));
			});

			const openssl = spawn('openssl', [
				's_client',
				'-dtls1_2',
				'-connect',
				`127.0.0.1:${transport.port}`,
				'-cipher',
				'ECDHE-ECDSA-AES128-SHA256',
				'-quiet',
			]);
			let output = '';
			openssl.stdout.on('data', chunk => (output += String(chunk)));
			openssl.stderr.on('data', chunk => (output += String(chunk)));
			await new Promise<void>(resolve => dtls.onConnect.subscribe(() => resolve()));
			openssl.stdin.write('ping\n');
			await new Promise<void>(resolve => {
				const check = setInterval(() => {
					if (output.includes('pong')) {
						clearInterval(check);
						resolve();
					}
				}, 50);
			});
			openssl.kill();
			await transport.close();

			expect(dtls.cipher.cipherSuite).toBe(cbcSuite);
			expect(received.join('')).toContain('ping');
			expect(output).toContain('pong');
		},
		20_000,
	);
});
