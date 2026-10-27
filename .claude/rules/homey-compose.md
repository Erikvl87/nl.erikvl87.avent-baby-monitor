---
paths:
  - ".homeycompose/**"
  - "drivers/**/*.compose.json"
  - "app.json"
  - "locales/**"
---

# Homey Compose

- [.homeycompose/](../../.homeycompose/) and the drivers' `*.compose.json` are the source for `app.json`. Edit those,
  never the generated `app.json`; `homey app build` regenerates it.
- Custom capabilities: `lullaby_track`, `privacy_mode`, `measure_breathing_rate`, `alarm_crying`.
- Custom capabilities only get the flow cards declared in `driver.flow.compose.json`; `<id>_true`/`_false`/`_changed`
  fire automatically.
- Every user-facing string needs an `en` and an `nl` translation, in compose files and in `locales/`.
- Check with `homey app validate --level publish`.
