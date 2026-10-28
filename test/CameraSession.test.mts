import { describe, it, expect, vi } from 'vitest';
import {
	MediaStreamTrack,
	RTCPeerConnection,
	RtpHeader,
	RtpPacket,
	useH264,
	usePCMU,
	type RTCPeerConnection as Peer,
} from 'werift';
import CameraSession from '../CameraSession.mjs';
import { nalType } from '../utils/rtp-restamp.mjs';
import { createFakeLogger } from './helpers/fake-logger.mjs';

const codecs = { video: [useH264({ payloadType: 96 })], audio: [usePCMU()] };
const noIceServers = async (): Promise<[]> => [];

async function gathered(peer: Peer): Promise<void> {
	if (peer.iceGatheringState === 'complete') return;
	await new Promise<void>(resolve => {
		peer.iceGatheringStateChange.subscribe(state => {
			if (state === 'complete') resolve();
		});
	});
}

async function connected(peer: Peer): Promise<void> {
	if (peer.connectionState === 'connected') return;
	await new Promise<void>(resolve => {
		peer.connectionStateChange.subscribe(state => {
			if (state === 'connected') resolve();
		});
	});
}

async function sleep(ms: number): Promise<void> {
	await new Promise(resolve => setTimeout(resolve, ms));
}

/** A camera that answers like the monitors do and sends every packet with one constant timestamp. */
function createCamera(lineEnding = '\r\n'): {
	peer: Peer;
	offers: () => number;
	signal: (offer: { sdp: string; candidates: string[] }) => Promise<string>;
	send: () => Promise<void>;
} {
	const peer = new RTCPeerConnection({ codecs });
	const video = new MediaStreamTrack({ kind: 'video' });
	let sequence = 100;
	let offers = 0;
	const packet = (payload: number[], marker: boolean): RtpPacket =>
		new RtpPacket(
			new RtpHeader({ payloadType: 96, sequenceNumber: sequence++, timestamp: 1234, marker }),
			Buffer.from(payload),
		);

	return {
		peer,
		offers: () => offers,
		signal: async (offer: { sdp: string; candidates: string[] }): Promise<string> => {
			offers++;
			expect(offer.sdp).not.toContain('a=candidate');
			// The cameras only fill in the video section when audio comes first.
			expect(offer.sdp.indexOf('m=audio')).toBeLessThan(offer.sdp.indexOf('m=video'));
			expect(offer.candidates.length).toBeGreaterThan(0);
			await peer.setRemoteDescription({ type: 'offer', sdp: offer.sdp });
			for (const candidate of offer.candidates) await peer.addIceCandidate({ candidate, sdpMid: '0' });
			for (const transceiver of peer.getTransceivers()) {
				if (transceiver.kind === 'video') await transceiver.sender.replaceTrack(video);
				transceiver.setDirection('sendonly');
			}
			await peer.setLocalDescription(await peer.createAnswer());
			await gathered(peer);
			return peer.localDescription!.sdp.replace(/\r\n/g, lineEnding);
		},
		send: async (): Promise<void> => {
			await connected(peer);
			// A keyframe (SPS, PPS, IDR), then P frames, 40 ms apart, all with timestamp 1234.
			video.writeRtp(packet([0x67, 0x42], false));
			video.writeRtp(packet([0x68, 0xce], false));
			video.writeRtp(packet([0x65, 0x88], true));
			for (let frame = 0; frame < 5; frame++) {
				await sleep(40);
				video.writeRtp(packet([0x41, 0x80 | frame], true));
			}
			await sleep(40);
			video.writeRtp(packet([0x65, 0x99], true));
			// The relay holds each packet until the next arrives, so one more picture lets the keyframe through.
			await sleep(40);
			video.writeRtp(packet([0x41, 0x85], true));
		},
	};
}

/** A Homey viewer: makes an offer and collects the video it receives. */
async function createViewer(): Promise<{ peer: Peer; offer: string; received: RtpPacket[] }> {
	const peer = new RTCPeerConnection({ codecs });
	peer.addTransceiver('video', { direction: 'recvonly' });
	peer.addTransceiver('audio', { direction: 'recvonly' });
	const received: RtpPacket[] = [];
	peer.onTrack.subscribe(track => {
		track.onReceiveRtp.subscribe(rtp => {
			if (track.kind === 'video') received.push(rtp.clone());
		});
	});
	await peer.setLocalDescription(await peer.createOffer());
	await gathered(peer);
	return { peer, offer: peer.localDescription!.sdp, received };
}

describe('CameraSession', () => {
	it.each([
		['CRLF', '\r\n'],
		['bare LF', '\n'],
	])('relays the camera video (answer with %s) with timestamps that move with the clock', async (_name, ending) => {
		const camera = createCamera(ending);
		const session = new CameraSession({
			logger: createFakeLogger(),
			iceServers: noIceServers,
			signal: camera.signal,
			cameraVideoWaitMs: 0,
		});
		const viewer = await createViewer();

		const answer = await session.addViewer(viewer.offer);
		await viewer.peer.setRemoteDescription({ type: 'answer', sdp: answer });
		await connected(viewer.peer);
		await camera.send();
		await sleep(300);

		const types = viewer.received.map(packet => nalType(packet.payload));
		expect(types.slice(0, 3)).toEqual([7, 8, 5]);
		// The second keyframe gets the cached SPS and PPS again.
		expect(types.slice(-3)).toEqual([7, 8, 5]);
		// Only a picture's last packet carries the marker.
		expect(viewer.received.filter(item => item.header.marker).map(item => nalType(item.payload))).toEqual([
			5, 1, 1, 1, 1, 1, 5,
		]);

		const frameStarts = viewer.received.filter(packet => [1, 5].includes(nalType(packet.payload)));
		const stamps = frameStarts.map(packet => packet.header.timestamp);
		for (let i = 1; i < stamps.length; i++) {
			// About 40 ms apart at 90 kHz: 3600 ticks, with room for timer jitter.
			expect(stamps[i] - stamps[i - 1]).toBeGreaterThan(1800);
			expect(stamps[i] - stamps[i - 1]).toBeLessThan(18000);
		}
		const sequences = viewer.received.map(packet => packet.header.sequenceNumber);
		for (let i = 1; i < sequences.length; i++) expect((sequences[i] - sequences[i - 1]) & 0xffff).toBe(1);

		session.close();
		await viewer.peer.close();
		await camera.peer.close();
	}, 30_000);

	it("answers the first viewer only once the camera's video flows", async () => {
		const camera = createCamera();
		const logger = createFakeLogger();
		const session = new CameraSession({ logger, iceServers: noIceServers, signal: camera.signal });
		const viewer = await createViewer();

		let answered = false;
		const answer = session.addViewer(viewer.offer).then(sdp => {
			answered = true;
			return sdp;
		});
		await connected(camera.peer);
		await sleep(300);
		expect(answered).toBe(false);
		expect(session.isConnecting()).toBe(true);

		await camera.send();
		expect(await answer).toContain('m=video');
		await session.connected();
		expect(session.isConnecting()).toBe(false);
		expect(logger.logs.some(args => String(args[0]).startsWith('Camera video after'))).toBe(true);

		session.close();
		await viewer.peer.close();
		await camera.peer.close();
	}, 30_000);

	it('shares one camera stream between viewers, each under its own stream id', async () => {
		const camera = createCamera();
		const session = new CameraSession({
			logger: createFakeLogger(),
			iceServers: noIceServers,
			signal: camera.signal,
			cameraVideoWaitMs: 0,
		});
		const first = await createViewer();
		const second = await createViewer();

		await first.peer.setRemoteDescription({ type: 'answer', sdp: await session.addViewer(first.offer) });
		await second.peer.setRemoteDescription({ type: 'answer', sdp: await session.addViewer(second.offer) });
		await connected(first.peer);
		await connected(second.peer);
		expect(session.viewerCount).toBe(2);
		await camera.send();
		await sleep(300);

		expect(camera.offers()).toBe(1);
		for (const viewer of [first, second]) {
			expect(viewer.received.map(packet => nalType(packet.payload)).slice(0, 3)).toEqual([7, 8, 5]);
		}
		expect(second.received.map(packet => packet.header.timestamp)).toEqual(
			first.received.map(packet => packet.header.timestamp),
		);
		expect(first.received[0].header.ssrc).not.toBe(second.received[0].header.ssrc);

		session.close();
		await first.peer.close();
		await second.peer.close();
		await camera.peer.close();
	}, 30_000);

	it("answers a viewer who joins a running stream without waiting for the camera's video again", async () => {
		const camera = createCamera();
		const logger = createFakeLogger();
		const session = new CameraSession({ logger, iceServers: noIceServers, signal: camera.signal });
		const first = await createViewer();
		const answer = session.addViewer(first.offer);
		await camera.send();
		await first.peer.setRemoteDescription({ type: 'answer', sdp: await answer });

		const second = await createViewer();
		const started = Date.now();
		expect(await session.addViewer(second.offer)).toContain('m=video');
		// Gathering candidates takes a moment; the camera's 8 s wait doesn't come into it.
		expect(Date.now() - started).toBeLessThan(4_000);
		expect(logger.logs.filter(args => String(args[0]).startsWith('Camera video after'))).toHaveLength(1);

		session.close();
		await first.peer.close();
		await second.peer.close();
		await camera.peer.close();
	}, 30_000);

	it('keeps the camera stream while someone watches, and closes it a while after the last viewer left', async () => {
		const camera = createCamera();
		let closes = 0;
		const session = new CameraSession({
			logger: createFakeLogger(),
			iceServers: noIceServers,
			signal: camera.signal,
			cameraVideoWaitMs: 0,
			lingerMs: 200,
			onClose: (): void => {
				closes++;
			},
		});
		const first = await createViewer();
		const second = await createViewer();
		await first.peer.setRemoteDescription({ type: 'answer', sdp: await session.addViewer(first.offer) });
		await second.peer.setRemoteDescription({ type: 'answer', sdp: await session.addViewer(second.offer) });
		await connected(first.peer);
		await connected(second.peer);
		// Viewers report back once video flows; a viewer that stops reporting has left.
		await camera.send();
		await sleep(1_500);

		// A viewer that leaves closes its connection, which ends that viewer only.
		await first.peer.close();
		await vi.waitFor(() => expect(session.viewerCount).toBe(1), { timeout: 10_000, interval: 50 });
		await sleep(400);
		expect(session.isClosed()).toBe(false);

		await second.peer.close();
		await vi.waitFor(() => expect(session.viewerCount).toBe(0), { timeout: 10_000, interval: 50 });
		expect(session.isClosed()).toBe(false);
		await sleep(400);
		expect(session.isClosed()).toBe(true);
		expect(closes).toBe(1);

		await camera.peer.close();
	}, 30_000);

	it('closes the oldest viewer when one too many joins', async () => {
		const camera = createCamera();
		const logger = createFakeLogger();
		const session = new CameraSession({
			logger,
			iceServers: noIceServers,
			signal: camera.signal,
			cameraVideoWaitMs: 0,
			maxViewers: 1,
		});
		const first = await createViewer();
		const second = await createViewer();
		await first.peer.setRemoteDescription({ type: 'answer', sdp: await session.addViewer(first.offer) });
		await second.peer.setRemoteDescription({ type: 'answer', sdp: await session.addViewer(second.offer) });

		expect(session.viewerCount).toBe(1);
		expect(session.isClosed()).toBe(false);
		expect(logger.logs.some(args => args[0] === 'Closing the oldest viewer to make room')).toBe(true);

		session.close();
		await first.peer.close();
		await second.peer.close();
		await camera.peer.close();
	}, 30_000);

	it('rejects every waiting viewer when the camera refuses the stream', async () => {
		let closes = 0;
		const session = new CameraSession({
			logger: createFakeLogger(),
			iceServers: noIceServers,
			signal: async (): Promise<string> => {
				throw new Error('The camera ended the stream');
			},
			onClose: (): void => {
				closes++;
			},
		});
		const first = await createViewer();
		const second = await createViewer();
		const results = await Promise.allSettled([session.addViewer(first.offer), session.addViewer(second.offer)]);

		expect(results.map(result => result.status)).toEqual(['rejected', 'rejected']);
		expect(session.isClosed()).toBe(true);
		expect(session.viewerCount).toBe(0);
		expect(closes).toBe(1);
		await expect(session.addViewer(first.offer)).rejects.toThrow('closed');

		await first.peer.close();
		await second.peer.close();
	}, 30_000);

	it('closes every viewer with the camera stream, once', async () => {
		const camera = createCamera();
		let closes = 0;
		const session = new CameraSession({
			logger: createFakeLogger(),
			iceServers: noIceServers,
			signal: camera.signal,
			cameraVideoWaitMs: 0,
			onClose: (): void => {
				closes++;
			},
		});
		const viewer = await createViewer();
		await viewer.peer.setRemoteDescription({ type: 'answer', sdp: await session.addViewer(viewer.offer) });

		session.close();
		session.close();
		expect(closes).toBe(1);
		expect(session.isClosed()).toBe(true);
		expect(session.viewerCount).toBe(0);

		await viewer.peer.close();
		await camera.peer.close();
	}, 30_000);
});

