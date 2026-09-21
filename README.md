# fleet-observability — Hermes Desktop plugin

Adds a **Fleet** row to the Hermes Desktop sidebar (directly under **Kanban**) plus a `/fleet` page that embeds the live fleet-status dashboard served on the LAN.

Runtime plugin, plain ESM, no build step — the app loads it as-is.

## What it shows

The page frames the existing dashboard, which stays the single source of truth:

```
http://10.0.0.5:3000/fleet-status.html
```

That page owns everything: the tabs (Projects / Agents / Cron jobs / Cahiers / Everything), per-row status, the original ETA guess **and** running elapsed, collapse/expand, drag-and-drop re-filing, reordering and column sort. The collector refreshes every ~5 minutes; the page self-refreshes every 60 seconds.

This plugin deliberately adds **only navigation chrome** (row + route + ⌘K command) and frames that page, so there is never a second renderer of the same data to keep in sync.

## Requirements

- Hermes Desktop app (the plugin system is app-side; the CLI/gateway alone does not load these).
- Network reachability from the machine running the app to the dashboard host on the LAN.
- Git available to the app: the Windows Hermes installer ships PortableGit under `%LOCALAPPDATA%\hermes\git`, which the installer uses automatically.

## Install

In the Hermes Desktop app:

1. **Settings → Plugins → Install from Git**.
2. Paste either form:
   - `SmoothMarx/fleet-observability`
   - `https://github.com/SmoothMarx/fleet-observability`
3. Confirm. The app shallow-clones the repo and installs `plugin.js` into:

   `<hermes home>/desktop-plugins/fleet-observability/plugin.js`

   (`%USERPROFILE%\.hermes\desktop-plugins\fleet-observability\plugin.js` on Windows.)

4. The **Fleet** row appears in the sidebar under Kanban. If it does not, run **Reload desktop plugins** from ⌘K.

## Usage

- Sidebar **Fleet** row, or ⌘K → **Fleet: Open dashboard**.
- Toolbar above the frame: live URL, collector/refresh cadence, a **Refresh** button (re-keys the iframe) and **open in browser**.

## Configuration

The dashboard URL is a constant near the top of `plugin.js`:

```js
const PAGE_URL = 'http://10.0.0.5:3000/fleet-status.html'
```

Edit and save — the app hot-reloads plugins on file change. If the dashboard moves, change this line (and `COLLECTOR_MINUTES` / `PAGE_REFRESH_S` if the cadence changes).

## Uninstall

Settings → Plugins → disable or remove. Nothing else is touched: no core files, no config edits, no backend changes.

## Notes

- Styling uses the app's theme variables (`var(--ui-*)`) and Tailwind utility classes already present in the app shell, so it follows light/dark themes with no hardcoded colors.
- The dashboard's LAN address is baked into this repo as a plain constant. It is a private RFC1918 address, not a credential.
