import { describe, it, expect } from 'vitest';
import {
	Dp,
	isSenseIq,
	readBoolean,
	readNumber,
	readPercentage,
	readSensitivity,
	readTemperature,
	senseIqProductId,
	toPercentage,
	toSensitivity,
} from '../../utils/dps.mjs';

describe('Dp', () => {
	it('maps the data points to their numbers as strings', () => {
		expect(Dp.temperature).toBe('207');
		expect(Dp.alarmRecord).toBe('212');
		expect(Dp.senseIqStatus).toBe('3');
	});
});

describe('isSenseIq', () => {
	it('is true only for the SenseIQ product id', () => {
		expect(isSenseIq(senseIqProductId)).toBe(true);
		expect(isSenseIq('7d9t0rygsm7ztnww')).toBe(true);
		expect(isSenseIq('someotherproduct')).toBe(false);
		expect(isSenseIq(undefined)).toBe(false);
	});
});

describe('readBoolean', () => {
	it('passes booleans through', () => {
		expect(readBoolean(true)).toBe(true);
		expect(readBoolean(false)).toBe(false);
	});

	it('reads "1"/"0" strings and 1/0 numbers', () => {
		expect(readBoolean('1')).toBe(true);
		expect(readBoolean('0')).toBe(false);
		expect(readBoolean(1)).toBe(true);
		expect(readBoolean(0)).toBe(false);
	});

	it('returns undefined for anything else', () => {
		expect(readBoolean('true')).toBeUndefined();
		expect(readBoolean(2)).toBeUndefined();
		expect(readBoolean(undefined)).toBeUndefined();
		expect(readBoolean(null)).toBeUndefined();
	});
});

describe('readNumber', () => {
	it('passes finite numbers through', () => {
		expect(readNumber(42)).toBe(42);
		expect(readNumber(-1.5)).toBe(-1.5);
	});

	it('parses numeric strings', () => {
		expect(readNumber('2250')).toBe(2250);
		expect(readNumber(' 7 ')).toBe(7);
	});

	it('returns undefined for non-numbers, blank strings and infinities', () => {
		expect(readNumber('')).toBeUndefined();
		expect(readNumber('   ')).toBeUndefined();
		expect(readNumber('abc')).toBeUndefined();
		expect(readNumber(Number.NaN)).toBeUndefined();
		expect(readNumber(Number.POSITIVE_INFINITY)).toBeUndefined();
		expect(readNumber(true)).toBeUndefined();
		expect(readNumber(undefined)).toBeUndefined();
	});
});

describe('readTemperature', () => {
	it('converts hundredths of a degree to degrees', () => {
		expect(readTemperature(2250)).toBe(22.5);
		expect(readTemperature('1987')).toBe(19.87);
	});

	it('returns undefined when there is no number', () => {
		expect(readTemperature(undefined)).toBeUndefined();
		expect(readTemperature('n/a')).toBeUndefined();
	});
});

describe('readPercentage', () => {
	it('scales 1-100 to 0-1', () => {
		expect(readPercentage(100)).toBe(1);
		expect(readPercentage(50)).toBe(0.5);
		expect(readPercentage('1')).toBe(0.01);
	});

	it('clamps values outside 0-100', () => {
		expect(readPercentage(150)).toBe(1);
		expect(readPercentage(-5)).toBe(0);
	});

	it('returns undefined when there is no number', () => {
		expect(readPercentage(undefined)).toBeUndefined();
	});
});

describe('toPercentage', () => {
	it('scales 0-1 to 1-100, rounding', () => {
		expect(toPercentage(1)).toBe(100);
		expect(toPercentage(0.5)).toBe(50);
		expect(toPercentage(0.333)).toBe(33);
	});

	it('never goes below 1, since the camera does not accept 0', () => {
		expect(toPercentage(0)).toBe(1);
		expect(toPercentage(-1)).toBe(1);
	});

	it('never goes above 100', () => {
		expect(toPercentage(2)).toBe(100);
	});
});

describe('readSensitivity', () => {
	it('reads "0", "1" and "2" as low, medium and high', () => {
		expect(readSensitivity('0')).toBe('low');
		expect(readSensitivity('1')).toBe('medium');
		expect(readSensitivity('2')).toBe('high');
		expect(readSensitivity(2)).toBe('high');
	});

	it('returns undefined for unknown values', () => {
		expect(readSensitivity('3')).toBeUndefined();
		expect(readSensitivity('high')).toBeUndefined();
		expect(readSensitivity(undefined)).toBeUndefined();
	});
});

describe('toSensitivity', () => {
	it('writes low, medium and high as "0", "1" and "2"', () => {
		expect(toSensitivity('low')).toBe('0');
		expect(toSensitivity('medium')).toBe('1');
		expect(toSensitivity('high')).toBe('2');
	});

	it('falls back to medium for an unknown value', () => {
		expect(toSensitivity('extreme')).toBe('1');
	});

	it('round-trips with readSensitivity', () => {
		for (const level of ['low', 'medium', 'high']) {
			expect(readSensitivity(toSensitivity(level))).toBe(level);
		}
	});
});
