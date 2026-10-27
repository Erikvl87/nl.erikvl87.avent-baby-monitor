import Homey from 'homey';
import type { PairSession } from 'homey/lib/Driver';
import AppLogger from '../../Logger.mjs';
import { getApp } from '../../app.mjs';
import TuyaClient, { type PendingLogin, type TuyaSession } from '../../TuyaClient.mjs';
import TuyaError from '../../errors/tuya-error.mjs';
import { countryRouting } from '../../utils/region.mjs';
import type BabyMonitorDevice from './device.mjs';

/** A sensible first guess for the account country, from Homey's language. */
const countryByLanguage: Record<string, string> = {
	nl: 'NL',
	de: 'DE',
	fr: 'FR',
	it: 'IT',
	es: 'ES',
	sv: 'SE',
	da: 'DK',
	no: 'NO',
	pl: 'PL',
};

interface LoginForm {
	email: string;
	password: string;
	country: string;
}

/**
 * Signing in takes two steps: the password, after which Philips Avent emails a verification code, and then that
 * code. Pairing and repairing share them.
 */
interface LoginFlow {
	client: TuyaClient;
	form?: LoginForm;
	pending?: PendingLogin;
	session?: TuyaSession;
}

export default class BabyMonitorDriver extends Homey.Driver {
	logger!: AppLogger;

	/**
	 * This method is called when the driver is inited.
	 */
	override async onInit(): Promise<void> {
		this.logger = AppLogger.create(this.homey, this.log, this.error);
		this.registerFlowCards();
		this.logger.log(`${this.constructor.name} has been initialized`);
	}

	/**
	 * This method is called when a pair session starts.
	 * @param session Bi-directional socket for communication with the front-end
	 */
	override async onPair(session: PairSession): Promise<void> {
		const flow = this.registerLoginHandlers(session);

		session.setHandler('verify', async ({ code }: { code: string }) => {
			await this.verify(flow, code);
			return { done: false };
		});

		session.setHandler('list_devices', async () => {
			if (!flow.session) throw new Error(this.homey.__('errors.noPendingLogin'));
			this.logger.log('Listing devices for pairing');
			const cameras = await flow.client.getCameras();
			if (cameras.length === 0) throw new Error(this.homey.__('errors.noCameras'));

			const packed = getApp(this.homey).packSession(flow.session);
			return cameras.map(camera => ({
				name: camera.name,
				data: { id: camera.id },
				store: { session: packed, productId: camera.productId },
			}));
		});
	}

	/**
	 * This method is called when a repair session starts. Signs in again when the session expired, and hands the new
	 * session to every device on the same account.
	 */
	override async onRepair(session: PairSession, device: Homey.Device): Promise<void> {
		const flow = this.registerLoginHandlers(session, (device as BabyMonitorDevice).getAccountEmail());

		session.setHandler('verify', async ({ code }: { code: string }) => {
			const signedIn = await this.verify(flow, code);
			const cameras = await flow.client.getCameras();
			if (!cameras.some(camera => camera.id === device.getData().id)) {
				throw new Error(this.homey.__('errors.differentAccount'));
			}

			const app = getApp(this.homey);
			for (const other of this.getDevices() as BabyMonitorDevice[]) {
				const sameAccount = other === device || app.unpackSession(other.getStoreValue('session'))?.uid === signedIn.uid;
				if (sameAccount && cameras.some(camera => camera.id === other.getData().id)) {
					await other.updateSession(signedIn);
				}
			}
			return { done: true };
		});
	}

	private registerLoginHandlers(session: PairSession, email?: string): LoginFlow {
		const logger = this.logger.createChildLogger({ prefix: 'TuyaClient' });
		const flow: LoginFlow = { client: getApp(this.homey).createTuyaClient(logger) };
		session.setHandler('showView', async (view: string) => {
			this.logger.log(`Showing pair view ${view}`);
		});
		session.setHandler('viewLog', async (message: string) => {
			this.logger.log(String(message));
		});

		session.setHandler('getLoginDefaults', async () => {
			const language = this.homey.i18n.getLanguage();
			return {
				countries: Object.keys(countryRouting),
				country: flow.form?.country ?? countryByLanguage[language] ?? '',
				email: flow.form?.email ?? email ?? '',
				language,
			};
		});

		session.setHandler('login', async (form: LoginForm) => {
			flow.form = form;
			flow.pending = await this.requestCode(flow.client, form);
		});

		session.setHandler('resend', async () => {
			if (!flow.form) throw new Error(this.homey.__('errors.noPendingLogin'));
			flow.pending = await this.requestCode(flow.client, flow.form);
		});

		return flow;
	}

	private async requestCode(client: TuyaClient, form: LoginForm): Promise<PendingLogin> {
		try {
			return await client.requestLoginCode(form.email, form.password, form.country);
		} catch (error) {
			throw this.loginError(error, false);
		}
	}

	private async verify(flow: LoginFlow, code: string): Promise<TuyaSession> {
		if (!flow.pending) throw new Error(this.homey.__('errors.noPendingLogin'));
		this.logger.log('Verifying the code');
		try {
			flow.session = await flow.client.completeLogin(flow.pending, code);
			return flow.session;
		} catch (error) {
			throw this.loginError(error, true);
		}
	}

	/** Turns a failed sign-in into a message for the pair screen. */
	private loginError(error: unknown, withCode: boolean): Error {
		this.logger.log(`Login failed: ${(error as Error).message ?? String(error)}`);
		if (error instanceof TuyaError) {
			if (withCode && error.isWrongCode) return new Error(this.homey.__('errors.wrongCode'));
			if (error.isWrongPassword) return new Error(this.homey.__('errors.wrongPassword'));
			return new Error(this.homey.__('errors.loginFailed', { code: error.code }));
		}
		return error instanceof Error ? error : new Error(String(error));
	}

	private registerFlowCards(): void {
		const flow = this.homey.flow;
		type Args = { device: BabyMonitorDevice } & Record<string, string>;

		flow.getActionCard('play-lullaby').registerRunListener(async ({ device, lullaby }: Args) => {
			await device.playLullaby(lullaby);
		});
		flow.getActionCard('set-lullaby-timer').registerRunListener(async ({ device, duration }: Args) => {
			await device.setTimer('lullaby', Number(duration));
		});
		flow.getActionCard('cancel-lullaby-timer').registerRunListener(async ({ device }: Args) => {
			await device.setTimer('lullaby', 0);
		});
		flow.getActionCard('set-night-light-timer').registerRunListener(async ({ device, duration }: Args) => {
			await device.setTimer('nightLight', Number(duration));
		});
		flow.getActionCard('cancel-night-light-timer').registerRunListener(async ({ device }: Args) => {
			await device.setTimer('nightLight', 0);
		});
		flow.getActionCard('set-privacy-mode').registerRunListener(async ({ device, state }: Args) => {
			await device.triggerCapabilityListener('privacy_mode', state === 'on');
		});
		flow.getActionCard('set-motion-detection').registerRunListener(async ({ device, state }: Args) => {
			await device.setDetection('motion', state === 'on');
		});
		flow.getActionCard('set-sound-detection').registerRunListener(async ({ device, state }: Args) => {
			await device.setDetection('sound', state === 'on');
		});

		flow.getConditionCard('privacy-mode-is-on').registerRunListener(async ({ device }: Args) => {
			return device.getCapabilityValue('privacy_mode') === true;
		});
		flow.getConditionCard('lullaby-is').registerRunListener(async ({ device, lullaby }: Args) => {
			return device.getCapabilityValue('lullaby_track') === lullaby;
		});
		flow.getConditionCard('is-crying').registerRunListener(async ({ device }: Args) => {
			return device.getCapabilityValue('alarm_crying') === true;
		});
	}
}
