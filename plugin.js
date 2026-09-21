/**
 * Fleet Observability — embed ANY HTTP dashboard as a full page in Hermes Desktop.
 *
 * Nothing about a particular dashboard is baked in. The URL, the sidebar label and
 * an optional auto-reload interval live in plugin-scoped storage
 * (`hermes.plugin.fleet-observability.*`) and are edited from the page itself or
 * from the command palette. Point it at a LAN status page, Grafana, Uptime Kuma,
 * a static report — anything served over http(s).
 *
 * Runtime plugin: plain ESM, loaded uncompiled through the desktop app's blob-import
 * pipeline. `jsx()` calls only — never JSX syntax — and only `@hermes/plugin-sdk`,
 * `react` and `react/jsx-runtime` resolve. No build step, no bundler.
 *
 * Install: Settings > Plugins > Install from Git > `<owner>/<repo>` (this repo)
 */

import { host, PALETTE_AREA, ROUTES_AREA, SIDEBAR_NAV_AREA, usePluginI18n } from '@hermes/plugin-sdk'
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

const LOCALES = {
  en: {
    label: 'Fleet',
    open: 'Fleet: Open dashboard',
    setUrl: 'Fleet: Set dashboard URL',
    setupTitle: 'Point this at a dashboard',
    setupBody:
      'Any page served over http(s) — a status page on your network, a metrics dashboard, a static report. It is embedded as-is, so the page stays the single source of truth.',
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
    offline: 'not loaded yet',
    notSet: 'not set',
    changeHint: 'rename applies after "Reload desktop plugins"',
    embedNote:
      'If the page refuses to be embedded (X-Frame-Options / frame-ancestors), open it in your browser instead.'
  },
  pt: {
    label: 'Frota',
    open: 'Frota: abrir painel',
    setUrl: 'Frota: definir URL do painel',
    setupTitle: 'Aponte isto para um painel',
    setupBody:
      'Qualquer página servida por http(s) — uma página de estado na sua rede, um painel de métricas, um relatório estático. É embutida tal como está, por isso a página continua a ser a fonte de verdade.',
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
    offline: 'ainda não carregada',
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

const BTN =
  'inline-flex h-7 items-center rounded-md border border-(--ui-border) px-2.5 text-[length:var(--conversation-caption-font-size)] ' +
  'text-(--ui-text-secondary) transition-colors hover:bg-(--ui-surface-hover) hover:text-(--ui-text-primary)'
const INPUT =
  'w-full rounded-md border border-(--ui-border) bg-transparent px-2 py-1.5 text-[length:var(--conversation-body-font-size)] ' +
  'text-(--ui-text-primary) outline-none focus:border-(--ui-text-tertiary)'
const FIELD_LABEL = 'mb-1 block text-[length:var(--conversation-caption-font-size)] text-(--ui-text-tertiary)'

function Form({ t, draft, setDraft, error, onSave, onCancel, canCancel }) {
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
            className: 'mt-1 text-[length:var(--conversation-caption-font-size)] text-(--ui-text-tertiary)',
            children: t('setupBody')
          })
        ]
      }),
      jsxs('div', {
        children: [
          jsx('label', { className: FIELD_LABEL, children: t('urlLabel') }),
          jsx('input', {
            className: INPUT,
            value: draft.url,
            placeholder: t('urlPlaceholder'),
            spellCheck: false,
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
              jsx('label', { className: FIELD_LABEL, children: t('labelLabel') }),
              jsx('input', { className: INPUT, value: draft.label, onChange: set('label') })
            ]
          }),
          jsxs('div', {
            className: 'w-40',
            children: [
              jsx('label', { className: FIELD_LABEL, children: t('refreshLabel') }),
              jsx('input', {
                className: INPUT,
                value: draft.refresh,
                inputMode: 'numeric',
                onChange: set('refresh')
              })
            ]
          })
        ]
      }),
      error
        ? jsx('div', { className: 'text-[length:var(--conversation-caption-font-size)] text-destructive', children: error })
        : null,
      jsxs('div', {
        className: 'flex items-center gap-2',
        children: [
          jsx('button', {
            type: 'button',
            className: BTN,
            onClick: onSave,
            children: t('save')
          }),
          canCancel
            ? jsx('button', { type: 'button', className: BTN, onClick: onCancel, children: t('cancel') })
            : null,
          jsx('span', {
            className: 'text-[length:var(--conversation-caption-font-size)] text-(--ui-text-tertiary)',
            children: t('embedNote')
          })
        ]
      })
    ]
  })
}

function Page({ storage, os }) {
  const t = usePluginI18n(ID)
  const [config, setConfig] = useState(() => readConfig(storage, t('label')))
  const [editing, setEditing] = useEditRequest()
  const [draft, setDraft] = useState(() => {
    const initial = readConfig(storage, t('label'))

    return { url: initial.url, label: initial.label, refresh: String(initial.refresh) }
  })
  const [error, setError] = useState('')
  const [nonce, setNonce] = useState(0)
  const [loaded, setLoaded] = useState(false)

  // Entering edit mode always starts from what is stored, not from a stale draft.
  useEffect(() => {
    if (editing) {
      setDraft({ url: config.url, label: config.label, refresh: String(config.refresh) })
      setError('')
    }
  }, [editing, config.url, config.label, config.refresh])

  const reload = useCallback(() => {
    setLoaded(false)
    setNonce((value) => value + 1)
  }, [])

  useEffect(() => {
    if (!config.url || config.refresh <= 0) {
      return undefined
    }

    const timer = setInterval(reload, config.refresh * 1000)

    return () => clearInterval(timer)
  }, [config.url, config.refresh, reload])

  const openExternal = useCallback(() => {
    if (!config.url) {
      return
    }

    let result = null

    try {
      result = os && os.openExternal ? os.openExternal(config.url) : null
    } catch {
      result = false
    }

    Promise.resolve(result)
      .then((opened) => {
        if (opened === false) {
          window.open(config.url, '_blank', 'noopener,noreferrer')
        }
      })
      .catch(() => {
        try {
          window.open(config.url, '_blank', 'noopener,noreferrer')
        } catch {
          /* nothing left to try */
        }
      })
  }, [config.url, os])

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
    setLoaded(false)
    setNonce((value) => value + 1)
  }, [draft, storage, t, setEditing])

  const cancel = useCallback(() => {
    setEditing(false)
    setError('')
  }, [setEditing])

  if (!config.url || editing) {
    return jsx(Form, {
      t,
      draft,
      setDraft,
      error,
      onSave: save,
      onCancel: cancel,
      canCancel: Boolean(config.url)
    })
  }

  return jsxs('div', {
    className: 'flex h-full min-h-0 flex-col bg-background text-foreground',
    children: [
      jsxs('div', {
        className: 'flex items-center gap-2 border-b border-(--ui-border) px-3 py-1.5',
        children: [
          jsx('span', {
            className: 'text-[length:var(--conversation-caption-font-size)] font-medium text-(--ui-text-secondary)',
            children: config.label
          }),
          jsx('span', {
            className: 'truncate text-[length:var(--conversation-caption-font-size)] text-(--ui-text-tertiary)',
            children: loaded ? config.url : t('offline')
          }),
          config.refresh > 0
            ? jsx('span', {
                className: 'shrink-0 text-[length:var(--conversation-caption-font-size)] text-(--ui-text-tertiary)',
                children: `${t('reloadHint')} ${config.refresh}s`
              })
            : null,
          jsx('span', { className: 'flex-1' }),
          jsx('button', { type: 'button', className: BTN, onClick: reload, children: t('reload') }),
          jsx('button', { type: 'button', className: BTN, onClick: openExternal, children: t('openExternal') }),
          jsx('button', {
            type: 'button',
            className: BTN,
            title: t('changeHint'),
            onClick: () => setEditing(true),
            children: t('change')
          })
        ]
      }),
      jsx(
        'iframe',
        {
          src: config.url,
          title: config.label,
          className: 'h-full w-full flex-1 border-0 bg-white',
          referrerPolicy: 'no-referrer',
          onLoad: () => setLoaded(true)
        },
        // React's `jsx()` takes the key as its THIRD argument. Nested inside
        // props it is dropped (and dev-warned), so the reload nonce never
        // forced a remount — reload just re-set the same src.
        nonce
      )
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
  }
}
