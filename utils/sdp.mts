/**
 * Gives an SDP CRLF line endings without trailing whitespace. Some cameras answer with bare LF; mixing that with the
 * CRLF lines added here makes a strict parser like werift's read several lines as one.
 */
export function normalizeSdp(sdp: string): string {
	const lines = sdp.split(/\r?\n/).map(line => line.trimEnd());
	while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
	return lines.join('\r\n') + '\r\n';
}

/**
 * Rewrites valid SDP that werift's strict parser rejects with a bare "exception": an `a=rtcp:` line with only a port,
 * and address lines with a TTL or count suffix (`IN IP4 0.0.0.0/127`).
 */
export function forWerift(sdp: string): string {
	return normalizeSdp(sdp)
		.split('\r\n')
		.map(line => {
			const rtcp = /^a=rtcp:(\d+)\s*(?:IN\s+(IP[46])\s+([^\s/]+).*)?$/.exec(line);
			if (rtcp) return `a=rtcp:${rtcp[1]} IN ${rtcp[2] ?? 'IP4'} ${rtcp[3] ?? '0.0.0.0'}`;
			const connection = /^c=IN\s+(IP[46])\s+([^\s/]+).*$/.exec(line);
			if (connection) return `c=IN ${connection[1]} ${connection[2]}`;
			return line;
		})
		.join('\r\n');
}

/** An SDP for the log: the ICE password and fingerprints blanked, on one line. */
export function sdpForLog(sdp: string): string {
	return normalizeSdp(sdp)
		.replace(/^(a=ice-pwd:).*$/gm, '$1…')
		.replace(/^(a=fingerprint:\S+ ).*$/gm, '$1…')
		.replace(/\r\n/g, ' | ');
}

/**
 * Prepares a viewer's WebRTC offer for the camera: drops the `a=extmap` lines, since the camera refuses offers over a
 * size it can handle, and makes audio receive-only, since offering to send audio puts the camera in talk-back mode,
 * which stops a playing lullaby and restarts it when the stream closes.
 */
export function prepareOffer(sdp: string): string {
	const sections = normalizeSdp(sdp).replace(/\r\na=extmap[^\r\n]*/g, '').split(/(?=\r\nm=)/);
	return sections
		.map(section =>
			section.startsWith('\r\nm=audio') ? section.replace(/\r\na=(sendrecv|sendonly)(?=\r\n|$)/, '\r\na=recvonly') : section,
		)
		.join('');
}

/**
 * Takes the ICE candidates out of an offer, so they can go to the camera as separate messages. The cameras truncate
 * an SDP over their size limit (the video section of the answer is cut off mid-line), and candidates for every
 * interface, repeated per media section, are most of an offer's size. IPv6 candidates are dropped: the cameras
 * only offer IPv4.
 * @returns The offer without candidates, and each distinct IPv4 candidate once, as `candidate:...`.
 */
export function splitCandidates(sdp: string): { sdp: string; candidates: string[] } {
	const candidates: string[] = [];
	const lines = normalizeSdp(sdp)
		.split('\r\n')
		.filter(line => {
			if (line === 'a=end-of-candidates') return false;
			if (!line.startsWith('a=candidate:')) return true;
			const candidate = normalizeCandidate(line);
			const address = candidate.split(' ')[4] ?? '';
			if (/^\d+\.\d+\.\d+\.\d+$/.test(address) && !candidates.includes(candidate)) candidates.push(candidate);
			return false;
		});
	return { sdp: lines.join('\r\n'), candidates };
}

/** Turns a candidate as the camera sends it (`a=candidate:...\r`) into a bare `candidate:...` line. */
export function normalizeCandidate(candidate: string): string {
	return candidate.trim().replace(/^a=/, '');
}

/**
 * Adds the camera's ICE candidates to its answer. The camera trickles them separately, but Homey wants a complete
 * answer, so they go into every media section, followed by an end-of-candidates marker.
 */
export function addCandidates(sdp: string, candidates: string[]): string {
	if (candidates.length === 0) return normalizeSdp(sdp);
	const lines = candidates.map(candidate => `a=${normalizeCandidate(candidate)}`).join('\r\n');
	const body = normalizeSdp(sdp).replace(/(\r\n)+$/, '');
	const sections = body.split(/(?=\r\nm=)/);
	return (
		sections
			.map((section, index) => (index === 0 ? section : `${section}\r\n${lines}\r\na=end-of-candidates`))
			.join('') + '\r\n'
	);
}

/** Tuya's video description: which stream types the camera has, and at which size. */
export interface CameraSkill {
	videos?: Array<{ streamType?: number; width?: number; height?: number; codecType?: number }>;
}

/**
 * The stream type to ask the camera for: its largest H.264 stream for HD, its smallest for SD. Falls back to 1 (the
 * main stream) when the camera doesn't describe its streams.
 */
export function streamTypeFor(skill: unknown, quality: 'hd' | 'sd' = 'hd'): number {
	let parsed: CameraSkill | undefined;
	try {
		parsed = typeof skill === 'string' ? (JSON.parse(skill) as CameraSkill) : (skill as CameraSkill);
	} catch {
		return 1;
	}
	let chosen: { type: number; size: number } | undefined;
	for (const video of parsed?.videos ?? []) {
		// H.265 needs a data channel and a decoder the viewer may not have.
		if (video.codecType === 4 || typeof video.streamType !== 'number') continue;
		const size = (video.width ?? 0) * (video.height ?? 0);
		const better = quality === 'hd' ? size > (chosen?.size ?? -1) : size < (chosen?.size ?? Infinity);
		if (!chosen || better) chosen = { type: video.streamType, size };
	}
	return chosen?.type ?? 1;
}

/** The lines of the first media section of a kind (`video`, `audio`), or none. */
function mediaSection(sdp: string, kind: string): string[] {
	const lines = normalizeSdp(sdp).split('\r\n');
	const start = lines.findIndex(line => line.startsWith(`m=${kind} `));
	if (start < 0) return [];
	const end = lines.findIndex((line, index) => index > start && line.startsWith('m='));
	return lines.slice(start, end < 0 ? undefined : end);
}

/** The codec lines (m=, rtpmap, fmtp) of a media section, on one line, for the log. */
export function codecSummary(sdp: string, kind: string): string {
	return (
		mediaSection(sdp, kind)
			.filter(line => line.startsWith('m=') || line.startsWith('a=rtpmap:') || line.startsWith('a=fmtp:'))
			.join(' | ') || 'none'
	);
}

/** The fmtp parameters of the first H.264 format in an SDP's video section, like `profile-level-id=640028;...`. */
export function h264Parameters(sdp: string): string | undefined {
	const lines = mediaSection(sdp, 'video');
	const payloadType = lines.map(line => /^a=rtpmap:(\d+) H264\//i.exec(line)?.[1]).find(Boolean);
	if (!payloadType) return undefined;
	return lines.find(line => line.startsWith(`a=fmtp:${payloadType} `))?.slice(`a=fmtp:${payloadType} `.length);
}
