---
sidebar_position: 5
---

# Local Connection

The **Local connection** setting, in the **Connection** group, lets the app listen to the monitor directly on your home network, next to the Philips Avent cloud. It is on by default.

## Why it matters

* **Alarms within seconds.** The monitor pushes motion and sound alarms, the temperature and other changes the moment they happen. Without the local connection, Homey only sees them at the next cloud check (every 30 seconds).
* **Needed on the SCD973 and SCD923.** On these models, motion and sound alarms **only** arrive over the local connection. Turn it off and Homey won't see their alarms at all.
* **Live SenseIQ status.** The SenseIQ pushes its crib status and breathing rate every few seconds over the local connection.

## How it works

* The app finds the monitor on your network by listening for the announcements it broadcasts (UDP ports 6666 and 6667), and remembers its address.
* It then connects to the monitor on **TCP port 6668**, using the Tuya protocol the monitor speaks.
* The connection **only listens**. Commands still go through the cloud, and the app never asks the monitor for its state over this connection, because some of those requests made the SCD973 reboot.
* When the monitor can't be found, the app tries again every 10 minutes. When the connection has been down for 5 minutes, the app looks the monitor up again, in case its address changed.

:::info

Homey and the monitor need to be on the same network for this to work. If your monitor is on a separate guest or IoT network, Homey may not hear it. The rest of the app keeps working through the cloud.

:::

## When to turn it off

Turn it off if the monitor misbehaves, for example if it restarts or drops off Wi-Fi more often than before. Everything except the SCD973/SCD923 alarms keeps working through the cloud, just with a bit more delay.

## Locating the Setting

1. Open the **Homey Mobile App** or **Homey Web App**.
2. Navigate to **Devices** and select your baby monitor.
3. Open the device settings:
   * **Mobile App:** Tap the gear icon → **Advanced Settings**
   * **Web App:** Click the gear icon and scroll to **Advanced Settings**
4. Find **Local connection** in the **Connection** group.
