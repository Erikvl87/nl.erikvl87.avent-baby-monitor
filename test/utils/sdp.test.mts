import { describe, it, expect } from 'vitest';
import { addCandidates, codecSummary, forWerift, h264Parameters, splitCandidates, streamTypeFor, normalizeCandidate, normalizeSdp, prepareOffer, sdpForLog } from '../../utils/sdp.mjs';

const offer = [
	'v=0',
	'o=- 1 2 IN IP4 127.0.0.1',
	's=-',
	'a=group:BUNDLE 0 1',
	'm=audio 9 UDP/TLS/RTP/SAVPF 0',
	'a=mid:0',
	'a=extmap:1 urn:ietf:params:rtp-hdrext:ssrc-audio-level',
	'a=sendrecv',
	'm=video 9 UDP/TLS/RTP/SAVPF 96',
	'a=mid:1',
	'a=extmap:2 http://www.webrtc.org/experiments/rtp-hdrext/abs-send-time',
	'a=recvonly',
	'',
].join('\r\n');

describe('prepareOffer', () => {
	it('removes every extmap line', () => {
		expect(prepareOffer(offer)).not.toContain('a=extmap');
	});

	it('makes audio receive-only so the camera does not start talk-back', () => {
		const prepared = prepareOffer(offer);
		const audio = prepared.slice(prepared.indexOf('m=audio'), prepared.indexOf('m=video'));
		expect(audio).toContain('a=recvonly');
		expect(audio).not.toContain('a=sendrecv');
	});

	it('leaves the video direction alone', () => {
		const prepared = prepareOffer(offer.replace('a=recvonly', 'a=sendrecv'));
		expect(prepared.slice(prepared.indexOf('m=video'))).toContain('a=sendrecv');
	});
});

describe('normalizeCandidate', () => {
	it('strips the a= prefix and the trailing carriage return the camera sends', () => {
		expect(normalizeCandidate('a=candidate:1 1 udp 2113937151 192.168.5.166 50000 typ host\r')).toBe(
			'candidate:1 1 udp 2113937151 192.168.5.166 50000 typ host',
		);
	});
});

describe('addCandidates', () => {
	it('adds the candidates to every media section, not the session section', () => {
		const answer = addCandidates(offer, ['a=candidate:1 1 udp 1 10.0.0.2 5000 typ host\r']);
		const [session, ...media] = answer.split(/(?=m=)/);
		expect(session).not.toContain('a=candidate');
		expect(media).toHaveLength(2);
		for (const section of media) {
			expect(section).toContain('a=candidate:1 1 udp 1 10.0.0.2 5000 typ host\r\na=end-of-candidates');
		}
	});

	it('keeps CRLF line endings', () => {
		const answer = addCandidates(offer, ['candidate:1 1 udp 1 10.0.0.2 5000 typ host']);
		expect(answer.endsWith('\r\n')).toBe(true);
		expect(answer.replace(/\r\n/g, '')).not.toContain('\n');
	});

	it('leaves the answer as it is without candidates', () => {
		expect(addCandidates(offer, [])).toBe(offer);
	});

	it('gives an answer with bare LF line endings CRLF throughout', () => {
		const lfAnswer = offer.replace(/\r\n/g, '\n');
		const answer = addCandidates(lfAnswer, ['candidate:1 1 udp 1 10.0.0.2 5000 typ host']);
		expect(answer.replace(/\r\n/g, '')).not.toContain('\n');
		expect(answer).toContain('\r\nm=audio 9 UDP/TLS/RTP/SAVPF 0\r\n');
	});
});

describe('normalizeSdp', () => {
	it('turns LF and stray whitespace into clean CRLF lines', () => {
		expect(normalizeSdp('v=0\nc=IN IP4 0.0.0.0 \r\na=mid:0\n\n')).toBe('v=0\r\nc=IN IP4 0.0.0.0\r\na=mid:0\r\n');
	});
});

describe('streamTypeFor', () => {
	it('picks the smallest H.264 stream for SD', () => {
		const skill = JSON.stringify({
			videos: [
				{ streamType: 2, codecType: 2, width: 1920, height: 1080 },
				{ streamType: 4, codecType: 2, width: 1280, height: 720 },
			],
		});
		expect(streamTypeFor(skill, 'sd')).toBe(4);
		expect(streamTypeFor(skill, 'hd')).toBe(2);
	});

	it('picks the largest H.264 stream', () => {
		const skill = JSON.stringify({
			webrtc: 3,
			videos: [
				{ streamType: 2, codecType: 2, width: 1920, height: 1080 },
				{ streamType: 4, codecType: 2, width: 640, height: 360 },
			],
		});
		expect(streamTypeFor(skill)).toBe(2);
	});

	it('skips H.265 streams', () => {
		const skill = JSON.stringify({
			videos: [
				{ streamType: 2, codecType: 4, width: 1920, height: 1080 },
				{ streamType: 4, codecType: 2, width: 640, height: 360 },
			],
		});
		expect(streamTypeFor(skill)).toBe(4);
	});

	it('falls back to the main stream for anything unreadable', () => {
		expect(streamTypeFor('not json')).toBe(1);
		expect(streamTypeFor(undefined)).toBe(1);
		expect(streamTypeFor('{}')).toBe(1);
	});
});

describe('forWerift', () => {
	it('gives a port-only rtcp line an address', () => {
		expect(forWerift('v=0\na=rtcp:9\n')).toContain('a=rtcp:9 IN IP4 0.0.0.0');
	});

	it('drops TTL suffixes from connection and rtcp addresses', () => {
		const sdp = forWerift('v=0\nc=IN IP4 0.0.0.0/127\na=rtcp:9 IN IP4 0.0.0.0/2\n');
		expect(sdp).toContain('c=IN IP4 0.0.0.0\r\n');
		expect(sdp).toContain('a=rtcp:9 IN IP4 0.0.0.0\r\n');
	});

	it('leaves well-formed lines alone', () => {
		const sdp = 'v=0\r\nc=IN IP4 192.168.5.150\r\na=rtcp:9 IN IP4 0.0.0.0\r\n';
		expect(forWerift(sdp)).toBe(sdp);
	});
});

describe('sdpForLog', () => {
	it('blanks the ICE password and fingerprint', () => {
		const logged = sdpForLog('v=0\na=ice-pwd:secret\na=fingerprint:sha-256 AA:BB\na=mid:0\n');
		expect(logged).not.toContain('secret');
		expect(logged).not.toContain('AA:BB');
		expect(logged).toContain('a=mid:0');
	});
});

describe('splitCandidates', () => {
	const withCandidates = [
		'v=0',
		'm=video 9 UDP/TLS/RTP/SAVPF 96',
		'a=candidate:1 1 udp 2116026367 172.25.1.2 43718 typ host generation 0',
		'a=candidate:2 1 udp 2116026367 fe80::1 43718 typ host',
		'a=end-of-candidates',
		'a=mid:0',
		'm=audio 9 UDP/TLS/RTP/SAVPF 0',
		'a=candidate:1 1 udp 2116026367 172.25.1.2 43718 typ host generation 0',
		'a=mid:1',
		'',
	].join('\r\n');

	it('takes the candidates out of the offer', () => {
		const { sdp } = splitCandidates(withCandidates);
		expect(sdp).not.toContain('a=candidate');
		expect(sdp).not.toContain('end-of-candidates');
		expect(sdp).toContain('a=mid:0');
		expect(sdp).toContain('a=mid:1');
	});

	it('returns each IPv4 candidate once, without the a= prefix', () => {
		expect(splitCandidates(withCandidates).candidates).toEqual([
			'candidate:1 1 udp 2116026367 172.25.1.2 43718 typ host generation 0',
		]);
	});
});

describe('h264Parameters and codecSummary', () => {
	const answer = [
		'v=0',
		'm=audio 9 UDP/TLS/RTP/SAVPF 0',
		'a=rtpmap:0 PCMU/8000',
		'm=video 9 UDP/TLS/RTP/SAVPF 96',
		'a=rtpmap:96 H264/90000',
		'a=fmtp:96 profile-level-id=640028;packetization-mode=1',
		'a=mid:1',
		'',
	].join('\n');

	it("reads the H.264 parameters of the video section", () => {
		expect(h264Parameters(answer)).toBe('profile-level-id=640028;packetization-mode=1');
		expect(h264Parameters('v=0\nm=audio 9 X 0\n')).toBeUndefined();
	});

	it('summarises the codec lines of one section', () => {
		expect(codecSummary(answer, 'video')).toBe(
			'm=video 9 UDP/TLS/RTP/SAVPF 96 | a=rtpmap:96 H264/90000 | a=fmtp:96 profile-level-id=640028;packetization-mode=1',
		);
		expect(codecSummary('v=0\n', 'video')).toBe('none');
	});
});
