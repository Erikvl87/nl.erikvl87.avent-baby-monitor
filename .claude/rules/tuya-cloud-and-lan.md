---
paths:
  - "TuyaClient.mts"
  - "TuyaLanSession.mts"
  - "utils/tuya-*.mts"
  - "utils/region.mts"
  - "utils/secret-obfuscation.mts"
  - "types/tuya.mts"
  - "test/TuyaClient.test.mts"
  - "test/TuyaLanSession.test.mts"
  - "test/utils/tuya-*.test.mts"
---

# Tuya cloud API and LAN session

## Cloud ([TuyaClient.mts](../../TuyaClient.mts))

- Signed form-encoded POSTs to `https://<host>/api.json`.
- Sign-in is two steps: `requestLoginCode()` (password, data-center probing, Tuya emails a code) and `completeLogin()`
  (the code).
- There is no token refresh: when Tuya answers `SID_INVALID`/`USER_SESSION_LOSS` the user must sign in again through
  Repair.
- Devices keep the session in their store, obfuscated with `packSession()`/`unpackSession()` in `app.mts`.

## LAN ([TuyaLanSession.mts](../../TuyaLanSession.mts))

- Tuya protocol 3.3/3.4/3.5 on TCP 6668: handshake, heartbeat every 8 s, receive pushed data points. Listen-only.
- **Never send DP_QUERY or UPDATEDPS**: they returned nothing or rebooted the SCD973.
- An SCD951 (base 40.00) speaks 3.4: 55AA frames with an HMAC-SHA256 trailer, ECB with a negotiated session key.
- Version fallback: a version that fails twice in a row makes way for the next (the announced or stored one first,
  then 3.3, then the rest). The one that yields a readable frame is kept as `lanVersion` in the device store.
