---
sidebar_position: 1
---

# Detailed Diagnostics

The **Detailed diagnostics** setting adds extra detail to the app's log on your Homey. That log is what the developer gets when you send a diagnostic report. It is off by default and not needed for day-to-day use.

## How It Works

- **Unchecked (default)**
  - The app logs what happens and what goes wrong: monitors connecting, alarms, commands, and failed requests.
- **Checked**
  - The app also logs step-by-step detail that only helps when diagnosing a problem, such as how a video stream is set up and how the monitor is found on your network.

The setting doesn't change the error reports that the app sends automatically when something unexpected happens. See [Privacy](../../privacy.md#diagnostics).

The app never logs your password, your session or the monitor's local key, with or without this setting.

## When to Enable It

1. Enable this setting **before** reproducing the problem.
2. Reproduce the problem.
3. Send a diagnostic report from the app's page in Homey, and report the issue on the [Homey Community Forum](https://community.homey.app/) or [GitHub](https://github.com/Erikvl87/nl.erikvl87.avent-baby-monitor/issues). Mention your monitor model.

You can disable it again once the problem has been reported.

## Locating the Setting

1. Open the **Homey Mobile App** or **Homey Web App**.
2. Navigate to **Settings** (bottom tab on mobile / left sidebar on web).
3. Select **Apps** and tap or click **Philips Avent Baby Monitor**.
4. Open the app settings using the gear icon.
5. Toggle the **Detailed diagnostics** checkbox.

:::info

This is an app-level setting, not a per-device setting. It applies to all baby monitors connected through this app.

:::
