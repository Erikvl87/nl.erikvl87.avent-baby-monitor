import type { Logger } from '../Logger.mjs';

export enum DeviceStatus {
	available = 'available',
	offline = 'offline',
	apiError = 'apiError',
	sessionExpired = 'sessionExpired',
}

export interface AvailabilityMessages {
	apiError: string;
	offline: string;
	sessionExpired: string;
}

export interface AvailabilityTrackerOptions {
	setAvailable: () => Promise<void>;
	setUnavailable: (message: string) => Promise<void>;
	logger: Logger;
	messages: AvailabilityMessages;
	failureThreshold?: number;
}

/**
 * Tracks device availability across API successes and failures, the camera going offline, and the sign-in expiring.
 * Only transitions state once per logical change, so repeated signals don't spam `setAvailable`/`setUnavailable`.
 * A few failed requests in a row are normal for a cloud API, so the device only turns unavailable after
 * `failureThreshold` of them.
 */
export class AvailabilityTracker {
	private status: DeviceStatus = DeviceStatus.available;
	private failures = 0;
	private readonly threshold: number;

	public constructor(private readonly options: AvailabilityTrackerOptions) {
		this.threshold = options.failureThreshold ?? 5;
	}

	public getStatus(): DeviceStatus {
		return this.status;
	}

	/** A request succeeded. Recovers from API errors, but not from the camera being offline or the sign-in expiring. */
	public async onApiSuccess(): Promise<void> {
		this.failures = 0;
		if (this.status !== DeviceStatus.apiError) return;
		await this.transition(DeviceStatus.available, 'Tuya API reachable again; device available');
	}

	public async onApiFailure(): Promise<void> {
		this.failures += 1;
		if (this.failures < this.threshold || this.status !== DeviceStatus.available) return;
		await this.transition(DeviceStatus.apiError, `Tuya API failed ${this.failures} times in a row`);
	}

	/** The sign-in is no longer accepted; only a repair (signing in again) brings the device back. */
	public async onSessionExpired(): Promise<void> {
		await this.transition(DeviceStatus.sessionExpired, 'Session expired; the user needs to repair the device');
	}

	/** A new sign-in replaced the expired one. */
	public async onSessionRestored(): Promise<void> {
		this.failures = 0;
		await this.transition(DeviceStatus.available, 'Signed in again; device available');
	}

	public async onCameraOffline(): Promise<void> {
		if (this.status === DeviceStatus.sessionExpired) return;
		await this.transition(DeviceStatus.offline, 'Camera reported offline');
	}

	public async onCameraOnline(): Promise<void> {
		if (this.status !== DeviceStatus.offline) return;
		await this.transition(DeviceStatus.available, 'Camera reported online; device available');
	}

	private async transition(status: DeviceStatus, reason: string): Promise<void> {
		if (this.status === status) return;
		this.options.logger.log(reason);
		try {
			if (status === DeviceStatus.available) await this.options.setAvailable();
			else await this.options.setUnavailable(this.options.messages[status]);
			this.status = status;
		} catch (error) {
			this.options.logger.error(new Error(`Failed to mark device ${status}: ${(error as Error).message ?? error}`));
		}
	}
}
