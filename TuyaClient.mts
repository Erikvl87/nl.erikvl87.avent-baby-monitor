import crypto from 'node:crypto';
import type { Logger } from './Logger.mjs';
import HttpError from './errors/http-error.mjs';
import TuyaError from './errors/tuya-error.mjs';
import { encryptPassword, signRequest } from './utils/tuya-sign.mjs';
import { isWrongDataCenter, loginCandidates, normalizeHost, type LoginCandidate } from './utils/region.mjs';
import type {
	Camera,
	DeviceDetails,
	Home,
	ListedDevice,
	LoginResult,
	Room,
	RtcConfig,
	RsaToken,
	TuyaResponse,
	TuyaSession,
} from './types/tuya.mjs';

export type { Camera, DeviceDetails, RtcConfig, TuyaSession } from './types/tuya.mjs';

/** The Philips Avent Baby Monitor+ app's Tuya client id and channel key. */
const clientId = 'wx3at9qprkhskvkcsyhm';
const channelKey = '071d81fa';
const appVersion = '1.8.0';
const sdkVersion = '6.7.0';
const userAgent = `Thing-UA=APP/Android/${appVersion}/SDK/${sdkVersion}`;
/** A request that takes longer than this is given up on, so a pair screen never waits forever. */
const requestTimeoutMs = 20_000;

export interface TuyaClientOptions {
	logger: Logger;
	session?: TuyaSession;
	fetch?: typeof fetch;
	/** For tests: fixes the request time and id. */
	now?: () => number;
	requestId?: () => string;
}

/** The state between asking for the emailed code and entering it. */
export interface PendingLogin {
	email: string;
	password: string;
	candidate: LoginCandidate;
	phoneId: string;
}

/**
 * Client for the Tuya mobile API the Philips Avent Baby Monitor+ app uses. The monitors are Tuya cameras sold under
 * the Philips Avent name, so the app signs in, lists cameras and reads and sets their data points ("dps") the same
 * way the phone app does.
 */
export default class TuyaClient {
	private readonly logger: Logger;
	private readonly fetch: typeof fetch;
	private readonly now: () => number;
	private readonly requestId: () => string;
	private session: TuyaSession | undefined;

	/**
	 * @internal Prefer `getApp(this.homey).createTuyaClient(logger, session)`.
	 */
	public constructor(options: TuyaClientOptions) {
		this.logger = options.logger;
		this.session = options.session;
		this.fetch = options.fetch ?? globalThis.fetch.bind(globalThis);
		this.now = options.now ?? Date.now;
		this.requestId = options.requestId ?? ((): string => crypto.randomUUID());
	}

	public getSession(): TuyaSession | undefined {
		return this.session;
	}

	/**
	 * First half of signing in: checks the password and has Tuya email a verification code. Tries the data center of
	 * the user's country first and moves on only when Tuya says the account isn't there.
	 * @returns What `completeLogin` needs once the user has entered the code.
	 */
	public async requestLoginCode(email: string, password: string, country: string): Promise<PendingLogin> {
		const phoneId = crypto.randomUUID().replaceAll('-', '');
		let firstError: unknown;

		for (const candidate of loginCandidates(country)) {
			const pending: PendingLogin = { email, password, candidate, phoneId };
			try {
				// The first attempt is expected to fail with MFA_NEED_SEND_CODE; anything else is a real failure.
				try {
					await this.passwordLogin(pending, '');
				} catch (error) {
					if (!(error instanceof TuyaError) || error.code !== 'MFA_NEED_SEND_CODE') throw error;
				}

				const token = await this.getRsaToken(pending);
				await this.call(
					'thing.m.user.username.mfa.code.get',
					'1.0',
					{
						countryCode: candidate.callingCode,
						username: email,
						passwd: encryptPassword(password, token.pbKey),
						token: token.token,
						ifencrypt: 1,
						options: JSON.stringify({ group: 1, mfaCode: 'null' }),
					},
					{ host: candidate.host, sid: '', phoneId },
				);
				this.logger.log(`Verification code sent via data center ${candidate.dataCenter}`);
				return pending;
			} catch (error) {
				firstError ??= error;
				if (error instanceof TuyaError && isWrongDataCenter(error.code)) {
					this.logger.log(`Data center ${candidate.dataCenter} does not know the account (${error.code})`);
					continue;
				}
				throw error;
			}
		}
		throw firstError ?? new TuyaError('UNKNOWN', 'No data center accepted the login');
	}

	/**
	 * Second half of signing in: logs in with the emailed code and keeps the session. Switches to the API host Tuya
	 * reports for the account, which corrects a wrong guess from the country.
	 */
	public async completeLogin(pending: PendingLogin, code: string): Promise<TuyaSession> {
		const result = await this.passwordLogin(pending, code.trim());
		this.session = {
			sid: result.sid,
			uid: result.uid,
			email: pending.email,
			apiHost: normalizeHost(result.domain?.mobileApiUrl) ?? pending.candidate.host,
			callingCode: pending.candidate.callingCode,
			phoneId: pending.phoneId,
			ecode: result.ecode,
			partnerIdentity: result.partnerIdentity,
			mqttHost: normalizeHost(result.domain?.mobileMqttsUrl),
		};
		this.logger.log(`Signed in on ${this.session.apiHost}`);
		return this.session;
	}

	/** Lists the cameras on the account, trying the discovery endpoints the phone app uses until one returns devices. */
	public async getCameras(): Promise<Camera[]> {
		const devices = await this.discoverDevices();
		const cameras: Camera[] = [];
		for (const device of devices) {
			const id = device.devId ?? device.deviceId ?? device.id;
			if (!id || cameras.some(camera => camera.id === id)) continue;
			cameras.push({
				id,
				name: device.name ?? device.deviceName ?? 'Baby monitor',
				productId: device.productId ?? device.productKey ?? '',
			});
		}
		const kinds = cameras.map(camera => camera.productId || '?').join(', ');
		this.logger.log(`Found ${cameras.length} device(s) on the account: ${kinds}`);
		return cameras;
	}

	/** Reads a camera's current state, including all its data points. */
	public async getDevice(deviceId: string): Promise<DeviceDetails> {
		return this.call<DeviceDetails>('tuya.m.device.get', '1.0', { devId: deviceId });
	}

	/** Sets data points on a camera. Values must have the type the camera expects: boolean, number or string. */
	public async setDps(deviceId: string, dps: Record<string, boolean | number | string>): Promise<void> {
		this.logger.debug(`Setting dps ${Object.keys(dps).join(', ')}`);
		await this.call('tuya.m.device.dp.publish', '1.0', { devId: deviceId, gwId: deviceId, dps });
	}

	/**
	 * Gets what the camera needs to start a WebRTC stream. The pre-link and session calls before and after it are what
	 * the phone app does; they may fail without harm, but skipping them made the config request get refused.
	 */
	public async getRtcConfig(deviceId: string): Promise<RtcConfig> {
		await this.call('smartlife.m.p2p.main.pre.link.get', '1.0', { devId: deviceId }).catch(error => {
			this.logger.log(`P2P pre-link failed: ${(error as Error).message ?? String(error)}`);
		});
		const config = await this.call<RtcConfig>('smartlife.m.rtc.config.get', '1.0', { devId: deviceId });
		await this.call('smartlife.m.rtc.session.init', '1.0', { devId: deviceId }).catch(error => {
			this.logger.log(`RTC session init failed: ${(error as Error).message ?? String(error)}`);
		});
		return config;
	}

	/**
	 * Collects the account's devices the ways the phone app does. A device that isn't in a room is missing from the
	 * room list, so each home's own device list is always added; the account-wide lists are the last resort.
	 */
	private async discoverDevices(): Promise<ListedDevice[]> {
		const homes = await this.listOrEmpty<Home>('m.life.home.space.list');
		const gids = homes.map(home => String(home.gid ?? '')).filter(gid => gid !== '');
		this.logger.debug(`Found ${gids.length} home(s)`);

		const found: ListedDevice[] = [];
		for (const gid of gids) {
			for (const version of ['2.0', '1.0']) {
				const rooms = await this.listOrEmpty<Room>('tuya.m.location.get', gid, version, { gid }, 'rooms');
				const inRooms = rooms.flatMap(room => room.deviceList ?? []);
				this.logger.debug(`Rooms (v${version}): ${rooms.length} room(s), ${inRooms.length} device(s)`);
				found.push(...inRooms);
				if (inRooms.length > 0) break;
			}
			found.push(...(await this.listOrEmpty<ListedDevice>('tuya.m.my.group.device.list', gid)));
		}
		if (found.length > 0) return found;

		for (const gid of gids) {
			found.push(...(await this.listOrEmpty<ListedDevice>('tuya.m.my.group.device.relation.list', gid)));
		}
		if (found.length > 0) return found;

		return this.listOrEmpty<ListedDevice>('tuya.m.device.list.get');
	}

	/**
	 * Calls a listing endpoint and returns its items, or none when it fails. Logs how many items it returned, and the
	 * shape of a result that isn't a list, since discovery is where an unfamiliar account shows up.
	 */
	private async listOrEmpty<T>(
		action: string,
		gid?: string,
		version = '1.0',
		postData?: unknown,
		listKey?: string,
	): Promise<T[]> {
		try {
			let result = await this.call<unknown>(action, version, postData, gid ? { extra: { gid } } : {});
			// Some endpoints wrap the list in an object, like the room list in its home.
			if (listKey && result && typeof result === 'object' && !Array.isArray(result)) {
				result = (result as Record<string, unknown>)[listKey];
			}
			if (Array.isArray(result)) {
				this.logger.debug(`${action}: ${result.length} item(s)`);
				return result as T[];
			}
			const shape = result && typeof result === 'object' ? `object with ${Object.keys(result).join(', ')}` : typeof result;
			this.logger.debug(`${action}: not a list but ${shape}`);
			return [];
		} catch (error) {
			this.logger.log(`${action} failed: ${(error as Error).message ?? String(error)}`);
			return [];
		}
	}

	private async getRsaToken(pending: PendingLogin): Promise<RsaToken> {
		return this.call<RsaToken>(
			'thing.m.user.username.token.get',
			'2.0',
			{ countryCode: pending.candidate.callingCode, username: pending.email, isUid: false },
			{ host: pending.candidate.host, sid: '', phoneId: pending.phoneId },
		);
	}

	/** Logs in with the password; every attempt needs its own one-time RSA token. */
	private async passwordLogin(pending: PendingLogin, mfaCode: string): Promise<LoginResult> {
		const token = await this.getRsaToken(pending);
		return this.call<LoginResult>(
			'thing.m.user.email.password.login',
			'3.0',
			{
				countryCode: pending.candidate.callingCode,
				email: pending.email,
				passwd: encryptPassword(pending.password, token.pbKey),
				token: token.token,
				ifencrypt: 1,
				options: JSON.stringify({ group: 1, mfaCode }),
			},
			{ host: pending.candidate.host, sid: '', phoneId: pending.phoneId },
		);
	}

	/**
	 * Makes a signed request. Uses the signed-in session unless `overrides` supplies the host, session id and phone id
	 * (as the login does, before there is a session).
	 */
	private async call<T>(
		action: string,
		version: string,
		postData?: unknown,
		overrides: { host?: string; sid?: string; phoneId?: string; extra?: Record<string, string> } = {},
	): Promise<T> {
		const host = overrides.host ?? this.session?.apiHost;
		const phoneId = overrides.phoneId ?? this.session?.phoneId;
		if (!host || !phoneId) throw new Error('Not signed in');

		const params: Record<string, string> = {
			a: action,
			v: version,
			time: String(Math.floor(this.now() / 1000)),
			appVersion,
			appRnVersion: '5.92',
			channel: 'oem',
			chKey: channelKey,
			clientId,
			cp: 'gzip',
			deviceCoreVersion: sdkVersion,
			deviceId: phoneId,
			et: '0.0.1',
			nd: '1',
			lang: 'en_US',
			os: 'Android',
			osSystem: '14',
			platform: 'homey',
			requestId: this.requestId(),
			sdkVersion,
			sid: overrides.sid ?? this.session?.sid ?? '',
			timeZoneId: 'Europe/Amsterdam',
			ttid: `sdk_international@${clientId}`,
		};
		if (postData !== undefined) params.postData = JSON.stringify(postData);
		params.sign = signRequest(params);
		Object.assign(params, overrides.extra);

		const response = await this.fetch(`https://${host}/api.json`, {
			method: 'POST',
			// eslint-disable-next-line @typescript-eslint/naming-convention
			headers: { 'User-Agent': userAgent, 'Content-Type': 'application/x-www-form-urlencoded' },
			body: new URLSearchParams(params).toString(),
			signal: AbortSignal.timeout(requestTimeoutMs),
		});

		if (!response.ok) {
			const body = await response.text().catch(() => '');
			throw new HttpError(`Tuya ${action} failed with HTTP ${response.status}`, response.status, body);
		}
		const json = (await response.json()) as TuyaResponse<T>;
		if (!json.success) {
			throw new TuyaError(json.errorCode ?? 'UNKNOWN', json.errorMsg ?? `Tuya ${action} failed`);
		}
		return json.result as T;
	}
}
