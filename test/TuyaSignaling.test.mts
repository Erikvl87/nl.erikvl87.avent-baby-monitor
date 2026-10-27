import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import type { IClientOptions, MqttClient } from 'mqtt';
import TuyaSignaling from '../TuyaSignaling.mjs';
import type { TuyaSession } from '../types/tuya.mjs';
import { decodeDeviceMessage, encodeDeviceMessage, type SignalMessage } from '../utils/tuya-mqtt.mjs';
import { createFakeLogger } from './helpers/fake-logger.mjs';

const session: TuyaSession = {
	sid: 'sid1',
	uid: 'uid1',
	email: 'parent@example.com',
	apiHost: 'a1.tuyaeu.com',
	callingCode: '31',
	phoneId: 'phone1',
	ecode: 'ecode1',
	partnerIdentity: 'p1000001',
	mqttHost: 'm1.tuyaeu.com',
};

const rtc = { auth: 'auth1', motoId: 'moto1', p2pConfig: { ices: [{ urls: 'turn:turn.example:3478' }] } };

type FakeClient = EventEmitter & {
	connected: boolean;
	publishAsync: ReturnType<typeof vi.fn>;
	subscribeAsync: ReturnType<typeof vi.fn>;
	unsubscribeAsync: ReturnType<typeof vi.fn>;
	end: ReturnType<typeof vi.fn>;
};

function createFakeClient(): FakeClient {
	return Object.assign(new EventEmitter(), {
		connected: true,
		publishAsync: vi.fn(async () => undefined),
		subscribeAsync: vi.fn(async () => []),
		unsubscribeAsync: vi.fn(async () => undefined),
		end: vi.fn(),
	});
}

function setup(sessionOverrides: Partial<TuyaSession> = {}): {
	signaling: TuyaSignaling;
	client: FakeClient;
	connect: ReturnType<typeof vi.fn>;
} {
	const client = createFakeClient();
	const connect = vi.fn(async (_url: string, _options: IClientOptions) => client as unknown as MqttClient);
	const signaling = new TuyaSignaling({
		logger: createFakeLogger(),
		session: { ...session, ...sessionOverrides },
		connect,
		answerTimeoutMs: 1_000,
		candidateWaitMs: 100,
	});
	return { signaling, client, connect };
}

/** The offer the signaling published, once it has been published. */
async function publishedOffer(client: FakeClient): Promise<{ topic: string; message: SignalMessage }> {
	await vi.waitFor(() => expect(client.publishAsync).toHaveBeenCalled());
	const [topic, payload] = client.publishAsync.mock.calls[0] as [string, string];
	return { topic, message: JSON.parse(payload) as SignalMessage };
}

function reply(client: FakeClient, sessionId: string, type: string, msg: Record<string, unknown>): void {
	const payload = { protocol: 302, data: { header: { type, sessionid: sessionId }, msg } };
	client.emit('message', '/av/u/uid1', Buffer.from(JSON.stringify(payload)));
}

describe('TuyaSignaling', () => {
	beforeEach(() => {
		vi.useFakeTimers({ shouldAdvanceTime: true });
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	it('connects to the broker with the derived credentials and listens on the user topic', async () => {
		const { signaling, client, connect } = setup();
		const stream = signaling.startStream({ deviceId: 'dev1', offerSdp: 'v=0', rtc, streamType: 2 });
		const { message } = await publishedOffer(client);
		reply(client, message.data.header.sessionid, 'answer', { sdp: 'v=0\r\n' });
		await vi.advanceTimersByTimeAsync(100);
		await stream;

		const [url, options] = connect.mock.calls[0] as [string, IClientOptions];
		expect(url).toBe('mqtts://m1.tuyaeu.com:8883');
		expect(options.reconnectPeriod).toBe(0);
		expect(options.clientId).toMatch(/^com\.philips\.ph\.babymonitorplus_mb_phone1_/);
		expect(client.subscribeAsync).toHaveBeenCalledWith('/av/u/uid1', { qos: 1 });
	});

	it('derives the broker from the API host when the session has none', async () => {
		const { signaling, client, connect } = setup({ mqttHost: undefined });
		const stream = signaling.startStream({ deviceId: 'dev1', offerSdp: 'v=0', rtc, streamType: 2 });
		const { message } = await publishedOffer(client);
		reply(client, message.data.header.sessionid, 'answer', { sdp: 'v=0\r\n' });
		await vi.advanceTimersByTimeAsync(100);
		await stream;

		expect(connect.mock.calls[0][0]).toBe('mqtts://m1.tuyaeu.com:8883');
	});

	it('sends the offer to the camera with the stream settings', async () => {
		const { signaling, client } = setup();
		const stream = signaling.startStream({ deviceId: 'dev1', offerSdp: 'v=0 offer', rtc, streamType: 2 });
		const { topic, message } = await publishedOffer(client);
		reply(client, message.data.header.sessionid, 'answer', { sdp: 'v=0\r\n' });
		await vi.advanceTimersByTimeAsync(100);
		await stream;

		expect(topic).toBe('/av/moto/moto1/u/dev1');
		expect(message.protocol).toBe(302);
		expect(message.data.header).toMatchObject({ type: 'offer', from: 'uid1', to: 'dev1' });
		expect(message.data.msg).toMatchObject({
			mode: 'webrtc',
			sdp: 'v=0 offer',
			// eslint-disable-next-line @typescript-eslint/naming-convention
			stream_type: 2,
			auth: 'auth1',
			token: rtc.p2pConfig.ices,
			// eslint-disable-next-line @typescript-eslint/naming-convention
			datachannel_enable: false,
		});
	});

	it('sends its own candidates after the offer, each as a candidate message', async () => {
		const { signaling, client } = setup();
		const stream = signaling.startStream({
			deviceId: 'dev1',
			offerSdp: 'v=0',
			rtc,
			streamType: 2,
			candidates: ['candidate:1 1 udp 1 172.25.1.2 5000 typ host', 'candidate:2 1 udp 1 1.2.3.4 5000 typ srflx'],
		});
		const { message } = await publishedOffer(client);
		await vi.waitFor(() => expect(client.publishAsync).toHaveBeenCalledTimes(3));
		reply(client, message.data.header.sessionid, 'answer', { sdp: 'v=0\r\n' });
		await vi.advanceTimersByTimeAsync(100);
		await stream;

		const sent = client.publishAsync.mock.calls.slice(1, 3).map(call => JSON.parse(call[1] as string) as SignalMessage);
		expect(sent.map(item => item.data.header.type)).toEqual(['candidate', 'candidate']);
		expect(sent.map(item => item.data.msg.candidate)).toEqual([
			'a=candidate:1 1 udp 1 172.25.1.2 5000 typ host',
			'a=candidate:2 1 udp 1 1.2.3.4 5000 typ srflx',
		]);
		expect(sent.every(item => item.data.header.sessionid === message.data.header.sessionid)).toBe(true);
	});

	it('answers with the camera SDP and the candidates that follow it', async () => {
		const { signaling, client } = setup();
		const stream = signaling.startStream({ deviceId: 'dev1', offerSdp: 'v=0', rtc, streamType: 2 });
		const { message } = await publishedOffer(client);
		const sessionId = message.data.header.sessionid;

		reply(client, sessionId, 'answer', { sdp: 'v=0\r\nm=video 9 UDP/TLS/RTP/SAVPF 96\r\na=mid:0\r\n' });
		reply(client, sessionId, 'candidate', { candidate: 'a=candidate:1 1 udp 1 192.168.5.166 5000 typ host\r' });
		reply(client, 'someone-else', 'candidate', { candidate: 'a=candidate:9 1 udp 1 10.9.9.9 9 typ host' });
		await vi.advanceTimersByTimeAsync(100);
		const answer = await stream;

		expect(answer.sessionId).toBe(sessionId);
		expect(answer.answerSdp).toContain('a=candidate:1 1 udp 1 192.168.5.166 5000 typ host\r\na=end-of-candidates');
		expect(answer.answerSdp).not.toContain('10.9.9.9');
	});

	it('gives up when the camera does not answer', async () => {
		const { signaling } = setup();
		const stream = signaling.startStream({ deviceId: 'dev1', offerSdp: 'v=0', rtc, streamType: 2 });
		const failure = expect(stream).rejects.toThrow('did not answer');
		await vi.advanceTimersByTimeAsync(1_000);
		await failure;
	});

	it('fails when the camera ends the stream before answering', async () => {
		const { signaling, client } = setup();
		const stream = signaling.startStream({ deviceId: 'dev1', offerSdp: 'v=0', rtc, streamType: 2 });
		const { message } = await publishedOffer(client);
		reply(client, message.data.header.sessionid, 'disconnect', { mode: 'webrtc' });
		await expect(stream).rejects.toThrow('ended the stream');
	});

	it('asks for the HD stream a few seconds after the answer', async () => {
		const { signaling, client } = setup();
		const stream = signaling.startStream({ deviceId: 'dev1', offerSdp: 'v=0', rtc, streamType: 2 });
		const { message } = await publishedOffer(client);
		reply(client, message.data.header.sessionid, 'answer', { sdp: 'v=0\r\n' });
		await vi.advanceTimersByTimeAsync(100);
		await stream;
		await vi.advanceTimersByTimeAsync(3_000);

		const resolution = JSON.parse(client.publishAsync.mock.calls[1][1] as string) as SignalMessage;
		expect(resolution.protocol).toBe(312);
		expect(resolution.data.header.type).toBe('resolution');
		expect(resolution.data.msg).toEqual({ mode: 'webrtc', cmdValue: 0 });
	});

	it('asks for the SD stream when that quality is chosen', async () => {
		const { signaling, client } = setup();
		const stream = signaling.startStream({ deviceId: 'dev1', offerSdp: 'v=0', rtc, streamType: 2, quality: 'sd' });
		const { message } = await publishedOffer(client);
		reply(client, message.data.header.sessionid, 'answer', { sdp: 'v=0\r\n' });
		await vi.advanceTimersByTimeAsync(100);
		await stream;
		await vi.advanceTimersByTimeAsync(3_000);

		const resolution = JSON.parse(client.publishAsync.mock.calls[1][1] as string) as SignalMessage;
		expect(resolution.data.msg).toEqual({ mode: 'webrtc', cmdValue: 1 });
	});

	it('reuses one connection for several streams and closes it on request', async () => {
		const { signaling, client, connect } = setup();
		for (let i = 0; i < 2; i++) {
			client.publishAsync.mockClear();
			const stream = signaling.startStream({ deviceId: 'dev1', offerSdp: 'v=0', rtc, streamType: 2 });
			const { message } = await publishedOffer(client);
			reply(client, message.data.header.sessionid, 'answer', { sdp: 'v=0\r\n' });
			await vi.advanceTimersByTimeAsync(100);
			await stream;
		}
		expect(connect).toHaveBeenCalledTimes(1);

		signaling.close();
		expect(client.end).toHaveBeenCalled();
	});

	it('tells the camera when a stream ends', async () => {
		const { signaling, client } = setup();
		const stream = signaling.startStream({ deviceId: 'dev1', offerSdp: 'v=0', rtc, streamType: 2 });
		const { message } = await publishedOffer(client);
		const sessionId = message.data.header.sessionid;
		reply(client, sessionId, 'answer', { sdp: 'v=0\r\n' });
		await vi.advanceTimersByTimeAsync(100);
		await stream;

		expect(await signaling.endStream(sessionId)).toBe(true);
		expect(await signaling.endStream(sessionId)).toBe(false);
		const disconnects = client.publishAsync.mock.calls
			.map(call => JSON.parse(call[1] as string) as SignalMessage)
			.filter(sent => sent.data.header.type === 'disconnect');
		expect(disconnects).toHaveLength(1);
		expect(disconnects[0].data.header.sessionid).toBe(sessionId);
	});

	it('ends a stream an earlier run started, connecting for it', async () => {
		const { signaling, client, connect } = setup();
		expect(await signaling.endStaleStream({ deviceId: 'dev1', motoId: 'moto1', sessionId: 'old-session' })).toBe(true);
		expect(connect).toHaveBeenCalledTimes(1);
		const [topic, payload] = client.publishAsync.mock.calls[0] as [string, string];
		const sent = JSON.parse(payload) as SignalMessage;
		expect(topic).toBe('/av/moto/moto1/u/dev1');
		expect(sent.data.header.type).toBe('disconnect');
		expect(sent.data.header.sessionid).toBe('old-session');
	});

	it('asks a camera for its Wi-Fi signal on its device channel and reads the answer', async () => {
		const { signaling, client } = setup();
		const localKey = '0123456789abcdef';
		const key = Buffer.from(localKey, 'latin1');
		const signal = signaling.requestWifiSignal('dev1', localKey);

		await vi.waitFor(() => expect(client.publishAsync).toHaveBeenCalled());
		expect(client.subscribeAsync).toHaveBeenCalledWith('smart/mb/in/dev1', { qos: 1 });
		const [topic, payload] = client.publishAsync.mock.calls[0] as [string, Buffer];
		expect(topic).toBe('smart/mb/out/dev1');
		expect(decodeDeviceMessage(key, payload)).toEqual({ protocol: 22, data: { reqType: 'sigQry' } });

		// Another device's message and an unrelated one first: neither is the answer.
		client.emit(
			'message',
			'smart/mb/in/dev2',
			encodeDeviceMessage(key, 23, { reqType: 'sigQry', data: { signal: 10 } }, 1),
		);
		client.emit('message', 'smart/mb/in/dev1', encodeDeviceMessage(key, 4, { dps: { statusLed: true } }, 2));
		client.emit(
			'message',
			'smart/mb/in/dev1',
			encodeDeviceMessage(key, 23, { reqType: 'sigQry', data: { signal: 87 } }, 3),
		);
		await expect(signal).resolves.toBe(87);
		expect(client.unsubscribeAsync).toHaveBeenCalledWith('smart/mb/in/dev1');
	});

	it('gives up on the Wi-Fi signal when the camera does not answer', async () => {
		const { signaling } = setup();
		const signal = signaling.requestWifiSignal('dev1', '0123456789abcdef', 2_000);
		await vi.advanceTimersByTimeAsync(2_000);
		await expect(signal).resolves.toBeUndefined();
	});

	it('needs the ecode and partner identity from the sign-in', () => {
		expect(TuyaSignaling.canSignal(session)).toBe(true);
		expect(TuyaSignaling.canSignal({ ...session, ecode: undefined })).toBe(false);
		expect(TuyaSignaling.canSignal({ ...session, partnerIdentity: undefined })).toBe(false);
	});
});
