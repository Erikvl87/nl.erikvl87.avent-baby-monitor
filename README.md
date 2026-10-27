# Philips Avent Baby Monitor

A Homey app for the Philips Avent connected baby monitors (SCD923, SCD951, SCD953, SCD973 and the SenseIQ models)
that you set up with the Philips Avent Baby Monitor+ app. It shows the nursery temperature, raises motion and sound
alarms, and lets flows control the night light, the lullabies and the camera's privacy mode. On SenseIQ models it also
shows whether the baby is in the crib, the breathing rate and crying.

Documentation: https://avent-baby-monitor.erikvl87.nl/

This is an unofficial app, not made or supported by Philips. The monitors are Tuya cameras under the hood, and the app
talks to them the way the Philips app does; how that works was worked out by
[aventproxy](https://github.com/thekoma/aventproxy), which this app is built on.

## Flow cards

| Card | Kind | Notes |
| --- | --- | --- |
| Motion alarm turned on/off | trigger, condition | built in, from `alarm_motion` |
| Sound alarm turned on/off | trigger, condition | built in, from `alarm_noise`; on SenseIQ a cry counts as sound too |
| Temperature changed | trigger, condition | built in |
| Night light on/off, dim | trigger, condition, action | built in |
| Lullaby playing, next, previous, volume | trigger, condition, action | built in |
| Baby started / stopped crying | trigger | SenseIQ only |
| Breathing rate changed | trigger | SenseIQ only, token: breaths per minute |
| Presence alarm turned on/off | trigger, condition | SenseIQ only, built in, from `alarm_presence` (baby in crib) |
| Privacy mode turned on / off | trigger | privacy mode turns the camera off |
| Lullaby changed | trigger | tokens: the sound's name in your language, and its id |
| Monitor went offline / came back online | trigger | from the cloud's online status; not when only Homey loses its connection |
| Privacy mode is on | condition | |
| [lullaby] is the selected lullaby | condition | |
| Baby is crying | condition | SenseIQ only |
| Play [lullaby] | action | one of the 15 sounds on the monitor |
| Stop the lullaby after [duration] / Turn the lullaby timer off | action | the monitor's own timer |
| Turn the night light off after [duration] / Turn the night light timer off | action | the monitor's own timer |
| Turn privacy mode [on/off] | action | |
| Turn motion / sound detection [on/off] | action | also in the device settings |

Alarms turn themselves off after 30 seconds: the monitor reports that something happened, not when it stopped.

## Adding a monitor

1. Add a device, choose Philips Avent Baby Monitor, and sign in with your Baby Monitor+ account (e-mail, password and
   the country you picked when you created the account).
2. Philips Avent emails a 6-digit verification code. Enter it.
3. Pick the monitors to add.

The app keeps the session, not your password. When the session expires the device says so; use Repair on the device
to sign in again. A repair updates every monitor on the same account.

## Cloud and local connection

The app uses both at the same time; it doesn't switch between them.

- **Cloud** (Tuya's API and MQTT broker): sign-in, every command, live video signalling, the Wi-Fi signal, and the
  regular state, polled every 30 seconds (every 2 minutes while the local connection is up and the monitor doesn't
  report alarm records). Changes the monitor makes itself, like alarms, the temperature or a lullaby ending, come in
  within seconds as pushes through the MQTT broker, as the Philips app gets them.
- **Local connection** (TCP port 6668 on your home network): the same pushes a second time, straight from the monitor.
  It only listens: it never sends commands or asks the monitor for its state, because some requests make the SCD973
  reboot. Its key comes from the cloud.

On the SCD973 family the motion and sound alarms only arrive as pushes, since the cloud's copy has no time.

Without internet, alarms, the temperature and SenseIQ status keep coming in over the local connection; commands and
video don't work. The device then stays available with a warning, and turns unavailable only when the local connection
is down too. The device settings show the local connection's status. Turn it off if the monitor misbehaves; everything
keeps working through the cloud while the internet is up.

## Live video

Open the camera on the device to watch. Homey sends the viewer's WebRTC offer to the app, and the app asks the monitor
for a stream through Tuya's MQTT broker (as the Philips app does). The monitors stamp every RTP packet with the same
timestamp, which makes players stutter, so by default the app relays the stream (werift, loaded only while someone
watches): it receives the video from the monitor, rewrites the timestamps from the wall clock, re-sends the SPS/PPS
before keyframes, and sends it on to Homey, without decoding anything. The **Smooth video** device setting turns the
relay off, and the monitor then streams straight to Homey. Audio is receive-only, so watching doesn't interrupt a lullaby. Privacy mode turns the
camera off, so it blocks video too.

The video also plays in Homey's Camera dashboard widget, with the same smoothing.

## What it can't do (yet)

- Snapshots. The monitors have no snapshot API; one would need the video stream plus an H.264 decoder on Homey.
- Humidity, a sound level in decibels and the battery level: the monitors don't report them.
- SenseIQ sleep summaries.

## Development

With pnpm, or npm on a device without it (`package-lock.json` is ignored; `pnpm-lock.yaml` is the lockfile):

```sh
pnpm install        # npm install
pnpm build          # npm run build: TypeScript (.mts) → .homeybuild/ (.mjs)
pnpm lint           # npm run lint
pnpm typecheck      # npm run typecheck
pnpm test           # npm test
npm install         # before homey app run: the Homey CLI bundles node_modules after an `npm ls` check that pnpm's tree fails
homey app run       # builds and runs on your Homey
```

Copy `env.example.json` to `env.json` and fill in `OBFUSCATION_KEY` (any long random string) and, optionally,
`HOMEY_LOG_URL` (Sentry DSN for `homey-log`).

| Path | What |
| --- | --- |
| `app.mts` | the app: logger, diagnostics setting, `createTuyaClient()`, and packing the session devices keep |
| `TuyaClient.mts` | the Tuya mobile API: signed requests, the two-step sign-in with data-center routing, cameras, state, commands |
| `VideoRelay.mts` | the smooth-video relay: two werift peer connections (camera, viewer) with restamping in between |
| `utils/rtp-restamp.mts` | restamping video per frame and audio per packet, and re-sending SPS/PPS before keyframes |
| `utils/rtp-reorder.mts` | putting the camera's RTP packets back in sequence order before the relay passes them on |
| `utils/werift-cbc.mts` | the AES-CBC DTLS cipher werift lacks, the only kind an SCD973 on camera SDK 4.8.8 offers |
| `TuyaSignaling.mts` | one MQTT connection per account to Tuya's broker: WebRTC offers and answers for live video, the Wi-Fi signal, and the data points the monitor pushes |
| `TuyaLanSession.mts` | the local connection: Tuya protocol 3.3/3.4/3.5 on TCP 6668, heartbeat and reconnects; listens only |
| `drivers/baby-monitor/driver.mts` | pairing and repair (sign-in, verification code, cameras) and the flow cards |
| `drivers/baby-monitor/device.mts` | polling, the local connection, data points to capabilities and settings, alarms, commands |
| `drivers/baby-monitor/pair/`, `repair/` | the sign-in and verification code screens (the same files in both) |
| `utils/dps.mts` | the monitor's data points and their value conversions |
| `utils/alarm-events.mts` | motion, sound and crying alarms per monitor family, and when an alarm is new |
| `utils/lullaby.mts` | the 15 sounds and their track ids |
| `utils/senseiq.mts` | SenseIQ's live status: baby in crib and breathing rate |
| `utils/region.mts` | countries to Tuya data centers and calling codes |
| `utils/sdp.mts`, `utils/tuya-mqtt.mts` | preparing the viewer's offer and the camera's answer; MQTT credentials and message envelope |
| `utils/tuya-sign.mts` | request signing and password encryption |
| `utils/tuya-lan-protocol.mts`, `utils/tuya-lan-discovery.mts` | Tuya LAN frames and finding the monitor on the network |
| `utils/availability-tracker.mts` | when the device turns unavailable and available again |
| `utils/secret-obfuscation.mts` | keeps the stored session unreadable at a glance (not real security) |
| `Logger.mts` | Homey log plus Sentry through `homey-log` |
| `.homeycompose/` | source of `app.json`; edit these, not `app.json` |
