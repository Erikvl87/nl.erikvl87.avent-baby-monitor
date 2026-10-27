---
sidebar_position: 3
---

# Live Video

You can watch the monitor's camera in Homey.

## Watching the camera

1. Open the **Homey Mobile App** or **Homey Web App**.
2. Go to **Devices** and open your baby monitor.
3. Open the **Camera** video on the device.

The video starts after a few seconds, while Homey and the monitor set up the stream.

## How it works

The monitors stream video over **WebRTC**, the same technique video calls in a browser use. When you open the camera, Homey asks the app for a stream, and the app asks the monitor for one through the Philips Avent (Tuya) cloud, the same way the official app does.

The monitors send their video with timing information that makes players stutter. So by default the video passes through the app on your Homey, which corrects the timing before passing it on to Homey. The video itself is not decoded, changed or stored; it goes from the monitor over your home network to Homey, and from Homey to the device you're watching on. You can turn this off with the [Smooth video](settings/device/video.md#smooth-video) setting, and the video then goes straight from the monitor to Homey, but stutters.

## Things to know

* **Privacy mode blocks the video.** Privacy mode turns the camera off, so while it is on Homey shows *"Privacy mode is on, so the camera is off."* Turn [privacy mode](capabilities.md#privacy-mode) off to watch.
* **Monitors added before video support need one Repair.** The video needs a bit more from the sign-in than the rest of the app. If your monitor was added with an older version of the app, Homey shows *"Use Repair on this device and sign in again to enable video."* Run [Repair](settings/device/repair.md) once and the video works from then on.
* **There is no snapshot image.** The app offers the live video only, not a still image of the camera. That means there is no camera image to put in a notification or a Flow.
* **Sometimes the camera doesn't answer in time.** Homey then shows *"The camera didn't start the video. Try again in a moment."* Close the video and open it again.
* **Your Homey must support camera video.** On a Homey that doesn't, the rest of the app works as usual, but there is no video on the device.
