#!/usr/bin/env node
// Is the plugin actually loaded in a running instance? Read-only, no token.
//
// A 404 proves nothing on its own: an instance without this plugin answers 404
// just the same. What proves it is a status code only this plugin's own routes
// can produce - a missing-session 400 on /state, or a method refusal on /apply.
// Those mean our handlers ran, which cannot happen unless the bundle loaded.
//
//   node tools/probe-loaded.mjs [port]
import { PLUGIN_ID } from '../lib/index.js'

const PORT = process.argv[2] ?? '3080'
const base = `http://127.0.0.1:${PORT}`

/** Status codes that only exist if this plugin's routes are mounted. */
const PROBES = [
  { path: `/${PLUGIN_ID}/state`, why: 'GET /state refuses a missing sessionId with 400' },
  { path: `/${PLUGIN_ID}/apply`, why: 'GET /apply refuses the method with 405' },
]

async function statusOf(path) {
  const res = await fetch(base + path, { method: 'GET' }).catch(() => null)
  return res === null ? 'connection-failed' : String(res.status)
}

const probe = async () => {
  console.log(`probing ${base}`)
  const codes = []
  for (const entry of PROBES) {
    const code = await statusOf(entry.path)
    codes.push(code)
    const mine = code === '400' || code === '405'
    console.log(`  ${mine ? '✓' : '✗'} ${entry.path} -> ${code}  (${entry.why})`)
  }

  if (codes.includes('connection-failed')) {
    console.log(`\nNothing is listening on ${base}. Start DSH first, then probe again.`)
    process.exit(1)
  }

  // Everything this plugin owns answers 404 without it, including an unknown path.
  const baseline = await statusOf(`/${PLUGIN_ID}-not-a-plugin`)
  console.log(`  · ${PLUGIN_ID}-not-a-plugin -> ${baseline} (expected 404)`)
  const missing = PROBES.filter((entry, index) => !['400', '405'].includes(codes[index]))
  if (missing.length > 0) {
    console.log(`\nNOT mounted: ${missing.map((entry) => entry.path).join(', ')} answered with something other than 400/405.`)
    console.log('The plugin never activated in this instance - check the profile install, not the code.')
    process.exit(1)
  }
  console.log(`\n${PLUGIN_ID} is mounted in the instance on port ${PORT}.`)
}

probe()
