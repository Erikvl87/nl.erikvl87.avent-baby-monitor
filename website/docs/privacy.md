---
sidebar_position: 7
---

# Privacy

A baby monitor sees and hears a lot. This page explains what the app does with your account and your monitor.

## Your account

* **Your password is not stored.** You enter it while adding a monitor or during a [Repair](settings/device/repair.md), and the app only uses it to sign in.
* **The app keeps the session instead.** After you sign in, each monitor's device in Homey keeps the session the app needs to talk to the cloud: the session itself, your account id and e-mail address, the data center your account lives in, and the details needed to set up [live video](live-video.md).
* **The session is obfuscated.** It is stored in a form that isn't readable at a glance, for example when you look at a device in the Homey developer tools or share your screen. This is not strong encryption, so treat access to your Homey as access to the monitor.

## Who the app talks to

* **The Philips Avent cloud.** Philips Avent monitors are Tuya cameras under the hood, and the official app talks to Tuya's cloud. This app talks to the same cloud in the same way, in the data center your country belongs to. Apart from the error reports described under [Diagnostics](#diagnostics), it doesn't talk to any other server.
* **Your monitor, on your home network.** The [local connection](settings/device/local-connection.md) stays inside your home network and only listens.
* **Live video** flows between the monitor and the device you watch on. It does not pass through the app, and the app doesn't record or store it.

## Diagnostics

When something goes wrong in the app, an error report is sent to the developer so it can be fixed. These reports never contain your password, your session or the monitor's local key. You can add more detail to them with [Detailed diagnostics](settings/app/detailed-diagnostics.md), which is off by default.

## Removing a monitor

When you remove a monitor from Homey, the session stored in its device is removed with it.
