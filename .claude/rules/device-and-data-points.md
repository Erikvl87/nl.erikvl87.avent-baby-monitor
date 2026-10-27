---
paths:
  - "drivers/baby-monitor/device.mts"
  - "drivers/baby-monitor/driver.mts"
  - "utils/dps.mts"
  - "utils/alarm-events.mts"
  - "utils/lullaby.mts"
  - "utils/senseiq.mts"
  - "utils/availability-tracker.mts"
  - "test/utils/dps.test.mts"
  - "test/utils/alarm-events.test.mts"
  - "test/utils/lullaby.test.mts"
  - "test/utils/senseiq.test.mts"
  - "test/utils/availability-tracker.test.mts"
---

# Device, data points and monitor families

## Device ([device.mts](../../drivers/baby-monitor/device.mts))

- Polls `tuya.m.device.get` every 30 s, or 120 s while the LAN is up and the monitor has no alarm records.
- Reads the Wi-Fi signal (percent) every 5 min, over MQTT (see the video rule).
- Takes the camera's pushes from the LAN and from MQTT (`watchPushes()`, renewed on every poll); both count as pushes
  (`DpSource` other than `cloud`). Both families report every change they make themselves on MQTT within a second,
  without a local connection. An SCD973 sent 250/141 there at the second the message center stamped the alarm;
  212 over MQTT is not yet seen.
- Maps data points to capabilities and settings, raises alarms for 30 s, sends commands through the cloud.
- The local connection's state shows in the `local_connection_status` label setting (`showLanStatus()`, strings under
  `device.localConnection`). Written outside `onSettings`, which would overwrite it when it saves.
- `AvailabilityTracker` hears about the local connection (`onLocalConnection()`): a cloud outage while it is up sets a
  warning (`device.warning.apiErrorWithLocal`) instead of making the device unavailable.
- The local key is only kept in memory, from the poll; after a restart the local connection waits for the cloud.

## Data points and families

`utils/dps.mts` lists the data points. Alarms differ per family (`utils/alarm-events.mts`):

- **SCD973/SCD923** (`kzm54lhabeeucq5a`): DP 250 `motion_detection`, DP 141 `decibel_upload`. No timestamp and the
  cloud keeps the last value, so only pushes (LAN or MQTT) count.
- **SCD951/SCD953** (`selj2idknqhjnids`) and **SenseIQ** (`7d9t0rygsm7ztnww`): DP 212 alarm record (base64 JSON with
  `cmd` and `time`). Fires when newer than the last one (`lastAlarmTime` in the store) and under 180 s old.
- **SenseIQ only**: DP 3 live status (crib presence, breaths per minute); stale after 60 s without a LAN push.

For 15 s after a command, the cloud's copy of that data point is ignored altogether (night light, brightness, volume,
lullaby state), since it lags.

## Lullabies

State (DP 246):

- Set optimistically on play/stop. From the cloud only a change of its value counts, since the cloud's copy can stay at
  `playing` after a stop. LAN pushes always count.
- Picker changes wait 1 s before playing, and a newer pick or play cancels an older one's block probing.
- An SCD973 on camera SDK 4.8.8 stops its lullaby when a video stream's media starts, and opening the device page
  starts one, so a play waits (8 s at most) for streams to that camera that are still connecting.

Catalogue (`utils/lullaby.mts`):

- Track ids depend on the unit's catalogue block; the block comes from DP 248. An SCD951 reports 248 through the cloud
  with its quotes escaped (`{\"bizcode\":...}`), which `readTrackId()` handles.
- Writing DP 202 with an id in the unit's block starts that track on its own. A camera ignores an id outside its block
  and replays its current sound.
- Next steps through the ids in order and wraps. That is how a new block is measured: step 15+ times, reading 248
  after each.
- When DP 248 reports an id outside every known block, or a probe of all blocks went unconfirmed, the device sets
  `lullabyCatalogueUnknown` in its store and removes the `lullaby_track` picker (`syncLullabyPicker()`); picking from a
  flow throws `errors.unknownCatalogue`. A later 248 in a known block clears the flag and brings the picker back. The
  picker's listener is registered only while the capability exists.
