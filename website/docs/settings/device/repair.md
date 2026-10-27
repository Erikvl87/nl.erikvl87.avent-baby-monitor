---
sidebar_position: 1
---

# Repair (Sign In Again)

The app keeps a signed-in session for your Philips Avent Baby Monitor+ account, not your password. Use **Repair** to sign in again when:

* **The session expired.** The device is unavailable with *"Signed out of Philips Avent. Use Repair to sign in again."* This can happen when you change your password, or when Philips Avent ends the session on its side. Homey can't control or read the monitor until you sign in again.
* **The video asks for it.** Monitors added before the app supported [live video](../../live-video.md) show *"Use Repair on this device and sign in again to enable video."* when you open the camera. One repair is enough; after that the video keeps working.

## Signing in again

1. Open the **Homey Mobile App** or **Homey Web App**.
2. Navigate to **Devices** and select your baby monitor.
3. Open the device settings:
   * **Mobile App:** Tap the gear icon → **Repair**
   * **Web App:** Click the gear icon and select **Repair**
4. Your e-mail address is filled in already. Enter your **password**, check the **country**, and tap **Send verification code**.
5. Enter the **6-digit verification code** that Philips Avent e-mails you, and tap **Sign in**.
6. The device reconnects right away.

:::info

A repair updates **every monitor on the same account** at once. If you have several monitors on one account, you only need to repair one of them.

:::

:::warning

Sign in with the **same account** you added the monitor with. If the monitor isn't on the account you signed in with, the repair stops with *"This baby monitor isn't on that account."*

:::
