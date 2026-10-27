
declare module 'homey-log' {
	export class Log {
		constructor(options: { homey: Homey });
		captureException(err): Promise<string> | undefined;
		captureMessage(message): Promise<string> | undefined;
	}
}