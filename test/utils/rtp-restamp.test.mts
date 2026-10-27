import { describe, it, expect } from 'vitest';
import { AudioRestamper, inspect, nalType, rtpTicks, VideoRestamper, type RtpLike } from '../../utils/rtp-restamp.mjs';

function packet(payload: number[], marker: boolean, sequenceNumber: number, timestamp = 1234): RtpLike {
	const make = (header: RtpLike['header'], body: Buffer): RtpLike => ({
		header,
		payload: body,
		clone: () => make({ ...header, extensions: [...header.extensions] }, Buffer.from(body)),
	});
	return make({ timestamp, sequenceNumber, marker, extensions: [{ id: 3 }] }, Buffer.from(payload));
}

function clock(): { now: () => number; advance: (ms: number) => void } {
	let time = 1_000_000;
	return { now: () => time, advance: ms => (time += ms) };
}

describe('nalType', () => {
	it('reads single NAL units and the first fragment of a fragmented one', () => {
		expect(nalType(Buffer.from([0x65]))).toBe(5);
		expect(nalType(Buffer.from([0x7c, 0x85]))).toBe(5);
		expect(nalType(Buffer.from([0x7c, 0x05]))).toBe(0);
		expect(nalType(Buffer.alloc(0))).toBe(0);
	});
});

describe('rtpTicks', () => {
	it('converts milliseconds to clock ticks and wraps at 2^32', () => {
		expect(rtpTicks(1000, 90_000)).toBe(90_000);
		expect(rtpTicks(40, 90_000)).toBe(3600);
		expect(rtpTicks(13.26 * 3600 * 1000 + 1000, 90_000)).toBeLessThan(2 ** 32);
	});
});

describe('inspect', () => {
	it("tells a picture's first slice from a later one by its first macroblock", () => {
		expect(inspect(Buffer.from([0x41, 0x80])).firstSliceOfPicture).toBe(true);
		expect(inspect(Buffer.from([0x41, 0x40])).firstSliceOfPicture).toBe(false);
		expect(inspect(Buffer.from([0x7c, 0x85, 0x80])).firstSliceOfPicture).toBe(true);
		expect(inspect(Buffer.from([0x7c, 0x05, 0x80])).sliceStart).toBe(false);
	});

	it('marks parameter sets, SEI and delimiters as coming before a picture', () => {
		for (const header of [0x67, 0x68, 0x06, 0x09]) expect(inspect(Buffer.from([header, 0])).prefix).toBe(true);
		expect(inspect(Buffer.from([0x41, 0x80])).prefix).toBe(false);
	});
});

/** Feeds packets through and returns everything sent, flushing the held packet with one extra picture. */
function run(restamper: VideoRestamper, packets: RtpLike[], advance?: (index: number) => void): RtpLike[] {
	const out: RtpLike[] = [];
	packets.forEach((item, index) => {
		advance?.(index);
		out.push(...restamper.process(item));
	});
	return out;
}

describe('VideoRestamper', () => {
	it('holds each packet until the next one arrives', () => {
		const restamper = new VideoRestamper(clock().now);
		expect(restamper.process(packet([0x41, 0x80], true, 1))).toEqual([]);
		expect(restamper.process(packet([0x41, 0x80], true, 2)).map(item => item.header.sequenceNumber)).toEqual([1]);
	});

	it('gives every slice of a picture the same timestamp and sets the marker only on its last packet', () => {
		const time = clock();
		const restamper = new VideoRestamper(time.now);
		// Two pictures of two slices each; the camera sets the marker after every slice.
		const out = run(
			restamper,
			[
				packet([0x41, 0x80], true, 1),
				packet([0x41, 0x40], true, 2),
				packet([0x41, 0x80], true, 3),
				packet([0x41, 0x40], true, 4),
				packet([0x41, 0x80], true, 5),
			],
			index => {
				if (index === 2 || index === 4) time.advance(40);
			},
		);
		expect(out.map(item => item.header.sequenceNumber)).toEqual([1, 2, 3, 4]);
		expect(out.map(item => item.header.marker)).toEqual([false, true, false, true]);
		expect(out[1].header.timestamp).toBe(out[0].header.timestamp);
		expect(out[3].header.timestamp).toBe(out[2].header.timestamp);
		expect(out[2].header.timestamp - out[0].header.timestamp).toBe(rtpTicks(40, 90_000));
	});

	it('treats parameter sets and the keyframe after them as one picture', () => {
		const time = clock();
		const restamper = new VideoRestamper(time.now);
		const out = run(restamper, [
			packet([0x41, 0x80], true, 1),
			packet([0x67, 0x42], false, 2),
			packet([0x68, 0xce], false, 3),
			packet([0x65, 0x88], true, 4),
			packet([0x41, 0x80], true, 5),
		], index => {
			if (index > 0) time.advance(10);
		});
		const [p, sps, pps, idr] = out;
		expect([sps, pps, idr].every(item => item.header.timestamp === sps.header.timestamp)).toBe(true);
		expect(sps.header.timestamp).toBeGreaterThan(p.header.timestamp);
		expect(out.map(item => item.header.marker)).toEqual([true, false, false, true]);
	});

	it('keeps pictures moving forward when the clock stands still', () => {
		const restamper = new VideoRestamper(clock().now);
		const out = run(restamper, [packet([0x41, 0x80], true, 1), packet([0x41, 0x80], true, 2), packet([0x41, 0x80], true, 3)]);
		expect(out[1].header.timestamp).toBe(out[0].header.timestamp + 1);
	});

	it('re-sends the cached SPS and PPS before a keyframe that comes without them', () => {
		const time = clock();
		const restamper = new VideoRestamper(time.now);
		const out = run(restamper, [
			packet([0x67, 0xaa], false, 10),
			packet([0x68, 0xbb], false, 11),
			packet([0x65, 0x81], true, 12),
			packet([0x65, 0x82], true, 13),
			packet([0x41, 0x80], true, 14),
		], index => {
			if (index >= 3) time.advance(40);
		});
		expect(out.map(item => nalType(item.payload))).toEqual([7, 8, 5, 7, 8, 5]);
		expect(out.map(item => item.header.sequenceNumber)).toEqual([10, 11, 12, 13, 14, 15]);
		expect(out.slice(3).every(item => item.header.timestamp === out[3].header.timestamp)).toBe(true);
		expect(out.map(item => item.header.marker)).toEqual([false, false, true, false, false, true]);
		expect(restamper.keyframes).toBe(2);
	});

	it('caches SPS and PPS that arrive together in one aggregation packet', () => {
		const time = clock();
		const restamper = new VideoRestamper(time.now);
		const stap = [0x78, 0x00, 0x02, 0x67, 0xaa, 0x00, 0x02, 0x68, 0xbb];
		const out = run(restamper, [
			packet(stap, false, 1),
			packet([0x65, 0x80], true, 2),
			packet([0x65, 0x80], true, 3),
			packet([0x41, 0x80], true, 4),
		], index => {
			if (index >= 2) time.advance(40);
		});
		expect(out.map(item => nalType(item.payload))).toEqual([24, 5, 24, 5]);
	});

	it('continues the sequence numbers when the camera switches to a new stream', () => {
		const time = clock();
		const restamper = new VideoRestamper(time.now);
		const items = [packet([0x41, 0x80], true, 500), packet([0x41, 0x80], true, 9000), packet([0x41, 0x80], true, 9001), packet([0x41, 0x80], true, 9002)];
		items[0].header.ssrc = 1111;
		for (const item of items.slice(1)) item.header.ssrc = 2222;
		const out = run(restamper, items, () => time.advance(40));
		expect(out.map(item => item.header.sequenceNumber)).toEqual([500, 501, 502]);
	});

	it('wraps sequence numbers at 16 bits and drops the camera header extensions', () => {
		const restamper = new VideoRestamper(clock().now);
		const out = run(restamper, [packet([0x41, 0x80], true, 0xffff), packet([0x41, 0x80], true, 0)]);
		expect(out[0].header.sequenceNumber).toBe(0xffff);
		expect(out[0].header.extensions).toEqual([]);
	});
});

describe('AudioRestamper', () => {
	it('stamps each packet with the time it arrives at 8 kHz', () => {
		const time = clock();
		const restamper = new AudioRestamper(time.now);
		expect(restamper.process(packet([0], false, 1)).header.timestamp).toBe(0);
		time.advance(20);
		expect(restamper.process(packet([0], false, 2)).header.timestamp).toBe(160);
	});
});
