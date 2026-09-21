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
 *
 * `scripts/check-sdk-exports.mjs` re-checks these values against a Hermes
 * checkout when one is available.
 */

export const PALETTE_AREA = 'palette'
export const ROUTES_AREA = 'routes'
export const SIDEBAR_NAV_AREA = 'sidebar.nav'

// ── host ─────────────────────────────────────────────────────────────────────

/** Every path passed to `host.navigate`, newest last. */
export const navigations = []

export const host = {
  navigate(path) {
    navigations.push(path)
  }
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
  openedExternal.length = 0
  bundlesByPlugin.clear()
  activeLocale = 'en'
}
