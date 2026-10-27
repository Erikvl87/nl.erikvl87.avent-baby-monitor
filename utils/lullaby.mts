/** The 15 sounds, in id order, which is also the order Next steps through them. Ids match the `lullaby_track` capability. */
export const lullabies = [
	'baa_baa_black_sheep',
	'brahms_lullaby',
	'rock_a_bye_baby',
	'golden_slumbers',
	'hush_little_baby',
	'mothers_shh',
	'calming_river',
	'heartbeat',
	'vacuum_cleaner',
	'white_noise',
	'garden_bird_song',
	'valley_wind',
	'ocean_shore',
	'night_time_nature',
	'rain_shower',
] as const;

export type Lullaby = (typeof lullabies)[number];

/**
 * First track id of each block the sounds are published under, always in the order of `lullabies`. Units of the same
 * product report different blocks, and a camera ignores ids outside its own block:
 * - 3542154: the original SCD973
 * - 12072916: an SCD973 on firmware 1.1.12
 * - 3219038: the SCD923
 * - 4848444: an SCD973/SCD923 (`kzm54lhabeeucq5a`) on firmware 1.4.0, base 30.01. Next also steps through one more
 *   sound outside the block, 7964640, between the last and the first.
 * - 17807426: an SCD951/SCD953 (`selj2idknqhjnids`), base 40.00
 * The last two were measured by stepping through with Next and reading DP 248 after each step (see CLAUDE.md).
 */
export const blockStarts = [3542154, 12072916, 3219038, 4848444, 17807426];

/** Business code the camera expects with a track id. */
const bizCode = 'phi-no-bm';

/**
 * Reads the track id from the "now playing" data point, a JSON string like `{"bizcode":"phi-no-bm","id":3542155}`.
 * Some units (an SCD951/953 among them) report it with its quotes escaped, `{\"bizcode\":...}`, or encoded twice.
 */
export function readTrackId(value: unknown): number | undefined {
	let parsed: unknown = value;
	for (let depth = 0; typeof parsed === 'string' && depth < 3; depth++) {
		const text: string = parsed;
		try {
			parsed = JSON.parse(text);
		} catch {
			if (!text.includes('\\"')) return undefined;
			parsed = text.replace(/\\"/g, '"');
		}
	}
	const id = (parsed as { id?: unknown } | null)?.id;
	return typeof id === 'number' && Number.isInteger(id) ? id : undefined;
}

/** The sound a track id belongs to, whichever block it is in. */
export function lullabyForTrackId(id: number | undefined): Lullaby | undefined {
	if (id === undefined) return undefined;
	for (const start of blockStarts) {
		if (id >= start && id < start + lullabies.length) return lullabies[id - start];
	}
	return undefined;
}

/**
 * The track id to play a sound on this camera. The block comes from the last id the camera reported, the only sign of
 * which catalogue it holds; without one, the original block is assumed.
 */
export function trackIdFor(lullaby: string, currentId: number | undefined): number | undefined {
	const index = lullabies.indexOf(lullaby as Lullaby);
	if (index < 0) return undefined;
	const start =
		blockStarts.find(block => currentId !== undefined && currentId >= block && currentId < block + lullabies.length) ??
		blockStarts[0];
	return start + index;
}

/** The first id of the block a track id belongs to, or undefined for an id outside every known block. */
export function blockOf(id: number | undefined): number | undefined {
	if (id === undefined) return undefined;
	return blockStarts.find(start => id >= start && id < start + lullabies.length);
}

/** The track id of a sound in a given block. */
export function trackIdInBlock(lullaby: string, block: number): number | undefined {
	const index = lullabies.indexOf(lullaby as Lullaby);
	return index < 0 ? undefined : block + index;
}

/** The value for the "play this track" data point. */
export function trackValue(id: number): string {
	return JSON.stringify({ bizcode: bizCode, id });
}
