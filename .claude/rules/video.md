---
paths:
  - "TuyaSignaling.mts"
  - "CameraSession.mts"
  - "VideoRelay.mts"
  - "utils/rtp-*.mts"
  - "utils/sdp.mts"
  - "utils/werift-cbc.mts"
  - "utils/tuya-mqtt.mts"
  - "types/homey-video.mts"
  - "test/TuyaSignaling.test.mts"
  - "test/CameraSession.test.mts"
  - "test/utils/rtp-*.test.mts"
  - "test/utils/sdp.test.mts"
  - "test/utils/werift-cbc.test.mts"
---

# Live video and MQTT signalling

## Signalling ([TuyaSignaling.mts](../../TuyaSignaling.mts))

- Homey's `createVideoWebRTC` offer listener hands over the viewer's SDP. It goes to the camera over Tuya's MQTT broker
  (`mqtts://<mqttHost>:8883`, topic `/av/moto/<motoId>/u/<devId>`, protocol 302); the answer and trickled candidates
  come back on `/av/u/<uid>`.
- One connection per account (`getApp().getSignaling(session)`): the same client id kicks an earlier connection.
- Needs `ecode`/`partnerIdentity` from the sign-in; without them opening the video asks for a Repair.
- The offer is stripped of `a=extmap` lines (size limit) and audio is made receive-only (sending audio is talk-back,
  which restarts lullabies).
- Homey's types package lacks the video API; see `types/homey-video.mts`.

### Wi-Fi signal

Comes from the camera over the same broker, as the Philips app gets it: protocol 22 `{"reqType":"sigQry"}` on
`smart/mb/out/<devId>`, answered with protocol 23 `{"signal":<percent>}` on `smart/mb/in/<devId>`, both in the "2.2"
envelope (`utils/tuya-mqtt.mts`, ECB with the local key). The cloud's `tuya.m.device.upgrade.rssi.info.query` returns a
fixed -75 dBm on these monitors; don't use it.

### Data point pushes

The camera also reports every change it makes itself on `smart/mb/in/<devId>`: protocol 4, `{"dps":{...}}`, the same
envelope. Opening a stream in the Philips app makes it send its whole state there. aventproxy concluded MQTT carries no
data points, but it never subscribed to this topic. `watchDevice()` keeps the topic subscribed and the connection open
(no idle close) while any camera is watched. The broker gives no reconnects, so the device calls it again on every poll.
Other clients' WebRTC signalling (protocol 302, with ICE candidates) arrives on the topic too and is dropped.

## Relay ([CameraSession.mts](../../CameraSession.mts), [VideoRelay.mts](../../VideoRelay.mts))

The cameras put one constant RTP timestamp on every packet, so a direct stream stutters. With the `video_relay` device
setting on (default) the device answers Homey's offer itself:

- A camera accepts only a few viewers at once, counting the Philips app on every phone (Tuya refuses one more with
  error 23). The limit depends on the model: three per the SCD921/923 and SCD973 manuals and the SCD860 product page;
  nothing says what the SCD951/953 allow. Every Homey viewer of a camera therefore shares one `CameraSession`: one werift peer connection to the camera
  (its offer goes through TuyaSignaling), and a `ViewerConnection` per viewer. The device creates the session before
  its first `await`, so viewers that arrive together share it.
- The session puts packets back in sequence order once (`utils/rtp-reorder.mts`: Wi-Fi reorders them, resends arrive
  late), and `utils/rtp-restamp.mts` gives each frame a wall-clock timestamp and re-sends SPS/PPS before every IDR, so
  a viewer that joins mid-stream can start at the next keyframe. Each viewer has its own tracks; werift gives each
  viewer's packets its own SSRC, payload type and SRTP keys, and answers its NACKs from its own packet history.
- Keyframe requests (PLI/FIR) from all viewers reach the camera at most once a second; each viewer asks for one when
  it connects.
- At most three Homey viewers per camera; one more closes the oldest viewer. Each viewer costs about a tenth of a
  Homey core, mostly encryption.
- After the last viewer leaves, the session stays open 5 s before it sends the camera its `disconnect`.
- Changing `video_quality` sends the running session the 312 `resolution` message; the camera carries on under a new
  SSRC, which the session follows.
- A `disconnect` from the camera after its answer closes the session and every viewer. Before the answer, any message
  other than the answer and candidates is logged with its field names and error codes (`describeSignal()`), which is
  where a refusal shows.
- With `video_relay` off, Homey connects to the camera itself, and the app sets no limit: it doesn't see a direct
  viewer leave.
- werift is loaded lazily, so an idle app doesn't carry it, and through `require` (its CommonJS build):
  `utils/werift-cbc.mts` adds an AES-CBC suite to its DTLS server there. An SCD973 on camera SDK 4.8.8 offers only CBC
  suites, werift only GCM, and werift's ES module bundle can't be patched. `test/utils/werift-cbc.test.mts` checks the
  suite against `openssl s_client`.
- The camera's video starts about 2 s after it answers, so the first viewers' answer waits for it (8 s at most):
  Homey's spinner covers that time instead of a black picture. A viewer joining a running session is answered at once.
- A viewer is closed once it has sent no RTCP for 2.5 s, or when it hasn't connected 20 s after its answer. Its
  connection only fails a minute later, and Homey's keep-alive listener never fired in testing. Homey keeps the video
  running while the device's other tabs are open.
- The camera keeps its "someone is watching" light on until it gets a `disconnect` (it turns white at once). Each
  camera session's stream is therefore kept in the device store (`videoStreams`) until its disconnect went out, and `onInit`
  ends any that an earlier run left open.
