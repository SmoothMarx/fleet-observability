/**
 * Module-resolution hook for the test harness.
 *
 * The desktop app *injects* `@hermes/plugin-sdk` into a runtime plugin module;
 * in plain Node that specifier resolves to nothing. Here it is mapped to
 * `test/stubs/plugin-sdk.mjs`, which mirrors the real SDK surface.
 *
 * `react` and `react/jsx-runtime` are deliberately NOT stubbed — the harness
 * installs the real packages and renders the page for real.
 *
 * Used via `module.register('./loader.mjs', import.meta.url)` in test/register.mjs.
 */

const SDK_STUB = new URL('./stubs/plugin-sdk.mjs', import.meta.url).href

export async function resolve(specifier, context, nextResolve) {
  if (specifier === '@hermes/plugin-sdk') {
    return { url: SDK_STUB, shortCircuit: true }
  }

  return nextResolve(specifier, context)
}
