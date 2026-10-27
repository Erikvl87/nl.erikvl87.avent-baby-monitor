import { describe, it, expect } from 'vitest';
import SecretObfuscation from '../../utils/secret-obfuscation.mjs';

describe('SecretObfuscation', () => {
	const secrets = new SecretObfuscation('test-key');

	it('round-trips a value', () => {
		const obfuscated = secrets.obfuscate('{"sid":"eu1234","uid":"abc"}');
		expect(secrets.deobfuscate(obfuscated)).toBe('{"sid":"eu1234","uid":"abc"}');
	});

	it('round-trips empty and non-ASCII values', () => {
		expect(secrets.deobfuscate(secrets.obfuscate(''))).toBe('');
		expect(secrets.deobfuscate(secrets.obfuscate('wachtwoord €✓'))).toBe('wachtwoord €✓');
	});

	it('produces a prefixed value that does not contain the plaintext', () => {
		const obfuscated = secrets.obfuscate('my-session-id');
		expect(obfuscated).toMatch(/^obfuscated:[0-9a-f]{32}:[0-9a-f]+$/);
		expect(obfuscated).not.toContain('my-session-id');
	});

	it('uses a random IV, so the same value obfuscates differently each time', () => {
		expect(secrets.obfuscate('same')).not.toBe(secrets.obfuscate('same'));
	});

	it('recognises obfuscated values', () => {
		expect(secrets.isObfuscated(secrets.obfuscate('x'))).toBe(true);
		expect(secrets.isObfuscated('plain')).toBe(false);
		expect(secrets.isObfuscated('encrypted:abc:def')).toBe(false);
	});

	it('does not obfuscate an already obfuscated value twice', () => {
		const obfuscated = secrets.obfuscate('x');
		expect(secrets.obfuscate(obfuscated)).toBe(obfuscated);
	});

	it('passes plain values through deobfuscate unchanged', () => {
		expect(secrets.deobfuscate('plain value')).toBe('plain value');
	});

	it('can be read back by another instance with the same key', () => {
		const obfuscated = secrets.obfuscate('shared');
		expect(new SecretObfuscation('test-key').deobfuscate(obfuscated)).toBe('shared');
	});

	it('cannot be read back with a different key', () => {
		const obfuscated = secrets.obfuscate('a value long enough to fill more than one block');
		let recovered: string | undefined;
		try {
			recovered = new SecretObfuscation('other-key').deobfuscate(obfuscated);
		} catch {
			recovered = undefined;
		}
		expect(recovered).not.toBe('a value long enough to fill more than one block');
	});
});
