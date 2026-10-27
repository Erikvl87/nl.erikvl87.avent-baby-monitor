/**
 * SenseIQ's live status (data point 3), a JSON string like `{"r":"o","br":0}`: `br` is breaths per minute (0 when
 * there is none to report) and `r` is the crib state, where `o` means empty and anything else means the baby is there.
 */
export interface SenseIqStatus {
	babyPresent: boolean | undefined;
	breathingRate: number | undefined;
}

/**
 * While the baby is in the crib, a monitor with a local connection pushes the status every 1–10 seconds, and simply
 * stops when the baby leaves. A minute without a push means the status on show is stale.
 */
export const statusStaleAfterMs = 60_000;

export function decodeSenseIqStatus(raw: unknown): SenseIqStatus | undefined {
	let data: unknown = raw;
	if (typeof raw === 'string') {
		try {
			data = JSON.parse(raw);
		} catch {
			return undefined;
		}
	}
	if (!data || typeof data !== 'object' || !('br' in data)) return undefined;

	const { r: state, br } = data as { r?: unknown; br?: unknown };
	const rate = Number(br);
	const breathingRate = Number.isFinite(rate) && rate > 0 ? rate : undefined;
	let babyPresent: boolean | undefined;
	if (breathingRate !== undefined) babyPresent = true;
	else if (typeof state === 'string' && state) babyPresent = state !== 'o';
	return { babyPresent, breathingRate };
}
