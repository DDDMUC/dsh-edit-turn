// Verify the browser half of a RUNNING DSH instance.
//
// The static checker (verify-client-static.mjs) proves the source is sound; this
// proves the bytes the browser will actually download are the ones just edited.
// It answers the question a screenshot answers badly: is my plugin in the client
// module graph, and is the code being served the current code?
//
// How it works: an authenticated boot page carries one `<link rel="preload">`
// per client module group, and the group URL lists every member, e.g.
//   /plugins/??dsh-free-search/client.js,dsh-edit-turn/client.js&rev=<hash>
// The rev is a content hash, so a changed file changes the URL the browser
// fetches. Fetching that URL and asserting the plugin's own markers are present
// is a direct check on the served artifact.
//
// Auth is the token DSH prints on boot: `GET /?token=<t>` answers 303 with an
// auth cookie, which the follow-up request needs.
//
//   node tools/verify-live-client.mjs --token <token>
//   node tools/verify-live-client.mjs --token-file ./dsh.log
//   DSH_URL=http://127.0.0.1:3080 node tools/verify-live-client.mjs --token <t>
//
// Read-only: it never writes to the instance it inspects.
import { readFileSync } from 'node:fs'

const PLUGIN_ID = 'dsh-edit-turn'

// Markers that must appear in the served bundle, each tied to something real:
// the module id, a class the stylesheet and the DOM code share, the version the
// client exports, and an identifier that only exists after the notice-banner fix.
const MARKERS = [
  { needle: PLUGIN_ID, what: 'the module id' },
  { needle: 'dshet-notice', what: 'the notice stylesheet rule' },
  { needle: 'ERROR_KEYS', what: 'the dictionary-validated error lookup' },
  { needle: "typeof view.notice !== 'string'", what: 'the guarded notice render' },
  { needle: 'editorMarker', what: 'the editor re-render marker that tracks every field' },
  { needle: 'syncEditableSet', what: 'the transcript-change refresh of the editable set' },
  { needle: 'collapseRowContent', what: 'the row collapse that leaves the platform action bar standing' },
  { needle: 'dshet-revision-action', what: 'the revision gutter that keeps the pencil off the text' },
  { needle: 'readReplyView', what: 'the reply entry that cannot take its strip down with it' },
  { needle: '--dshet-panel', what: 'the self-contained panel surface that survives a skin' },
  { needle: 'hidden && canHide', what: 'the guard that keeps a message up until its replacement is drawn' },
  { needle: 'await this.load(true)', what: 'the refresh that hands the optimistic view back to the host' },
  { needle: 'placeRevisionBubble', what: 'the bubble planted above the action bar, not after the row' },
  { needle: 'dshet-reply-action', what: 'the reply pencil pulled ahead of its action strip' },
  { needle: 'injectRowAction(row, editTarget', what: "the collapsed row's pencil placed in the bar that survived" },
  { needle: 'fitEditorHeight', what: 'the editor box that grows with its text' },
  { needle: "'/dsh-rerun-turn'", what: 'the re-run button that belongs to the sibling plugin' },
  { needle: 'takeOverRowCopy', what: 'the rewritten row answering its own copy' },
  { needle: 'dshetCopyText', what: 'the copy handover this plugin writes on the host’s button' },
]

function arg(name) {
  const index = process.argv.indexOf(`--${name}`)
  return index === -1 ? undefined : process.argv[index + 1]
}

let failures = 0
function check(label, condition, detail) {
  if (condition) console.log(`  ✓ ${label}`)
  else {
    failures += 1
    console.log(`  ✗ ${label}${detail === undefined ? '' : ` — ${detail}`}`)
  }
}

const base = (process.env.DSH_URL || 'http://127.0.0.1:3080').replace(/\/$/, '')
let token = arg('token')
const tokenFile = arg('token-file')
if (token === undefined && tokenFile !== undefined) {
  // DSH prints one URL per launch and appends to the log, so the LAST one is
  // the live token.
  const matches = [...readFileSync(tokenFile, 'utf8').matchAll(/[?&]token=([A-Za-z0-9_-]+)/g)]
  token = matches.length > 0 ? matches[matches.length - 1][1] : undefined
}
if (token === undefined) {
  console.error('usage: node tools/verify-live-client.mjs --token <token> | --token-file <log>')
  process.exit(2)
}

console.log(`1. authenticate against ${base}`)
const handshake = await fetch(`${base}/?token=${encodeURIComponent(token)}`, { redirect: 'manual' })
check('the token is accepted', handshake.status === 303 || handshake.status === 200, `HTTP ${handshake.status}`)
const cookie = (handshake.headers.getSetCookie?.() ?? []).map((value) => value.split(';')[0]).join('; ')
check('an auth cookie was issued', cookie !== '')
const withCookie = cookie === '' ? {} : { cookie }

const page = await fetch(`${base}/`, { headers: withCookie })
const html = (await page.text()).replace(/&amp;/g, '&')
check('the boot page was served', page.status === 200 && html.length > 1000, `HTTP ${page.status}, ${html.length} bytes`)

console.log('\n2. find this plugin in the client module graph')
// The boot page writes these hrefs relative to itself: `plugins/??...`.
const groups = [...new Set([...html.matchAll(/href="((?:\/|\.{1,2}\/)?plugins\/[^"]+)"/g)]
  .map((match) => match[1]))]
  .map((href) => `/${href.replace(/^(\.\/|\/)+/, '')}`)
check('the boot page lists client module groups', groups.length > 0, `${groups.length} groups`)
const group = groups.find((href) => href.includes(`${PLUGIN_ID}/client.js`))
check(`"${PLUGIN_ID}/client.js" is in the module graph`, group !== undefined,
  group === undefined ? 'the plugin is not part of this instance' : undefined)
if (group === undefined) {
  console.log(`\n${failures} 项失败。`)
  process.exit(1)
}
const rev = /[?&]rev=([0-9a-f]+)/.exec(group)?.[1]
console.log(`  · group rev ${rev ?? '(none)'} with ${group.split(',').length} member(s)`)

console.log('\n3. download the served bundle and assert its contents')
const bundle = await fetch(`${base}${group}`, { headers: withCookie })
const code = await bundle.text()
check('the bundle was served', bundle.status === 200 && code.includes(PLUGIN_ID), `HTTP ${bundle.status}, ${code.length} bytes`)
// The group is the concatenation of many plugins, so markers must be checked in
// this plugin's own module; otherwise another plugin's copy could satisfy them -
// and another plugin's code could fail the negative check below. Anchoring on
// the module registration and cutting at the next one is exact; a fixed window
// around the first and last mention of the id is not, because the id also turns
// up in other plugins' comments and in the group's source-map hint.
const idAt = code.lastIndexOf(`id: '${PLUGIN_ID}'`)
check(`the module registers under "${PLUGIN_ID}"`, idAt !== -1)
const loadAt = idAt === -1 ? -1 : code.lastIndexOf('__ModuleLoader__.load({', idAt)
const nextLoad = idAt === -1 ? -1 : code.indexOf('__ModuleLoader__.load({', idAt)
const fallback = Math.max(0, Math.min(...[...code.matchAll(new RegExp(PLUGIN_ID, 'g'))].map((match) => match.index)) - 4000)
const slice = code.slice(
  loadAt === -1 ? fallback : loadAt,
  nextLoad === -1 ? code.length : nextLoad,
)
for (const marker of MARKERS) {
  check(`the served code carries ${marker.what}`, slice.includes(marker.needle))
}
check('no stale naive error lookup survives in this plugin slice', !slice.includes('t(`error.${'))

// The browser half does not only depend on its own code: it reads node shapes
// that the chat-flow state produces. If a DSH update renames those, actions
// silently stop appearing on model replies - nothing throws, the feature just
// vanishes. They are built by another module (the flow state lives outside this
// plugin's own group) and the bundler quotes them however it likes, so these
// are matched across every group the boot page loads, without quotes.
const hostShapes = [
  { pattern: /["']assistant-step["']/, what: 'the node kind that assistant rows use' },
  { pattern: /data\.finalNode/, what: 'where a reply seq lives on that node' },
  { pattern: /kind\s*===?\s*["']user["']/, what: 'the node kind that prompt rows use' },
]
console.log('\n4. the node shapes this client reads still exist')
const pending = [...hostShapes]
for (const href of groups) {
  if (pending.length === 0) break
  const response = await fetch(`${base}${href}`, { headers: withCookie })
  const groupCode = await response.text()
  for (const shape of [...pending]) {
    if (shape.pattern.test(groupCode)) {
      check(`the served modules still produce ${shape.what}`, true)
      pending.splice(pending.indexOf(shape), 1)
    }
  }
}
for (const shape of pending) check(`the served modules still produce ${shape.what}`, false, 'not found in any module group')

console.log(failures === 0
  ? '\n全部通过：运行中的实例正在下发本插件的当前代码（浏览器刷新即可生效）。'
  : `\n${failures} 项失败。`)
process.exit(failures === 0 ? 0 : 1)
