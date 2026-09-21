/**
 * Fleet Observability — embed ANY HTTP dashboard as a full page in Hermes Desktop.
 *
 * Nothing about a particular dashboard is baked in. The URL, the sidebar label and
 * an optional auto-reload interval live in plugin-scoped storage
 * (`hermes.plugin.fleet-observability.*`) and are edited from the page itself or
 * from the command palette. Point it at a LAN status page, Grafana, Uptime Kuma,
 * a static report — anything served over http(s).
 *
 * UI: the app's own kit (`Button`, `Input`, `EmptyState`, `GlyphSpinner`,
 * `StatusDot`, `cn`) rather than hand-rolled markup, so the pane inherits the
 * app's focus rings, variants, dark mode and motion. Load state is a first-class
 * value, not a boolean: a frame that never reports a load says so and offers a
 * way out instead of sitting blank.
 *
 * Runtime plugin: plain ESM, loaded uncompiled through the desktop app's blob-import
 * pipeline. `jsx()` calls only — never JSX syntax — and only `@hermes/plugin-sdk`,
 * `react` and `react/jsx-runtime` resolve. No build step, no bundler.
 *
 * Install: Settings > Plugins > Install from Git > `<owner>/<repo>` (this repo)
 */

import {
  Button,
  cn,
  EmptyState,
  fmtDayTime,
  GlyphSpinner,
  host,
  Input,
  PALETTE_AREA,
  ROUTES_AREA,
  SIDEBAR_NAV_AREA,
  StatusDot,
  usePluginI18n
} from '@hermes/plugin-sdk'
import { useCallback, useEffect, useState } from 'react'
import { jsx, jsxs } from 'react/jsx-runtime'

// ── Make it your own: change NAME, ROUTE and the locale bundles below. ────────
// `ID` namespaces this plugin's settings (`hermes.plugin.<ID>.*`), its locale
// bundles and its palette command ids. Pick something unique and then leave it
// alone — changing it orphans whatever users have already configured. The
// folder you install into is irrelevant: the app reads the id from the exported
// object at the bottom of this file, not from the directory name.
const ID = 'fleet-observability'
const NAME = 'Fleet Observability'
const ROUTE = '/fleet'
const NAV_ORDER = 51 // kanban sits at 50

const STORAGE_URL = 'dashboardUrl'
const STORAGE_LABEL = 'label'
const STORAGE_REFRESH = 'refreshSeconds'
const DEFAULT_LABEL = 'Fleet'
const DEFAULT_REFRESH = 0 // 0 = the embedded page handles its own refresh

// How long a configured frame may stay silent before the page stops pretending
// it is still loading. A cross-origin frame reports nothing about its own
// failure: a blocked embed and a dead host both look like "no load event yet".
const SLOW_MS = 10_000

const LOCALES = {
  en: {
    label: 'Fleet',
    open: 'Fleet: Open dashboard',
    setUrl: 'Fleet: Set dashboard URL',
    browser: 'Fleet: Open dashboard in browser',
    setupTitle: 'Point this at a dashboard',
    setupBody:
      'Any page served over http(s) — a status page on your network, a metrics dashboard, a static report. It is embedded as-is, so the page stays the single source of truth.',
    emptyAction: 'Set dashboard URL',
    urlLabel: 'Dashboard URL',
    urlPlaceholder: 'http://10.0.0.5:3000/d/fleet',
    labelLabel: 'Sidebar label',
    refreshLabel: 'Auto-reload every (seconds, 0 = off)',
    save: 'Save',
    cancel: 'Cancel',
    reload: 'Reload',
    change: 'Change',
    openExternal: 'Open in browser',
    invalidUrl: 'Enter a full URL, e.g. http://host:port/path',
    reloadHint: 'auto-reload on',
    loading: 'Loading',
    loadingHint: 'Loading the page…',
    loadedAt: 'loaded',
    slowTitle: 'No response yet',
    slowBody:
      'This page has not finished loading. It may be slow, unreachable, or refusing to be embedded (X-Frame-Options).',
    retry: 'Retry',
    notSet: 'not set',
    changeHint: 'rename applies after "Reload desktop plugins"',
    embedNote:
      'If the page refuses to be embedded (X-Frame-Options / frame-ancestors), open it in your browser instead.'
  },
  pt: {
    label: 'Frota',
    open: 'Frota: abrir painel',
    setUrl: 'Frota: definir URL do painel',
    browser: 'Frota: abrir painel no navegador',
    setupTitle: 'Aponte isto para um painel',
    setupBody:
      'Qualquer página servida por http(s) — uma página de estado na sua rede, um painel de métricas, um relatório estático. É embutida tal como está, por isso a página continua a ser a fonte de verdade.',
    emptyAction: 'Definir URL do painel',
    urlLabel: 'URL do painel',
    urlPlaceholder: 'http://10.0.0.5:3000/d/frota',
    labelLabel: 'Rótulo na barra lateral',
    refreshLabel: 'Recarregar a cada (segundos, 0 = desligado)',
    save: 'Guardar',
    cancel: 'Cancelar',
    reload: 'Recarregar',
    change: 'Alterar',
    openExternal: 'Abrir no navegador',
    invalidUrl: 'Indique um URL completo, ex.: http://host:port/caminho',
    reloadHint: 'recarga automática ligada',
    loading: 'A carregar',
    loadingHint: 'A carregar a página…',
    loadedAt: 'carregado',
    slowTitle: 'Ainda sem resposta',
    slowBody:
      'Esta página ainda não acabou de carregar. Pode estar lenta, inacessível, ou a recusar ser embutida (X-Frame-Options).',
    retry: 'Tentar de novo',
    notSet: 'não definido',
    changeHint: 'o novo nome aplica-se após "Recarregar plugins do desktop"',
    embedNote:
      'Se a página recusar ser embutida (X-Frame-Options / frame-ancestors), abra-a no navegador.'
  }
}

// ── URL handling ─────────────────────────────────────────────────────────────

/** Tolerate what people actually paste: `host:port/path` -> `http://host:port/path`. */
function normalizeUrl(raw) {
  const trimmed = String(raw == null ? '' : raw).trim()

  if (!trimmed) {
    return ''
  }

  if (/^https?:\/\//i.test(trimmed)) {
    return trimmed
  }

  if (/^[a-z][a-z0-9+.-]*:/i.test(trimmed)) {
    return '' // some other scheme (ftp:, javascript:, data:) — refuse
  }

  return `http://${trimmed.replace(/^\/+/, '')}`
}

function readConfig(storage, fallbackLabel = DEFAULT_LABEL) {
  const url = normalizeUrl(storage.get(STORAGE_URL, ''))
  const label = String(storage.get(STORAGE_LABEL, '') || '').trim() || fallbackLabel
  const refresh = Math.max(0, Math.min(86400, Math.round(Number(storage.get(STORAGE_REFRESH, DEFAULT_REFRESH)) || 0)))

  return { url, label, refresh }
}

// ── Opening a URL outside the pane ───────────────────────────────────────────
// `os.openExternal` is the app's own shell open; `window.open` is the fallback
// for hosts that do not provide one. Shared by the toolbar, the "no response
// yet" escape hatch and the palette command.
function openExternalUrl(os, url) {
  if (!url) {
    return
  }

  const fallback = () => {
    try {
      window.open(url, '_blank', 'noopener,noreferrer')
    } catch {
      /* nothing left to try */
    }
  }

  let result = null

  try {
    result = os && os.openExternal ? os.openExternal(url) : null
  } catch {
    result = false
  }

  Promise.resolve(result)
    .then((opened) => {
      if (opened === false) {
        fallback()
      }
    })
    .catch(fallback)
}

// ── Palette -> page intent ───────────────────────────────────────────────────
// The palette runs a plain function with no React context, so the request is
// parked here and the page picks it up when it mounts or is already open.

const editRequests = new Set()
let editRequestSeq = 0
let editRequestSeen = 0

function requestEdit() {
  editRequestSeq += 1
  editRequests.forEach((notify) => notify())
}

function useEditRequest() {
  const [editing, setEditing] = useState(false)

  useEffect(() => {
    const notify = () => {
      editRequestSeen = editRequestSeq
      setEditing(true)
    }

    editRequests.add(notify)

    // The palette runs with no React context, so the command may have been fired
    // while no page was mounted (app just started, or the route was never
    // visited). Pick that parked request up on mount, otherwise "Configure"
    // navigates and then silently shows the dashboard instead of the form.
    if (editRequestSeq > editRequestSeen) {
      editRequestSeen = editRequestSeq
      setEditing(true)
    }

    return () => {
      editRequests.delete(notify)
    }
  }, [])

  // Same setter shape as useState's, so Cancel (false) keeps working, while
  // opening the form by hand also consumes any parked request.
  const setEditingSeen = useCallback((value) => {
    if (value) {
      editRequestSeen = editRequestSeq
    }

    setEditing(value)
  }, [])

  return [editing, setEditingSeen]
}

// ── UI ───────────────────────────────────────────────────────────────────────

const FIELD_LABEL = 'mb-1 block text-[length:var(--conversation-caption-font-size)] text-(--ui-text-tertiary)'
const CAPTION = 'text-[length:var(--conversation-caption-font-size)]'

function Form({ t, draft, setDraft, error, onSave, onCancel }) {
  const set = (key) => (event) => setDraft({ ...draft, [key]: event.target.value })

  return jsxs('div', {
    className: 'mx-auto flex h-full w-full max-w-md flex-col justify-center gap-4 p-6',
    children: [
      jsxs('div', {
        children: [
          jsx('h2', {
            className: 'text-[length:var(--conversation-title-font-size)] font-medium text-(--ui-text-primary)',
            children: t('setupTitle')
          }),
          jsx('p', {
            className: `mt-1 ${CAPTION} text-(--ui-text-tertiary)`,
            children: t('setupBody')
          })
        ]
      }),
      jsxs('div', {
        children: [
          jsx('label', { className: FIELD_LABEL, htmlFor: `${ID}-url`, children: t('urlLabel') }),
          jsx(Input, {
            id: `${ID}-url`,
            value: draft.url,
            placeholder: t('urlPlaceholder'),
            onChange: set('url'),
            onKeyDown: (event) => {
              if (event.key === 'Enter') {
                onSave()
              }
            }
          })
        ]
      }),
      jsxs('div', {
        className: 'flex gap-3',
        children: [
          jsxs('div', {
            className: 'flex-1',
            children: [
              jsx('label', { className: FIELD_LABEL, htmlFor: `${ID}-label`, children: t('labelLabel') }),
              jsx(Input, { id: `${ID}-label`, value: draft.label, onChange: set('label') })
            ]
          }),
          jsxs('div', {
            className: 'w-40',
            children: [
              jsx('label', { className: FIELD_LABEL, htmlFor: `${ID}-refresh`, children: t('refreshLabel') }),
              jsx(Input, {
                id: `${ID}-refresh`,
                value: draft.refresh,
                inputMode: 'numeric',
                onChange: set('refresh')
              })
            ]
          })
        ]
      }),
      error
        ? jsx('div', { className: `${CAPTION} text-destructive`, role: 'alert', children: error })
        : null,
      jsxs('div', {
        className: 'flex items-center gap-2',
        children: [
          jsx(Button, { onClick: onSave, children: t('save') }),
          jsx(Button, { variant: 'ghost', onClick: onCancel, children: t('cancel') }),
          jsx('span', { className: `${CAPTION} text-(--ui-text-tertiary)`, children: t('embedNote') })
        ]
      })
    ]
  })
}

/**
 * Exported for the test harness (`test/smoke.mjs` mounts it directly to drive
 * `slowMs`); the app only ever reads the default export below.
 */
export function Page({ storage, os, slowMs = SLOW_MS }) {
  const t = usePluginI18n(ID)
  const [config, setConfig] = useState(() => readConfig(storage, t('label')))
  const [editing, setEditing] = useEditRequest()
  const [draft, setDraft] = useState(() => {
    const initial = readConfig(storage, t('label'))

    return { url: initial.url, label: initial.label, refresh: String(initial.refresh) }
  })
  const [error, setError] = useState('')
  const [nonce, setNonce] = useState(0)
  // 'loading'  the frame has not reported a load yet
  // 'ready'    it has painted at least once (and when, so the value is dated)
  // 'slow'     it still has not, so the page says so and offers a way out
  const [frame, setFrame] = useState({ state: 'loading', at: null })

  // Entering edit mode always starts from what is stored, not from a stale draft.
  useEffect(() => {
    if (editing) {
      setDraft({ url: config.url, label: config.label, refresh: String(config.refresh) })
      setError('')
    }
  }, [editing, config.url, config.label, config.refresh])

  const reload = useCallback(() => {
    setFrame({ state: 'loading', at: null })
    setNonce((value) => value + 1)
  }, [])

  useEffect(() => {
    if (!config.url || config.refresh <= 0) {
      return undefined
    }

    const timer = setInterval(reload, config.refresh * 1000)

    return () => clearInterval(timer)
  }, [config.url, config.refresh, reload])

  // Nothing is allowed to hang silently. A cross-origin frame tells us nothing
  // about why it never loaded, so the copy stays honest about all three causes
  // and the escape hatch (open in browser) is right there.
  useEffect(() => {
    if (!config.url || editing || frame.state !== 'loading') {
      return undefined
    }

    const timer = setTimeout(() => {
      setFrame((prev) => (prev.state === 'loading' ? { state: 'slow', at: null } : prev))
    }, slowMs)

    return () => clearTimeout(timer)
  }, [config.url, editing, frame.state, nonce, slowMs])

  const openExternal = useCallback(() => openExternalUrl(os, config.url), [config.url, os])

  const save = useCallback(() => {
    const url = normalizeUrl(draft.url)

    if (!url) {
      setError(t('invalidUrl'))
      return
    }

    const label = String(draft.label || '').trim() || t('label')
    const refresh = Math.max(0, Math.min(86400, Math.round(Number(draft.refresh) || 0)))

    storage.set(STORAGE_URL, url)
    storage.set(STORAGE_LABEL, label)
    storage.set(STORAGE_REFRESH, refresh)
    setConfig({ url, label, refresh })
    setError('')
    setEditing(false)
    setFrame({ state: 'loading', at: null })
    setNonce((value) => value + 1)
  }, [draft, storage, t, setEditing])

  const cancel = useCallback(() => {
    setEditing(false)
    setError('')
  }, [setEditing])

  // Cold start: nothing to embed yet. One sentence, one action — not a form
  // dropped into a page body with no explanation.
  if (!config.url && !editing) {
    return jsxs('div', {
      className: 'flex h-full flex-col items-center justify-center gap-3 p-6',
      children: [
        jsx(EmptyState, { title: t('setupTitle'), description: t('setupBody') }),
        jsx(Button, { onClick: () => setEditing(true), children: t('emptyAction') })
      ]
    })
  }

  if (!config.url || editing) {
    return jsx(Form, { t, draft, setDraft, error, onSave: save, onCancel: cancel })
  }

  const tone = frame.state === 'ready' ? 'good' : frame.state === 'slow' ? 'warn' : 'muted'
  const status =
    frame.state === 'ready'
      ? `${t('loadedAt')} ${fmtDayTime.format(new Date(frame.at))}`
      : frame.state === 'slow'
        ? t('slowTitle')
        : t('loadingHint')

  return jsxs('div', {
    className: 'flex h-full min-h-0 flex-col bg-background text-foreground',
    'data-fleet-state': frame.state,
    'data-fleet-nonce': String(nonce),
    children: [
      jsxs('div', {
        className: 'flex items-center gap-2 border-b border-(--ui-border) px-3 py-1.5',
        children: [
          jsx(StatusDot, { tone }),
          jsx('span', {
            className: `${CAPTION} shrink-0 font-medium text-(--ui-text-secondary)`,
            children: config.label
          }),
          jsx('span', {
            className: `truncate ${CAPTION} text-(--ui-text-tertiary)`,
            title: config.url,
            children: config.url
          }),
          jsx('span', {
            className: `shrink-0 ${CAPTION} text-(--ui-text-tertiary)`,
            'aria-live': 'polite',
            children: status
          }),
          config.refresh > 0
            ? jsx('span', {
                className: `shrink-0 ${CAPTION} text-(--ui-text-tertiary)`,
                children: `${t('reloadHint')} ${config.refresh}s`
              })
            : null,
          jsx('span', { className: 'flex-1' }),
          // `loading` keeps the button's width while the frame reloads — a label
          // swapped for a glyph would reflow every action on the row.
          jsx(Button, {
            size: 'sm',
            variant: 'ghost',
            loading: frame.state === 'loading',
            onClick: reload,
            children: t('reload')
          }),
          jsx(Button, {
            size: 'sm',
            variant: 'ghost',
            onClick: openExternal,
            children: t('openExternal')
          }),
          jsx(Button, {
            size: 'sm',
            variant: 'ghost',
            title: t('changeHint'),
            onClick: () => setEditing(true),
            children: t('change')
          })
        ]
      }),
      frame.state === 'slow'
        ? jsxs('div', {
            className: `flex items-center gap-3 border-b border-(--ui-border) bg-amber-500/10 px-3 py-2 ${CAPTION}`,
            role: 'status',
            children: [
              jsx('span', { className: 'shrink-0 font-medium text-(--ui-text-primary)', children: t('slowTitle') }),
              jsx('span', { className: 'text-(--ui-text-secondary)', children: t('slowBody') }),
              jsx('span', { className: 'flex-1' }),
              jsx(Button, { size: 'xs', variant: 'secondary', onClick: reload, children: t('retry') }),
              jsx(Button, { size: 'xs', variant: 'ghost', onClick: openExternal, children: t('openExternal') })
            ]
          })
        : null,
      jsxs('div', {
        className: 'relative h-full min-h-0 flex-1',
        children: [
          // Sits behind the frame: visible until the page paints, then covered by
          // it (the frame only becomes opaque once it reports a load).
          frame.state === 'ready'
            ? null
            : jsxs('div', {
                className:
                  'pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-2 text-(--ui-text-tertiary)',
                children: [
                  jsx(GlyphSpinner, { ariaLabel: t('loading') }),
                  jsx('span', { className: CAPTION, children: t('loadingHint') })
                ]
              }),
          jsx(
            'iframe',
            {
              src: config.url,
              title: config.label,
              className: cn('h-full w-full border-0', frame.state === 'ready' ? 'bg-white' : 'bg-transparent'),
              referrerPolicy: 'no-referrer',
              onLoad: () => setFrame({ state: 'ready', at: Date.now() })
            },
            // React's `jsx()` takes the key as its THIRD argument. Nested inside
            // props it is dropped (and dev-warned), so the reload nonce never
            // forced a remount — reload just re-set the same src.
            nonce
          )
        ]
      })
    ]
  })
}

export default {
  id: ID,
  name: NAME,
  register(ctx) {
    ctx.i18n.register(LOCALES)

    const t = ctx.i18n.t
    // The nav label is read once, at load: a rename needs a plugin reload.
    const label = String(ctx.storage.get(STORAGE_LABEL, '') || '').trim() || t('label')

    ctx.register({
      id: 'nav',
      area: SIDEBAR_NAV_AREA,
      order: NAV_ORDER,
      data: { codicon: 'graph', label, path: ROUTE }
    })

    ctx.register({
      id: 'route',
      area: ROUTES_AREA,
      data: { path: ROUTE },
      render: () => jsx(Page, { storage: ctx.storage, os: ctx.os })
    })

    ctx.register({
      id: 'open',
      area: PALETTE_AREA,
      order: NAV_ORDER,
      data: {
        id: `${ID}.open`,
        label: t('open'),
        keywords: [NAME.toLowerCase(), 'dashboard', 'embed', 'iframe', 'status', 'observability'],
        run: () => host.navigate(ROUTE)
      }
    })

    ctx.register({
      id: 'configure',
      area: PALETTE_AREA,
      order: NAV_ORDER + 1,
      data: {
        id: `${ID}.configure`,
        label: t('setUrl'),
        keywords: [NAME.toLowerCase(), 'dashboard', 'url', 'configure', 'settings', 'embed'],
        // Live state in the row itself: the palette re-reads this on every open.
        detail: () => normalizeUrl(ctx.storage.get(STORAGE_URL, '')) || t('notSet'),
        detailVariant: 'state',
        run: () => {
          requestEdit()
          host.navigate(ROUTE)
        }
      }
    })

    // Independent of the pane: the way out when a page refuses to be embedded
    // and the pane is showing nothing useful.
    ctx.register({
      id: 'browser',
      area: PALETTE_AREA,
      order: NAV_ORDER + 2,
      data: {
        id: `${ID}.browser`,
        label: t('browser'),
        keywords: [NAME.toLowerCase(), 'dashboard', 'browser', 'external', 'open', 'embed'],
        detail: () => normalizeUrl(ctx.storage.get(STORAGE_URL, '')) || t('notSet'),
        detailVariant: 'state',
        run: () => openExternalUrl(ctx.os, normalizeUrl(ctx.storage.get(STORAGE_URL, '')))
      }
    })
  }
}
