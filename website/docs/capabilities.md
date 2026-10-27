---
sidebar_position: 2
---

# Capabilities

Each baby monitor in Homey shows the values below and lets you control the monitor from the device page and from Flows.

:::info

The monitor itself measures and detects everything. The app reads it from the Philips Avent cloud and, when it can, straight from the monitor on your home network. See [Device Behavior](device-behavior.md) for how and how often.

:::

## Temperature

The temperature in the nursery, in °C, as the monitor measures it. It is tracked in Homey Insights, so you can look back at how warm or cold the room was during the night.

## Motion alarm

Turns on when the monitor detects motion. Motion alarms only work while **Motion detection** is on in the [device settings](settings/device/alerts.md).

## Sound detected

Turns on when the monitor hears a sound. Sound alarms only work while **Sound detection** is on in the [device settings](settings/device/alerts.md). On SenseIQ models, crying counts as a sound too.

:::warning

The monitor reports **that** something happened, not when it stopped. That's why the motion, sound and crying alarms turn themselves off again after **30 seconds**. A new detection within those 30 seconds keeps the alarm on for another 30 seconds.

:::

:::info

On the **SCD973** and **SCD923**, motion and sound alarms only reach Homey through the [local connection](settings/device/local-connection.md). Keep it on for these models.

:::

## Night light

Turns the monitor's night light on or off.

## Night light brightness

The brightness of the night light. Changing the brightness turns the night light on as well.

To turn the night light off after a while, use the [night light timer Flow card](flow-cards.mdx#turn-the-night-light-off-after-a-while).

## Lullabies

The monitor has 15 built-in sounds. These capabilities control them:

* **Lullaby playing**: play or stop the lullaby.
* **Previous lullaby** and **Next lullaby**: skip to the previous or next sound.
* **Lullaby volume**: the volume of the lullaby.
* **Lullaby**: the selected sound. Picking a sound here plays it. Monitors number their sounds differently, so the very first time you pick one the app checks which numbering your monitor uses; that can take a few seconds. After that it remembers.

| Sound | | Sound |
| --- | --- | --- |
| 1. Baa Baa Black Sheep | | 9. Vacuum Cleaner |
| 2. Brahms' Lullaby | | 10. White Noise |
| 3. Rock-a-Bye Baby | | 11. Garden Bird Song |
| 4. Golden Slumbers | | 12. Valley Wind |
| 5. Hush Little Baby | | 13. Ocean Shore |
| 6. Mother's Shh | | 14. Night-time Nature |
| 7. Calming River | | 15. Rain Shower |
| 8. Heartbeat | | |

**Next lullaby** steps through the sounds in this order.

To stop the lullaby after a while, use the [lullaby timer Flow card](flow-cards.mdx#stop-the-lullaby-after-a-while).

## Privacy mode

Privacy mode turns the camera off. While it is on, you can't watch [live video](live-video.md). You can switch it from the device page, from a [Flow](flow-cards.mdx#turn-privacy-mode-on-or-off), or in the official app; Homey follows the monitor either way.

## Signal strength

The Wi-Fi signal strength of the monitor, in dBm. It is updated every 5 minutes. Values closer to 0 are better: around -50 dBm is a strong signal, below -75 dBm the connection may become unreliable.

## SenseIQ only

The SenseIQ models have three extra capabilities. The app adds them automatically once it recognizes a monitor as a SenseIQ.

### Baby in crib

Shows **In crib** or **Not in crib**.

### Breathing rate

Your baby's breathing rate in breaths per minute, while your baby is in the crib. It is empty when the monitor has no rate to report, for example when the crib is empty. It is tracked in Homey Insights.

### Crying

Turns on when the SenseIQ hears your baby cry, and turns itself off again after 30 seconds, like the other alarms. Crying also turns on **Sound detected**.

:::info

With the [local connection](settings/device/local-connection.md) on, the SenseIQ sends its crib status every few seconds while your baby is in the crib, and simply stops when your baby leaves. When nothing has arrived for a minute, the app shows **Not in crib** and clears the breathing rate.

:::

## What the monitors don't report

The monitors don't report **humidity**, a **sound level in decibels** or a **battery level**, so the app can't show them. SenseIQ **sleep summaries** aren't available in Homey either.
