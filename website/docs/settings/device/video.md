---
sidebar_position: 4
---

# Video

The **Video** group has two settings for the [live video](../../live-video.md).

## Video quality

The **Video quality** setting, in the **Video** group, chooses which stream the monitor sends when you open the camera: **HD** (the default) or **SD**.

HD is sharper. SD sends far less data, so it can play more smoothly when the monitor's Wi-Fi connection is weak or busy.

The setting applies the next time you open the camera. The video starts in SD either way and switches to the chosen quality after a few seconds.

## Smooth video

The **Smooth video** setting is on by default. The monitors send their video with timing that makes it stutter. With this setting on, the video passes through the app on your Homey, which fixes the timing on the way. Nothing is decoded or re-encoded, but it does use some extra memory (about 40 MB) and a little processor time on your Homey while someone watches. With nobody watching, it costs nothing.

Turn it off to stream straight from the monitor to Homey, for example to rule the app out when the video doesn't start.

## Locating the Settings

1. Open the **Homey Mobile App** or **Homey Web App**.
2. Navigate to **Devices** and select your baby monitor.
3. Open the device settings:
   * **Mobile App:** Tap the gear icon → **Advanced Settings**
   * **Web App:** Click the gear icon and scroll to **Advanced Settings**
4. Find **Video quality** and **Smooth video** in the **Video** group.
