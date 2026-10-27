/**
 * Tuya refused a request. `code` is Tuya's own error code (for example `USER_PASSWD_WRONG` or `SID_INVALID`), so
 * callers can tell a wrong password from an expired session without parsing the message.
 */
export default class TuyaError extends Error {
	public readonly code: string;

	public constructor(code: string, message: string) {
		super(`${code}: ${message}`);
		this.name = 'TuyaError';
		this.code = code;
	}

	/** The session id is no longer accepted, so the user has to sign in again (with a new emailed code). */
	public get isSessionExpired(): boolean {
		return ['SID_INVALID', 'USER_SESSION_LOSS', 'USER_SESSION_INVALID'].includes(this.code);
	}

	/** Tuya answered that the password is wrong. */
	public get isWrongPassword(): boolean {
		return this.code.includes('PASSWD');
	}

	/** Tuya answered that the emailed verification code is wrong or expired. */
	public get isWrongCode(): boolean {
		return this.code.includes('MFA') || this.code.includes('CODE');
	}
}
