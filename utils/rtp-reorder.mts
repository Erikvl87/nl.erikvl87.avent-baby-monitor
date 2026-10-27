/**
 * Puts RTP packets back in sequence order. Over Wi-Fi the camera's packets regularly arrive slightly out of order,
 * and a resent packet always arrives late; passed on as they come, each such packet breaks the picture it belongs to
 * and every picture after it up to the next keyframe. Packets wait here until the ones before them have arrived, or
 * until waiting longer isn't worth it.
 */

export interface Sequenced {
	header: { sequenceNumber: number };
}

export interface ReorderResult<T> {
	/** Packets now in order, to pass on. */
	ready: T[];
	/** Sequence numbers given up on because they didn't arrive in time. */
	skipped: number;
	/** The packet came after its place was given up on (or was a duplicate), and was dropped. */
	late: boolean;
	/** The packet filled a gap, arriving after a later packet. */
	reordered: boolean;
}

/** The signed distance from `from` to `to` in 16-bit sequence space. */
function distance(from: number, to: number): number {
	return (((to - from) << 16) >> 16);
}

export class ReorderBuffer<T extends Sequenced> {
	private expected: number | undefined;
	private readonly pending = new Map<number, { packet: T; at: number }>();

	/**
	 * @param maxWaitMs How long a gap may hold up later packets.
	 * @param maxPending How many packets may wait at most, whatever their age.
	 */
	public constructor(
		private readonly maxWaitMs = 80,
		private readonly maxPending = 100,
		private readonly now: () => number = Date.now,
	) {}

	public push(packet: T): ReorderResult<T> {
		const sequence = packet.header.sequenceNumber;
		this.expected ??= sequence;

		const ahead = distance(this.expected, sequence);
		if (ahead < 0 || this.pending.has(sequence)) {
			return { ready: [], skipped: 0, late: true, reordered: false };
		}
		const reordered = ahead === 0 && this.pending.size > 0;
		this.pending.set(sequence, { packet, at: this.now() });

		const ready: T[] = [];
		let skipped = 0;
		this.drain(ready);
		while (this.pending.size > 0 && this.mustSkip()) {
			const next = this.nextPending();
			skipped += distance(this.expected, next);
			this.expected = next;
			this.drain(ready);
		}
		return { ready, skipped, late: false, reordered };
	}

	/** Packets still waiting for a gap to fill. */
	public get waiting(): number {
		return this.pending.size;
	}

	private drain(ready: T[]): void {
		let entry = this.pending.get(this.expected!);
		while (entry) {
			ready.push(entry.packet);
			this.pending.delete(this.expected!);
			this.expected = (this.expected! + 1) & 0xffff;
			entry = this.pending.get(this.expected);
		}
	}

	private mustSkip(): boolean {
		if (this.pending.size > this.maxPending) return true;
		const oldest = Math.min(...[...this.pending.values()].map(entry => entry.at));
		return this.now() - oldest > this.maxWaitMs;
	}

	/** The waiting packet that comes first in sequence order. */
	private nextPending(): number {
		let best: number | undefined;
		for (const sequence of this.pending.keys()) {
			if (best === undefined || distance(best, sequence) < 0) best = sequence;
		}
		return best!;
	}
}
