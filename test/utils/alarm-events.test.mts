import { describe, it, expect } from 'vitest';
import { Dp } from '../../utils/dps.mjs';
import { decodeAlarmRecord, isNewAlarm, maxAlarmAgeSeconds, pushedAlarms } from '../../utils/alarm-events.mjs';

/** A motion alarm as an SCD951 posts it to data point 212. */
const motionRecordJson =
	'{"v":"4.0","bucket":"ty-eu-storage30","cmd":"ipc_motion","type":"image","with":"resource","alarm":true,' +
	'"time":1783686591,"files":[["/c9aa72/unify/1783686591.jpeg","6f2c417218f24082"]]}';

function base64(text: string): string {
	return Buffer.from(text, 'utf8').toString('base64');
}

function record(fields: Record<string, unknown>): string {
	return base64(JSON.stringify({ v: '4.0', bucket: 'ty-eu-storage30', type: 'image', ...fields }));
}

describe('decodeAlarmRecord', () => {
	it('decodes a base64 motion record', () => {
		expect(decodeAlarmRecord(base64(motionRecordJson))).toEqual({
			command: 'ipc_motion',
			time: 1783686591,
			kinds: ['motion'],
		});
	});

	it('decodes a plain JSON record', () => {
		expect(decodeAlarmRecord(motionRecordJson)?.command).toBe('ipc_motion');
	});

	it('decodes an already parsed object', () => {
		expect(decodeAlarmRecord({ cmd: 'ipc_motion', alarm: true, time: 1783686591 })?.time).toBe(1783686591);
	});

	it('tolerates surrounding whitespace', () => {
		expect(decodeAlarmRecord(`  ${base64(motionRecordJson)}\n`)?.command).toBe('ipc_motion');
	});

	it('converts a millisecond time to seconds', () => {
		expect(decodeAlarmRecord(record({ cmd: 'ipc_motion', alarm: true, time: 1783686591123 }))?.time).toBe(
			1783686591.123,
		);
	});

	it('accepts a time given as a string', () => {
		expect(decodeAlarmRecord(record({ cmd: 'ipc_motion', time: '1783686591' }))?.time).toBe(1783686591);
	});

	it('lowercases the command', () => {
		expect(decodeAlarmRecord(record({ cmd: 'IPC_MOTION', time: 1783686591 }))).toEqual({
			command: 'ipc_motion',
			time: 1783686591,
			kinds: ['motion'],
		});
	});

	it('ignores a record with alarm set to false', () => {
		expect(decodeAlarmRecord(record({ cmd: 'ipc_motion', alarm: false, time: 1783686591 }))).toBeUndefined();
	});

	it('treats a baby cry as both sound and crying', () => {
		expect(decodeAlarmRecord(record({ cmd: 'ipc_baby_cry', alarm: true, time: 1783686591 }))?.kinds).toEqual([
			'sound',
			'crying',
		]);
	});

	it('treats other sound commands as sound only', () => {
		expect(decodeAlarmRecord(record({ cmd: 'ipc_bang', time: 1783686591 }))?.kinds).toEqual(['sound']);
		expect(decodeAlarmRecord(record({ cmd: 'ipc_decibel', time: 1783686591 }))?.kinds).toEqual(['sound']);
	});

	it('treats human detection as motion', () => {
		expect(decodeAlarmRecord(record({ cmd: 'ipc_human', time: 1783686591 }))?.kinds).toEqual(['motion']);
	});

	it('keeps an unknown command but reports no alarm kinds', () => {
		expect(decodeAlarmRecord(record({ cmd: 'ipc_doorbell', alarm: true, time: 1783686591 }))).toEqual({
			command: 'ipc_doorbell',
			time: 1783686591,
			kinds: [],
		});
	});

	it('returns undefined without a command or a valid time', () => {
		expect(decodeAlarmRecord(record({ alarm: true, time: 1783686591 }))).toBeUndefined();
		expect(decodeAlarmRecord(record({ cmd: 'ipc_motion', alarm: true }))).toBeUndefined();
		expect(decodeAlarmRecord(record({ cmd: 'ipc_motion', time: 0 }))).toBeUndefined();
		expect(decodeAlarmRecord(record({ cmd: 'ipc_motion', time: -5 }))).toBeUndefined();
		expect(decodeAlarmRecord(record({ cmd: 'ipc_motion', time: 'soon' }))).toBeUndefined();
	});

	it('returns undefined for unreadable input', () => {
		expect(decodeAlarmRecord('')).toBeUndefined();
		expect(decodeAlarmRecord('   ')).toBeUndefined();
		expect(decodeAlarmRecord('not base64 json')).toBeUndefined();
		expect(decodeAlarmRecord('{broken')).toBeUndefined();
		expect(decodeAlarmRecord(base64('"just a string"'))).toBeUndefined();
		expect(decodeAlarmRecord(undefined)).toBeUndefined();
		expect(decodeAlarmRecord(null)).toBeUndefined();
		expect(decodeAlarmRecord(42)).toBeUndefined();
	});
});

describe('isNewAlarm', () => {
	const now = 1783686600;

	it('accepts a recent alarm when none was seen before', () => {
		expect(isNewAlarm(now - 9, undefined, now)).toBe(true);
	});

	it('accepts an alarm exactly at the freshness limit', () => {
		expect(maxAlarmAgeSeconds).toBe(180);
		expect(isNewAlarm(now - 180, undefined, now)).toBe(true);
	});

	it('rejects an alarm older than the freshness limit', () => {
		expect(isNewAlarm(now - 181, undefined, now)).toBe(false);
	});

	it('rejects the same alarm a second time', () => {
		expect(isNewAlarm(now - 9, now - 9, now)).toBe(false);
	});

	it('rejects an alarm older than the last one acted on', () => {
		expect(isNewAlarm(now - 30, now - 9, now)).toBe(false);
	});

	it('accepts an alarm newer than the last one acted on', () => {
		expect(isNewAlarm(now - 5, now - 9, now)).toBe(true);
	});

	it('accepts an alarm from the future, for cameras whose clock runs ahead', () => {
		expect(isNewAlarm(now + 60, undefined, now)).toBe(true);
	});

	it('works with a decoded millisecond time', () => {
		const decoded = decodeAlarmRecord(record({ cmd: 'ipc_motion', time: (now - 10) * 1000 + 500 }));
		expect(decoded).toBeDefined();
		expect(isNewAlarm(decoded!.time, now - 11, now)).toBe(true);
		expect(isNewAlarm(decoded!.time, decoded!.time, now)).toBe(false);
	});
});

describe('pushedAlarms', () => {
	it('reports motion when detection is on', () => {
		expect(pushedAlarms({ [Dp.motionEvent]: 'motion_detection' }, true)).toEqual(['motion']);
	});

	it('ignores motion when detection is off', () => {
		expect(pushedAlarms({ [Dp.motionEvent]: 'motion_detection' }, false)).toEqual([]);
	});

	it('reports sound regardless of motion detection', () => {
		expect(pushedAlarms({ [Dp.soundEvent]: 'decibel_upload' }, false)).toEqual(['sound']);
	});

	it('reports both together', () => {
		const dps = { [Dp.motionEvent]: 'motion_detection', [Dp.soundEvent]: 'decibel_upload' };
		expect(pushedAlarms(dps, true)).toEqual(['motion', 'sound']);
	});

	it('reports nothing for other data points or values', () => {
		const dps = { [Dp.temperature]: 2250, [Dp.motionEvent]: 'something_else', [Dp.soundEvent]: '' };
		expect(pushedAlarms(dps, true)).toEqual([]);
		expect(pushedAlarms({}, true)).toEqual([]);
	});
});
