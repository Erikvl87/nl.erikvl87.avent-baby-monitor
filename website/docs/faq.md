---
sidebar_position: 6
---

# FAQ

## Adding a monitor

### "No baby monitors were found on this account."

Signing in worked, but the account has no monitors on it. Check that:

* You signed in with the **same account** you use in the Philips Avent Baby Monitor+ app, and the monitor shows up there.
* You picked the **country** you chose when you created the account. The country decides which data center the app looks in.

### "The e-mail address or password is wrong."

Check your e-mail address and password. They are the ones for the Philips Avent Baby Monitor+ app. If you aren't sure of your password, reset it in the official app first.

### "That code is wrong or has expired."

Tap **Send a new code**, wait for the new e-mail and enter the code from that e-mail.

### I didn't get a verification code

Check your spam folder, wait a minute, and tap **Send a new code**. The code goes to the e-mail address of your Philips Avent Baby Monitor+ account.

## Why is my device showing as unavailable?

The app marks the monitor unavailable when it detects a problem. The message tells you why.

### "The baby monitor is offline"

The monitor lost its connection to the Philips Avent cloud, usually after a power cut or a Wi-Fi problem. Check that the monitor is powered and shows up in the official app. The device becomes available again by itself once the monitor is back online.

### "Can't reach the Philips Avent cloud"

Homey couldn't reach the cloud several times in a row. This is usually a temporary internet or cloud problem. The device recovers by itself once the cloud answers again.

### "Signed out of Philips Avent. Use Repair to sign in again."

The session expired. Use [Repair](settings/device/repair.md) to sign in again. One repair fixes every monitor on the same account.

## Alarms

### Motion or sound alarms never arrive

* Check that **Motion detection** and **Sound detection** are on in the [device settings](settings/device/alerts.md).
* On the **SCD973** and **SCD923**, alarms only arrive over the [local connection](settings/device/local-connection.md). Make sure it is on and that Homey can reach the monitor (see below).

### Why does the alarm turn off after 30 seconds?

The monitor reports that it detected something, but not when it stopped. The app therefore turns the alarm off again after 30 seconds. Each new detection keeps it on for another 30 seconds. See [Capabilities](capabilities.md#sound-detected).

### Alarms arrive late

Without the local connection, alarms arrive at the next cloud check, up to 30 seconds later. Keep the [local connection](settings/device/local-connection.md) on to get them within seconds.

## Local connection

### The local connection doesn't find my monitor

The app finds the monitor by listening for the announcements it broadcasts on your network. That only works when:

* Homey and the monitor are on the **same network**. A separate guest network, IoT network or VLAN usually blocks the announcements.
* Your router or access point lets **UDP broadcasts** (ports 6666 and 6667) and **TCP port 6668** through between devices. Some "client isolation" or "AP isolation" options block this.

When the monitor isn't found, the app tries again every 10 minutes. Everything else keeps working through the cloud in the meantime.

### The monitor restarts or drops off Wi-Fi

Turn the [local connection](settings/device/local-connection.md) off in the device settings and see if that helps. The app only listens on it, but a monitor that misbehaves is more important than faster alarms. On the SCD973 and SCD923 you'll lose the motion and sound alarms in Homey, the rest keeps working.

## Video

### The video doesn't start

* *"Privacy mode is on, so the camera is off."*: turn [privacy mode](capabilities.md#privacy-mode) off.
* *"Use Repair on this device and sign in again to enable video."*: run [Repair](settings/device/repair.md) once.
* *"The camera didn't start the video. Try again in a moment."*: close the video and open it again.

See [Live Video](live-video.md) for more.

## Missing features

### Why is there no humidity, sound level or battery level?

The monitors don't report humidity, a sound level in decibels or a battery level, so the app has nothing to show.

### Can I see the SenseIQ sleep summaries?

Not in Homey. The app shows the live crib status, breathing rate and crying, but not the sleep summaries from the official app.

### Can I use a camera snapshot in a notification?

No. The app offers the live video only, not a still image. See [Live Video](live-video.md#things-to-know).

## Reporting a problem

Turn on [Detailed diagnostics](settings/app/detailed-diagnostics.md), reproduce the problem, and report it on [GitHub](https://github.com/Erikvl87/nl.erikvl87.avent-baby-monitor/issues) or the [Homey Community Forum](https://community.homey.app/). Mention your monitor model.
