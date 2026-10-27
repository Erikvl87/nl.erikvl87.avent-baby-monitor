import { describe, it, expect, vi, beforeEach } from 'vitest';

const { captureException, captureMessage } = vi.hoisted(() => ({
	captureException: vi.fn<(error: unknown) => Promise<void>>(),
	captureMessage: vi.fn<(message: string) => Promise<void>>(),
}));

vi.mock('homey-log', () => ({
	// eslint-disable-next-line @typescript-eslint/naming-convention
	Log: class {
		public captureException = captureException;
		public captureMessage = captureMessage;
	},
}));

import AppLogger, { setDebug, type LoggerOptions } from '../Logger.mjs';
import type Homey from 'homey/lib/Homey';

function buildLogger(options?: LoggerOptions): {
	logger: AppLogger;
	log: ReturnType<typeof vi.fn<(...args: unknown[]) => void>>;
	error: ReturnType<typeof vi.fn<(...args: unknown[]) => void>>;
} {
	const log = vi.fn<(...args: unknown[]) => void>();
	const error = vi.fn<(...args: unknown[]) => void>();
	const homey = {} as Homey;
	const logger = AppLogger.create(homey, log, error, options);
	return { logger, log, error };
}

async function flushMicrotasks(): Promise<void> {
	for (let i = 0; i < 5; i += 1) {
		await Promise.resolve();
	}
}

beforeEach(() => {
	setDebug(false);
	captureException.mockReset();
	captureMessage.mockReset();
	captureException.mockImplementation(async () => {});
	captureMessage.mockImplementation(async () => {});
});

describe('AppLogger log()', () => {
	it('forwards a single-argument message', () => {
		const { logger, log } = buildLogger();
		logger.log('hello');
		expect(log).toHaveBeenCalledWith('hello');
	});

	it('does nothing when called without arguments', () => {
		const { logger, log } = buildLogger();
		logger.log();
		expect(log).not.toHaveBeenCalled();
	});

	it('forwards every argument', () => {
		const { logger, log } = buildLogger();
		logger.log('hello', { extra: 1 });
		expect(log).toHaveBeenCalledWith('hello', { extra: 1 });
	});
});

describe('AppLogger debug()', () => {
	it('drops the message when debug is off', () => {
		const { logger, log } = buildLogger();
		logger.debug('hello', { extra: 1 });
		expect(log).not.toHaveBeenCalled();
	});

	it('forwards every argument when debug is on', () => {
		setDebug(true);
		const { logger, log } = buildLogger();
		logger.debug('hello', { extra: 1 });
		expect(log).toHaveBeenCalledWith('hello', { extra: 1 });
	});

	it('adds the prefix chain', () => {
		setDebug(true);
		const { logger, log } = buildLogger({ prefix: 'Tuya' });
		logger.debug('hello');
		expect(log).toHaveBeenCalledWith('[Tuya] hello');
	});
});

describe('AppLogger prefix chain', () => {
	it('adds a single prefix to the first argument', () => {
		const { logger, log } = buildLogger({ prefix: 'Tuya' });
		logger.log('hello');
		expect(log).toHaveBeenCalledWith('[Tuya] hello');
	});

	it('chains prefixes across child loggers', () => {
		const { logger, log } = buildLogger({ prefix: 'Tuya' });
		const child = logger.createChildLogger({ prefix: 'Nursery' });
		child.log('hello');
		expect(log).toHaveBeenCalledWith('[Tuya] [Nursery] hello');
	});

	it('does not change the parent prefix chain when a child adds one', () => {
		const { logger, log } = buildLogger({ prefix: 'A' });
		const child = logger.createChildLogger({ prefix: 'B' });
		child.log('one');
		logger.log('two');
		expect(log).toHaveBeenNthCalledWith(1, '[A] [B] one');
		expect(log).toHaveBeenNthCalledWith(2, '[A] two');
	});

	it('keeps the parent chain for a child without its own prefix', () => {
		const { logger, log } = buildLogger({ prefix: 'A' });
		const child = logger.createChildLogger();
		child.log('hi');
		expect(log).toHaveBeenCalledWith('[A] hi');
	});

	it('supports three levels of nesting', () => {
		const { logger, log } = buildLogger({ prefix: 'A' });
		const grandchild = logger.createChildLogger({ prefix: 'B' }).createChildLogger({ prefix: 'C' });
		grandchild.log('hi');
		expect(log).toHaveBeenCalledWith('[A] [B] [C] hi');
	});

	it('prefixes a non-string first argument by turning it into a string', () => {
		const { logger, log } = buildLogger({ prefix: 'A' });
		logger.log(42);
		expect(log).toHaveBeenCalledWith('[A] 42');
	});
});

describe('AppLogger setDebug()', () => {
	it('turns debug on for an existing logger', () => {
		const { logger, log } = buildLogger();
		setDebug(true);
		logger.debug('hello');
		expect(log).toHaveBeenCalledWith('hello');
	});

	it('turns debug off for an existing logger', () => {
		setDebug(true);
		const { logger, log } = buildLogger();
		setDebug(false);
		logger.debug('hello');
		expect(log).not.toHaveBeenCalled();
	});

	it('affects child loggers immediately', () => {
		const { logger, log } = buildLogger();
		const child = logger.createChildLogger({ prefix: 'Child' });
		setDebug(true);
		child.debug('hello');
		expect(log).toHaveBeenCalledWith('[Child] hello');
	});

	it('affects separate logger trees', () => {
		const { logger: loggerA, log: logA } = buildLogger();
		const { logger: loggerB, log: logB } = buildLogger();
		setDebug(true);
		loggerA.debug('a');
		loggerB.debug('b');
		expect(logA).toHaveBeenCalledWith('a');
		expect(logB).toHaveBeenCalledWith('b');
	});

	it('does not affect log() or error(), which always forward every argument', () => {
		const { logger, log, error } = buildLogger();
		logger.log('hello', { detail: 1 });
		logger.error('oops', { detail: 1 });
		expect(log).toHaveBeenCalledWith('hello', { detail: 1 });
		expect(error).toHaveBeenCalledWith('oops', { detail: 1 });
	});
});

describe('AppLogger error()', () => {
	it('calls the Homey error handler and skips Sentry when called without arguments', async () => {
		const { logger, error } = buildLogger();
		logger.error();
		await flushMicrotasks();
		expect(error).toHaveBeenCalledTimes(1);
		expect(error.mock.calls[0]).toHaveLength(0);
		expect(captureException).not.toHaveBeenCalled();
		expect(captureMessage).not.toHaveBeenCalled();
	});

	it('sends Error instances to captureException', async () => {
		const { logger } = buildLogger();
		const err = new Error('boom');
		logger.error(err);
		await flushMicrotasks();
		expect(captureException).toHaveBeenCalledWith(err);
		expect(captureMessage).not.toHaveBeenCalled();
	});

	it('sends strings to captureMessage', async () => {
		const { logger } = buildLogger();
		logger.error('string-message');
		await flushMicrotasks();
		expect(captureMessage).toHaveBeenCalledWith('string-message');
	});

	it('sends the undecorated message to Sentry, without the prefix', async () => {
		const { logger } = buildLogger({ prefix: 'Tuya' });
		logger.error('string-message');
		await flushMicrotasks();
		expect(captureMessage).toHaveBeenCalledWith('string-message');
	});

	it('turns other payloads into a string for captureMessage', async () => {
		const { logger } = buildLogger();
		logger.error({ weird: 'object' });
		await flushMicrotasks();
		expect(captureMessage).toHaveBeenCalledWith('[object Object]');
	});

	it('adds the prefix chain to the Homey error output', () => {
		const { logger, error } = buildLogger({ prefix: 'Tuya' });
		logger.error('oops');
		expect(error).toHaveBeenCalledWith('[Tuya] oops');
	});

	it('reports to the Homey error handler when Sentry itself fails', async () => {
		captureMessage.mockImplementation(async () => {
			throw new Error('sentry down');
		});
		const { logger, error } = buildLogger({ prefix: 'Tuya' });
		logger.error('oops');
		await flushMicrotasks();
		expect(error).toHaveBeenNthCalledWith(1, '[Tuya] oops');
		expect(error).toHaveBeenNthCalledWith(2, '[Tuya] Failed to send error to Sentry', expect.any(Error));
	});
});
