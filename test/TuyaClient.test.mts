import crypto from 'node:crypto';
import { describe, it, expect, beforeAll } from 'vitest';
import TuyaClient, { type PendingLogin, type TuyaSession } from '../TuyaClient.mjs';
import HttpError from '../errors/http-error.mjs';
import TuyaError from '../errors/tuya-error.mjs';
import { Dp } from '../utils/dps.mjs';
import { md5Hex, signRequest } from '../utils/tuya-sign.mjs';
import { loginCandidates } from '../utils/region.mjs';
import { createFakeLogger, type FakeLogger } from './helpers/fake-logger.mjs';
import { buildFakeResponse, createFakeFetch, type FakeFetch, type FakeFetchCall } from './helpers/fake-fetch.mjs';

const fixedNow = 1776696747123;
const fixedRequestId = 'test-request-id';

const session: TuyaSession = {
	sid: 'eu166195w4946940N8j46e73ef27267bf8e9b205b8e052debb5e1683',
	uid: 'eu1700000000000abcd',
	email: 'parent@example.com',
	apiHost: 'a1.tuyaeu.com',
	callingCode: '31',
	phoneId: '4ea1245dcfe5ebfaae4fe06ed2c7344f',
};

let publicKey: string;
let privateKey: crypto.KeyObject;

beforeAll(() => {
	const pair = crypto.generateKeyPairSync('rsa', { modulusLength: 1024 });
	publicKey = pair.publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
	privateKey = pair.privateKey;
});

function tuyaOk(result: unknown): Response {
	return buildFakeResponse({ body: { success: true, result, t: 1776696747 } });
}

function tuyaFail(errorCode: string, errorMsg = 'Request failed'): Response {
	return buildFakeResponse({ body: { success: false, errorCode, errorMsg, t: 1776696747 } });
}

function rsaToken(token: string): Response {
	return tuyaOk({ token, pbKey: publicKey, exponent: '65537' });
}

/** The form fields of a recorded request. */
function form(call: FakeFetchCall): Record<string, string> {
	return Object.fromEntries(new URLSearchParams(call.init?.body as string));
}

function postData(call: FakeFetchCall): Record<string, unknown> {
	return JSON.parse(form(call).postData) as Record<string, unknown>;
}

function actions(fetch: FakeFetch): string[] {
	return fetch.calls.map(call => form(call).a);
}

function decryptPasswd(call: FakeFetchCall): string {
	const encrypted = String(postData(call).passwd);
	return crypto
		.privateDecrypt({ key: privateKey, padding: crypto.constants.RSA_PKCS1_PADDING }, Buffer.from(encrypted, 'hex'))
		.toString('utf8');
}

function buildClient(
	responses: Parameters<typeof createFakeFetch>[0],
	options: { session?: TuyaSession } = { session },
): { client: TuyaClient; fetch: FakeFetch; logger: FakeLogger } {
	const fetch = createFakeFetch(responses);
	const logger = createFakeLogger();
	const client = new TuyaClient({
		logger,
		session: options.session,
		fetch,
		now: (): number => fixedNow,
		requestId: (): string => fixedRequestId,
	});
	return { client, fetch, logger };
}

/** A fake fetch that answers every request through one routing function, for flows with many fallbacks. */
function buildRoutedClient(route: (fields: Record<string, string>) => Response): {
	client: TuyaClient;
	fetch: FakeFetch;
	logger: FakeLogger;
} {
	const responder = (call: FakeFetchCall): Response => route(form(call));
	return buildClient(Array.from({ length: 30 }, () => responder));
}

function pendingFor(country: string, phoneId = session.phoneId): PendingLogin {
	return { email: 'parent@example.com', password: 'hunter2', candidate: loginCandidates(country)[0], phoneId };
}

describe('TuyaClient requests', () => {
	it('POSTs a form-encoded body to the session host', async () => {
		const { client, fetch } = buildClient([tuyaOk({ devId: 'cam1' })]);
		await client.getDevice('cam1');

		expect(fetch.calls).toHaveLength(1);
		const [call] = fetch.calls;
		expect(call.url).toBe('https://a1.tuyaeu.com/api.json');
		expect(call.init?.method).toBe('POST');
		const headers = call.init?.headers as Record<string, string>;
		expect(headers['Content-Type']).toBe('application/x-www-form-urlencoded');
		expect(headers['User-Agent']).toBe('Thing-UA=APP/Android/1.8.0/SDK/6.7.0');
		expect(typeof call.init?.body).toBe('string');
	});

	it('sends the action, version, session, device and fixed time and request id', async () => {
		const { client, fetch } = buildClient([tuyaOk({ devId: 'cam1' })]);
		await client.getDevice('cam1');

		const fields = form(fetch.calls[0]);
		expect(fields).toMatchObject({
			a: 'tuya.m.device.get',
			v: '1.0',
			sid: session.sid,
			deviceId: session.phoneId,
			time: '1776696747',
			requestId: fixedRequestId,
			clientId: 'wx3at9qprkhskvkcsyhm',
			chKey: '071d81fa',
			ttid: 'sdk_international@wx3at9qprkhskvkcsyhm',
			appVersion: '1.8.0',
			et: '0.0.1',
			os: 'Android',
			lang: 'en_US',
		});
		expect(JSON.parse(fields.postData)).toEqual({ devId: 'cam1' });
	});

	it('signs the request over its own fields', async () => {
		const { client, fetch } = buildClient([tuyaOk({ devId: 'cam1' })]);
		await client.getDevice('cam1');

		const { sign, ...unsigned } = form(fetch.calls[0]);
		expect(sign).toMatch(/^[0-9a-f]{64}$/);
		expect(sign).toBe(signRequest(unsigned));
	});

	it('leaves postData out when there is none', async () => {
		const { client, fetch } = buildClient([tuyaOk([]), tuyaOk([])]);
		await client.getCameras();

		const fields = form(fetch.calls[0]);
		expect(fields.a).toBe('m.life.home.space.list');
		expect(fields).not.toHaveProperty('postData');
	});

	it('adds the gid extra parameter after signing', async () => {
		const { client, fetch } = buildRoutedClient(fields => {
			if (fields.a === 'm.life.home.space.list') return tuyaOk([{ gid: 42, name: 'Home' }]);
			return tuyaOk([{ deviceList: [{ devId: 'cam1', name: 'Nursery', productId: 'p1', category: 'sp' }] }]);
		});
		await client.getCameras();

		const locationCall = fetch.calls[1];
		const fields = form(locationCall);
		expect(fields.a).toBe('tuya.m.location.get');
		expect(fields.gid).toBe('42');
		expect(JSON.parse(fields.postData)).toEqual({ gid: '42' });

		const keys = Object.keys(fields);
		expect(keys.indexOf('gid')).toBeGreaterThan(keys.indexOf('sign'));
		const { sign, gid: _gid, ...signed } = fields;
		expect(sign).toBe(signRequest(signed));
	});

	it('throws a TuyaError with the code when Tuya answers success false', async () => {
		const { client } = buildClient([tuyaFail('SID_INVALID', 'session invalid')]);
		const error = await client.getDevice('cam1').catch((caught: unknown) => caught);

		expect(error).toBeInstanceOf(TuyaError);
		expect((error as TuyaError).code).toBe('SID_INVALID');
		expect((error as TuyaError).message).toBe('SID_INVALID: session invalid');
		expect((error as TuyaError).isSessionExpired).toBe(true);
	});

	it('uses UNKNOWN when a failure has no error code', async () => {
		const { client } = buildClient([buildFakeResponse({ body: { success: false } })]);
		const error = await client.getDevice('cam1').catch((caught: unknown) => caught);

		expect(error).toBeInstanceOf(TuyaError);
		expect((error as TuyaError).code).toBe('UNKNOWN');
		expect((error as TuyaError).message).toContain('tuya.m.device.get');
	});

	it('throws an HttpError with status and body on a non-2xx response', async () => {
		const { client } = buildClient([buildFakeResponse({ status: 502, bodyText: 'Bad Gateway' })]);
		const error = await client.getDevice('cam1').catch((caught: unknown) => caught);

		expect(error).toBeInstanceOf(HttpError);
		expect((error as HttpError).status).toBe(502);
		expect((error as HttpError).body).toBe('Bad Gateway');
		expect((error as HttpError).message).toContain('tuya.m.device.get');
	});

	it('refuses to make a request without a session', async () => {
		const { client, fetch } = buildClient([], { session: undefined });
		await expect(client.getDevice('cam1')).rejects.toThrow('Not signed in');
		expect(fetch.calls).toHaveLength(0);
	});

	it('exposes the session it was given', () => {
		const { client } = buildClient([]);
		expect(client.getSession()).toEqual(session);
	});
});

describe('TuyaClient requestLoginCode', () => {
	it('checks the password and asks Tuya to email a code', async () => {
		const { client, fetch, logger } = buildClient(
			[rsaToken('token-1'), tuyaFail('MFA_NEED_SEND_CODE'), rsaToken('token-2'), tuyaOk(true)],
			{ session: undefined },
		);

		const pending = await client.requestLoginCode('parent@example.com', 'hunter2', 'NL');

		expect(actions(fetch)).toEqual([
			'thing.m.user.username.token.get',
			'thing.m.user.email.password.login',
			'thing.m.user.username.token.get',
			'thing.m.user.username.mfa.code.get',
		]);
		expect(fetch.calls.map(call => call.url)).toEqual(Array(4).fill('https://a1.tuyaeu.com/api.json'));
		expect(fetch.calls.map(call => form(call).v)).toEqual(['2.0', '3.0', '2.0', '1.0']);
		expect(fetch.calls.map(call => form(call).sid)).toEqual(['', '', '', '']);

		expect(postData(fetch.calls[0])).toEqual({ countryCode: '31', username: 'parent@example.com', isUid: false });

		const login = postData(fetch.calls[1]);
		expect(login).toMatchObject({
			countryCode: '31',
			email: 'parent@example.com',
			token: 'token-1',
			ifencrypt: 1,
			options: '{"group":1,"mfaCode":""}',
		});
		expect(decryptPasswd(fetch.calls[1])).toBe(md5Hex('hunter2'));

		const codeRequest = postData(fetch.calls[3]);
		expect(codeRequest).toMatchObject({
			countryCode: '31',
			username: 'parent@example.com',
			token: 'token-2',
			ifencrypt: 1,
			options: '{"group":1,"mfaCode":"null"}',
		});
		expect(decryptPasswd(fetch.calls[3])).toBe(md5Hex('hunter2'));

		expect(pending).toEqual({
			email: 'parent@example.com',
			password: 'hunter2',
			candidate: { dataCenter: 'eu', host: 'a1.tuyaeu.com', callingCode: '31' },
			phoneId: expect.stringMatching(/^[0-9a-f]{32}$/),
		});
		expect(fetch.calls.every(call => form(call).deviceId === pending.phoneId)).toBe(true);
		expect(logger.logs.map(args => args[0])).toContain('Verification code sent via data center eu');
		expect(client.getSession()).toBeUndefined();
	});

	it('moves on to the next data center when the account does not exist', async () => {
		const { client, fetch } = buildClient(
			[
				rsaToken('eu-token'),
				tuyaFail('USER_NOT_EXIST'),
				rsaToken('us-token-1'),
				tuyaFail('MFA_NEED_SEND_CODE'),
				rsaToken('us-token-2'),
				tuyaOk(true),
			],
			{ session: undefined },
		);

		const pending = await client.requestLoginCode('parent@example.com', 'hunter2', 'NL');

		expect(pending.candidate).toEqual({ dataCenter: 'us', host: 'a1.tuyaus.com', callingCode: '1' });
		expect(fetch.calls.map(call => new URL(call.url).host)).toEqual([
			'a1.tuyaeu.com',
			'a1.tuyaeu.com',
			'a1.tuyaus.com',
			'a1.tuyaus.com',
			'a1.tuyaus.com',
			'a1.tuyaus.com',
		]);
		expect(postData(fetch.calls[2]).countryCode).toBe('1');
		expect(postData(fetch.calls[5]).countryCode).toBe('1');
	});

	it('moves on when the data center reports a session error while fetching the token', async () => {
		const { client, fetch } = buildClient(
			[
				tuyaFail('USER_SESSION_LOSS'),
				rsaToken('us-token-1'),
				tuyaFail('MFA_NEED_SEND_CODE'),
				rsaToken('us-token-2'),
				tuyaOk(true),
			],
			{ session: undefined },
		);

		const pending = await client.requestLoginCode('parent@example.com', 'hunter2', 'NL');

		expect(pending.candidate.dataCenter).toBe('us');
		expect(fetch.calls).toHaveLength(5);
	});

	it('throws a wrong password immediately without trying other data centers', async () => {
		const { client, fetch } = buildClient([rsaToken('token-1'), tuyaFail('USER_PASSWD_WRONG')], {
			session: undefined,
		});

		const error = await client.requestLoginCode('parent@example.com', 'wrong', 'NL').catch((caught: unknown) => caught);

		expect(error).toBeInstanceOf(TuyaError);
		expect((error as TuyaError).code).toBe('USER_PASSWD_WRONG');
		expect((error as TuyaError).isWrongPassword).toBe(true);
		expect(fetch.calls).toHaveLength(2);
	});

	it('throws an HTTP failure immediately', async () => {
		const { client, fetch } = buildClient([buildFakeResponse({ status: 500, bodyText: 'oops' })], {
			session: undefined,
		});

		await expect(client.requestLoginCode('parent@example.com', 'hunter2', 'NL')).rejects.toBeInstanceOf(HttpError);
		expect(fetch.calls).toHaveLength(1);
	});

	it('throws the first error when no data center knows the account', async () => {
		const { client, fetch } = buildClient(
			[
				rsaToken('eu'),
				tuyaFail('USER_NOT_EXIST', 'eu says no'),
				rsaToken('us'),
				tuyaFail('USER_SESSION_INVALID', 'us says no'),
				rsaToken('in'),
				tuyaFail('USER_NOT_EXIST', 'in says no'),
				rsaToken('cn'),
				tuyaFail('USER_NOT_EXIST', 'cn says no'),
			],
			{ session: undefined },
		);

		const error = await client
			.requestLoginCode('parent@example.com', 'hunter2', 'NL')
			.catch((caught: unknown) => caught);

		expect(error).toBeInstanceOf(TuyaError);
		expect((error as TuyaError).message).toBe('USER_NOT_EXIST: eu says no');
		expect(fetch.calls.map(call => new URL(call.url).host)).toEqual([
			'a1.tuyaeu.com',
			'a1.tuyaeu.com',
			'a1.tuyaus.com',
			'a1.tuyaus.com',
			'a1.tuyain.com',
			'a1.tuyain.com',
			'a1.tuyacn.com',
			'a1.tuyacn.com',
		]);
	});

	it('starts at the US data center for a US account', async () => {
		const { client, fetch } = buildClient(
			[rsaToken('t1'), tuyaFail('MFA_NEED_SEND_CODE'), rsaToken('t2'), tuyaOk(true)],
			{ session: undefined },
		);

		const pending = await client.requestLoginCode('parent@example.com', 'hunter2', 'US');

		expect(pending.candidate).toEqual({ dataCenter: 'us', host: 'a1.tuyaus.com', callingCode: '1' });
		expect(new URL(fetch.calls[0].url).host).toBe('a1.tuyaus.com');
	});
});

describe('TuyaClient completeLogin', () => {
	it('logs in with the trimmed code and keeps the session on the host Tuya reports', async () => {
		const { client, fetch, logger } = buildClient(
			[
				rsaToken('token-3'),
				tuyaOk({ sid: 'new-sid', uid: 'new-uid', domain: { mobileApiUrl: 'a1.tuyaus.com', regionCode: 'AZ' } }),
			],
			{ session: undefined },
		);

		const result = await client.completeLogin(pendingFor('NL', 'phone-abc'), ' 123456 ');

		expect(actions(fetch)).toEqual(['thing.m.user.username.token.get', 'thing.m.user.email.password.login']);
		const login = postData(fetch.calls[1]);
		expect(login.options).toBe('{"group":1,"mfaCode":"123456"}');
		expect(login.token).toBe('token-3');
		expect(decryptPasswd(fetch.calls[1])).toBe(md5Hex('hunter2'));

		expect(result).toEqual({
			sid: 'new-sid',
			uid: 'new-uid',
			email: 'parent@example.com',
			apiHost: 'a1.tuyaus.com',
			callingCode: '31',
			phoneId: 'phone-abc',
		});
		expect(client.getSession()).toEqual(result);
		expect(logger.logs.map(args => args[0])).toContain('Signed in on a1.tuyaus.com');
	});

	it('accepts the API host as a full URL', async () => {
		const { client } = buildClient(
			[rsaToken('t'), tuyaOk({ sid: 's', uid: 'u', domain: { mobileApiUrl: 'https://a1.tuyaus.com/' } })],
			{ session: undefined },
		);

		const result = await client.completeLogin(pendingFor('NL'), '123456');

		expect(result.apiHost).toBe('a1.tuyaus.com');
	});

	it('keeps the candidate host when Tuya reports none', async () => {
		const { client } = buildClient([rsaToken('t'), tuyaOk({ sid: 's', uid: 'u' })], { session: undefined });

		const result = await client.completeLogin(pendingFor('NL'), '123456');

		expect(result.apiHost).toBe('a1.tuyaeu.com');
	});

	it('uses the new session for the next request', async () => {
		const { client, fetch } = buildClient(
			[
				rsaToken('t'),
				tuyaOk({ sid: 'new-sid', uid: 'u', domain: { mobileApiUrl: 'https://a1.tuyaus.com' } }),
				tuyaOk({ devId: 'cam1' }),
			],
			{ session: undefined },
		);

		await client.completeLogin(pendingFor('NL', 'phone-abc'), '123456');
		await client.getDevice('cam1');

		expect(fetch.calls[2].url).toBe('https://a1.tuyaus.com/api.json');
		expect(form(fetch.calls[2])).toMatchObject({ sid: 'new-sid', deviceId: 'phone-abc' });
	});

	it('throws on a wrong code and keeps no session', async () => {
		const { client } = buildClient([rsaToken('t'), tuyaFail('USER_MFA_CODE_WRONG')], { session: undefined });

		const error = await client.completeLogin(pendingFor('NL'), '000000').catch((caught: unknown) => caught);

		expect(error).toBeInstanceOf(TuyaError);
		expect((error as TuyaError).isWrongCode).toBe(true);
		expect(client.getSession()).toBeUndefined();
	});
});

describe('TuyaClient getCameras', () => {
	it('lists every device from the rooms of each home, whatever its category', async () => {
		const { client, fetch } = buildRoutedClient(fields => {
			if (fields.a === 'm.life.home.space.list') return tuyaOk([{ gid: 42, name: 'Home' }]);
			if (fields.a === 'tuya.m.location.get') {
				return tuyaOk([
					{
						deviceList: [
							{ devId: 'cam1', name: 'Nursery', productId: 'prod1', category: 'sp' },
							{ devId: 'plug1', name: 'Plug', productId: 'prod2', category: 'cz' },
						],
					},
					{ deviceList: [{ deviceId: 'cam2', deviceName: 'Bedroom', productKey: 'prod3' }] },
					{},
				]);
			}
			return tuyaFail('UNEXPECTED');
		});

		const cameras = await client.getCameras();

		expect(cameras).toEqual([
			{ id: 'cam1', name: 'Nursery', productId: 'prod1' },
			{ id: 'plug1', name: 'Plug', productId: 'prod2' },
			{ id: 'cam2', name: 'Bedroom', productId: 'prod3' },
		]);
		expect(actions(fetch)).toEqual([
			'm.life.home.space.list',
			'tuya.m.location.get',
			'tuya.m.my.group.device.list',
		]);
		expect(form(fetch.calls[1]).v).toBe('2.0');
	});

	it('removes duplicates and devices without an id, and names unnamed cameras', async () => {
		const { client, logger } = buildRoutedClient(fields => {
			if (fields.a === 'm.life.home.space.list') return tuyaOk([{ gid: '42' }]);
			return tuyaOk([
				{
					deviceList: [
						{ devId: 'cam1', category: 'sp' },
						{ name: 'No id', category: 'sp' },
					],
				},
				{ deviceList: [{ id: 'cam1', name: 'Again', category: 'sp' }] },
			]);
		});

		const cameras = await client.getCameras();

		expect(cameras).toEqual([{ id: 'cam1', name: 'Baby monitor', productId: '' }]);
		expect(logger.logs.map(args => args[0])).toContain('Found 1 device(s) on the account: ?');
	});

	it('falls back to version 1.0 of the room list', async () => {
		const { client, fetch } = buildRoutedClient(fields => {
			if (fields.a === 'm.life.home.space.list') return tuyaOk([{ gid: 42 }]);
			if (fields.a === 'tuya.m.location.get' && fields.v === '2.0') return tuyaFail('API_VERSION_WRONG');
			if (fields.a === 'tuya.m.location.get') return tuyaOk([{ deviceList: [{ devId: 'cam1', category: 'sp' }] }]);
			return tuyaFail('UNEXPECTED');
		});

		const cameras = await client.getCameras();

		expect(cameras.map(camera => camera.id)).toEqual(['cam1']);
		expect(fetch.calls.map(call => `${form(call).a}@${form(call).v}`)).toEqual([
			'm.life.home.space.list@1.0',
			'tuya.m.location.get@2.0',
			'tuya.m.location.get@1.0',
			'tuya.m.my.group.device.list@1.0',
		]);
	});

	it('adds devices that are not in a room from the home device list', async () => {
		const { client } = buildRoutedClient(fields => {
			if (fields.a === 'm.life.home.space.list') return tuyaOk([{ gid: 42 }]);
			if (fields.a === 'tuya.m.location.get') return tuyaOk([{ deviceList: [{ devId: 'cam1' }] }]);
			if (fields.a === 'tuya.m.my.group.device.list') return tuyaOk([{ devId: 'cam1' }, { devId: 'cam2' }]);
			return tuyaFail('UNEXPECTED');
		});

		const cameras = await client.getCameras();

		expect(cameras.map(camera => camera.id)).toEqual(['cam1', 'cam2']);
	});

	it('falls back to the group device list when the rooms are empty', async () => {
		const { client, fetch } = buildRoutedClient(fields => {
			if (fields.a === 'm.life.home.space.list') return tuyaOk([{ gid: 42 }]);
			if (fields.a === 'tuya.m.location.get') return tuyaOk([{ deviceList: [] }]);
			if (fields.a === 'tuya.m.my.group.device.list') return tuyaOk([{ devId: 'cam1', category: 'sp' }]);
			return tuyaFail('UNEXPECTED');
		});

		const cameras = await client.getCameras();

		expect(cameras.map(camera => camera.id)).toEqual(['cam1']);
		const groupCall = fetch.calls[fetch.calls.length - 1];
		expect(form(groupCall)).toMatchObject({ a: 'tuya.m.my.group.device.list', gid: '42' });
		expect(form(groupCall)).not.toHaveProperty('postData');
	});

	it('falls back to the device relation list per home', async () => {
		const { client, fetch } = buildRoutedClient(fields => {
			if (fields.a === 'm.life.home.space.list') return tuyaOk([{ gid: 42 }]);
			if (fields.a === 'tuya.m.my.group.device.relation.list') {
				return tuyaOk([{ devId: 'cam1', name: 'Nursery', category: 'sp' }]);
			}
			return tuyaOk([]);
		});

		const cameras = await client.getCameras();

		expect(cameras).toEqual([{ id: 'cam1', name: 'Nursery', productId: '' }]);
		expect(actions(fetch)).toEqual([
			'm.life.home.space.list',
			'tuya.m.location.get',
			'tuya.m.location.get',
			'tuya.m.my.group.device.list',
			'tuya.m.my.group.device.relation.list',
		]);
		expect(form(fetch.calls[4]).gid).toBe('42');
	});

	it('falls back to the flat device list when listing homes fails', async () => {
		const { client, fetch } = buildRoutedClient(fields => {
			if (fields.a === 'm.life.home.space.list') return buildFakeResponse({ status: 503, bodyText: 'down' });
			if (fields.a === 'tuya.m.device.list.get') return tuyaOk([{ devId: 'cam1', category: 'sp' }]);
			return tuyaFail('UNEXPECTED');
		});

		const cameras = await client.getCameras();

		expect(cameras.map(camera => camera.id)).toEqual(['cam1']);
		expect(actions(fetch)).toEqual(['m.life.home.space.list', 'tuya.m.device.list.get']);
		expect(form(fetch.calls[1])).not.toHaveProperty('gid');
	});

	it('returns no cameras when every endpoint is empty or fails', async () => {
		const { client, fetch } = buildRoutedClient(fields => {
			if (fields.a === 'm.life.home.space.list') return tuyaOk(null);
			if (fields.a === 'tuya.m.device.list.get') return tuyaOk({ not: 'an array' });
			return tuyaFail('UNEXPECTED');
		});

		await expect(client.getCameras()).resolves.toEqual([]);
		expect(actions(fetch)).toEqual(['m.life.home.space.list', 'tuya.m.device.list.get']);
	});

	it('skips homes without a gid when listing rooms', async () => {
		const { client, fetch } = buildRoutedClient(fields => {
			if (fields.a === 'm.life.home.space.list') return tuyaOk([{ gid: '' }, { gid: 7 }]);
			if (fields.a === 'tuya.m.location.get') return tuyaOk([{ deviceList: [{ devId: 'cam1', category: 'sp' }] }]);
			return tuyaFail('UNEXPECTED');
		});

		await client.getCameras();

		const roomCalls = fetch.calls.filter(call => form(call).a === 'tuya.m.location.get');
		expect(roomCalls.map(call => form(call).gid)).toEqual(['7']);
	});

	it('does not query the relation list for a home without a gid', async () => {
		const { client, fetch } = buildRoutedClient(fields => {
			if (fields.a === 'm.life.home.space.list') return tuyaOk([{ name: 'No gid' }]);
			if (fields.a === 'tuya.m.device.list.get') return tuyaOk([]);
			return tuyaFail('UNEXPECTED');
		});

		await client.getCameras();

		expect(fetch.calls.map(call => form(call).gid)).not.toContain('undefined');
	});

	it('finds cameras in a second home that only the fallback endpoints list', async () => {
		const { client } = buildRoutedClient(fields => {
			if (fields.a === 'm.life.home.space.list') return tuyaOk([{ gid: 1 }, { gid: 2 }]);
			if (fields.a === 'tuya.m.location.get' && fields.gid === '1') {
				return tuyaOk([{ deviceList: [{ devId: 'cam1', category: 'sp' }] }]);
			}
			if (fields.a === 'tuya.m.location.get') return tuyaOk([]);
			if (fields.a === 'tuya.m.my.group.device.list' && fields.gid === '2') {
				return tuyaOk([{ devId: 'cam2', category: 'sp' }]);
			}
			return tuyaOk([]);
		});

		const cameras = await client.getCameras();

		expect(cameras.map(camera => camera.id)).toEqual(['cam1', 'cam2']);
	});
});

describe('TuyaClient getDevice', () => {
	it('returns the device details', async () => {
		const details = {
			devId: 'cam1',
			name: 'Nursery',
			productId: '7d9t0rygsm7ztnww',
			isOnline: true,
			dps: { [Dp.temperature]: 2250, [Dp.senseIqStatus]: '{"r":"m","br":32}' },
		};
		const { client, fetch } = buildClient([tuyaOk(details)]);

		await expect(client.getDevice('cam1')).resolves.toEqual(details);
		expect(form(fetch.calls[0])).toMatchObject({ a: 'tuya.m.device.get', v: '1.0' });
		expect(postData(fetch.calls[0])).toEqual({ devId: 'cam1' });
	});
});

describe('TuyaClient setDps', () => {
	it('publishes the data points for the device', async () => {
		const { client, fetch, logger } = buildClient([tuyaOk(true)]);

		await expect(
			client.setDps('cam1', {
				[Dp.nightLight]: true,
				[Dp.lullabyVolume]: 50,
				[Dp.lullabyTrack]: '{"bizcode":"phi-no-bm","id":3542155}',
			}),
		).resolves.toBeUndefined();

		expect(form(fetch.calls[0])).toMatchObject({ a: 'tuya.m.device.dp.publish', v: '1.0' });
		expect(postData(fetch.calls[0])).toEqual({
			devId: 'cam1',
			gwId: 'cam1',
			dps: {
				[Dp.nightLight]: true,
				[Dp.lullabyVolume]: 50,
				[Dp.lullabyTrack]: '{"bizcode":"phi-no-bm","id":3542155}',
			},
		});
		expect(logger.debugs.map(args => args[0])).toContain('Setting dps 138, 202, 209');
	});

	it('passes a Tuya failure on', async () => {
		const { client } = buildClient([tuyaFail('DEVICE_OFFLINE')]);
		await expect(client.setDps('cam1', { [Dp.nightLight]: true })).rejects.toBeInstanceOf(TuyaError);
	});
});

