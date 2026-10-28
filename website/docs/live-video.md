---
sidebar_position: 3
---

# Live Video

You can watch the monitor's camera in Homey.

## Watching the camera

1. Open the **Homey Mobile App** or **Homey Web App**.
2. Go to **Devices** and open your baby monitor.
3. Open the **Camera** video on the device.

The video starts after a few seconds, while Homey and the monitor set up the stream. When someone else is already watching the monitor in Homey, it starts almost at once.

## How it works

The monitors send their video with timing information that makes players stutter. So by default the video passes through the app on your Homey, which corrects the timing before passing it on to Homey. The video itself is not decoded, changed or stored; it goes from the monitor over your home network to Homey, and from Homey to the device you're watching on. You can turn this off with the [Smooth video](settings/device/video.md#smooth-video) setting, and the video then goes straight from the monitor to Homey, but stutters.

## How many people can watch

Philips limits how many people can watch a monitor at the same time, and the limit can differ per model: the manuals of the SCD923 and SCD973 say three. Everyone counts towards it, in the Philips Avent app and in Homey alike. A viewer over the limit can't start the video.

With [Smooth video](settings/device/video.md#smooth-video) on, Homey takes just one of those places, however many people watch in Homey: the app on your Homey receives one stream from the monitor and passes it on to every Homey viewer. Up to three people can watch a monitor through Homey at once; when a fourth starts watching, the one who has watched longest is stopped. The places that are left stay free for the Philips Avent app.

With Smooth video off, every Homey viewer gets a stream of their own from the monitor, so each one takes a place.

## Things to know

* **Privacy mode blocks the video.** Privacy mode turns the camera off, so while it is on Homey shows *"Privacy mode is on, so the camera is off."* Turn [privacy mode](capabilities.md#privacy-mode) off to watch.
* **There is no snapshot image.** The app offers the live video only, not a still image of the camera. That means there is no camera image to put in a notification or a Flow.
* **Sometimes the camera doesn't answer in time.** Homey then shows *"The camera didn't start the video. Try again in a moment."* Close the video and open it again.
* **Homey uses one of the monitor's viewer places.** See [How many people can watch](#how-many-people-can-watch).
* **The monitor's "someone is watching" light stays on a few seconds after the last viewer closes the video.** The stream stays open that long, so the video comes back at once if you reopen it.
* **Some SCD973 units stop the lullaby when the video starts.** A lullaby that was playing can stop when you open the camera; play it again.
* **Homey Self-Hosted Server needs version 12.12 or later.** On an older version, the rest of the app works as usual, but there is no video on the device.
