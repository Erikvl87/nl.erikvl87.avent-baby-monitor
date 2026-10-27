---
sidebar_position: 1
---

# Detailed Diagnostics

The **Detailed diagnostics** setting enriches the crash and diagnostic reports that the app automatically sends to the developer when something goes wrong. It is off by default and not needed for day-to-day use.

## How It Works

- **Unchecked (default)**
  - Only the primary message of each log entry is recorded.
  - Crash reports contain enough context for most issues.
- **Checked**
  - Full argument lists are included in every log entry.
  - Crash reports contain the complete data that was in flight at the time of the error, making it much easier to reproduce and fix the problem.

The app never logs your password, your session or the monitor's local key, with or without this setting.

## When to Enable It

Enable this setting **before** reproducing a problem and then report the issue via the [Homey Community Forum](https://community.homey.app/) or [GitHub](https://github.com/Erikvl87/nl.erikvl87.avent-baby-monitor/issues). The next crash or error that occurs will automatically include the extra detail in the report sent to the developer.

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
