import { describe, it, expect } from 'vitest';
import { decodeSenseIqStatus, statusStaleAfterMs } from '../../utils/senseiq.mjs';

describe('decodeSenseIqStatus', () => {
	it('reads an empty crib as baby absent without a breathing rate', () => {
		expect(decodeSenseIqStatus('{"r":"o","br":0}')).toEqual({ babyPresent: false, breathingRate: undefined });
	});

	it('reads a breathing rate as baby present', () => {
		expect(decodeSenseIqStatus('{"r":"m","br":32}')).toEqual({ babyPresent: true, breathingRate: 32 });
	});

	it('reads a non-empty crib state without a rate as baby present', () => {
		expect(decodeSenseIqStatus('{"r":"b","br":0}')).toEqual({ babyPresent: true, breathingRate: undefined });
	});

	it('trusts a breathing rate over an empty crib state', () => {
		expect(decodeSenseIqStatus('{"r":"o","br":28}')).toEqual({ babyPresent: true, breathingRate: 28 });
	});

	it('accepts an already parsed object and a rate given as a string', () => {
		expect(decodeSenseIqStatus({ r: 'm', br: '30' })).toEqual({ babyPresent: true, breathingRate: 30 });
	});

	it('leaves presence unknown without a crib state or rate', () => {
		expect(decodeSenseIqStatus('{"br":0}')).toEqual({ babyPresent: undefined, breathingRate: undefined });
		expect(decodeSenseIqStatus('{"r":"","br":0}')).toEqual({ babyPresent: undefined, breathingRate: undefined });
	});

	it('ignores a negative or non-numeric rate', () => {
		expect(decodeSenseIqStatus('{"r":"m","br":-1}')).toEqual({ babyPresent: true, breathingRate: undefined });
		expect(decodeSenseIqStatus('{"r":"o","br":"fast"}')).toEqual({ babyPresent: false, breathingRate: undefined });
	});

	it('returns undefined for garbage', () => {
		expect(decodeSenseIqStatus('garbage')).toBeUndefined();
		expect(decodeSenseIqStatus('{"r":"o"}')).toBeUndefined();
		expect(decodeSenseIqStatus('42')).toBeUndefined();
		expect(decodeSenseIqStatus('null')).toBeUndefined();
		expect(decodeSenseIqStatus(undefined)).toBeUndefined();
		expect(decodeSenseIqStatus(7)).toBeUndefined();
	});
});

describe('statusStaleAfterMs', () => {
	it('is one minute', () => {
		expect(statusStaleAfterMs).toBe(60_000);
	});
});
