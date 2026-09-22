/**
 * Fleet Observability — embed ANY HTTP dashboard as a full page in Hermes Desktop.
 *
 * Nothing about a particular dashboard is baked in. The URL, the sidebar label and
 * an optional auto-reload interval live in plugin-scoped storage
 * (`hermes.plugin.fleet-observability.*`) and are edited from the page itself or
 * from the command palette. Point it at a LAN status page, Grafana, Uptime Kuma,
 * a static report — anything served over http(s).
 *
 * The page is the view, immediately: a saved address is framed on the spot and a
 * fresh install frames the default page on this machine — never a form, never a
 * waiting screen. In the background the pane asks the APP where its gateway is
 * (`host.connections()` + `host.activeConnectionId()` — the settings the window
 * is running on) and re-points itself at that host a moment later, so the common
 * case is zero configuration and two addresses are never needed.
 *
 * A hand-typed URL is stored as an explicit override and detection leaves it
 * alone — with one exception: the app's *own* dashboard. A page inside the app
 * has no session for it (its own cookie jar, SameSite-gated cookies), so that
 * address can only ever show a sign-in form; the pane says so and shows the page
 * on the gateway machine instead.
 *
 * The page may also ask the app for one thing: a message
 * `{ source: 'hermes-fleet', type: 'open-session', session, profile }` from the
 * embedded origin makes the app open that session (the page puts an "open
 * session" button on every row that carries one). Only the configured origin
 * may ask, and a refusal surfaces as an error toast instead of failing
 * silently.
 *
 * UI: the app's own kit (`Button`, `Input`, `GlyphSpinner`, `StatusDot`, `cn`)
 * rather than hand-rolled markup, so the pane inherits the
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
import { useCallback, useEffect, useRef, useState } from 'react'
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

// Where the app's own gateway settings point, when nobody has typed a URL: the
// fleet bridge serves this page on the same machine as the agent (default port
// of `serve-bridge.py`). A typed URL replaces it; nothing is ever guessed twice.
const PAGE_PORT = 8766
const PAGE_PATH = '/fleet-status.html'
/** `'gateway'` = derived from the app's connection, `'manual'` = typed by the user. */
const STORAGE_SOURCE = 'urlSource'
/** When the derived URL was last read from the app's gateway (epoch ms). */
const STORAGE_DETECTED_AT = 'detectedAt'

// How long a configured frame may stay silent before the page stops pretending
// it is still loading. A cross-origin frame reports nothing about its own
// failure: a blocked embed and a dead host both look like "no load event yet".
const SLOW_MS = 10_000

// The embedded page asks for a session jump with this message shape (see the
// message effect in `Page`). A tag, not a secret: the origin check is the guard.
const MESSAGE_SOURCE = 'hermes-fleet'

const LOCALES = {
  en: {
    label: 'Fleet',
    open: 'Fleet: Open dashboard',
    setUrl: 'Fleet: Set dashboard URL',
    browser: 'Fleet: Open dashboard in browser',
    setupTitle: 'Point this at a dashboard',
    setupBody:
      'Any page served over http(s) — a status page on your network, a metrics dashboard, a static report. It is embedded as-is, so the page stays the single source of truth. Normally you do not have to fill this in: the address comes from this app’s own gateway settings.',
    ownGatewayNotice:
      'That address is this app’s own dashboard. A page inside the app has no session for it, so it can only ever show its sign-in. Showing the page on the gateway machine instead.',
    noRegistryNotice:
      'Couldn’t read this app’s gateway settings, so this is the default address. Change it if the page lives elsewhere.',
    fromGateway: 'from the app’s gateway',
    useGateway: 'Use the app’s gateway page',
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
    openFailed: 'Could not open that session',
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
      'Qualquer página servida por http(s) — uma página de estado na sua rede, um painel de métricas, um relatório estático. É embutida tal como está, por isso a página continua a ser a fonte de verdade. Normalmente não precisa de preencher isto: o endereço vem das definições da gateway desta app.',
    ownGatewayNotice:
      'Esse endereço é o próprio painel desta app. Uma página dentro da app não tem sessão para ele, por isso só pode mostrar o início de sessão. A mostrar a página na máquina da gateway.',
    noRegistryNotice:
      'Não foi possível ler as definições da gateway desta app, por isso este é o endereço predefinido. Altere-o se a página estiver noutro sítio.',
    fromGateway: 'da gateway da app',
    useGateway: 'Usar a página da gateway da app',
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
    openFailed: 'Não foi possível abrir essa sessão',
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

/** The origin of a configured URL, or '' when it cannot be parsed. */
function originOf(url) {
  try {
    return new URL(url).origin
  } catch {
    return ''
  }
}

// ── Where the page is (the user never has to paste it) ───────────────────────
// This app already knows which machine its agent runs on — that is what its
// connection settings ARE. The page is served from that same machine, so derive
// it. A typed URL stays an explicit override; detection never overwrites one.

/**
 * Host of the machine the app's gateway runs on, from the app's own rows
 * (`host.connections()`). Remote/cloud entries carry `remote.url`, ssh entries
 * `remote.host`, and a local backend means the app's own machine.
 * Exported for the test harness; the pane only uses `gatewayPage` below.
 */
export function gatewayHostOf(rows, activeId) {
  const list = Array.isArray(rows) ? rows.filter((row) => row && typeof row === 'object') : []

  // No registered connections at all: this app is running a backend of its own
  // on this machine, so the page is here too. Derive, don't ask.
  if (!list.length) {
    return { host: '127.0.0.1', row: null }
  }

  const row =
    (activeId ? list.find((entry) => entry.id === activeId) : null) ||
    list.find((entry) => entry.primary) ||
    (list.length === 1 ? list[0] : null)

  if (!row) {
    return { host: '', row: null }
  }

  const remote = row.remote && typeof row.remote === 'object' ? row.remote : {}
  const url = String(remote.url || '').trim()

  if (url) {
    try {
      return { host: new URL(url).hostname, row }
    } catch {
      /* not a URL — an ssh entry names its host instead (below) */
    }
  }

  const sshHost = String(remote.host || '').trim()

  if (sshHost) {
    return { host: sshHost.replace(/^[^@]*@/, ''), row }
  }

  // No remote at all: the backend is on this same machine.
  return { host: !remote.mode || remote.mode === 'local' ? '127.0.0.1' : '', row }
}

/**
 * Origin of the app's *own* gateway — the dashboard the window is talking to.
 * A page framed on that origin can never hold a session (its own cookie jar,
 * SameSite-gated cookies), so it is the one address that is guaranteed to sit
 * on a sign-in form forever. Empty when the app reports nothing.
 */
export function gatewayOriginOf(rows, activeId) {
  const list = Array.isArray(rows) ? rows.filter((row) => row && typeof row === 'object') : []
  const row =
    (activeId ? list.find((entry) => entry.id === activeId) : null) ||
    list.find((entry) => entry.primary) ||
    (list.length === 1 ? list[0] : null)
  const remote = row && row.remote && typeof row.remote === 'object' ? row.remote : {}
  const url = String(remote.url || '').trim()

  if (!url) {
    return ''
  }

  try {
    return new URL(url).origin
  } catch {
    return ''
  }
}

/** Is this address the app's own dashboard (the dead end described above)? */
export function isOwnGatewayUrl(url, gatewayOrigin) {
  if (!url || !gatewayOrigin) {
    return false
  }

  try {
    return new URL(url).origin === gatewayOrigin
  } catch {
    return false
  }
}

/** Where the page lives when the app cannot be asked: this machine. */
function defaultPageUrl() {
  return `http://127.0.0.1:${PAGE_PORT}${PAGE_PATH}`
}

/**
 * Ask the app for its gateway settings and build the page URL from them.
 *
 * Rejects — never guesses — when this build has no registry or no usable
 * connection: the pane then says so and offers the manual form, which is
 * honest, where framing the wrong host would look like a broken page.
 */
async function gatewayPage() {
  if (!host || typeof host.connections !== 'function') {
    throw new Error('no connection registry')
  }

  const rows = await host.connections()
  const activeId = typeof host.activeConnectionId === 'function' ? host.activeConnectionId() : null
  const { host: name, row } = gatewayHostOf(rows, activeId)

  if (!name) {
    throw new Error('no gateway connection')
  }

  return {
    detectedAt: Date.now(),
    gatewayOrigin: gatewayOriginOf(rows, activeId),
    host: name,
    label: String((row && row.label) || '').trim(),
    url: `http://${name}:${PAGE_PORT}${PAGE_PATH}`
  }
}

function readConfig(storage, fallbackLabel = DEFAULT_LABEL) {
  const url = normalizeUrl(storage.get(STORAGE_URL, ''))
  const label = String(storage.get(STORAGE_LABEL, '') || '').trim() || fallbackLabel
  const refresh = Math.max(0, Math.min(86400, Math.round(Number(storage.get(STORAGE_REFRESH, DEFAULT_REFRESH)) || 0)))
  const marked = storage.get(STORAGE_SOURCE, '')
  // 'manual' — typed here. 'gateway' — derived, and therefore re-derived on every
  // load. 'legacy' — a URL stored before this version knew about sources: an
  // address the user chose, so it counts as typed and is never overwritten.
  const source = marked === 'manual' || marked === 'gateway' ? marked : url ? 'legacy' : ''
  const detectedAt = Number(storage.get(STORAGE_DETECTED_AT, 0)) || 0

  return { url, label, refresh, source, detectedAt }
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

function Form({ t, draft, setDraft, error, onSave, onCancel, onUseGateway }) {
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
          onUseGateway
            ? jsx(Button, { variant: 'ghost', onClick: onUseGateway, children: t('useGateway') })
            : null,
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
  // Detection is the default path: a pane with no URL says what it is doing
  // instead of asking for something the app already knows.
  // The pane always frames *something*: a stored address, or — when there is
  // none — the default page on this machine, refined by detection a moment
  // later. Frames are never gated behind a form or a waiting screen.
  const [ownGateway, setOwnGateway] = useState(false)
  const [detectError, setDetectError] = useState('')
  const [detectTick, setDetectTick] = useState(0)
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

  const detect = useCallback(() => setDetectTick((value) => value + 1), [])

  // The translator is not guaranteed to be a stable function identity, and this
  // effect writes state: depending on `t` directly re-ran it every render and
  // looped forever (the harness caught it as a hang, not as a red test). Read
  // the current one through a ref instead.
  const tRef = useRef(t)

  tRef.current = t

  // Ask the app where its gateway is, then point the pane at that machine.
  //
  // This refines the address in the background; it never gates the page. A
  // hand-typed URL is an explicit override and is left alone — with one
  // exception, the app's *own* dashboard, which can never hold a session inside
  // a frame: that one is a dead end, so the pane derives instead and says so.
  // Anything derived IS re-derived on every load rather than trusted from
  // storage, so a re-homed app follows along instead of framing a stale host.
  useEffect(() => {
    let cancelled = false

    gatewayPage()
      .then((page) => {
        if (cancelled) {
          return
        }

        const stored = readConfig(storage, tRef.current('label'))
        const deadEnd = isOwnGatewayUrl(stored.url, page.gatewayOrigin)

        // A saved address the user chose is respected — unless it is the app's
        // own dashboard, or it was derived in the first place.
        if (!deadEnd && (stored.source === 'manual' || (stored.url && stored.source !== 'gateway'))) {
          setOwnGateway(false)
          setDetectError('')
          return
        }

        setOwnGateway(deadEnd)
        setDetectError('')

        if (stored.url === page.url) {
          return
        }

        storage.set(STORAGE_URL, page.url)
        storage.set(STORAGE_SOURCE, 'gateway')
        storage.set(STORAGE_DETECTED_AT, page.detectedAt)
        setConfig({
          detectedAt: page.detectedAt,
          label: stored.label,
          refresh: stored.refresh,
          source: 'gateway',
          url: page.url
        })
        setFrame({ state: 'loading', at: null })
        setNonce((value) => value + 1)
      })
      .catch((failure) => {
        if (cancelled) {
          return
        }

        setDetectError(String((failure && failure.message) || failure || 'unknown'))
      })

    return () => {
      cancelled = true
    }
  }, [storage, detectTick])

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

  // ── The embedded page may ask for exactly one thing: open a session ─────────
  // Only the page we embedded can ask (origin must match the configured URL), and
  // the message carries no power beyond jumping to a session the app already has.
  // Anything else — another frame, another origin, another message shape — is
  // ignored without a word.
  useEffect(() => {
    if (!config.url) {
      return undefined
    }

    const allowed = originOf(config.url)

    const onMessage = (event) => {
      if (!allowed || event.origin !== allowed) {
        return
      }

      const data = event.data

      if (!data || data.source !== MESSAGE_SOURCE || data.type !== 'open-session') {
        return
      }

      const session = String(data.session || '').trim()

      if (!session) {
        return
      }

      const profile = String(data.profile || '').trim()

      Promise.resolve(host.openSession(session, profile ? { profile } : undefined)).catch((error) => {
        host.notify({
          kind: 'error',
          message: `${t('openFailed')}: ${(error && error.message) || t('openFailed')}`
        })
      })
    }

    window.addEventListener('message', onMessage)

    return () => window.removeEventListener('message', onMessage)
  }, [config.url, t])

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
    // Typed by hand = an explicit override. Detection must not take it back.
    storage.set(STORAGE_SOURCE, 'manual')
    storage.remove(STORAGE_DETECTED_AT)
    setConfig({ detectedAt: 0, label, refresh, source: 'manual', url })
    setDetectError('')
    setError('')
    setEditing(false)
    setFrame({ state: 'loading', at: null })
    setNonce((value) => value + 1)
  }, [draft, storage, t, setEditing])

  // Drop a hand-typed override and go back to whatever the app's gateway says.
  const useGateway = useCallback(() => {
    storage.remove(STORAGE_URL)
    storage.remove(STORAGE_SOURCE)
    storage.remove(STORAGE_DETECTED_AT)
    setEditing(false)
    setError('')
    setDraft((current) => ({ ...current, url: '' }))
    detect()
  }, [storage, setEditing, detect])

  const cancel = useCallback(() => {
    setEditing(false)
    setError('')
  }, [setEditing])

  // The form is the exception, not the entrance: it appears when the user asks
  // for it, and the page is the view otherwise.
  if (editing) {
    return jsx(Form, { t, draft, setDraft, error, onSave: save, onCancel: cancel, onUseGateway: useGateway })
  }

  const pageUrl = config.url || defaultPageUrl()

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
            title: pageUrl,
            children: pageUrl
          }),
          // Where the address came from, dated when it was read from the app —
          // a derived value must never look like a setting the user has seen.
          config.source === 'gateway'
            ? jsx('span', {
                className: `shrink-0 ${CAPTION} text-(--ui-text-tertiary)`,
                'data-fleet-source': 'gateway',
                title: config.detectedAt
                  ? `${t('fromGateway')} · ${fmtDayTime.format(new Date(config.detectedAt))}`
                  : t('fromGateway'),
                children: t('fromGateway')
              })
            : null,
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
      ownGateway
        ? jsxs('div', {
            className: `flex items-center gap-3 border-b border-(--ui-border) bg-amber-500/10 px-3 py-2 ${CAPTION}`,
            'data-fleet-notice': 'own-gateway',
            role: 'status',
            children: [
              jsx('span', { className: 'shrink-0 font-medium text-(--ui-text-primary)', children: t('ownGatewayNotice') }),
              jsx('span', { className: 'flex-1' }),
              jsx(Button, { size: 'xs', variant: 'ghost', onClick: () => setEditing(true), children: t('change') })
            ]
          })
        : !config.url && detectError
          ? jsxs('div', {
              className: `flex items-center gap-3 border-b border-(--ui-border) bg-amber-500/10 px-3 py-2 ${CAPTION}`,
              'data-fleet-notice': 'no-registry',
              role: 'status',
              children: [
                jsx('span', { className: 'shrink-0 font-medium text-(--ui-text-primary)', children: t('noRegistryNotice') }),
                jsx('span', { className: 'truncate text-(--ui-text-secondary)', children: detectError }),
                jsx('span', { className: 'flex-1' }),
                jsx(Button, { size: 'xs', variant: 'secondary', onClick: detect, children: t('retry') }),
                jsx(Button, { size: 'xs', variant: 'ghost', onClick: () => setEditing(true), children: t('change') })
              ]
            })
          : null,
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
              src: pageUrl,
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
