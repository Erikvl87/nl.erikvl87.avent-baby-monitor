import { describe, it, expect } from 'vitest';
import {
	MediaStreamTrack,
	RTCPeerConnection,
	RtpHeader,
	RtpPacket,
	useH264,
	usePCMU,
	type RTCPeerConnection as Peer,
} from 'werift';
import VideoRelay from '../VideoRelay.mjs';
import { nalType } from '../utils/rtp-restamp.mjs';
import { createFakeLogger } from './helpers/fake-logger.mjs';

const codecs = { video: [useH264({ payloadType: 96 })], audio: [usePCMU()] };

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

/** A camera that answers like the monitors do and sends every packet with one constant timestamp. */
function createCamera(lineEnding = '\r\n'): {
	peer: Peer;
	signal: (offer: { sdp: string; candidates: string[] }) => Promise<string>;
	send: () => Promise<void>;
} {
	const peer = new RTCPeerConnection({ codecs });
	const video = new MediaStreamTrack({ kind: 'video' });
	let sequence = 100;
	const packet = (payload: number[], marker: boolean): RtpPacket =>
		new RtpPacket(
			new RtpHeader({ payloadType: 96, sequenceNumber: sequence++, timestamp: 1234, marker }),
			Buffer.from(payload),
		);

	return {
		peer,
		signal: async (offer: { sdp: string; candidates: string[] }): Promise<string> => {
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
				await new Promise(resolve => setTimeout(resolve, 40));
				video.writeRtp(packet([0x41, 0x80 | frame], true));
			}
			await new Promise(resolve => setTimeout(resolve, 40));
			video.writeRtp(packet([0x65, 0x99], true));
			// The relay holds each packet until the next arrives, so one more picture lets the keyframe through.
			await new Promise(resolve => setTimeout(resolve, 40));
			video.writeRtp(packet([0x41, 0x85], true));
		},
	};
}

describe('VideoRelay', () => {
	it.each([
		['CRLF', '\r\n'],
		['bare LF', '\n'],
	])('relays the camera video (answer with %s) with timestamps that move with the clock', async (_name, ending) => {
		const camera = createCamera(ending);
		const relay = new VideoRelay({ logger: createFakeLogger(), iceServers: [], signal: camera.signal, cameraVideoWaitMs: 0 });

		const viewer = new RTCPeerConnection({ codecs });
		viewer.addTransceiver('video', { direction: 'recvonly' });
		viewer.addTransceiver('audio', { direction: 'recvonly' });
		const received: RtpPacket[] = [];
		viewer.onTrack.subscribe(track => {
			track.onReceiveRtp.subscribe(rtp => {
				if (track.kind === 'video') received.push(rtp.clone());
			});
		});
		await viewer.setLocalDescription(await viewer.createOffer());
		await gathered(viewer);

		const answer = await relay.answer(viewer.localDescription!.sdp);
		await viewer.setRemoteDescription({ type: 'answer', sdp: answer });
		await connected(viewer);
		await camera.send();
		await new Promise(resolve => setTimeout(resolve, 300));

		const types = received.map(packet => nalType(packet.payload));
		expect(types.slice(0, 3)).toEqual([7, 8, 5]);
		// The second keyframe gets the cached SPS and PPS again.
		expect(types.slice(-3)).toEqual([7, 8, 5]);
		// Only a picture's last packet carries the marker.
		expect(received.filter(item => item.header.marker).map(item => nalType(item.payload))).toEqual([5, 1, 1, 1, 1, 1, 5]);

		const frameStarts = received.filter(packet => [1, 5].includes(nalType(packet.payload)));
		const stamps = frameStarts.map(packet => packet.header.timestamp);
		for (let i = 1; i < stamps.length; i++) {
			// About 40 ms apart at 90 kHz: 3600 ticks, with room for timer jitter.
			expect(stamps[i] - stamps[i - 1]).toBeGreaterThan(1800);
			expect(stamps[i] - stamps[i - 1]).toBeLessThan(18000);
		}
		const sequences = received.map(packet => packet.header.sequenceNumber);
		for (let i = 1; i < sequences.length; i++) expect((sequences[i] - sequences[i - 1]) & 0xffff).toBe(1);

		relay.close();
		await viewer.close();
		await camera.peer.close();
	}, 30_000);

	it("answers the viewer only once the camera's video flows", async () => {
		const camera = createCamera();
		const logger = createFakeLogger();
		const relay = new VideoRelay({ logger, iceServers: [], signal: camera.signal });

		const viewer = new RTCPeerConnection({ codecs });
		viewer.addTransceiver('video', { direction: 'recvonly' });
		viewer.addTransceiver('audio', { direction: 'recvonly' });
		await viewer.setLocalDescription(await viewer.createOffer());
		await gathered(viewer);

		let answered = false;
		const answer = relay.answer(viewer.localDescription!.sdp).then(sdp => {
			answered = true;
			return sdp;
		});
		await connected(camera.peer);
		await new Promise(resolve => setTimeout(resolve, 300));
		expect(answered).toBe(false);
		expect(relay.isConnecting()).toBe(true);

		await camera.send();
		expect(await answer).toContain('m=video');
		await relay.connected();
		expect(relay.isConnecting()).toBe(false);
		expect(logger.logs.some(args => String(args[0]).startsWith('Camera video after'))).toBe(true);

		relay.close();
		await viewer.close();
		await camera.peer.close();
	}, 30_000);

	it('closes once and tells its owner', async () => {
		let closes = 0;
		const relay = new VideoRelay({
			logger: createFakeLogger(),
			iceServers: [],
			signal: async (): Promise<string> => '',
			onClose: (): void => {
				closes += 1;
			},
		});
		relay.close();
		relay.close();
		expect(closes).toBe(1);
		expect(relay.isClosed()).toBe(true);
	});
});
