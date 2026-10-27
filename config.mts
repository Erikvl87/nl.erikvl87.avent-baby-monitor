import Homey from 'homey';

export interface AppConfig {
	/** Key for obfuscating the stored session; see utils/secret-obfuscation.mts for why this is not real security. */
	obfuscationKey: string;
}

export function loadConfig(): AppConfig {
	const obfuscationKey = Homey.env.OBFUSCATION_KEY as string | undefined;
	if (!obfuscationKey) throw new Error('OBFUSCATION_KEY is missing from env.json');
	return { obfuscationKey };
}
