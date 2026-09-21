/**
 * Fleet Observability — a sidebar row + full page that embeds the live
 * fleet-status dashboard served on the LAN.
 *
 * Install location (desktop app on this machine):
 *   <hermes home>/desktop-plugins/fleet-observability/plugin.js
 * Folder name MUST equal `id`. Plain ESM, loaded uncompiled — jsx() calls,
 * never JSX syntax. Only `@hermes/plugin-sdk`, `react`, `react/jsx-runtime`
 * resolve.
 *
 * Design: the LAN page stays the single source of truth (it owns the tabs,
 * drag-and-drop re-filing, column sort and the ETA/elapsed columns). This
 * plugin contributes only navigation chrome — a "Fleet" row under Kanban
 * (Kanban registers SIDEBAR_NAV_AREA order 50; we take 51) and the /fleet
 * route that frames the live page. No second renderer of the same JSON.
 */

import { host, PALETTE_AREA, ROUTES_AREA, SIDEBAR_NAV_AREA } from '@hermes/plugin-sdk'
import { useCallback, useState } from 'react'
import { jsx, jsxs } from 'react/jsx-runtime'

const ID = 'fleet-observability'

/** Live dashboard on the LAN host (collector box, 10.0.0.5). */
const PAGE_URL = 'http://10.0.0.5:3000/fleet-status.html'
/** Collector cadence (minutes) and the page's own self-refresh (seconds). */
const COLLECTOR_MINUTES = 5
const PAGE_REFRESH_S = 60

function FleetPage() {
  // Re-keying the iframe is the only reliable reload for a cross-origin frame.
  const [nonce, setNonce] = useState(0)
  const [loaded, setLoaded] = useState(false)

  const reload = useCallback(() => {
    setLoaded(false)
    setNonce((n) => n + 1)
  }, [])

  return jsxs('div', {
    className: 'flex h-full min-h-0 flex-col',
    children: [
      jsxs('div', {
        className:
          'flex shrink-0 items-center gap-3 border-b border-(--ui-stroke-secondary) px-3 py-1.5 text-[0.6875rem]',
        children: [
          jsx('span', {
            className: 'font-medium text-(--ui-text-secondary)',
            children: 'Fleet live'
          }),
          jsx('span', {
            className: 'truncate text-(--ui-text-quaternary)',
            children: PAGE_URL
          }),
          jsx('span', {
            className: 'ml-auto shrink-0 text-(--ui-text-quaternary)',
            children: `collector ~${COLLECTOR_MINUTES}m · page self-refresh ${PAGE_REFRESH_S}s · ${
              loaded ? 'loaded' : 'loading…'
            }`
          }),
          jsx('button', {
            type: 'button',
            onClick: reload,
            className:
              'shrink-0 rounded px-2 py-0.5 text-(--ui-text-tertiary) transition-colors ' +
              'hover:bg-(--chrome-action-hover) hover:text-foreground',
            children: 'Refresh'
          }),
          jsx('a', {
            href: PAGE_URL,
            target: '_blank',
            rel: 'noreferrer',
            className: 'shrink-0 text-(--ui-accent) hover:underline',
            children: 'open in browser'
          })
        ]
      }),
      jsx('iframe', {
        key: nonce,
        src: PAGE_URL,
        title: 'Fleet status',
        onLoad: () => setLoaded(true),
        className: 'w-full flex-1 border-0',
        style: { display: 'block' }
      })
    ]
  })
}

export default {
  id: ID, // must match the folder name
  name: 'Fleet Observability',
  register(ctx) {
    ctx.i18n.register({
      en: {
        navLabel: 'Fleet',
        pageLabel: 'Fleet live'
      }
    })

    // The page itself — mounts in the workspace (main) pane.
    ctx.register({
      id: 'page',
      area: ROUTES_AREA,
      data: { path: '/fleet' },
      render: () => jsx(FleetPage, {})
    })

    // Sidebar row directly under Kanban (Kanban is order 50).
    ctx.register({
      id: 'nav',
      area: SIDEBAR_NAV_AREA,
      order: 51,
      data: { codicon: 'dashboard', label: 'Fleet', path: '/fleet' }
    })

    // ⌘K reachability, so the row isn't the only door.
    ctx.register({
      id: 'open',
      area: PALETTE_AREA,
      data: {
        id: 'fleet.open',
        label: 'Fleet: Open dashboard',
        keywords: ['fleet', 'agents', 'subagents', 'dashboard', 'status', 'kanban'],
        run: () => host.navigate('/fleet')
      }
    })
  }
}
