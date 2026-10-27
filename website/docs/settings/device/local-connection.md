---
sidebar_position: 5
---

# Local Connection

The **Local connection** setting, in the **Connection** group, lets the app listen to the monitor directly on your home network, next to the Philips Avent cloud. It is on by default, needs no setup, and is best left on.

## Cloud and local work together

The local connection doesn't replace the cloud, and the app doesn't switch between them. Both run at the same time:

* **The cloud** handles everything: signing in, all commands (night light, lullabies, privacy mode, settings), live video, the Wi-Fi signal, a regular check of the monitor's state, and the changes the monitor pushes the moment they happen.
* **The local connection** gets those same pushes a second time, straight from the monitor on your network. Whichever copy arrives first counts.

The local connection only listens. Commands and video always go through the cloud, so there is no "local only" mode. See [Device behavior](../../device-behavior.md#without-internet) for what keeps working when the internet is down.

## On or off: what you gain and lose

| | Local connection **on** (default) | Local connection **off** |
| --- | --- | --- |
| Alarms, temperature, lullaby and night light changes | Arrive within seconds, through the cloud and over your network | Arrive within seconds through the cloud |
| When the internet is down | Alarms, the temperature and SenseIQ status keep coming in. The device stays available with a warning | Nothing comes in. After a few minutes the device turns unavailable: *"Can't reach the Philips Avent cloud"* |
| SenseIQ crib status and breathing rate | Every few seconds over your network | From the pushes through the cloud and the regular cloud check |
| Cloud checks on the SCD973 / SCD923 / SCD921 family | Every 2 minutes, since the pushes cover the rest | Every 30 seconds |
| Commands and live video | Through the cloud | Through the cloud, no difference |
| Network traffic | A small, steady connection to the monitor on TCP port 6668 | None on your home network |

In short: turning it off doesn't make anything faster or add anything. You only lose the backup for when the internet is down. Turn it off only when the monitor misbehaves (see [When to turn it off](#when-to-turn-it-off)).

## Status

The **Status** line below the setting shows what the local connection is doing:

| Status | Meaning |
| --- | --- |
| **Connected** | The app is listening to the monitor on your network. |
| **Connecting** | The app knows where the monitor is and is connecting, or reconnecting after the connection dropped. |
| **Looking for the monitor on your network** | The app is listening for the monitor's announcements to find its address. |
| **Monitor not found on your network** | The monitor's announcements didn't reach Homey. The app tries again every 10 minutes. See the [FAQ](../../faq.md#the-local-connection-doesnt-find-my-monitor). |
| **Waiting for the cloud** | The app needs to reach the cloud first, or you need to sign in again with [Repair](repair.md). |
| **Off** | The setting is off. |

## How it works

* The app finds the monitor on your network by listening for the announcements it broadcasts (UDP ports 6666 and 6667), and remembers its address.
* It then connects to the monitor on **TCP port 6668**. The local connection only starts after the app has reached the cloud once.
* When the monitor can't be found, the app tries again every 10 minutes. When the connection has been down for 5 minutes, the app looks the monitor up again, in case its address changed.

:::info

Homey and the monitor need to be on the same network for this to work. If your monitor is on a separate guest or IoT network, Homey may not hear it, and the status stays at *Monitor not found on your network*. The rest of the app keeps working through the cloud.

:::

## When to turn it off

Turn it off if the monitor misbehaves, for example if it restarts or drops off Wi-Fi more often than before. As long as the internet is up, everything keeps working through the cloud, alarms included.

## Locating the Setting

1. Open the **Homey Mobile App** or **Homey Web App**.
2. Navigate to **Devices** and select your baby monitor.
3. Open the device settings:
   * **Mobile App:** Tap the gear icon → **Advanced Settings**
   * **Web App:** Click the gear icon and scroll to **Advanced Settings**
4. Find **Local connection** and its **Status** in the **Connection** group.
