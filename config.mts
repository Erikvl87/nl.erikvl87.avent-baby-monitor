import Homey from 'homey';

export interface AppConfig {
	/** Key for obfuscating the stored session; see utils/secret-obfuscation.mts for why this is not real security. */
	encryptionKey: string;
}

export function loadConfig(): AppConfig {
	const encryptionKey = Homey.env.ENCRYPTION_KEY as string | undefined;
	if (!encryptionKey) throw new Error('ENCRYPTION_KEY is missing from env.json');
	return { encryptionKey };
}
