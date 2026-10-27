---
name: homey-run
description: Run the Avent baby monitor app on a real Homey, or get the log of the app installed there. Use when asked to try a change on the Homey, run or install the app, see what the app logged, or troubleshoot a monitor that misbehaves on the user's Homey.
---

# Run the app on a Homey and read its log

## Run with a debugger attached

1. `env.json` must exist (copy `env.example.json`) with `ENCRYPTION_KEY` set; the app throws on start without it.
   Keep the key the same between runs, or stored sessions can't be unpacked and every device needs a Repair.
2. `npm install`, even though the project uses pnpm: `homey app run` only bundles `node_modules` after `npm ls`
   passes, which fails on pnpm's tree (homey-log pulls raven from GitHub). Without it the bundle lacks `homey-log`.
3. `homey app run`. It regenerates `app.json` from the compose files, builds, and streams the log until stopped. Run
   it in the background and read its output.

## Read the log of an installed app

An installed app's log isn't visible without a debugger. Ask the user to send a diagnostic report from the app's page
in the Homey app; it reaches the developer through the Homey Developer Tools. For detailed diagnostics, ask them to
turn on the debug checkbox on the app's settings page (the `debug` app setting) and reproduce the problem first.

## When reading or quoting the log

The app never logs the session id or the local key, and logs the household's public IP only inside SDP, whose ICE
candidates can carry it. A session id, a local key, or the IP anywhere else is a bug to fix. Don't repeat any of
these values in chat, the IP in an SDP included.
