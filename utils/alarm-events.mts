/**
 * Motion and sound alarms, which every monitor family reports differently:
 *
 * - The SCD973/SCD923 sets data point 250 to `motion_detection` and 141 to `decibel_upload`. These carry no time, and
 *   the cloud keeps the last value forever, so they only count when the camera pushes
 *   them, over the local connection or through Tuya's MQTT broker.
 * - The SCD951/SCD953 and SenseIQ post the alarm to data point 212 as (usually base64) JSON describing the snapshot
 *   they uploaded, for example `{"cmd":"ipc_motion","alarm":true,"time":1783686591,...}`. That carries its own time,
 *   so it works from a cloud poll too.
 */

export type AlarmKind = 'motion' | 'sound' | 'crying';

const motionCommands = new Set(['ipc_motion', 'ipc_move', 'ipc_human', 'motion']);
const cryCommands = new Set(['ipc_cry', 'ipc_baby_cry']);
const soundCommands = new Set(['ipc_bang', 'ipc_sound', 'ipc_decibel', 'sound', 'decibel', ...cryCommands]);

/** An alarm older than this is history: the poll interval is well below it, so a real alarm is always seen in time. */
export const maxAlarmAgeSeconds = 180;

export interface AlarmRecord {
	command: string;
	/** Seconds since the epoch. */
	time: number;
	kinds: AlarmKind[];
}

/** Decodes an alarm record (data point 212): base64 or plain JSON. Undefined for anything unreadable or not an alarm. */
export function decodeAlarmRecord(raw: unknown): AlarmRecord | undefined {
	let payload: unknown = raw;
	if (typeof raw === 'string') {
		let text = raw.trim();
		if (!text) return undefined;
		if (!text.startsWith('{')) text = Buffer.from(text, 'base64').toString('utf8');
		try {
			payload = JSON.parse(text);
		} catch {
			return undefined;
		}
	}
	if (!payload || typeof payload !== 'object') return undefined;

	const record = payload as { cmd?: unknown; alarm?: unknown; time?: unknown };
	if (record.alarm === false) return undefined;
	const command = String(record.cmd ?? '').toLowerCase();
	let time = Number(record.time);
	if (!command || !Number.isFinite(time) || time <= 0) return undefined;
	if (time > 1e11) time /= 1000;

	const kinds: AlarmKind[] = [];
	if (motionCommands.has(command)) kinds.push('motion');
	if (soundCommands.has(command)) kinds.push('sound');
	if (cryCommands.has(command)) kinds.push('crying');
	return { command, time, kinds };
}

/**
 * Whether an alarm should fire now: newer than the last one acted on, and recent enough to be happening rather than
 * remembered. A time from the future is accepted, since a camera whose clock runs ahead still reports real alarms.
 */
export function isNewAlarm(time: number, lastSeen: number | undefined, nowSeconds: number): boolean {
	if (lastSeen !== undefined && time <= lastSeen) return false;
	return time >= nowSeconds - maxAlarmAgeSeconds;
}

/**
 * The alarms in a set of data points the camera pushed (data points 250 and 141). Motion only counts
 * while motion detection is on: the camera sets 250 even when it is off.
 */
export function pushedAlarms(dps: Record<string, unknown>, motionDetectionOn: boolean): AlarmKind[] {
	const kinds: AlarmKind[] = [];
	if (dps['250'] === 'motion_detection' && motionDetectionOn) kinds.push('motion');
	if (dps['141'] === 'decibel_upload') kinds.push('sound');
	return kinds;
}
