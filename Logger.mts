import { Log } from 'homey-log';
import Homey from 'homey/lib/Homey';

let _debugEnabled = false;

/** Turns `debug()` output on or off, for every logger at once. */
export function setDebug(enabled: boolean): void {
	_debugEnabled = enabled;
}

/**
 * Options applied to a (child) logger. `prefix` wraps each message with a
 * bracketed tag (chainable across children).
 */
export type LoggerOptions = {
	prefix?: string;
}

/**
 * Minimal logger surface that the app uses throughout. Implementations may
 * forward to any backend (Homey + Sentry in production, in-memory in tests).
 */
export interface Logger {
	/** Events and routine failures. */
	log(...args: unknown[]): void;
	/** Detail that only helps when diagnosing a problem; dropped unless the debug setting is on. */
	debug(...args: unknown[]): void;
	/** The unexpected; also sent to Sentry. */
	error(...args: unknown[]): void;
	createChildLogger(options?: LoggerOptions): Logger;
}

export default class AppLogger implements Logger {
	private readonly sentryLog: Log;
	private readonly homey: Homey;
	private readonly homeyLog: (...args: unknown[]) => void;
	private readonly homeyError: (...args: unknown[]) => void;
	private readonly prefixChain: string[];

	private constructor(homey: Homey, log: (...args: unknown[]) => void, error: (...args: unknown[]) => void, options?: LoggerOptions, parent?: AppLogger) {
		this.homey = homey;
		this.homeyLog = parent ? parent.homeyLog : log;
		this.homeyError = parent ? parent.homeyError : error;
		this.sentryLog = parent ? parent.sentryLog : new Log({ homey });

		this.prefixChain = [
			...(parent?.prefixChain ?? []),
			...(options?.prefix ? [options.prefix] : [])
		];
	}

	/**
	 * Instantiate a root logger that writes directly to the provided Homey handlers.
	 * @param homey Reference to the Homey SDK instance.
	 * @param log Function used for informational logging (typically homey.log).
	 * @param error Function used for error logging (typically homey.error).
	 * @param options Optional configuration such as prefix.
	 */
	public static create(homey: Homey, log: (...args: unknown[]) => void, error: (...args: unknown[]) => void, options?: LoggerOptions): AppLogger {
		return new AppLogger(homey, log, error, options);
	}

	/**
	 * Log a message to the console (local only).
	 * @param args Message fragments to forward to the underlying Homey logger.
	 */
	public log(...args: unknown[]): void {
		const decoratedArgs = this.decorateArgs(args);
		if (decoratedArgs.length === 0)
			return;

		this.homeyLog(...decoratedArgs);
	}

	/**
	 * Log detail to the console (local only), but only while the debug setting is on.
	 * @param args Message fragments to forward to the underlying Homey logger.
	 */
	public debug(...args: unknown[]): void {
		if (!_debugEnabled)
			return;

		this.log(...args);
	}

	/**
	 * Log an error to the console and automatically send to Sentry for tracking.
	 * Fire-and-forget: errors are sent to Sentry asynchronously without blocking.
	 * @param args Error details forwarded to both Homey and Sentry (first entry only for Sentry).
	 */
	public error(...args: unknown[]): void {
		const decoratedArgs = this.decorateArgs(args);

		this.homeyError(...decoratedArgs);

		if (args.length === 0)
			return;

		// Prevent Sentry failures from affecting the app
		void (async (): Promise<void> => {
			try {
				const payload = args[0];
				if (payload instanceof Error) {
					await this.sentryLog.captureException(payload);
				} else {
					const message = typeof payload === 'string' ? payload : String(payload);
					await this.sentryLog.captureMessage(message);
				}
			} catch (sentryError) {
				const failureArgs = this.decorateArgs(['Failed to send error to Sentry', sentryError]);
				this.homeyError(...failureArgs);
			}
		})();
	}

	/**
	 * Spawn a logger that inherits transports and options from this logger.
	 * @param options Overrides applied on top of the parent logger configuration.
	 */
	public createChildLogger(options?: LoggerOptions): AppLogger {
		return new AppLogger(this.homey, this.homeyLog, this.homeyError, options, this);
	}

	private decorateArgs(args: unknown[]): unknown[] {
		if (args.length === 0) {
			return [];
		}

		const decorated = [...args];
		if (this.prefixChain.length > 0) {
			const prefixString = this.prefixChain.map(p => `[${p}]`).join(' ');
			decorated[0] = `${prefixString} ${decorated[0]}`;
		}
		return decorated;
	}
}
