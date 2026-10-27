import { describe, it, expect } from 'vitest';
import {
	countryRouting,
	dataCenterHosts,
	isWrongDataCenter,
	loginCandidates,
	normalizeHost,
} from '../../utils/region.mjs';

describe('loginCandidates', () => {
	it('tries the Netherlands on the EU data center first with calling code 31, then the rest with fallback codes', () => {
		expect(loginCandidates('NL')).toEqual([
			{ dataCenter: 'eu', host: 'a1.tuyaeu.com', callingCode: '31' },
			{ dataCenter: 'us', host: 'a1.tuyaus.com', callingCode: '1' },
			{ dataCenter: 'in', host: 'a1.tuyain.com', callingCode: '91' },
			{ dataCenter: 'cn', host: 'a1.tuyacn.com', callingCode: '86' },
		]);
	});

	it('tries the United States on the US data center first with calling code 1', () => {
		expect(loginCandidates('US')).toEqual([
			{ dataCenter: 'us', host: 'a1.tuyaus.com', callingCode: '1' },
			{ dataCenter: 'eu', host: 'a1.tuyaeu.com', callingCode: '39' },
			{ dataCenter: 'in', host: 'a1.tuyain.com', callingCode: '91' },
			{ dataCenter: 'cn', host: 'a1.tuyacn.com', callingCode: '86' },
		]);
	});

	it('keeps the country calling code only for its own data center', () => {
		const candidates = loginCandidates('IN');
		expect(candidates.map(candidate => candidate.dataCenter)).toEqual(['in', 'eu', 'us', 'cn']);
		expect(candidates.map(candidate => candidate.callingCode)).toEqual(['91', '39', '1', '86']);
	});

	it('accepts lowercase country codes', () => {
		expect(loginCandidates('nl')).toEqual(loginCandidates('NL'));
		expect(loginCandidates('us')[0].dataCenter).toBe('us');
	});

	it('falls back to the EU data center with calling code 39 for an unknown country', () => {
		const candidates = loginCandidates('XX');
		expect(candidates[0]).toEqual({ dataCenter: 'eu', host: 'a1.tuyaeu.com', callingCode: '39' });
		expect(candidates.map(candidate => candidate.dataCenter)).toEqual(['eu', 'us', 'in', 'cn']);
	});

	it('falls back to the EU data center with calling code 39 for an empty or missing country', () => {
		expect(loginCandidates('')[0]).toEqual({ dataCenter: 'eu', host: 'a1.tuyaeu.com', callingCode: '39' });
		expect(loginCandidates(undefined)[0]).toEqual({ dataCenter: 'eu', host: 'a1.tuyaeu.com', callingCode: '39' });
	});

	it('always lists every data center exactly once', () => {
		for (const country of ['NL', 'US', 'CN', 'IN', 'BR', '', 'ZZ']) {
			const dataCenters = loginCandidates(country).map(candidate => candidate.dataCenter);
			expect([...dataCenters].sort()).toEqual(['cn', 'eu', 'in', 'us']);
		}
	});

	it('only routes to known data centers', () => {
		for (const [, dataCenter] of Object.values(countryRouting)) {
			expect(dataCenterHosts[dataCenter]).toBeDefined();
		}
	});
});

describe('isWrongDataCenter', () => {
	it('is true for an account that does not exist in this data center', () => {
		expect(isWrongDataCenter('USER_NOT_EXIST')).toBe(true);
	});

	it('is true for session and region errors', () => {
		expect(isWrongDataCenter('USER_SESSION_INVALID')).toBe(true);
		expect(isWrongDataCenter('SESSION_LOSS')).toBe(true);
		expect(isWrongDataCenter('WRONG_REGION')).toBe(true);
	});

	it('ignores case', () => {
		expect(isWrongDataCenter('user_not_exist')).toBe(true);
	});

	it('is false for a wrong password', () => {
		expect(isWrongDataCenter('USER_PASSWD_WRONG')).toBe(false);
	});

	it('is false for code and MFA failures, even when they also mention a session', () => {
		expect(isWrongDataCenter('MFA_NEED_SEND_CODE')).toBe(false);
		expect(isWrongDataCenter('SESSION_CODE_EXPIRED')).toBe(false);
		expect(isWrongDataCenter('PASSWD_NOT_EXIST')).toBe(false);
	});

	it('is false for unrelated errors', () => {
		expect(isWrongDataCenter('ILLEGAL_ACCESS_API')).toBe(false);
		expect(isWrongDataCenter('')).toBe(false);
	});
});

describe('normalizeHost', () => {
	it('keeps a bare host', () => {
		expect(normalizeHost('a1.tuyaeu.com')).toBe('a1.tuyaeu.com');
	});

	it('strips the scheme and path from a full URL', () => {
		expect(normalizeHost('https://a1.tuyaeu.com')).toBe('a1.tuyaeu.com');
		expect(normalizeHost('http://a1.tuyaus.com/api.json')).toBe('a1.tuyaus.com');
	});

	it('trims whitespace', () => {
		expect(normalizeHost('  https://a1.tuyain.com/  ')).toBe('a1.tuyain.com');
	});

	it('returns undefined for empty strings and non-strings', () => {
		expect(normalizeHost('')).toBeUndefined();
		expect(normalizeHost('   ')).toBeUndefined();
		expect(normalizeHost('https://')).toBeUndefined();
		expect(normalizeHost(undefined)).toBeUndefined();
		expect(normalizeHost(null)).toBeUndefined();
		expect(normalizeHost(42)).toBeUndefined();
	});
});
