import crypto from 'node:crypto';

const prefix = 'obfuscated:';

// Note: this exists so sensitive values don't show up in plaintext when you
// peek at a device in the Homey dev tools (screenshots, screen sharing, etc).
// It's not meant to be real crypto: any app with manage-devices can read
// device data via the Web API, and the obfuscation key itself is
// obtainable by a determined attacker, so there's nothing secret left to
// lean on. That's why the constant salt, AES-CBC and the shipped key are
// fine here. The goal is "not readable at a glance", not "unrecoverable".
export default class SecretObfuscation {
	private readonly derivedKey: Buffer;

	/**
	 * @internal Prefer `getApp(this.homey).secrets` in app code.
	 *
	 * @param key - Obfuscation key used to derive the AES key for both directions.
	 */
	public constructor(key: string) {
		this.derivedKey = crypto.scryptSync(key, 'salt', 32);
	}

	public isObfuscated(value: string): boolean {
		return value.startsWith(prefix);
	}

	public obfuscate(value: string): string {
		if (this.isObfuscated(value)) return value;

		const iv = crypto.randomBytes(16);
		const cipher = crypto.createCipheriv('aes-256-cbc', this.derivedKey, iv);
		const encrypted = cipher.update(value, 'utf8', 'hex') + cipher.final('hex');
		return `${prefix}${iv.toString('hex')}:${encrypted}`;
	}

	public deobfuscate(value: string): string {
		if (!this.isObfuscated(value)) return value;

		const [ivHex, encrypted] = value.slice(prefix.length).split(':');
		const decipher = crypto.createDecipheriv('aes-256-cbc', this.derivedKey, Buffer.from(ivHex, 'hex'));
		return decipher.update(encrypted, 'hex', 'utf8') + decipher.final('utf8');
	}
}
