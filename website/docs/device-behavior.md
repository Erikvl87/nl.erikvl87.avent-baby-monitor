---
sidebar_position: 5
---

# Device Behavior

## Cloud and local connection

The app talks to your monitor in two ways, both at the same time:

* **Through the Philips Avent cloud.** Everything goes this way: all commands (night light, lullabies, privacy mode and settings), live video, the Wi-Fi signal, and a regular check of the monitor's state (polling). On top of that, the monitor pushes every change it makes itself through the cloud the moment it happens, as the official app gets them, so alarms and the temperature come in within seconds.
* **Directly on your home network.** The app also listens to the monitor itself over the [local connection](settings/device/local-connection.md). The monitor pushes the same changes there. Whichever copy arrives first counts.

The local connection only listens. It never sends commands or asks the monitor for its state. The app doesn't switch between cloud and local: the cloud is always needed, and the local connection is a backup for the pushes.

| What | Cloud | Local connection |
| --- | --- | --- |
| Signing in and online status | Yes | No |
| Commands: night light, lullabies, privacy mode, settings | Yes | No |
| Regular check of the monitor's state | Yes | No |
| Pushes: alarms, temperature, lullaby and night light changes, SenseIQ status | Yes | Yes |
| Wi-Fi signal | Yes | No |
| Live video | Set up through the cloud; the video itself goes from the monitor to Homey over your home network | No |

## Without internet

When the internet or the Philips Avent cloud is down, this is what still works with the [local connection](settings/device/local-connection.md) on:

| What | Without internet |
| --- | --- |
| Motion, sound and crying alarms | Keep coming in |
| Temperature | Keeps coming in |
| SenseIQ crib status and breathing rate | Keep coming in |
| Changes made on the monitor itself, such as a lullaby ending | Keep coming in |
| Commands from Homey and flows | Fail until the cloud is back |
| Live video | Doesn't start |
| Wi-Fi signal | Keeps its last value |
| *Monitor went offline / came back online* triggers | Don't run, since they come from the cloud |

After a few failed cloud checks the device shows the warning *"Can't reach the Philips Avent cloud. Alarms still come in over the local connection; commands and video wait for the cloud."* It stays available, so flows on its alarms keep running. If the local connection drops too, or is off, the device turns unavailable.

The local connection needs the cloud once after Homey or the app starts. If Homey restarts while the internet is down, the local connection waits until the cloud answers again.

## How often the app checks

| What | How often |
| --- | --- |
| Monitor state from the cloud | Every **30 seconds**. On the SCD973 / SCD923 / SCD921 family, every **2 minutes** while the local connection is up, since changes arrive right away anyway. |
| Wi-Fi signal strength | Every **5 minutes**. |
| Pushes through the cloud and over the local connection | As they happen. |

Changes you make in the official Philips Avent Baby Monitor+ app, such as turning on the night light or changing a setting, usually show up in Homey right away as a push, and otherwise at the next check.

## How alarms work

The monitor families report their alarms differently. The **Model** in the [device information](settings/device/device-information.md) tells you which family yours belongs to.

| Monitor | How alarms reach Homey |
| --- | --- |
| **SCD973 / SCD923 / SCD921** family | Only as a push from the monitor, through the cloud or over the local connection. |
| **SCD951 / SCD953** and **SenseIQ** families | As a push from the monitor, or otherwise at the next regular check, up to 30 seconds later. |

An alarm turns on the matching capability for **30 seconds**.

## When the device becomes unavailable

The app marks the monitor unavailable in Homey when something is wrong. The message tells you why:

* **"The baby monitor is offline"**: the monitor lost its connection to the Philips Avent cloud, for example after a power cut or Wi-Fi trouble. The device becomes available again once the monitor is back online.
* **"Can't reach the Philips Avent cloud"**: requests to the cloud failed several times in a row. A single failed request is normal and doesn't count. The device recovers by itself once the cloud answers again. While the local connection is up, the device stays available and shows this as a warning instead, since alarms still come in. See [Without internet](#without-internet).
* **"Signed out of Philips Avent. Use Repair to sign in again."**: the session expired. Only signing in again brings the device back. See [Repair](settings/device/repair.md).

See the [FAQ](faq.md) for what to do in each case.
