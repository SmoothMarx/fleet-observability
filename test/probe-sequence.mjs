/**
 * Sequence probe: the smoke suite deadlocks in
 * `the configure row reports live state and opens the form` — but only when a
 * *previous* test already mounted and unmounted the page. This probe replays
 * exactly that: phase A = unconfigured (form), phase B = configured + palette.
 *
 * `STEP` marks bracket every await, so the last line names the stuck statement.
 *
 * Run: `timeout -s KILL 20 node test/probe-sequence.mjs; echo "exit=$?"`
 */

import { register } from 'node:module'

register('./loader.mjs', import.meta.url)

import { JSDOM } from 'jsdom'

const { PALETTE_AREA, ROUTES_AREA, createPluginContext, navigations, resetRecorders, setLocale } = await import(
  '@hermes/plugin-sdk'
)

let step = 0
const mark = (what) => console.log(`STEP ${++step}  ${what}`)

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' })

globalThis.window = dom.window
globalThis.document = dom.window.document

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

/** Verbatim `withPage` from test/smoke.mjs — the thing under suspicion. */
async function withPage(initialStorage, body) {
  resetRecorders()
  setLocale('en')

  const { ctx, storage, contributions } = createPluginContext({ id: 'fleet-observability' }, { storage: initialStorage })

  plugin.register(ctx)

  const page = contributions.find((entry) => entry.area === ROUTES_AREA)
  const container = dom.window.document.createElement('div')

  dom.window.document.body.appendChild(container)

  const root = createRoot(container)

  await act(async () => {
    root.render(page.render())
  })

  try {
    await body({ container, storage, ctx, contributions })
  } finally {
    await act(async () => {
      root.unmount()
    })
    container.remove()
  }
}

// ── phase A: the test that runs immediately before the deadlock ──────────────

mark('phase A: mount an unconfigured page')
await withPage({}, async ({ container }) => {
  mark(`A body: form=${/Point this at a dashboard/.test(container.textContent)} inputs=${container.querySelectorAll('input').length}`)
})
mark('phase A: done (unmounted)')

// ── phase B: the deadlocking test, statement for statement ───────────────────

mark('phase B: mount a configured page')
await withPage({ dashboardUrl: 'http://one:1/', label: 'Ops', refreshSeconds: 0 }, async ({ container, contributions, storage }) => {
  mark('B body: entered')

  const configure = contributions.find((entry) => entry.area === PALETTE_AREA && entry.data.id.endsWith('.configure'))

  mark(`B body: detail=${configure.data.detail()} iframe=${Boolean(container.querySelector('iframe'))}`)

  mark('B body: configure.data.run() inside act')
  await act(async () => {
    configure.data.run()
  })

  mark(`B body: after run — navigations=${JSON.stringify(navigations)} form=${/Point this at a dashboard/.test(container.textContent)} writes=${storage.writes.length}`)
})
mark('phase B: done')

mark('exit')
process.exit(0)
