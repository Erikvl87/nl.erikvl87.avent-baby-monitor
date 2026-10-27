/**
 * The monitors send every RTP packet with the same timestamp, and set the marker bit at the end of every slice
 * rather than every picture. A player groups packets into pictures by timestamp and finishes a picture at the
 * marker, so it gets a stream of broken pictures and freezes. These rewrite the timestamps from the wall clock per
 * picture (access unit), found from the H.264 data itself, and move the marker to each picture's last packet. They
 * also keep the stream decodable for a viewer that joins after its start.
 */

/** The parts of an RTP packet this touches; werift's `RtpPacket` has this shape. */
export interface RtpLike {
	header: { timestamp: number; sequenceNumber: number; marker: boolean; extensions: unknown[]; ssrc?: number };
	payload: Buffer;
	clone(): RtpLike;
}

/** RTP clock ticks for elapsed milliseconds, wrapping at 2^32 the way RTP timestamps do. */
export function rtpTicks(elapsedMs: number, clockRate: number): number {
	return Math.floor((elapsedMs * clockRate) / 1000) >>> 0;
}

/** H.264 NAL unit types. */
const nalSlice = 1;
const nalIdr = 5;
const nalSei = 6;
const nalSps = 7;
const nalPps = 8;
const nalAud = 9;
const nalStapA = 24;
const nalFuA = 28;

/** The NAL type a packet carries; for a fragmented unit only its first fragment counts, other fragments give 0. */
export function nalType(payload: Buffer): number {
	if (payload.length === 0) return 0;
	const type = payload[0] & 0x1f;
	if (type !== nalFuA) return type;
	return payload.length > 1 && (payload[1] & 0x80) !== 0 ? payload[1] & 0x1f : 0;
}

/** The NAL types inside an aggregation (STAP-A) packet, with the byte offset of each NAL. */
function stapUnits(payload: Buffer): Array<{ type: number; offset: number }> {
	const units: Array<{ type: number; offset: number }> = [];
	let offset = 1;
	while (offset + 2 < payload.length) {
		const size = payload.readUInt16BE(offset);
		offset += 2;
		if (size === 0 || offset + size > payload.length) break;
		units.push({ type: payload[offset] & 0x1f, offset });
		offset += size;
	}
	return units;
}

/** What a packet means for picture boundaries. */
export interface PacketInfo {
	/** The (first) NAL type it carries; 0 for a continuation fragment. */
	type: number;
	/** It carries parameter sets, SEI or an access unit delimiter, which come before a picture's slices. */
	prefix: boolean;
	/** It starts a slice. */
	sliceStart: boolean;
	/** For a slice start: the slice begins at the picture's first macroblock, so it starts a new picture. */
	firstSliceOfPicture: boolean;
}

/** Whether a slice (whose header starts at `offset`, just after its NAL header byte) is a picture's first. */
function startsAtFirstMacroblock(payload: Buffer, offset: number): boolean {
	// first_mb_in_slice is the slice header's first field, exp-Golomb coded: 0 is the single bit 1.
	return offset < payload.length && (payload[offset] & 0x80) !== 0;
}

export function inspect(payload: Buffer): PacketInfo {
	const none: PacketInfo = { type: 0, prefix: false, sliceStart: false, firstSliceOfPicture: false };
	if (payload.length === 0) return none;
	const type = payload[0] & 0x1f;
	const isPrefix = (t: number): boolean => t === nalSei || t === nalSps || t === nalPps || t === nalAud;
	const isSlice = (t: number): boolean => t === nalSlice || t === nalIdr;

	if (type === nalFuA) {
		if (payload.length < 2 || (payload[1] & 0x80) === 0) return none;
		const inner = payload[1] & 0x1f;
		return {
			type: inner,
			prefix: isPrefix(inner),
			sliceStart: isSlice(inner),
			firstSliceOfPicture: isSlice(inner) && startsAtFirstMacroblock(payload, 2),
		};
	}
	if (type === nalStapA) {
		const units = stapUnits(payload);
		const first = units[0];
		if (!first) return none;
		const slice = units.find(unit => isSlice(unit.type));
		return {
			type: first.type,
			prefix: isPrefix(first.type),
			sliceStart: slice !== undefined,
			firstSliceOfPicture: slice !== undefined && startsAtFirstMacroblock(payload, slice.offset + 1),
		};
	}
	return {
		type,
		prefix: isPrefix(type),
		sliceStart: isSlice(type),
		firstSliceOfPicture: isSlice(type) && startsAtFirstMacroblock(payload, 1),
	};
}

export class VideoRestamper {
	private wallStart: number | undefined;
	private pictureTs = 0;
	/** Parameter sets or SEI have started the current picture, so its first slice doesn't start another. */
	private inPrefix = false;
	private seqOffset = 0;
	private lastSsrc: number | undefined;
	private lastSequence: number | undefined;
	private sps: RtpLike | undefined;
	private pps: RtpLike | undefined;
	/** Whether the camera itself sent the SPS and PPS for the picture being built, so they needn't be repeated. */
	private parameterSetsInPicture = false;
	/** The last packet, held until the next shows whether it ended its picture. */
	private held: RtpLike | undefined;
	/** Keyframes seen, for the relay's statistics. */
	public keyframes = 0;

	public constructor(private readonly now: () => number = Date.now) {}

	/**
	 * Takes one packet from the camera and returns the packets to send now, in order. Each packet is held back until
	 * the next one arrives, since only then is it known whether it was the last of its picture.
	 */
	public process(packet: RtpLike): RtpLike[] {
		const info = inspect(packet.payload);
		const startsPicture = this.startsPicture(info);
		if (startsPicture) {
			this.pictureTs = this.nextTimestamp();
			this.parameterSetsInPicture = false;
		}

		if (info.type === nalSps) this.sps = packet.clone();
		if (info.type === nalPps) this.pps = packet.clone();
		// An aggregation packet with both parameter sets stands in for both.
		if (packet.payload.length > 0 && (packet.payload[0] & 0x1f) === nalStapA) {
			const types = stapUnits(packet.payload).map(unit => unit.type);
			if (types.includes(nalSps) && types.includes(nalPps)) {
				this.sps = packet.clone();
				this.pps = undefined;
				this.parameterSetsInPicture = true;
			}
		}
		if (info.type === nalPps) this.parameterSetsInPicture = true;
		if (info.sliceStart && info.type === nalIdr) this.keyframes++;

		// A camera that switches streams (as on a switch to HD) starts new sequence numbers; continue ours instead.
		const ssrc = packet.header.ssrc;
		if (ssrc !== undefined && this.lastSsrc !== undefined && ssrc !== this.lastSsrc && this.lastSequence !== undefined) {
			this.seqOffset = this.lastSequence + 1 - packet.header.sequenceNumber;
		}
		if (ssrc !== undefined) this.lastSsrc = ssrc;

		const queued: RtpLike[] = [];
		if (info.sliceStart && info.type === nalIdr && info.firstSliceOfPicture && this.sps && !this.parameterSetsInPicture) {
			for (const cached of [this.sps, this.pps]) if (cached) queued.push(cached.clone());
			this.parameterSetsInPicture = true;
		}
		queued.push(packet);

		const firstSequence = packet.header.sequenceNumber;
		queued.forEach((item, index) => {
			item.header.timestamp = this.pictureTs;
			item.header.sequenceNumber = (firstSequence + this.seqOffset + index) & 0xffff;
			item.header.extensions = [];
			item.header.marker = false;
		});
		this.seqOffset += queued.length - 1;
		this.lastSequence = queued[queued.length - 1].header.sequenceNumber;

		const out: RtpLike[] = [];
		if (this.held) {
			this.held.header.marker = startsPicture;
			out.push(this.held);
		}
		this.held = queued.pop();
		out.push(...queued);
		return out;
	}

	private startsPicture(info: PacketInfo): boolean {
		if (this.wallStart === undefined) {
			this.inPrefix = info.prefix;
			return true;
		}
		if (info.prefix) {
			const starts = !this.inPrefix;
			this.inPrefix = true;
			return starts;
		}
		if (info.sliceStart) {
			const starts = info.firstSliceOfPicture && !this.inPrefix;
			this.inPrefix = false;
			return starts;
		}
		return false;
	}

	private nextTimestamp(): number {
		const now = this.now();
		if (this.wallStart === undefined) {
			this.wallStart = now;
			return 0;
		}
		let timestamp = rtpTicks(now - this.wallStart, 90_000);
		// Pictures must move forward; the signed difference survives wraparound.
		if (((timestamp - this.pictureTs) | 0) <= 0) timestamp = (this.pictureTs + 1) >>> 0;
		return timestamp;
	}
}

/** Audio packets each get the wall-clock time they arrive, at the 8 kHz the monitors' PCMU audio runs at. */
export class AudioRestamper {
	private wallStart: number | undefined;

	public constructor(
		private readonly now: () => number = Date.now,
		private readonly clockRate = 8_000,
	) {}

	public process(packet: RtpLike): RtpLike {
		const now = this.now();
		this.wallStart ??= now;
		packet.header.timestamp = rtpTicks(now - this.wallStart, this.clockRate);
		packet.header.extensions = [];
		return packet;
	}
}
