---
paths:
  - "drivers/baby-monitor/driver.mts"
  - "drivers/baby-monitor/pair/**"
  - "drivers/baby-monitor/repair/**"
---

# Pair and repair

- Pair: `login` → `code` → `list_devices`. Repair: `login` → `code`, then `updateSession()` on every device of the
  account. Both live in [driver.mts](../../drivers/baby-monitor/driver.mts).
- `drivers/baby-monitor/pair/{login,code}.html` and `repair/` hold the same files: **change both**.
- The `verify` handler returns `{ done }` so the code view knows whether to close (repair) or continue (pair).
- Homey loads all custom pair views into one page. Element ids carry a per-view prefix (`avent-login-`, `avent-code-`)
  and each script is wrapped in its own function; a shared id silently wires one view's handlers to the other's
  elements.
- The views move on with `Homey.showView()` after a successful step, so they have no `next` navigation (Homey's button
  would skip the step).
