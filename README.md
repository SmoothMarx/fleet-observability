# Fleet Observability

A **Hermes Desktop plugin** that embeds *any* HTTP dashboard as a full page in the app, with its own row in the sidebar.

It was written to watch a fleet of agent/project statuses on a LAN page, but nothing about that page is baked in: point it at Grafana, Uptime Kuma, a static status report, a metrics endpoint — anything served over `http(s)`. The embedded page stays the single source of truth; the plugin only supplies chrome (sidebar row, toolbar, palette commands) around it.

## What it contributes

| Contribution | Area | Where it shows up |
| --- | --- | --- |
| Sidebar row | `SIDEBAR_NAV_AREA` (order 51) | sidebar, right under **Kanban** |
| Page | `ROUTES_AREA` → `/fleet` | workspace page, full-height iframe |
| Command | `PALETTE_AREA` | ⌘K → **Fleet: Open dashboard** |
| Command | `PALETTE_AREA` | ⌘K → **Fleet: Set dashboard URL** (the row shows the URL currently configured) |
| Command | `PALETTE_AREA` | ⌘K → **Fleet: Open dashboard in browser** (works without visiting the page — the way out when a page refuses to be framed) |

## Requirements

- Hermes Desktop app. The runtime plugin loader is app-side; the CLI/gateway alone does not load these.
- Network reachability from the app machine to the dashboard host.
- Git available to the app: the Windows installer ships PortableGit under `%LOCALAPPDATA%\hermes\git` and the installer uses it automatically.

## Install

1. **Settings → Plugins → Install from Git**
2. Identifier — any of these forms work:

   ```
   SmoothMarx/fleet-observability
   https://github.com/SmoothMarx/fleet-observability
   https://github.com/SmoothMarx/fleet-observability.git
   SmoothMarx/some-monorepo/plugins/fleet-observability
   ```

   (The installer also accepts a `#subdir` suffix and tree URLs for a plugin that lives in a subdirectory of a bigger repo.)
3. Confirm. The app installs `plugin.js` into `<hermes home>/desktop-plugins/fleet-observability/plugin.js` — `%USERPROFILE%\.hermes\desktop-plugins\…` on Windows.
4. The **Fleet** row appears under Kanban. If not, run **Reload desktop plugins** from ⌘K.
5. Open the row and give it a URL.

The clone runs on your machine, so a *private* repo needs a git credential that can read it; a public repo needs none. No build step: the app executes `plugin.js` as-is.

## Configure

First open shows an empty state with one action (**Set dashboard URL**); the form sits behind it. Afterwards: ⌘K → **Fleet: Set dashboard URL**, or the **Change** button in the page toolbar.

Everything lives in plugin-scoped app storage (`hermes.plugin.fleet-observability.*`):

| Key | Meaning | Default |
| --- | --- | --- |
| `dashboardUrl` | Full URL. A bare `host:port/path` is upgraded to `http://…`; other schemes are refused | — (unset ⇒ the empty state) |
| `label` | Sidebar row text and page title | `Fleet` |
| `refreshSeconds` | Re-key the iframe every N seconds (`0` = off, let the page refresh itself) | `0` |

`label` is read when the plugin loads, so a rename appears after **Reload desktop plugins**.

## What the pane tells you

The toolbar is a status line, not just buttons — an embedded page is a snapshot of an external service, so the pane says how current it is:

| State | Toolbar | What you get |
| --- | --- | --- |
| **Loading** | muted dot, spinner over the frame, `Loading the page…` | the app's in-button working state on **Reload** (label stays put, no reflow) |
| **Ready** | green dot, `loaded <date, time>` | the frame, and a dated value for *when* it last loaded |
| **No response yet** | amber dot, notice bar after 10 s | honest copy (slow / unreachable / refusing to embed), **Retry**, **Open in browser** |

A cross-origin frame reports nothing about its own failure, so the 10-second notice deliberately names all three likely causes rather than guessing — and never blocks: **Retry** restarts the load, and a late load clears the notice and wins.

## UI

The pane is built from the app's own kit — `Button`, `Input`, `EmptyState`, `GlyphSpinner`, `StatusDot`, `cn`, `fmtDayTime` — rather than hand-rolled markup, so it inherits the app's variants, focus rings, dark mode, motion and reduced-motion behaviour, and keeps tracking the app's design as it changes.

## Limits (by design)

- **Embedding is up to the target page.** A page sending `X-Frame-Options: DENY` or a restrictive `frame-ancestors` CSP cannot be framed — use **Open in browser** in the toolbar.
- **`http(s)` only.** Other schemes are refused rather than handed to the iframe.
- **No auth injection.** The iframe is not sandboxed and carries the app session for that origin, but the plugin does not log in for you: point it at something the app machine can already reach (a LAN page, or one with its own session/cookie).
- **Read-only.** The plugin never writes to the dashboard, and it adds only navigation chrome — there is never a second renderer of the same data to keep in sync.

## Make it your own

Fork it, then change the constants at the top of `plugin.js`:

```js
const ID = 'fleet-observability'   // the app reads the id from this export, not from the folder name
const NAME = 'Fleet Observability'
const ROUTE = '/fleet'             // path the sidebar row navigates to
const NAV_ORDER = 51               // sidebar position (kanban is 50)
```

…then the `LOCALES` bundles (`en`, `pt` — add your own locale key; `ctx.i18n.t()` falls back to `en`).

Two rules worth keeping if you fork further:

- Anything a user might need to change is **config, not source** — put it in `ctx.storage` and give it an editor. Never bake a URL, host or token into the module.
- The dashboard page is the single source of truth. The plugin adds chrome around it; it never re-implements the dashboard's data.

## Uninstall

Settings → Plugins → disable or remove. Nothing else is touched: no core files, no config edits, no backend changes.

## Development

```bash
npm install
npm test              # stubs the SDK + react, exercises register() and renders every page state
npm run check:sdk     # only meaningful on a Hermes source checkout
```

`npm test` needs Node ≥ 20.6 (it uses `module.register`). The SDK stub exists because the app *injects* `@hermes/plugin-sdk`, `react` and `react/jsx-runtime` into the module — in plain Node nothing resolves them, so `test/loader.mjs` maps the SDK specifier to `test/stubs/plugin-sdk.mjs`, which mirrors the real contribution shapes, the real area-constant values, and the UI kit the pane renders with (each stand-in keeps the element shape the real component produces: `data-slot`, `aria-busy`, disabled-while-loading, `role="status"`, tone).

`Page` is exported from `plugin.js` for that harness only (the app reads the default export): one test mounts it with a short `slowMs`, because waiting out the real 10-second "no response yet" threshold is not a test.

`check:sdk` is a no-op unless pointed at a checkout. Against one, it verifies that every
SDK import in `plugin.js` still exists in the app's real SDK module **and** that the area
constants (`ROUTES_AREA`, `SIDEBAR_NAV_AREA`, `PALETTE_AREA`) still hold the same string
values — a renamed constant is caught by the import check, but a *changed value* would
otherwise leave the plugin registering into an area nothing renders:

```bash
HERMES_APP_ROOT=/path/to/hermes-agent npm run check:sdk
# or point straight at the module: HERMES_SDK_INDEX=/path/to/hermes-agent/apps/desktop/src/sdk/index.ts npm run check:sdk
```

## Layout

```
plugin.js                     the whole plugin — runtime ESM, jsx() calls, no bundler
test/register.mjs             module.register() bootstrap
test/loader.mjs               maps @hermes/plugin-sdk → the stub
test/stubs/plugin-sdk.mjs     SDK stand-in: area constants, hooks, i18n, UI kit
test/smoke.mjs                behaviour tests: contributions, URL normalising, every pane state
scripts/check-sdk-exports.mjs drift check against a real Hermes checkout
.github/workflows/ci.yml      npm ci + npm test + the offline SDK check on Node 20 and 22
```

## License

MIT — see [LICENSE](LICENSE).
