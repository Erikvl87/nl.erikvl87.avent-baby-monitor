import type { Logger, LoggerOptions } from '../../Logger.mjs';

export interface FakeLogger extends Logger {
	readonly logs: unknown[][];
	readonly debugs: unknown[][];
	readonly errors: unknown[][];
	readonly children: FakeLogger[];
}

/**
 * Creates a Logger implementation that records every call without side effects.
 * `createChildLogger` returns the same fake, so recorded calls aggregate on one
 * object — most tests only care that something was logged, not which child did it.
 */
export function createFakeLogger(): FakeLogger {
	const logs: unknown[][] = [];
	const debugs: unknown[][] = [];
	const errors: unknown[][] = [];
	const children: FakeLogger[] = [];

	const fake: FakeLogger = {
		logs,
		debugs,
		errors,
		children,
		log: (...args: unknown[]) => { logs.push(args); },
		debug: (...args: unknown[]) => { debugs.push(args); },
		error: (...args: unknown[]) => { errors.push(args); },
		createChildLogger: (_options?: LoggerOptions) => {
			children.push(fake);
			return fake;
		},
	};
	return fake;
}
