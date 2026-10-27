import Homey from 'homey';
import type HomeyInstance from 'homey/lib/Homey';
import AppLogger, { setDebug, type Logger } from './Logger.mjs';
import TuyaClient, { type TuyaSession } from './TuyaClient.mjs';
import TuyaSignaling from './TuyaSignaling.mjs';
import SecretObfuscation from './utils/secret-obfuscation.mjs';
import { loadConfig } from './config.mjs';

/** The app setting that turns on detailed diagnostics. */
const debugSetting = 'debug';
/** An app setting earlier versions kept their recent log in; cleared on start. */
const obsoleteRecentLogSetting = 'recentLog';

export default class AventBabyMonitor extends Homey.App {
	logger!: AppLogger;
	secrets!: SecretObfuscation;
	/** One signalling connection per account, by user id: a second one with the same client id kicks the first. */
	private readonly signaling = new Map<string, TuyaSignaling>();

	/**
	 * This method is called upon initialization of your app.
	 */
	public override async onInit(): Promise<void> {
		setDebug(this.homey.settings.get(debugSetting) === true);
		this.logger = AppLogger.create(this.homey, this.log, this.error);
		this.catchStrayErrors();
		this.homey.settings.unset(obsoleteRecentLogSetting);
		this.secrets = new SecretObfuscation(loadConfig().obfuscationKey);

		this.homey.settings.on('set', (key: string) => {
			if (key === debugSetting) setDebug(this.homey.settings.get(debugSetting) === true);
		});

		this.logger.log(`${this.constructor.name} has been initialized`);
	}

	/**
	 * An error nothing caught would otherwise end the app and take every monitor offline. Log it, with where it came
	 * from, and carry on.
	 */
	private catchStrayErrors(): void {
		process.on('uncaughtException', error => {
			this.logger.error(new Error(`Uncaught: ${error.message}`, { cause: error }));
		});
		process.on('unhandledRejection', reason => {
			const error = reason instanceof Error ? reason : new Error(String(reason));
			this.logger.error(new Error(`Unhandled rejection: ${error.message}`, { cause: error }));
		});
	}

	/**
	 * Factory for a Tuya client, signed in when a session is given.
	 *
	 * @param logger - Logger the client should use for its own output
	 * @param session - The account session to make requests with
	 */
	public createTuyaClient(logger: Logger, session?: TuyaSession): TuyaClient {
		return new TuyaClient({ logger, session });
	}

	override async onUninit(): Promise<void> {
		for (const signaling of this.signaling.values()) signaling.close();
		this.signaling.clear();
	}

	/**
	 * The video signalling for an account, shared by all its cameras. A new sign-in replaces the connection.
	 *
	 * @param session - The account session to connect with
	 */
	public getSignaling(session: TuyaSession): TuyaSignaling {
		const existing = this.signaling.get(session.uid);
		if (existing && existing.sid === session.sid) return existing;
		existing?.close();

		const signaling = new TuyaSignaling({ logger: this.logger.createChildLogger({ prefix: 'Signaling' }), session });
		this.signaling.set(session.uid, signaling);
		return signaling;
	}

	/** Turns a session into the obfuscated string devices keep in their store. */
	public packSession(session: TuyaSession): string {
		return this.secrets.obfuscate(JSON.stringify(session));
	}

	/** Reads a session a device kept in its store, or undefined when there is none or it can't be read. */
	public unpackSession(packed: unknown): TuyaSession | undefined {
		if (typeof packed !== 'string' || !packed) return undefined;
		try {
			return JSON.parse(this.secrets.deobfuscate(packed)) as TuyaSession;
		} catch {
			return undefined;
		}
	}
}

/**
 * Typed accessor for the app instance from any driver/device.
 * Use this instead of `(this.homey.app as AventBabyMonitor)`.
 */
export function getApp(homey: HomeyInstance): AventBabyMonitor {
	return homey.app as AventBabyMonitor;
}
