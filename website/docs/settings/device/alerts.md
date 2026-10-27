---
sidebar_position: 2
---

# Alerts

The **Alerts** group in the device settings controls how the monitor watches for motion and sound. These are the monitor's own settings, the same ones you see in the official Philips Avent Baby Monitor+ app. When you change them in either place, the other follows.

## Settings

* **Motion detection** (on by default)
  * Whether the monitor watches for motion. The [motion alarm](../../capabilities.md#motion-alarm) in Homey only works while this is on.
* **Motion sensitivity**: **Low**, **Medium** (default) or **High**
  * How much movement it takes before the monitor reports motion.
* **Sound detection** (on by default)
  * Whether the monitor listens for sound. The [sound alarm](../../capabilities.md#sound-detected) in Homey only works while this is on.
* **Sound sensitivity**: **Low**, **Medium** (default) or **High**
  * How loud a sound has to be before the monitor reports it.

You can also turn motion and sound detection on or off from a Flow, with the [Turn motion detection on or off](../../flow-cards.mdx#turn-motion-detection-on-or-off) and [Turn sound detection on or off](../../flow-cards.mdx#turn-sound-detection-on-or-off) cards.

## Locating the Settings

1. Open the **Homey Mobile App** or **Homey Web App**.
2. Navigate to **Devices** and select your baby monitor.
3. Open the device settings:
   * **Mobile App:** Tap the gear icon → **Advanced Settings**
   * **Web App:** Click the gear icon and scroll to **Advanced Settings**
4. Find the **Alerts** group.

:::tip

Getting too many alarms, for example from a moving mobile above the crib or a fan in the room? Lower the sensitivity before you turn detection off.

:::
