/**
 * Step-traced probe for the one test that deadlocks:
 *   `the configure row reports live state and opens the form`
 *
 * Prints a `STEP <n>` line before every await, so the last line on stdout names
 * the exact statement that never returned. Ends with an explicit `process.exit`
 * so a leftover handle (interval, un-settled act) shows up as a missing
 * `STEP exit` line rather than as a silent hang.
 *
 * Run: `timeout -s KILL 20 node test/probe-palette.mjs; echo "exit=$?"`
 */

import { register } from 'node:module'

register('./loader.mjs', import.meta.url)

import { JSDOM } from 'jsdom'

// Dynamic, not static: a static import is linked *before* this module's body
// runs, so `register()` would come too late for the hook to apply. (Same reason
// test/register.mjs dynamically imports the suite.)
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

mark('import react')
const { act } = await import('react')
const { createRoot } = await import('react-dom/client')

mark('import plugin.js')
const plugin = (await import('../plugin.js')).default

resetRecorders()
setLocale('en')

mark('createPluginContext')
const { ctx, storage, contributions } = createPluginContext(
  { id: 'fleet-observability' },
  { storage: { dashboardUrl: 'http://one:1/', label: 'Ops', refreshSeconds: 0 } }
)

mark('plugin.register')
plugin.register(ctx)

const page = contributions.find((entry) => entry.area === ROUTES_AREA)
const configure = contributions.find(
  (entry) => entry.area === PALETTE_AREA && entry.data.id.endsWith('.configure')
)

console.log('   page contribution:', Boolean(page), '| configure row:', Boolean(configure))

const container = dom.window.document.createElement('div')

dom.window.document.body.appendChild(container)

const root = createRoot(container)

mark('render (mount)')
await act(async () => {
  root.render(page.render())
})

mark(`mounted — iframe=${Boolean(container.querySelector('iframe'))} inputs=${container.querySelectorAll('input').length}`)

mark('configure.data.detail()')
console.log('   detail:', configure.data.detail())

mark('configure.data.run() inside act')
await act(async () => {
  configure.data.run()
})

mark(`palette ran — navigations=${JSON.stringify(navigations)} form=${/Point this at a dashboard/.test(container.textContent)}`)

mark('unmount inside act')
await act(async () => {
  root.unmount()
})

mark('unmounted')
container.remove()

mark('exit')
process.exit(0)
