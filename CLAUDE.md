# CLAUDE.md

Homey App SDK v3 app (`nl.erikvl87.avent-baby-monitor`) for the Philips Avent connected baby monitors. They are Tuya
IP cameras; the app talks to them through the Tuya mobile API the Philips Avent Baby Monitor+ app uses, a listen-only
Tuya LAN connection, and Tuya's MQTT broker for video. [aventproxy](https://github.com/thekoma/aventproxy)
(`WHITEPAPER.md`, `custom_components/philips_avent/`) reverse engineered the protocol and is the reference for
anything Tuya-specific.

## Commands

```bash
pnpm install          # npm install on a device without pnpm
pnpm build            # TypeScript → .homeybuild/
pnpm lint
pnpm typecheck
pnpm test             # vitest run; pnpm test:watch, pnpm test:coverage
npx vitest run test/TuyaClient.test.mts   # a single test file
homey app validate --level publish
```

Run `pnpm lint`, `pnpm typecheck` and `pnpm test` before calling a change done. To run the app on a Homey or read an
installed app's log, use the `homey-run` skill.

## Code map

| File | Role |
| --- | --- |
| [app.mts](app.mts) | Logger, `debug` setting, uncaught-error handlers, `createTuyaClient()`, `packSession()`/`unpackSession()`, one signalling connection per account. `getApp(homey)` is the typed accessor. |
| [TuyaClient.mts](TuyaClient.mts) | Cloud API: signed POSTs, two-step sign-in, commands. |
| [TuyaLanSession.mts](TuyaLanSession.mts) | Listen-only Tuya LAN session (protocol 3.3/3.4/3.5, TCP 6668). |
| [TuyaSignaling.mts](TuyaSignaling.mts) | Tuya MQTT: WebRTC signalling for video, Wi-Fi signal queries, the camera's data point pushes. |
| [CameraSession.mts](CameraSession.mts) | One camera stream per device, shared by every Homey viewer; fixes the camera's RTP timestamps. |
| [VideoRelay.mts](VideoRelay.mts) | werift loading and `ViewerConnection`, one Homey viewer of a `CameraSession`. |
| [drivers/baby-monitor/](drivers/baby-monitor/) | `driver.mts`: pair, repair, flow cards. `device.mts`: polling, data points → capabilities, alarms, commands. |
| [utils/](utils/) | Pure logic (data points, alarms, lullaby catalogue, LAN/MQTT framing, SDP, RTP). Most tests target these. |
| [.homeycompose/](.homeycompose/) | Source of `app.json`. |

Detailed notes per area live in [.claude/rules/](.claude/rules/) and load when the matching files are read. Keep them
up to date with the code they describe, the same way as this file.

## Conventions

- All source files are TypeScript ESM with the `.mts` extension and import each other with `.mjs`.
- Edit `.homeycompose/` and the `*.compose.json` files, never the generated `app.json`.
- User-facing text goes in both `locales/en.json` and `locales/nl.json`.
- In the app, driver and device, timers go through `this.homey.setTimeout` and are cleared on uninit (the device's
  `stop()`, called from `onUninit`/`onDeleted`). The clients don't depend on Homey and clear their own timers on close.
- ESLint: explicit return types on functions, no floating promises, default `@typescript-eslint/naming-convention`
  (camelCase, enum members too; disable it locally for wire-format names), unused variables only with a `_` prefix.

## Logging

`logger.log` for events and routine failures (network, refused requests): what explains a diagnostic report with the
`debug` setting off. `logger.debug` for detail that only helps when diagnosing (negotiation steps, per-endpoint
discovery results, periodic statistics); it is dropped unless the user turns on the `debug` setting. `logger.error`
only for the unexpected, since errors go to Sentry. Pass an `Error` first to get a stack trace. **Never log the session id, the local key or the
household's public IP that `tuya.m.device.get` returns.** SDP (`sdpForLog`) is logged with its ICE candidates, which
can hold that IP: the log stays on the user's Homey until they send a diagnostic report. Keep it to `logger.log`,
never `logger.error`, which sends to Sentry unasked.

## Testing

vitest, in [test/](test/), mirroring the source tree. Homey itself is not mocked: put logic in `utils/` or the clients,
which take injected `fetch`, sockets and loggers. Helpers: `test/helpers/fake-fetch.mts`, `test/helpers/fake-logger.mts`.
