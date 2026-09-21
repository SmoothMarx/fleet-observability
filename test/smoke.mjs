/**
 * Smoke suite — exercises plugin.js the way the desktop app does.
 *
 * No build step, no test framework: real `plugin.js`, real React, real DOM
 * (jsdom), the stub SDK recording what the plugin does with it. A failure here
 * means the plugin is broken, not that a mock drifted.
 *
 * Run with `npm test` (which wires the SDK stub in first).
 */

import assert from 'node:assert/strict'
import { JSDOM } from 'jsdom'

import {
  PALETTE_AREA,
  ROUTES_AREA,
  SIDEBAR_NAV_AREA,
  createPluginContext,
  navigations,
  openedExternal,
  pluginBundles,
  resetRecorders,
  setLocale
} from '@hermes/plugin-sdk'

const PLUGIN_ID = 'fleet-observability'
const ROUTE = '/fleet'
const NAV_ORDER = 51

// ── DOM ──────────────────────────────────────────────────────────────────────

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' })

globalThis.window = dom.window
globalThis.document = dom.window.document
// Node 22 exposes `navigator` as a getter-only global, so plain assignment
// throws — define it instead. Same for anything else already on globalThis.
for (const [key, value] of Object.entries({
  navigator: dom.window.navigator,
  HTMLElement: dom.window.HTMLElement,
  Event: dom.window.Event,
  MouseEvent: dom.window.MouseEvent
})) {
  Object.defineProperty(globalThis, key, { value, writable: true, configurable: true })
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true

const { act } = await import('react')
const { createRoot } = await import('react-dom/client')
const plugin = (await import('../plugin.js')).default

// ── helpers ──────────────────────────────────────────────────────────────────

function buttons(container) {
  return [...container.querySelectorAll('button')]
}

function button(container, label) {
  const found = buttons(container).find((node) => (node.textContent || '').trim() === label)

  if (!found) {
    const have = buttons(container)
      .map((node) => (node.textContent || '').trim())
      .join(' | ')

    throw new Error(`no button labelled "${label}" (have: ${have})`)
  }

  return found
}

async function click(node) {
  await act(async () => {
    node.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true }))
  })
}

async function type(input, value) {
  const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value').set

  await act(async () => {
    setter.call(input, value)
    input.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
  })
}

/** The URL / label / refresh inputs, in the order the form renders them. */
function inputs(container) {
  const found = [...container.querySelectorAll('input')]

  if (found.length < 3) {
    throw new Error(`expected 3 form inputs, found ${found.length}`)
  }

  return { url: found[0], label: found[1], refresh: found[2] }
}

function text(container) {
  return container.textContent || ''
}

/** Register the plugin against a fresh context, without mounting anything. */
function setup(initialStorage = {}, locale = 'en') {
  resetRecorders()
  setLocale(locale)

  const { ctx, storage, contributions } = createPluginContext({ id: PLUGIN_ID }, { storage: initialStorage })

  plugin.register(ctx)

  return { ctx, storage, contributions }
}

/** `act()` never settles once the body has thrown, so bound it — a hung
 *  process is a worse failure signal than a red test. */
function withTimeout(promise, ms, label) {
  let timer

  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms: ${label}`)), ms)
    })
  ]).finally(() => clearTimeout(timer))
}

/** Register, mount the page contribution, hand it to `body`, always unmount. */
async function withPage(initialStorage, body) {
  const { ctx, storage, contributions } = setup(initialStorage)
  const page = contributions.find((entry) => entry.area === ROUTES_AREA)
  const container = dom.window.document.createElement('div')

  dom.window.document.body.appendChild(container)

  const root = createRoot(container)
  await act(async () => {
    root.render(page.render())
  })

  let failure = null

  try {
    await body({ container, storage, ctx, contributions })
  } catch (error) {
    failure = error
  }

  // A red test must never look like a hang. Once an assertion has thrown,
  // `act()` can spin forever flushing its queue (observed as 100% CPU with no
  // further output, and a SIGKILL timeout that hides the real failure — the
  // reason this guard exists). Bail out with the original failure instead of
  // trying to unmount first; the leaked root is harmless in jsdom and the run
  // is ending anyway.
  if (failure) {
    container.remove()

    throw failure
  }

  try {
    await withTimeout(
      act(async () => {
        root.unmount()
      }),
      3000,
      'unmount'
    )
  } catch (error) {
    failure ??= error
  }

  container.remove()

  if (failure) {
    throw failure
  }
}

// ── runner ───────────────────────────────────────────────────────────────────

const failures = []

// `ONLY=<substring> npm test` runs a single test. Debugging a deadlock by
// hand-bisecting the suite is how you burn an afternoon; this is the shortcut.
const ONLY = process.env.ONLY || ''

async function test(name, fn) {
  if (ONLY && !name.includes(ONLY)) {
    return
  }

  // Printed *before* the body: if a test deadlocks, the last name on screen is
  // the culprit — otherwise a hang looks exactly like a truncated run.
  console.log(`  ...   ${name}`)

  try {
    await fn()
    console.log(`  ok    ${name}`)
  } catch (error) {
    failures.push({ name, error })
    console.log(`  FAIL  ${name}`)
    console.log(`        ${error.message.split('\n').join('\n        ')}`)
  }
}

// ── the plugin's contract with the app ───────────────────────────────────────

await test('exports an id/name pair and a register function', () => {
  assert.equal(plugin.id, PLUGIN_ID)
  assert.equal(typeof plugin.name, 'string')
  assert.equal(typeof plugin.register, 'function')
})

await test('registers one sidebar row, one page and two palette commands', () => {
  const { contributions } = setup()
  const areas = contributions.map((entry) => entry.area).sort()

  assert.deepEqual(areas, [PALETTE_AREA, PALETTE_AREA, ROUTES_AREA, SIDEBAR_NAV_AREA].sort())
})

await test('the sidebar row points at the route with a codicon', () => {
  const { contributions } = setup()
  const nav = contributions.find((entry) => entry.area === SIDEBAR_NAV_AREA)

  assert.equal(nav.order, NAV_ORDER)
  assert.equal(nav.data.path, ROUTE)
  assert.equal(nav.data.codicon, 'graph')
  assert.equal(nav.data.label, 'Fleet')
})

await test('the page contribution carries the route and a render function', () => {
  const { contributions } = setup()
  const page = contributions.find((entry) => entry.area === ROUTES_AREA)

  assert.equal(page.data.path, ROUTE)
  assert.equal(typeof page.render, 'function')
})

await test('palette commands are namespaced by plugin id and ordered after the row', () => {
  const { contributions } = setup()
  const [open, configure] = contributions.filter((entry) => entry.area === PALETTE_AREA)

  assert.equal(open.data.id, `${PLUGIN_ID}.open`)
  assert.equal(configure.data.id, `${PLUGIN_ID}.configure`)
  assert.deepEqual([open.order, configure.order], [NAV_ORDER, NAV_ORDER + 1])
  assert.equal(typeof open.data.run, 'function')
  assert.equal(typeof configure.data.run, 'function')
})

await test('a stored label wins over the locale default', () => {
  const { contributions } = setup({ label: 'Ops' })
  const nav = contributions.find((entry) => entry.area === SIDEBAR_NAV_AREA)

  assert.equal(nav.data.label, 'Ops')
})

await test('palette labels and keywords follow the plugin name, not a hard-coded one', () => {
  const { contributions } = setup()
  const open = contributions.find((entry) => entry.area === PALETTE_AREA)

  assert.equal(open.data.label, 'Fleet: Open dashboard')
  assert.ok(open.data.keywords.includes('fleet observability'), 'expected the plugin name in keywords')
  assert.ok(open.data.keywords.includes('dashboard'))
})

// ── the page ─────────────────────────────────────────────────────────────────

await test('an unconfigured page renders the setup form, not an iframe', async () => {
  await withPage({}, async ({ container }) => {
    assert.ok(text(container).includes('Point this at a dashboard'))
    assert.equal(container.querySelectorAll('input').length, 3)
    assert.ok(container.querySelector('iframe') === null)
  })
})

await test('a bare host:port is normalised to http:// and persisted on save', async () => {
  await withPage({}, async ({ container, storage }) => {
    const fields = inputs(container)

    await type(fields.url, '10.0.0.5:9000/fleet?range=1h')
    await type(fields.label, 'Ops')
    await type(fields.refresh, '60')
    await click(button(container, 'Save'))

    assert.deepEqual(storage.snapshot(), {
      dashboardUrl: 'http://10.0.0.5:9000/fleet?range=1h',
      label: 'Ops',
      refreshSeconds: 60
    })

    const frame = container.querySelector('iframe')
    assert.equal(frame.getAttribute('src'), 'http://10.0.0.5:9000/fleet?range=1h')
    assert.equal(frame.getAttribute('title'), 'Ops')
    assert.ok(text(container).includes('Ops'))
    assert.ok(text(container).includes('auto-reload on 60s'))
  })
})

await test('a non-http scheme is refused and nothing is written', async () => {
  await withPage({}, async ({ container, storage }) => {
    await type(inputs(container).url, 'ftp://example.com/x')
    await click(button(container, 'Save'))

    assert.ok(text(container).includes('Enter a full URL'))
    assert.equal(storage.writes.length, 0)
    assert.ok(container.querySelector('iframe') === null)
  })
})

await test('javascript: is refused too', async () => {
  await withPage({}, async ({ container, storage }) => {
    await type(inputs(container).url, 'javascript:alert(1)')
    await click(button(container, 'Save'))

    assert.ok(text(container).includes('Enter a full URL'))
    assert.equal(storage.writes.length, 0)
  })
})

await test('the auto-reload interval is clamped to 0..86400', async () => {
  await withPage({ dashboardUrl: 'http://host:1/', label: 'Ops', refreshSeconds: 60 }, async ({ container, storage }) => {
    assert.ok(text(container).includes('auto-reload on 60s'))

    await click(button(container, 'Change'))
    await type(inputs(container).refresh, '999999')
    await click(button(container, 'Save'))

    assert.equal(storage.get('refreshSeconds', null), 86400)

    await click(button(container, 'Change'))
    await type(inputs(container).refresh, '-5')
    await click(button(container, 'Save'))

    assert.equal(storage.get('refreshSeconds', null), 0)
    assert.ok(!text(container).includes('auto-reload on'))
  })
})

await test('changing the URL re-points the iframe without a reload of the app', async () => {
  await withPage({ dashboardUrl: 'http://one:1/', label: 'Ops', refreshSeconds: 0 }, async ({ container }) => {
    assert.equal(container.querySelector('iframe').getAttribute('src'), 'http://one:1/')

    await click(button(container, 'Change'))
    await type(inputs(container).url, 'https://two:2/dash')
    await click(button(container, 'Save'))

    assert.equal(container.querySelector('iframe').getAttribute('src'), 'https://two:2/dash')
  })
})

await test('Cancel leaves stored settings untouched', async () => {
  await withPage({ dashboardUrl: 'http://one:1/', label: 'Ops', refreshSeconds: 0 }, async ({ container, storage }) => {
    await click(button(container, 'Change'))
    await type(inputs(container).url, 'http://nope:9/')
    await click(button(container, 'Cancel'))

    assert.equal(storage.get('dashboardUrl', null), 'http://one:1/')
    assert.equal(storage.writes.length, 0)
    assert.equal(container.querySelector('iframe').getAttribute('src'), 'http://one:1/')
  })
})

await test('Reload remounts the iframe without changing its src', async () => {
  await withPage({ dashboardUrl: 'http://one:1/', label: 'Ops', refreshSeconds: 0 }, async ({ container }) => {
    const before = container.querySelector('iframe')

    await click(button(container, 'Reload'))

    const after = container.querySelector('iframe')
    assert.notEqual(after, before, 'expected a fresh iframe element')
    assert.equal(after.getAttribute('src'), 'http://one:1/')
  })
})

await test('Open in browser goes through os.openExternal, not window.open', async () => {
  await withPage({ dashboardUrl: 'http://one:1/', label: 'Ops', refreshSeconds: 0 }, async ({ container }) => {
    await click(button(container, 'Open in browser'))
    await act(async () => {})

    assert.deepEqual(openedExternal, ['http://one:1/'])
  })
})

// ── palette -> page ──────────────────────────────────────────────────────────

await test('the configure row reports live state and opens the form', async () => {
  await withPage({ dashboardUrl: 'http://one:1/', label: 'Ops', refreshSeconds: 0 }, async ({ container, contributions, storage }) => {
    const configure = contributions.find((entry) => entry.area === PALETTE_AREA && entry.data.id.endsWith('.configure'))

    assert.equal(configure.data.detail(), 'http://one:1/')
    assert.equal(configure.data.detailVariant, 'state')

    // Sanity: the page is configured, so it starts on the dashboard frame.
    // Swapping that frame for the form is what the palette command must do.
    assert.ok(container.querySelector('iframe'), 'sanity: a configured page starts on the dashboard')

    await act(async () => {
      configure.data.run()
    })

    assert.deepEqual(navigations, [ROUTE])
    assert.ok(container.querySelector('iframe') === null, 'the form, not the frame')
    assert.ok(text(container).includes('Point this at a dashboard'), 'expected the form after the palette asked for it')
    assert.equal(storage.writes.length, 0, 'opening the form must not write settings')
  })
})

await test('a Configure request fired before the page mounts still opens the form', async () => {
  const { contributions } = setup({ dashboardUrl: 'http://one:1/', label: 'Ops', refreshSeconds: 0 })
  const configure = contributions.find((entry) => entry.area === PALETTE_AREA && entry.data.id.endsWith('.configure'))

  // The palette runs with no React context: at launch, or before the route has
  // ever been visited, the command fires with nobody listening.
  configure.data.run()

  assert.deepEqual(navigations, [ROUTE], 'the palette command still navigates')

  await withPage({ dashboardUrl: 'http://one:1/', label: 'Ops', refreshSeconds: 0 }, async ({ container }) => {
    assert.ok(container.querySelector('iframe') === null, 'the parked request must survive the first mount')
    assert.ok(text(container).includes('Point this at a dashboard'), 'expected the form on first mount, not the frame')
  })
})

await test('the configure row says "not set" while unconfigured', () => {
  const { contributions } = setup()
  const configure = contributions.find((entry) => entry.area === PALETTE_AREA && entry.data.id.endsWith('.configure'))

  assert.equal(configure.data.detail(), 'not set')
})

await test('the open row navigates to the route', async () => {
  const { contributions } = setup()
  const open = contributions.find((entry) => entry.area === PALETTE_AREA && entry.data.id.endsWith('.open'))

  await act(async () => {
    open.data.run()
  })

  assert.deepEqual(navigations, [ROUTE])
})

// ── i18n ─────────────────────────────────────────────────────────────────────

await test('en and pt bundles cover exactly the same keys', () => {
  const { contributions } = setup()
  const bundles = pluginBundles(PLUGIN_ID)
  const en = Object.keys(bundles.get('en') ?? {}).sort()
  const pt = Object.keys(bundles.get('pt') ?? {}).sort()

  assert.ok(en.length > 0, 'expected an en bundle')
  assert.deepEqual(pt, en, 'pt bundle is out of sync with en')
  void contributions
})

await test('pt locale drives every string the plugin shows, and unknown keys fall back to themselves', () => {
  const { ctx, contributions } = setup({}, 'pt')
  const nav = contributions.find((entry) => entry.area === SIDEBAR_NAV_AREA)
  const open = contributions.find((entry) => entry.area === PALETTE_AREA)

  assert.equal(nav.data.label, 'Frota')
  assert.equal(open.data.label, 'Frota: abrir painel')
  assert.equal(ctx.i18n.t('nope.not.here'), 'nope.not.here')
})

await test('every UI string the plugin renders comes from the bundle', async () => {
  await withPage({}, async ({ container }) => {
    for (const literal of ['Point this at a dashboard', 'Dashboard URL', 'Save', 'Sidebar label']) {
      assert.ok(text(container).includes(literal), `missing "${literal}"`)
    }
  })
})

// ── summary ──────────────────────────────────────────────────────────────────

const total = failures.length === 0

console.log(`\n${total ? 'PASS' : 'FAIL'} — ${failures.length} failure(s)`)

// Explicit exit, on purpose: a plugin that leaks a handle (an interval, a
// pending render) would otherwise keep Node alive forever and turn a green run
// into a CI timeout. The summary above is the whole verdict.
process.exit(total ? 0 : 1)
