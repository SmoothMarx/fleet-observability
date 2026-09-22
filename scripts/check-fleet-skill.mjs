#!/usr/bin/env node
/**
 * check-fleet-skill.mjs — the reporting contract ships with the plug-in, so it must stay
 * true in two directions:
 *
 *   doc -> code   every verb and flag the skill tells a session to use must exist in the
 *                 writer, or a session follows instructions that do not run.
 *   code -> doc   every flag the writer accepts must be documented, or a capability exists
 *                 that nobody can discover.
 *
 * Exit code 1 on any drift, same as the SDK check.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const skill = readFileSync(join(root, 'skills/fleet-reporting/SKILL.md'), 'utf8')
const writer = readFileSync(join(root, 'skills/fleet-reporting/scripts/fleet_evt.py'), 'utf8')
const readme = readFileSync(join(root, 'README.md'), 'utf8')

let failures = 0
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}${ok || !detail ? '' : ` — ${detail}`}`)
  if (!ok) failures += 1
}

// 1. the description is the routing signal; the skill index truncates past 57 chars
const desc = (skill.match(/^---\n[\s\S]*?^description:\s*(.+)$/m) || [])[1] || ''
check('skill has a description', desc.length > 0)
check('description fits the index budget (<=60 chars)', desc.length <= 60, `${desc.length} chars`)
check('description starts with "Use when"', /^Use when /.test(desc))
check('description ends with a period', /\.$/.test(desc))

// 2. verbs: the writer's choices ARE the contract
const verbBlock = (writer.match(/add_argument\("event",\s*choices=\[([^\]]+)\]/) || [])[1] || ''
const verbs = verbBlock.split(',').map((s) => s.trim().replace(/^["']|["']$/g, '')).filter(Boolean)
check('writer declares its verbs', verbs.length > 0)
for (const v of verbs) check(`skill documents the ${v} verb`, new RegExp(`fleet_evt\\.py ${v}\\b`).test(skill))

// 3. flags, both ways
const scriptFlags = [...writer.matchAll(/add_argument\("(--[a-z0-9-]+)"/g)].map((m) => m[1])
// a leading letter/digit is required, or the YAML frontmatter's '---' reads as a flag
const docFlags = [...new Set((skill.match(/--[a-z0-9][a-z0-9-]*/g) || []))]
check('writer accepts flags', scriptFlags.length > 0)
for (const f of scriptFlags) check(`skill documents ${f}`, docFlags.includes(f))
for (const f of docFlags) check(`skill's ${f} exists in the writer`, scriptFlags.includes(f), 'documented but not accepted')

// 4. the file both sides agree the writer writes
check('skill names the events file', /\.hermes\/fleet\/events\.jsonl/.test(skill))
check('writer writes the events file', /"events\.jsonl"/.test(writer) && /\.hermes\/fleet/.test(writer))

// 5. "included with the plug-in" has to be discoverable from the plug-in's own README
check('README points at the shipped skill', /skills\/fleet-reporting/.test(readme))

console.log(failures ? `\nFAIL — ${failures} drift(s)` : '\nPASS — skill and writer agree')
process.exit(failures ? 1 : 0)
