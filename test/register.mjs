/**
 * Entry point for `npm test`.
 *
 * `plugin.js` is loaded uncompiled by the desktop app, which *injects*
 * `@hermes/plugin-sdk` into it. Node can do neither, so this registers a
 * module-resolution hook (test/loader.mjs) that maps the SDK specifier to a
 * stub, then loads the suite. Registering first is what makes it work: hooks
 * only apply to modules loaded after `register()` returns.
 */

import { register } from 'node:module'

register('./loader.mjs', import.meta.url)

await import('./smoke.mjs')
