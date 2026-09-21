/**
 * Stand-in for `@hermes/plugin-sdk` under plain Node.
 *
 * Mirror, don't invent. Every value below is copied from the app, so a test
 * failure here means real behaviour, not stub drift:
 *
 *   area constants    apps/desktop/src/app/routes.ts (ROUTES_AREA, SIDEBAR_NAV_AREA)
 *                     apps/desktop/src/app/command-palette/contrib.ts (PALETTE_AREA)
 *   ctx surface       apps/desktop/src/contrib/plugin.ts
 *   i18n resolution   apps/desktop/src/i18n/plugin-i18n.ts
 *                     (active locale -> the plugin's own `en` bundle -> the key)
 *   storage namespace hermes.plugin.<plugin id>.*
 *   UI kit            apps/desktop/src/components/ui/{button,input,empty-state,
 *                     glyph-spinner}.tsx, components/status-dot.tsx, lib/time.ts
 *                     (stand-ins: same element shape + attributes, no Tailwind)
 *
 * `scripts/check-sdk-exports.mjs` re-checks these values against a Hermes
 * checkout when one is available.
 */

import { jsx, jsxs } from 'react/jsx-runtime'

export const PALETTE_AREA = 'palette'
export const ROUTES_AREA = 'routes'
export const SIDEBAR_NAV_AREA = 'sidebar.nav'

// ── host ─────────────────────────────────────────────────────────────────────

/** Every path passed to `host.navigate`, newest last. */
export const navigations = []

export const host = {
  navigate(path) {
    navigations.push(path)
  },
  /** In-app toasts: `{ kind, message }`. */
  notify(payload) {
    notifications.push(payload)
  },
  /** Open a stored session the way the app does: `(id, { profile })`. */
  openSession(session, options) {
    openedSessions.push({ options, session })

    return openSessionFails ? Promise.reject(new Error('no such session')) : Promise.resolve()
  }
}

/** Every `host.notify` payload. */
export const notifications = []

/** Every `host.openSession` call: `{ session, options }`. */
export const openedSessions = []

let openSessionFails = false

/** Make later `openSession` calls reject, to exercise the failure path. */
export function failOpenSessions(value = true) {
  openSessionFails = value
}

/** Every URL handed to `os.openExternal`. */
export const openedExternal = []

// ── i18n ─────────────────────────────────────────────────────────────────────

/** plugin id -> locale -> messages */
const bundlesByPlugin = new Map()
let activeLocale = 'en'

export function setLocale(locale) {
  activeLocale = locale
}

function lookup(pluginId, locale, key) {
  const bundle = bundlesByPlugin.get(pluginId)?.get(locale)

  if (!bundle) {
    return undefined
  }

  return key
    .split('.')
    .reduce((node, part) => (node && typeof node === 'object' ? node[part] : undefined), bundle)
}

/** Register locale bundles for a plugin. Mirrors `registerPluginLocales`. */
export function registerPluginLocales(pluginId, locales) {
  const byLocale = bundlesByPlugin.get(pluginId) ?? new Map()
  bundlesByPlugin.set(pluginId, byLocale)

  for (const [locale, messages] of Object.entries(locales ?? {})) {
    if (messages) {
      byLocale.set(locale, messages)
    }
  }

  return () => {
    bundlesByPlugin.delete(pluginId)
  }
}

/**
 * Resolve a key: active locale -> the plugin's `en` -> the raw key.
 * Mirrors `translatePlugin`.
 */
export function translatePlugin(pluginId, locale, key, args = []) {
  const value =
    lookup(pluginId, locale, key) ??
    (locale === 'en' ? undefined : lookup(pluginId, 'en', key)) ??
    key

  if (typeof value === 'function') {
    return value(...args)
  }

  return typeof value === 'string' ? value : key
}

/** Reactive translator for plugin React UI. */
export function usePluginI18n(pluginId) {
  return (key, ...args) => translatePlugin(pluginId, activeLocale, key, args)
}

// ── UI kit ──────────────────────────────────────────────────────────────────
// The app exports real Tailwind + radix components; under plain Node they can
// only be stood in for behaviourally. Each stand-in keeps the element shape and
// the attributes the real one produces (`data-slot`, `aria-busy`,
// disabled-while-loading, tone, role="status"), so a test that queries the DOM
// is asserting the contract the plugin depends on — not something the stub
// invented. Prop *names* come from the app source; `check-sdk-exports.mjs`
// re-checks the names against a checkout.

export function cn(...parts) {
  return parts.filter(Boolean).join(' ')
}

export function Button({
  variant = 'default',
  size = 'default',
  loading = false,
  className,
  children,
  disabled,
  ...props
}) {
  return jsx('button', {
    ...props,
    className: cn('button', className),
    'data-slot': 'button',
    'data-variant': variant,
    'data-size': size,
    'aria-busy': loading || undefined,
    disabled: Boolean(disabled) || loading,
    children: loading
      ? jsxs('span', {
          children: [children, jsx('span', { 'aria-hidden': 'true', 'data-slot': 'button-spinner' })]
        })
      : children
  })
}

export function Input({ className, containerClassName, prefix, suffix, size, ...props }) {
  return jsx('input', { ...props, className: cn('input', className), 'data-slot': 'input' })
}

export function EmptyState({ title, description, className }) {
  return jsxs('div', {
    className: cn('empty-state', className),
    'data-slot': 'empty-state',
    children: [jsx('div', { children: title }), description ? jsx('div', { children: description }) : null]
  })
}

export function GlyphSpinner({ ariaLabel = 'Loading', className, paused = false, spinner = 'braille' }) {
  return jsx('span', {
    role: 'status',
    'aria-label': ariaLabel,
    className: cn('glyph-spinner', className),
    'data-slot': 'glyph-spinner'
  })
}

export function StatusDot({ className, tone, ...props }) {
  return jsx('span', {
    ...props,
    'aria-hidden': 'true',
    'data-tone': tone,
    'data-slot': 'status-dot',
    className: cn('status-dot', className)
  })
}

/** Shared Intl instance, like the app's — created once, not per render. */
export const fmtDayTime = new Intl.DateTimeFormat('en-GB', {
  day: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
  month: 'short'
})

// ── storage ─────────────────────────────────────────────────────────────────

/**
 * Plugin-scoped storage. Real keys are namespaced `hermes.plugin.<id>.<key>`;
 * the namespace is invisible to plugins, so the stub keeps the bare key.
 */
export function createStorage(initial = {}) {
  const map = new Map(Object.entries(initial))
  const writes = []

  return {
    writes,
    get(key, fallback) {
      return map.has(key) ? map.get(key) : fallback
    },
    set(key, value) {
      writes.push({ key, value })
      map.set(key, value)
    },
    delete(key) {
      map.delete(key)
    },
    snapshot() {
      return Object.fromEntries(map)
    }
  }
}

// ── plugin context ──────────────────────────────────────────────────────────

/**
 * Build the `ctx` the app hands to `register(ctx)`, with recorders for
 * everything a plugin can do. Mirrors `createPluginContext` in
 * apps/desktop/src/contrib/plugin.ts.
 */
export function createPluginContext(plugin, { storage: initialStorage } = {}) {
  const storage = createStorage(initialStorage)
  const contributions = []
  const disposers = []

  const ctx = {
    source: `plugin:${plugin.id}`,
    storage,
    os: {
      openExternal: (url) => {
        openedExternal.push(url)
        return true
      }
    },
    i18n: {
      register: (locales) => registerPluginLocales(plugin.id, locales),
      t: (key, ...args) => translatePlugin(plugin.id, activeLocale, key, args)
    },
    register(contribution) {
      contributions.push(contribution)
      return () => {}
    },
    registerMany(list) {
      for (const contribution of list ?? []) {
        ctx.register(contribution)
      }
    },
    onDispose(fn) {
      disposers.push(fn)
      return () => {}
    },
    onEvent() {
      return () => {}
    },
    rest: null,
    socket: null
  }

  return { ctx, storage, contributions, disposers }
}

/** Locale bundles a plugin registered — `Map<locale, messages>`. */
export function pluginBundles(pluginId) {
  return bundlesByPlugin.get(pluginId) ?? new Map()
}

/** Reset every recorder between tests. */
export function resetRecorders() {
  navigations.length = 0
  notifications.length = 0
  openedSessions.length = 0
  openSessionFails = false
  openedExternal.length = 0
  bundlesByPlugin.clear()
  activeLocale = 'en'
}
