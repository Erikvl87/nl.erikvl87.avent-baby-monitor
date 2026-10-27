import type { Logger } from '../Logger.mjs';

export enum DeviceStatus {
	available = 'available',
	offline = 'offline',
	apiError = 'apiError',
	sessionExpired = 'sessionExpired',
}

export interface AvailabilityMessages {
	apiError: string;
	/** The warning shown instead of `apiError` while the local connection still brings the camera's pushes in. */
	apiErrorWithLocal: string;
	offline: string;
	sessionExpired: string;
}

export interface AvailabilityTrackerOptions {
	setAvailable: () => Promise<void>;
	setUnavailable: (message: string) => Promise<void>;
	/** Shows a warning on the device while it stays available; `null` clears it. */
	setWarning: (message: string | null) => Promise<void>;
	logger: Logger;
	messages: AvailabilityMessages;
	failureThreshold?: number;
}

/**
 * Tracks device availability across API successes and failures, the camera going offline, and the sign-in expiring.
 * Only transitions state once per logical change, so repeated signals don't spam `setAvailable`/`setUnavailable`.
 * A few failed requests in a row are normal for a cloud API, so the device only turns unavailable after
 * `failureThreshold` of them. While the local connection is up the camera's pushes still come in, so a cloud outage
 * then only shows a warning, and the device turns unavailable when the local connection drops too.
 */
export class AvailabilityTracker {
	private status: DeviceStatus = DeviceStatus.available;
	private failures = 0;
	private localConnected = false;
	private warning = false;
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
		await this.showWarning(false, 'Tuya API reachable again; warning cleared');
		if (this.status !== DeviceStatus.apiError) return;
		await this.transition(DeviceStatus.available, 'Tuya API reachable again; device available');
	}

	public async onApiFailure(): Promise<void> {
		this.failures += 1;
		if (!this.isCloudDown() || this.status !== DeviceStatus.available) return;
		if (this.localConnected) {
			await this.showWarning(
				true,
				`Tuya API failed ${this.failures} times in a row; the local connection is up, so the device stays available`,
			);
		} else {
			await this.transition(DeviceStatus.apiError, `Tuya API failed ${this.failures} times in a row`);
		}
	}

	/** The local connection came up or went down. During a cloud outage that decides whether the device is available. */
	public async onLocalConnection(connected: boolean): Promise<void> {
		this.localConnected = connected;
		if (!this.isCloudDown()) return;
		if (connected && this.status === DeviceStatus.apiError) {
			if (await this.transition(DeviceStatus.available, 'Local connection up while the Tuya API is unreachable'))
				await this.showWarning(true, 'Device available with a warning until the Tuya API answers');
		} else if (!connected && this.status === DeviceStatus.available) {
			await this.transition(DeviceStatus.apiError, 'Local connection down while the Tuya API is unreachable');
		}
	}

	/** The sign-in is no longer accepted; only a repair (signing in again) brings the device back. */
	public async onSessionExpired(): Promise<void> {
		await this.transition(DeviceStatus.sessionExpired, 'Session expired; the user needs to repair the device');
	}

	/** A new sign-in replaced the expired one. */
	public async onSessionRestored(): Promise<void> {
		this.failures = 0;
		await this.showWarning(false, 'Signed in again; warning cleared');
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

	private isCloudDown(): boolean {
		return this.failures >= this.threshold;
	}

	/** Moves to `status`; returns whether the device is in it now. */
	private async transition(status: DeviceStatus, reason: string): Promise<boolean> {
		if (this.status === status) return true;
		this.options.logger.log(reason);
		try {
			if (status === DeviceStatus.available) await this.options.setAvailable();
			else await this.options.setUnavailable(this.options.messages[status]);
			this.status = status;
		} catch (error) {
			this.options.logger.error(new Error(`Failed to mark device ${status}: ${(error as Error).message ?? error}`));
			return false;
		}
		// The unavailable message says it all, and a warning left behind would outlive the problem.
		if (status !== DeviceStatus.available) await this.showWarning(false);
		return true;
	}

	private async showWarning(on: boolean, reason?: string): Promise<void> {
		if (this.warning === on) return;
		if (reason) this.options.logger.log(reason);
		try {
			await this.options.setWarning(on ? this.options.messages.apiErrorWithLocal : null);
			this.warning = on;
		} catch (error) {
			this.options.logger.error(
				new Error(`Failed to ${on ? 'set' : 'clear'} the device warning: ${(error as Error).message ?? error}`),
			);
		}
	}
}
