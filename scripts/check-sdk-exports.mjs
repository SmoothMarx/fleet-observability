#!/usr/bin/env node
/**
 * Guard against SDK drift.
 *
 * `plugin.js` is written against `@hermes/plugin-sdk`, which only exists inside
 * the desktop app; the test suite swaps in `test/stubs/plugin-sdk.mjs`. That
 * split has exactly one failure mode worth automating: the stub drifts away
 * from the app and the tests stay green while the plugin breaks.
 *
 * Four checks, in order of availability:
 *
 *   1. Offline (always): every named import in plugin.js must exist in the
 *      stub, and the area constants the stub exports must still be the values
 *      the plugin registers under. Catches "the stub forgot an export".
 *   2. With a checkout (optional): every named import in plugin.js must also
 *      be exported by the app's real SDK module. Catches "the app renamed it".
 *   3. Same run: the area constants still hold the same VALUES.
 *   4. Same run: every `host.<verb>` the plugin calls is still a property of the
 *      app's `host` object — `openSession` is a verb, not an import, so nothing
 *      above would notice it going away.
 *
 * Point check 2 at a checkout with:
 *   node scripts/check-sdk-exports.mjs /path/to/hermes-agent
 * or by setting HERMES_APP_ROOT (a checkout) / HERMES_SDK_INDEX (the SDK module
 * itself). Without it, check 2 is skipped, not failed.
 */
import { readdir, readFile, stat } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const PLUGIN = path.join(ROOT, 'plugin.js')
const STUB = path.join(ROOT, 'test', 'stubs', 'plugin-sdk.mjs')

const SDK_SPECIFIER = '@hermes/plugin-sdk'

/** Named imports of `@hermes/plugin-sdk` in the plugin source. */
function importsOf(source) {
  const statement = source.match(/import\s*\{([^}]*)\}\s*from\s*['"]@hermes\/plugin-sdk['"]/)
  if (!statement) {
    throw new Error(`plugin.js has no named import from ${SDK_SPECIFIER}`)
  }

  return statement[1]
    .split(',')
    .map((name) => name.trim().split(/\s+as\s+/)[0].trim())
    .filter(Boolean)
    .sort()
}

/** Names the stub exports. */
function stubExports(source) {
  const names = new Set()

  for (const match of source.matchAll(/export\s+(?:const|let|var|function|class)\s+([A-Za-z0-9_$]+)/g)) {
    names.add(match[1])
  }

  for (const match of source.matchAll(/export\s*\{([^}]*)\}/g)) {
    for (const name of match[1].split(',').map((entry) => entry.trim().split(/\s+as\s+/).pop().trim())) {
      if (name) {
        names.add(name)
      }
    }
  }

  return names
}

const failures = []
const notes = []

/** `host.<verb>` calls in the plugin source. */
function hostVerbsUsed(source) {
  const names = new Set()

  for (const match of source.matchAll(/\bhost\.([A-Za-z0-9_$]+)/g)) {
    names.add(match[1])
  }

  return [...names].sort()
}

/**
 * The region of the SDK module that starts at `export const host = {`, or null
 * when that object cannot be located.
 *
 * Deliberately not a brace-matched parse: the object is hundreds of lines of
 * nested callbacks and template strings, and counting braces across those — to
 * report a *missing* verb, of all things — is exactly the kind of cleverness
 * that invents drift that is not there (it reported `host.notify` as missing
 * while `notify` sat in the object as a shorthand property).
 */
function hostRegionOf(sdkSource) {
  const start = sdkSource.indexOf('export const host = {')

  return start === -1 ? null : sdkSource.slice(start)
}

/**
 * Is `name` a member of that object? Longhand (`name:` , `name(`) or shorthand
 * (`name,`) — the app uses both. Exactly two spaces of indentation, which is how
 * the object's own members are written; deeper would be a nested object's.
 */
function declaresHostVerb(region, name) {
  return new RegExp(`^ {2}${name}\\s*[,:(]`, 'm').test(region)
}

const pluginSource = await readFile(PLUGIN, 'utf8')
const stubSource = await readFile(STUB, 'utf8')
const imported = importsOf(pluginSource)
const stub = stubExports(stubSource)

// ── Check 1: the stub covers the plugin ───────────────────────────────────────
for (const name of imported) {
  if (!stub.has(name)) {
    failures.push(`${SDK_SPECIFIER} import "${name}" is missing from test/stubs/plugin-sdk.mjs`)
  }
}

// String/array constants used as registration keys: read their stub values and
// confirm the plugin still registers under them (catching a plugin-side typo or
// a half-done rename).
const KEY_CONSTANTS = ['SIDEBAR_NAV_AREA', 'ROUTES_AREA', 'PALETTE_AREA']

for (const name of KEY_CONSTANTS) {
  const value = stubSource.match(new RegExp(`export\\s+const\\s+${name}\\s*=\\s*(['"\`])(.*?)\\1`))
  if (!value) {
    failures.push(`${name} is not a string literal in test/stubs/plugin-sdk.mjs — cannot verify it`)
    continue
  }
  if (!pluginSource.includes(name)) {
    notes.push(`plugin.js does not reference ${name} (${value[2]}) — fine if unused, worth a look`)
  }
}

// ── Check 2: the app's real SDK covers the plugin (optional) ──────────────────
const checkout = process.argv[2] || process.env.HERMES_APP_ROOT || ''
const explicitSdk = process.env.HERMES_SDK_INDEX || ''

/** Directories that never hold app source, so the value scan skips them. */
const SCAN_SKIP = new Set(['node_modules', 'dist', 'build', 'out', '.git', 'coverage'])

/**
 * `export const NAME = '…'` for each wanted name, found anywhere under `root`.
 * Returns only what it found, so a miss is reported as unverified rather than
 * as a mismatch.
 */
async function readAppConstants(root, names) {
  const found = {}
  const wanted = new Set(names)

  async function walk(dir) {
    if (!wanted.size) {
      return
    }

    let entries

    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return
    }

    for (const entry of entries) {
      if (!wanted.size) {
        return
      }

      const target = path.join(dir, entry.name)

      if (entry.isDirectory()) {
        if (!SCAN_SKIP.has(entry.name)) {
          await walk(target)
        }

        continue
      }

      if (!/\.(ts|tsx|js|mjs)$/.test(entry.name)) {
        continue
      }

      let source

      try {
        source = await readFile(target, 'utf8')
      } catch {
        continue
      }

      for (const name of [...wanted]) {
        const match = source.match(new RegExp(`export\\s+const\\s+${name}\\s*=\\s*(['"\`])(.*?)\\1`))

        if (match) {
          found[name] = match[2]
          wanted.delete(name)
        }
      }
    }
  }

  await walk(root)

  return found
}

async function findSdk(root) {
  const candidates = [
    path.join(root, 'apps', 'desktop', 'src', 'sdk', 'index.ts'),
    path.join(root, 'apps', 'desktop', 'src', 'sdk', 'index.tsx'),
    path.join(root, 'apps', 'desktop', 'src', 'plugin-sdk', 'index.ts'),
    path.join(root, 'src', 'sdk', 'index.ts')
  ]

  for (const candidate of candidates) {
    try {
      await stat(candidate)
      return candidate
    } catch {
      /* try the next one */
    }
  }

  return ''
}

let sdkPath = ''

if (explicitSdk) {
  try {
    await stat(explicitSdk)
    sdkPath = explicitSdk
  } catch {
    notes.push(`HERMES_SDK_INDEX=${explicitSdk} does not exist — falling back to a checkout search`)
  }
}

if (!checkout && !sdkPath) {
  notes.push('no checkout given — check 2 (app-side drift) skipped; pass HERMES_APP_ROOT, HERMES_SDK_INDEX, or a path argument')
} else {
  sdkPath = sdkPath || (await findSdk(checkout))

  if (!sdkPath) {
    notes.push(`no SDK module found under ${checkout} — check 2 skipped`)
  } else {
    const sdkSource = await readFile(sdkPath, 'utf8')
    const exported = /export\s+\*\s+from/.test(sdkSource)

    if (exported) {
      notes.push(`${sdkPath} re-exports via \`export *\` — check 2 reduced to a presence test`)
    }

    for (const name of imported) {
      if (!new RegExp(`\\b${name}\\b`).test(sdkSource)) {
        failures.push(`${name} is not present in ${sdkPath} — the app SDK may have renamed or dropped it`)
      }
    }

    notes.push(`check 2 ran against ${sdkPath}`)

    // ── Check 3: the area CONSTANTS still have the same VALUES ───────────────
    // A renamed constant fails check 2, but a changed value ('sidebar.nav' ->
    // 'sidebar') does not: the plugin would keep importing the same name and
    // silently register into an area nothing renders. So compare literals.
    const appSrc = path.dirname(path.dirname(sdkPath))

    const declared = await readAppConstants(appSrc, KEY_CONSTANTS)

    for (const name of KEY_CONSTANTS) {
      const stubValue = stubSource.match(new RegExp(`export\\s+const\\s+${name}\\s*=\\s*(['"\`])(.*?)\\1`))?.[2]

      if (stubValue === undefined) {
        continue // check 1 already complained about this one
      }

      if (!(name in declared)) {
        notes.push(`${name} = '${stubValue}' — not verified: no \`export const ${name} = '…'\` found under ${appSrc}`)
        continue
      }

      if (declared[name] !== stubValue) {
        failures.push(
          `${name}: the stub says '${stubValue}' but the app says '${declared[name]}' — update test/stubs/plugin-sdk.mjs`
        )
      }
    }

    notes.push(
      `check 3 compared ${Object.keys(declared).length}/${KEY_CONSTANTS.length} area constant values against the app`
    )

    // ── Check 4: the host VERBS the plugin calls still exist ────────────────
    // `host` is one import, so checks 1-3 prove only that the object is there.
    // `host.openSession` going away would break the plugin at runtime with a
    // TypeError in a click handler — the kind of failure no test here can catch,
    // because the stub would keep right on exporting it.
    const verbs = hostVerbsUsed(pluginSource)
    const hostRegion = hostRegionOf(sdkSource)

    if (!hostRegion) {
      notes.push('check 4 skipped: `export const host = {` not found in the SDK module')
    } else {
      const missing = verbs.filter((verb) => !declaresHostVerb(hostRegion, verb))

      for (const verb of missing) {
        failures.push(
          `host.${verb} is called by plugin.js but is not a member of the app's host object — likely renamed or removed`
        )
      }

      notes.push(
        `check 4 looked up ${verbs.length} host verb(s) in the app (${verbs.join(', ')}); ${missing.length} missing`
      )
    }
  }
}

// ── Report ────────────────────────────────────────────────────────────────────
console.log(`plugin imports ${imported.length} names from ${SDK_SPECIFIER}:`)
console.log(`  ${imported.join(', ')}`)

for (const note of notes) {
  console.log(`  note: ${note}`)
}

if (failures.length) {
  console.error('\nSDK drift detected:')
  for (const failure of failures) {
    console.error(`  ✗ ${failure}`)
  }
  process.exit(1)
}

console.log('\nNo SDK drift: the stub still mirrors what the plugin imports.')
