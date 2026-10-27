import { describe, it, expect } from 'vitest';
import { ReorderBuffer } from '../../utils/rtp-reorder.mjs';

const packet = (sequenceNumber: number): { header: { sequenceNumber: number } } => ({ header: { sequenceNumber } });
const order = (packets: Array<{ header: { sequenceNumber: number } }>): number[] => packets.map(item => item.header.sequenceNumber);

function clock(): { now: () => number; advance: (ms: number) => void } {
	let time = 0;
	return { now: () => time, advance: ms => (time += ms) };
}

describe('ReorderBuffer', () => {
	it('passes packets in order straight through', () => {
		const buffer = new ReorderBuffer(80, 100, clock().now);
		expect(order(buffer.push(packet(1)).ready)).toEqual([1]);
		expect(order(buffer.push(packet(2)).ready)).toEqual([2]);
	});

	it('holds packets after a gap until the missing one arrives', () => {
		const buffer = new ReorderBuffer(80, 100, clock().now);
		buffer.push(packet(1));
		expect(order(buffer.push(packet(3)).ready)).toEqual([]);
		expect(order(buffer.push(packet(4)).ready)).toEqual([]);
		const result = buffer.push(packet(2));
		expect(order(result.ready)).toEqual([2, 3, 4]);
		expect(result.reordered).toBe(true);
	});

	it('gives up on a gap after the wait and drops the packet when it comes after all', () => {
		const time = clock();
		const buffer = new ReorderBuffer(80, 100, time.now);
		buffer.push(packet(1));
		buffer.push(packet(3));
		time.advance(100);
		const result = buffer.push(packet(4));
		expect(order(result.ready)).toEqual([3, 4]);
		expect(result.skipped).toBe(1);
		expect(buffer.push(packet(2)).late).toBe(true);
	});

	it('gives up when too many packets wait', () => {
		const buffer = new ReorderBuffer(1_000, 3, clock().now);
		buffer.push(packet(1));
		for (const sequence of [3, 4, 5]) expect(buffer.push(packet(sequence)).ready).toEqual([]);
		expect(order(buffer.push(packet(6)).ready)).toEqual([3, 4, 5, 6]);
	});

	it('drops duplicates', () => {
		const buffer = new ReorderBuffer(80, 100, clock().now);
		buffer.push(packet(1));
		buffer.push(packet(3));
		expect(buffer.push(packet(3)).late).toBe(true);
		expect(buffer.push(packet(1)).late).toBe(true);
	});

	it('handles the wrap from 65535 to 0', () => {
		const buffer = new ReorderBuffer(80, 100, clock().now);
		buffer.push(packet(65534));
		expect(order(buffer.push(packet(0)).ready)).toEqual([]);
		expect(order(buffer.push(packet(65535)).ready)).toEqual([65535, 0]);
	});
});
