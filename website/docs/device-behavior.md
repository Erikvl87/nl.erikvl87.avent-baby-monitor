---
sidebar_position: 5
---

# Device Behavior

## Cloud and local connection

The app talks to your monitor in two ways:

* **Through the Philips Avent cloud.** All commands go this way: night light, lullabies, privacy mode and settings. The app also asks the cloud for the monitor's state on a regular schedule (polling).
* **Directly on your home network.** The app also listens to the monitor itself over the [local connection](settings/device/local-connection.md). The monitor pushes changes the moment they happen, so alarms and the temperature come in within seconds.

The local connection only listens. It never sends commands or asks the monitor for its state, because some of those requests made the SCD973 reboot.

## How often the app checks

| What | How often |
| --- | --- |
| Monitor state from the cloud | Every **30 seconds**. While the local connection is up and the monitor sends its alarms that way, every **2 minutes**, since changes arrive right away anyway. |
| Wi-Fi signal strength | Every **5 minutes**. |
| Pushes over the local connection | As they happen. |

Changes you make in the official Philips Avent Baby Monitor+ app, such as turning on the night light or changing a setting, show up in Homey at the next check, or right away over the local connection.

## How alarms work

The monitor families report their alarms differently:

| Monitor | How alarms reach Homey |
| --- | --- |
| **SCD973** and **SCD923** | Only as a push over the local connection. The cloud keeps the last alarm forever without a time, so the app can't tell a new alarm from an old one there. |
| **SCD951**, **SCD953** and **SenseIQ** | As an alarm record with a time. This works from the cloud and from the local connection, so alarms arrive even without the local connection, just a bit later. |

An alarm turns on the matching capability for **30 seconds**. An alarm record older than 3 minutes is ignored, so an old alarm doesn't go off again after Homey restarts.

## When the device becomes unavailable

The app marks the monitor unavailable in Homey when something is wrong. The message tells you why:

* **"The baby monitor is offline"**: the monitor lost its connection to the Philips Avent cloud, for example after a power cut or Wi-Fi trouble. The device becomes available again once the monitor is back online.
* **"Can't reach the Philips Avent cloud"**: requests to the cloud failed several times in a row. A single failed request is normal and doesn't count. The device recovers by itself once the cloud answers again.
* **"Signed out of Philips Avent. Use Repair to sign in again."**: the session expired. Only signing in again brings the device back. See [Repair](settings/device/repair.md).

See the [FAQ](faq.md) for what to do in each case.
