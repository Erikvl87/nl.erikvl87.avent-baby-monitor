import { describe, it, expect, vi } from 'vitest';
import { AvailabilityTracker, DeviceStatus } from '../../utils/availability-tracker.mjs';
import { createFakeLogger, type FakeLogger } from '../helpers/fake-logger.mjs';

interface FakeCalls {
	setAvailable: ReturnType<typeof vi.fn<() => Promise<void>>>;
	setUnavailable: ReturnType<typeof vi.fn<(message: string) => Promise<void>>>;
	setWarning: ReturnType<typeof vi.fn<(message: string | null) => Promise<void>>>;
}

function buildTracker(
	overrides: {
		setAvailable?: () => Promise<void>;
		setUnavailable?: (message: string) => Promise<void>;
		setWarning?: (message: string | null) => Promise<void>;
		failureThreshold?: number;
	} = {},
): { tracker: AvailabilityTracker; calls: FakeCalls; logger: FakeLogger } {
	const setAvailable = vi.fn<() => Promise<void>>(overrides.setAvailable ?? (async (): Promise<void> => {}));
	const setUnavailable = vi.fn<(message: string) => Promise<void>>(
		overrides.setUnavailable ?? (async (): Promise<void> => {}),
	);
	const setWarning = vi.fn<(message: string | null) => Promise<void>>(
		overrides.setWarning ?? (async (): Promise<void> => {}),
	);
	const logger = createFakeLogger();
	const tracker = new AvailabilityTracker({
		setAvailable,
		setUnavailable,
		setWarning,
		logger,
		messages: {
			apiError: 'api-error',
			apiErrorWithLocal: 'api-error-with-local',
			offline: 'offline',
			sessionExpired: 'session-expired',
		},
		failureThreshold: overrides.failureThreshold,
	});
	return { tracker, calls: { setAvailable, setUnavailable, setWarning }, logger };
}

async function fail(tracker: AvailabilityTracker, times: number): Promise<void> {
	for (let i = 0; i < times; i += 1) {
		await tracker.onApiFailure();
	}
}

describe('AvailabilityTracker failure threshold', () => {
	it('starts available', () => {
		const { tracker } = buildTracker();
		expect(tracker.getStatus()).toBe(DeviceStatus.available);
	});

	it('stays available below the default threshold of five failures', async () => {
		const { tracker, calls } = buildTracker();
		await fail(tracker, 4);
		expect(tracker.getStatus()).toBe(DeviceStatus.available);
		expect(calls.setUnavailable).not.toHaveBeenCalled();
	});

	it('turns unavailable with the API error message on the fifth failure in a row', async () => {
		const { tracker, calls } = buildTracker();
		await fail(tracker, 5);
		expect(tracker.getStatus()).toBe(DeviceStatus.apiError);
		expect(calls.setUnavailable).toHaveBeenCalledTimes(1);
		expect(calls.setUnavailable).toHaveBeenCalledWith('api-error');
	});

	it('only marks the device unavailable once, however many failures follow', async () => {
		const { tracker, calls } = buildTracker();
		await fail(tracker, 9);
		expect(calls.setUnavailable).toHaveBeenCalledTimes(1);
	});

	it('respects a custom threshold', async () => {
		const { tracker } = buildTracker({ failureThreshold: 2 });
		await fail(tracker, 1);
		expect(tracker.getStatus()).toBe(DeviceStatus.available);
		await fail(tracker, 1);
		expect(tracker.getStatus()).toBe(DeviceStatus.apiError);
	});

	it('starts counting again after a success', async () => {
		const { tracker, calls } = buildTracker({ failureThreshold: 3 });
		await fail(tracker, 2);
		await tracker.onApiSuccess();
		await fail(tracker, 2);
		expect(tracker.getStatus()).toBe(DeviceStatus.available);
		expect(calls.setUnavailable).not.toHaveBeenCalled();
	});
});

describe('AvailabilityTracker recovery from API errors', () => {
	it('becomes available again on the next success', async () => {
		const { tracker, calls } = buildTracker({ failureThreshold: 1 });
		await fail(tracker, 1);
		await tracker.onApiSuccess();
		expect(tracker.getStatus()).toBe(DeviceStatus.available);
		expect(calls.setAvailable).toHaveBeenCalledTimes(1);
	});

	it('does not call setAvailable for a success while already available', async () => {
		const { tracker, calls } = buildTracker();
		await tracker.onApiSuccess();
		await tracker.onApiSuccess();
		expect(calls.setAvailable).not.toHaveBeenCalled();
	});
});

describe('AvailabilityTracker session expiry', () => {
	it('turns unavailable with the session message once', async () => {
		const { tracker, calls } = buildTracker();
		await tracker.onSessionExpired();
		await tracker.onSessionExpired();
		expect(tracker.getStatus()).toBe(DeviceStatus.sessionExpired);
		expect(calls.setUnavailable).toHaveBeenCalledTimes(1);
		expect(calls.setUnavailable).toHaveBeenCalledWith('session-expired');
	});

	it('is not cleared by API successes, the camera coming online, or failures', async () => {
		const { tracker, calls } = buildTracker({ failureThreshold: 1 });
		await tracker.onSessionExpired();
		await tracker.onApiSuccess();
		await tracker.onCameraOnline();
		await tracker.onCameraOffline();
		await fail(tracker, 3);
		expect(tracker.getStatus()).toBe(DeviceStatus.sessionExpired);
		expect(calls.setAvailable).not.toHaveBeenCalled();
		expect(calls.setUnavailable).toHaveBeenCalledTimes(1);
	});

	it('is cleared by onSessionRestored', async () => {
		const { tracker, calls } = buildTracker();
		await tracker.onSessionExpired();
		await tracker.onSessionRestored();
		expect(tracker.getStatus()).toBe(DeviceStatus.available);
		expect(calls.setAvailable).toHaveBeenCalledTimes(1);
	});

	it('overrides an API error state', async () => {
		const { tracker, calls } = buildTracker({ failureThreshold: 1 });
		await fail(tracker, 1);
		await tracker.onSessionExpired();
		expect(tracker.getStatus()).toBe(DeviceStatus.sessionExpired);
		expect(calls.setUnavailable).toHaveBeenLastCalledWith('session-expired');
	});

	it('resets the failure count when the session is restored', async () => {
		const { tracker } = buildTracker({ failureThreshold: 3 });
		await fail(tracker, 2);
		await tracker.onSessionRestored();
		await fail(tracker, 2);
		expect(tracker.getStatus()).toBe(DeviceStatus.available);
	});

	it('does not call setAvailable when restoring a session that never expired', async () => {
		const { tracker, calls } = buildTracker();
		await tracker.onSessionRestored();
		expect(calls.setAvailable).not.toHaveBeenCalled();
	});
});

describe('AvailabilityTracker camera offline and online', () => {
	it('turns unavailable with the offline message once', async () => {
		const { tracker, calls } = buildTracker();
		await tracker.onCameraOffline();
		await tracker.onCameraOffline();
		expect(tracker.getStatus()).toBe(DeviceStatus.offline);
		expect(calls.setUnavailable).toHaveBeenCalledTimes(1);
		expect(calls.setUnavailable).toHaveBeenCalledWith('offline');
	});

	it('becomes available when the camera comes back online', async () => {
		const { tracker, calls } = buildTracker();
		await tracker.onCameraOffline();
		await tracker.onCameraOnline();
		expect(tracker.getStatus()).toBe(DeviceStatus.available);
		expect(calls.setAvailable).toHaveBeenCalledTimes(1);
	});

	it('ignores the camera coming online when it was not offline', async () => {
		const { tracker, calls } = buildTracker();
		await tracker.onCameraOnline();
		expect(calls.setAvailable).not.toHaveBeenCalled();
	});

	it('is not cleared by an API success', async () => {
		const { tracker, calls } = buildTracker();
		await tracker.onCameraOffline();
		await tracker.onApiSuccess();
		expect(tracker.getStatus()).toBe(DeviceStatus.offline);
		expect(calls.setAvailable).not.toHaveBeenCalled();
	});

	it('does not turn into an API error while offline', async () => {
		const { tracker, calls } = buildTracker({ failureThreshold: 1 });
		await tracker.onCameraOffline();
		await fail(tracker, 3);
		expect(tracker.getStatus()).toBe(DeviceStatus.offline);
		expect(calls.setUnavailable).toHaveBeenCalledTimes(1);
	});

	it('replaces an API error with offline', async () => {
		const { tracker } = buildTracker({ failureThreshold: 1 });
		await fail(tracker, 1);
		await tracker.onCameraOffline();
		expect(tracker.getStatus()).toBe(DeviceStatus.offline);
	});
});

describe('AvailabilityTracker with the local connection up', () => {
	it('shows a warning instead of turning unavailable when the cloud fails', async () => {
		const { tracker, calls } = buildTracker({ failureThreshold: 2 });
		await tracker.onLocalConnection(true);
		await fail(tracker, 5);
		expect(tracker.getStatus()).toBe(DeviceStatus.available);
		expect(calls.setUnavailable).not.toHaveBeenCalled();
		expect(calls.setWarning).toHaveBeenCalledTimes(1);
		expect(calls.setWarning).toHaveBeenCalledWith('api-error-with-local');
	});

	it('does not warn below the threshold', async () => {
		const { tracker, calls } = buildTracker({ failureThreshold: 2 });
		await tracker.onLocalConnection(true);
		await fail(tracker, 1);
		expect(calls.setWarning).not.toHaveBeenCalled();
	});

	it('clears the warning when the cloud answers again', async () => {
		const { tracker, calls } = buildTracker({ failureThreshold: 1 });
		await tracker.onLocalConnection(true);
		await fail(tracker, 1);
		await tracker.onApiSuccess();
		expect(calls.setWarning).toHaveBeenLastCalledWith(null);
		expect(calls.setAvailable).not.toHaveBeenCalled();
	});

	it('turns unavailable when the local connection drops during the outage', async () => {
		const { tracker, calls } = buildTracker({ failureThreshold: 1 });
		await tracker.onLocalConnection(true);
		await fail(tracker, 1);
		await tracker.onLocalConnection(false);
		expect(tracker.getStatus()).toBe(DeviceStatus.apiError);
		expect(calls.setUnavailable).toHaveBeenCalledWith('api-error');
		expect(calls.setWarning).toHaveBeenLastCalledWith(null);
	});

	it('becomes available with a warning when the local connection comes up during the outage', async () => {
		const { tracker, calls } = buildTracker({ failureThreshold: 1 });
		await fail(tracker, 1);
		expect(tracker.getStatus()).toBe(DeviceStatus.apiError);
		await tracker.onLocalConnection(true);
		expect(tracker.getStatus()).toBe(DeviceStatus.available);
		expect(calls.setAvailable).toHaveBeenCalledTimes(1);
		expect(calls.setWarning).toHaveBeenLastCalledWith('api-error-with-local');
	});

	it('ignores the local connection while the cloud answers', async () => {
		const { tracker, calls } = buildTracker();
		await tracker.onLocalConnection(true);
		await tracker.onLocalConnection(false);
		expect(tracker.getStatus()).toBe(DeviceStatus.available);
		expect(calls.setAvailable).not.toHaveBeenCalled();
		expect(calls.setUnavailable).not.toHaveBeenCalled();
		expect(calls.setWarning).not.toHaveBeenCalled();
	});

	it('does not override an expired session', async () => {
		const { tracker, calls } = buildTracker({ failureThreshold: 1 });
		await tracker.onSessionExpired();
		await fail(tracker, 1);
		await tracker.onLocalConnection(true);
		expect(tracker.getStatus()).toBe(DeviceStatus.sessionExpired);
		expect(calls.setAvailable).not.toHaveBeenCalled();
		expect(calls.setWarning).not.toHaveBeenCalled();
	});

	it('clears the warning when the session expires', async () => {
		const { tracker, calls } = buildTracker({ failureThreshold: 1 });
		await tracker.onLocalConnection(true);
		await fail(tracker, 1);
		await tracker.onSessionExpired();
		expect(tracker.getStatus()).toBe(DeviceStatus.sessionExpired);
		expect(calls.setWarning).toHaveBeenLastCalledWith(null);
	});

	it('tries to set the warning again after a failure', async () => {
		let shouldFail = true;
		const { tracker, calls, logger } = buildTracker({
			failureThreshold: 1,
			setWarning: async () => {
				if (shouldFail) throw new Error('busy');
			},
		});
		await tracker.onLocalConnection(true);
		await fail(tracker, 1);
		expect(logger.errors).toHaveLength(1);
		shouldFail = false;
		await fail(tracker, 1);
		expect(calls.setWarning).toHaveBeenCalledTimes(2);
	});
});

describe('AvailabilityTracker failing transitions', () => {
	it('logs a setUnavailable failure and keeps the old status', async () => {
		const { tracker, logger } = buildTracker({
			setUnavailable: async () => {
				throw new Error('device deleted');
			},
		});
		await tracker.onCameraOffline();
		expect(tracker.getStatus()).toBe(DeviceStatus.available);
		expect(logger.errors).toHaveLength(1);
		expect(String(logger.errors[0][0])).toContain('device deleted');
		expect(String(logger.errors[0][0])).toContain('offline');
	});

	it('logs a setAvailable failure and keeps the old status', async () => {
		const { tracker, logger } = buildTracker({
			setAvailable: async () => {
				throw new Error('nope');
			},
		});
		await tracker.onSessionExpired();
		await tracker.onSessionRestored();
		expect(tracker.getStatus()).toBe(DeviceStatus.sessionExpired);
		expect(logger.errors).toHaveLength(1);
	});

	it('retries the transition on the next signal after a failure', async () => {
		let shouldFail = true;
		const { tracker, calls } = buildTracker({
			setUnavailable: async () => {
				if (shouldFail) throw new Error('busy');
			},
		});
		await tracker.onCameraOffline();
		shouldFail = false;
		await tracker.onCameraOffline();
		expect(tracker.getStatus()).toBe(DeviceStatus.offline);
		expect(calls.setUnavailable).toHaveBeenCalledTimes(2);
	});

	it('logs the reason for every transition', async () => {
		const { tracker, logger } = buildTracker();
		await tracker.onCameraOffline();
		await tracker.onCameraOnline();
		expect(logger.logs.map(args => args[0])).toEqual([
			'Camera reported offline',
			'Camera reported online; device available',
		]);
	});
});
