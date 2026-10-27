/**
 * The camera's data points ("dps"), by number. The numbers and value types come from the Philips Avent Baby
 * Monitor+ app; see https://github.com/thekoma/aventproxy for how they were found.
 */
export enum Dp {
	statusLed = '101',
	motionSensitivity = '106',
	motionDetection = '134',
	nightLight = '138',
	soundDetection = '139',
	soundSensitivity = '140',
	soundEvent = '141',
	nightLightBrightness = '158',
	lullabyControl = '201',
	lullabyTrack = '202',
	temperature = '207',
	lullabyVolume = '209',
	alarmRecord = '212',
	privacyMode = '237',
	nightLightTimer = '240',
	nightLightTimerSwitch = '241',
	lullabyTimerSwitch = '243',
	lullabyTimer = '244',
	lullabyState = '246',
	lullabyCurrent = '248',
	motionEvent = '250',
	// SenseIQ models only
	senseIqStatus = '3',
}

export type DpValue = boolean | number | string;

/** Products the app knows. Each family reports alarms differently, and only SenseIQ watches breathing. */
export const senseIqProductId = '7d9t0rygsm7ztnww';

/**
 * The models reported with each product id (aventproxy's README and issues #40, #42, #61). The product id names a
 * family, not a model: Tuya returns nothing that tells the models within one apart.
 */
const modelNames: Record<string, string> = {
	kzm54lhabeeucq5a: 'SCD973 / SCD923 / SCD921',
	selj2idknqhjnids: 'SCD951 / SCD953',
	[senseIqProductId]: 'SenseIQ',
};

export function modelName(productId: string | undefined): string | undefined {
	return productId === undefined ? undefined : modelNames[productId];
}

export function isSenseIq(productId: string | undefined): boolean {
	return productId === senseIqProductId;
}

/** Reads a boolean data point, accepting the "0"/"1" strings some data points use. */
export function readBoolean(value: unknown): boolean | undefined {
	if (typeof value === 'boolean') return value;
	if (value === '1' || value === 1) return true;
	if (value === '0' || value === 0) return false;
	return undefined;
}

export function readNumber(value: unknown): number | undefined {
	if (typeof value === 'number' && Number.isFinite(value)) return value;
	if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) return Number(value);
	return undefined;
}

/** The temperature in °C. The camera reports hundredths of a degree (2250 is 22.5 °C). */
export function readTemperature(value: unknown): number | undefined {
	const raw = readNumber(value);
	return raw === undefined ? undefined : Math.round(raw) / 100;
}

/** A 1–100 data point (brightness, volume) as Homey's 0–1 scale. */
export function readPercentage(value: unknown): number | undefined {
	const raw = readNumber(value);
	return raw === undefined ? undefined : Math.min(Math.max(raw, 0), 100) / 100;
}

/** Homey's 0–1 scale as the camera's 1–100: the camera doesn't accept 0. */
export function toPercentage(value: number): number {
	return Math.min(Math.max(Math.round(value * 100), 1), 100);
}

const sensitivities = ['low', 'medium', 'high'] as const;

/** Sensitivity data points are the strings "0" (low), "1" (medium) and "2" (high). */
export function readSensitivity(value: unknown): (typeof sensitivities)[number] | undefined {
	return sensitivities[Number(value)];
}

export function toSensitivity(value: string): string {
	const index = sensitivities.indexOf(value as (typeof sensitivities)[number]);
	return String(index < 0 ? 1 : index);
}
