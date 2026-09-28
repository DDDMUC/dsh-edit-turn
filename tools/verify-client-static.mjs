// Static verification of the browser half.
//
// The client bundle cannot be unit-tested the way the host half can: it is a
// classic `window.__ModuleLoader__` factory that needs React and a DOM. This
// runs it with minimal stubs and checks the failure modes that a browser would
// only reveal at runtime, plus the ones a reviewer would miss:
//
//   1. the slot registration actually happens, with the shape the host UI needs
//      (name, id, order, locale, inject) and a controller exposing the hooks the
//      overlay component reads;
//   2. every user-facing string the code can ask for exists in BOTH dictionaries
//      - including every error code the host can return;
//   3. every CSS class the code applies exists in the injected stylesheet;
//   4. the version string is identical in package.json, lib/index.js and
//      lib/client.js.
//
//   node tools/verify-client-static.mjs
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = join(dirname(fileURLToPath(import.meta.url)), '..')
const read = (relative) => readFileSync(join(HERE, relative), 'utf8')

const clientSource = read('lib/client.js')
const hostSource = read('lib/index.js')
const manifest = JSON.parse(read('package.json'))

let failures = 0
function check(label, condition, detail) {
  if (condition) console.log(`  ✓ ${label}`)
  else {
    failures += 1
    console.log(`  ✗ ${label}${detail === undefined ? '' : ` — ${detail}`}`)
  }
}

// --- 1. load the bundle with stubs -------------------------------------------

let factory
const styleTags = []
globalThis.window = {
  __ModuleLoader__: {
    load({ id, factory: loaded }) {
      check('the bundle registers under the bare package name', id === 'dsh-edit-turn', id)
      factory = loaded
    },
  },
}
globalThis.document = {
  querySelector: () => null,
  createElement: () => ({ dataset: {}, textContent: '' }),
  head: {
    appendChild: (tag) => {
      styleTags.push(tag)
    },
  },
}

const reactStub = { useEffect: () => {}, createElement: () => null }
const jsxStub = { jsx: () => null, jsxs: () => null, Fragment: Symbol('Fragment') }
const requireStub = (id) => {
  if (id === 'react') return reactStub
  if (id === 'react/jsx-runtime') return jsxStub
  if (id === '@deepseek-ai/dsh-client-ui-primitives') return { Modal: () => null, Button: () => null }
  throw new Error(`unexpected require(${id})`)
}

await import(pathToFileURL(join(HERE, 'lib/client.js')).href)
check('the bundle exposes a factory', typeof factory === 'function')
const moduleExports = factory(requireStub)

console.log('\n1. module shape and slot registration')
check('exports apply()', typeof moduleExports.apply === 'function')
check('declares its client dependencies', Array.isArray(moduleExports.inject) && moduleExports.inject.includes('slots'))
check('exports PLUGIN_VERSION', typeof moduleExports.PLUGIN_VERSION === 'string')
check('injects the stylesheet', styleTags.length === 1 && String(styleTags[0].dataset.pluginCss).includes('dsh-edit-turn'))

const dictionaries = []
const injections = []
const registrations = []
const effects = []
const clientCtx = {
  effect(fn, label) {
    effects.push(label)
    fn()
    return () => {}
  },
  locale: {
    register(namespace, dict) {
      dictionaries.push({ namespace, dict })
    },
  },
  slots: {
    inject(name, callback) {
      injections.push(name)
      callback()
    },
    register(definition, component) {
      registrations.push({ definition, component })
    },
  },
}
moduleExports.apply(clientCtx)

check('registers one locale dictionary', dictionaries.length === 1)
check('the dictionary carries zh and en', Boolean(dictionaries[0] && dictionaries[0].dict.zh && dictionaries[0].dict.en))
check('injects the per-session overlay slot', injections.includes('conversation.input.overlay'), injections.join(','))
check('injects the per-session overlay slot', injections.includes('conversation.input.overlay'), injections.join(','))
check('injects the official assistant-actions slot', injections.includes('conversation.chat.assistant-actions'), injections.join(','))

// Two entries, two injection points. Picked by name so adding a third entry does
// not silently re-point these checks at the wrong one.
const byName = (name) => registrations.find((item) => item.definition.name === name) || { definition: {} }
check('registers one entry per injection point', registrations.length === 2, `got ${registrations.length}`)
const registration = byName('conversation.input.overlay')
check('the overlay slot name matches its injection point', registration.definition.name === 'conversation.input.overlay')
check('the overlay entry has a stable id', registration.definition.id === 'edit-turn')
check('the overlay entry declares an order', typeof registration.definition.order === 'number')
check('the overlay entry is localised', registration.definition.locale === 'dsh-edit-turn')
check('the overlay entry renders a component', typeof registration.component === 'function')

// The reply entry belongs to the host's own assistant-actions strip, which is
// where every other action for a reply lives. Registered anywhere else puts the
// pencil in a different place from the platform's own buttons.
const replyEntry = byName('conversation.chat.assistant-actions')
check('the reply entry targets the official strip', replyEntry.definition.name === 'conversation.chat.assistant-actions')
check('the reply entry has a stable id', replyEntry.definition.id === 'edit-turn-reply')
check('the reply entry declares an order', typeof replyEntry.definition.order === 'number', 'order decides where it sits among the host buttons')
check('the reply entry is localised', replyEntry.definition.locale === 'dsh-edit-turn')
check('the reply entry renders a component', typeof replyEntry.component === 'function')
check(
  'the reply entry sits ahead of the host feedback entry',
  typeof replyEntry.definition.order !== 'number' || replyEntry.definition.order < 10,
  `order ${replyEntry.definition.order} vs the host feedback entry's 10`,
)
const replyInjected = replyEntry.definition.inject
  ? replyEntry.definition.inject('session-11111111-2222-4333-8444-555555555555')
  : {}
check('the reply entry receives the controller', typeof replyInjected.controller === 'object')
check('the reply entry receives the controller hook', typeof replyInjected.hooks.editTurn === 'object')

const injectedProps = registration.definition.inject('session-11111111-2222-4333-8444-555555555555')
check('inject() yields the controller', typeof injectedProps.controller === 'object')
check('inject() yields the controller hook', typeof injectedProps.hooks.editTurn === 'object')
for (const method of ['getSnapshot', 'subscribe', 'load', 'open', 'close', 'setDraft', 'review', 'back', 'confirm', 'dispose']) {
  check(`the controller exposes ${method}()`, typeof injectedProps.controller[method] === 'function')
}
const snapshot = injectedProps.controller.getSnapshot()
check('the initial snapshot is shaped as the component reads it', snapshot.hidden instanceof Map && snapshot.editable instanceof Map)
check('the initial revision is zero', snapshot.revision === 0)
check('the initial state is empty', snapshot.editing === null && snapshot.notice === null)
// The overlay reads named fields off this snapshot and branches on them, so a
// field that is missing from the initial value reads as `undefined` and slips
// past `=== null` guards. Pin the exact key set: adding a field requires
// updating this list, removing one breaks the build here rather than in the UI.
const EXPECTED_SNAPSHOT_KEYS = [
  'confirmStep',
  'confirming',
  'draft',
  'editable',
  'editing',
  'failure',
  'hidden',
  'loadError',
  'loaded',
  'notice',
  'pending',
  'replies',
  'repliesByMessage',
  'rerun',
  'revision',
  'revisions',
  'surfaceReady',
]
const actualSnapshotKeys = Object.keys(snapshot).sort()
check(
  'the initial snapshot exposes exactly the documented fields',
  JSON.stringify(actualSnapshotKeys) === JSON.stringify(EXPECTED_SNAPSHOT_KEYS),
  `got ${actualSnapshotKeys.join(',')}`,
)
// Every `t(\`prefix.${value}\`)` lookup must be safe for a missing value,
// otherwise the UI renders the raw key (e.g. "error.undefined").
const dynamicLookups = [...clientSource.matchAll(/\bt\(`([^`$]*)\$\{([^}]*)\}`\)/g)]
check('dynamic localised lookups are guarded, not raw', dynamicLookups.length === 0,
  dynamicLookups.map((match) => `t(\`${match[1]}${'${'}${match[2]}}\`)`).join(', '))
check('cleanup effects are registered', effects.length >= 2, `got ${effects.length}`)

// --- 2. localisation completeness --------------------------------------------

console.log('\n2. every user-facing string resolves in both languages')
const zh = dictionaries[0].dict.zh
const en = dictionaries[0].dict.en
const zhKeys = Object.keys(zh)
const enKeys = Object.keys(en)
check('zh and en define the same keys', zhKeys.length === enKeys.length && zhKeys.every((key) => key in en),
  `zh ${zhKeys.length} vs en ${enKeys.length}`)
const emptyValues = [...zhKeys, ...enKeys].filter((key) => !zh[key] || !en[key])
check('no key has an empty translation', emptyValues.length === 0, emptyValues.join(','))

// Literal lookups: t('action.edit'), t(`dialog.title.${mode}`) etc.
const literalKeys = new Set()
const dynamicPrefixes = new Set()
for (const match of clientSource.matchAll(/\bt\(\s*'([^']+)'\s*\)/g)) literalKeys.add(match[1])
for (const match of clientSource.matchAll(/\bt\(\s*`([^`$]*)\$\{/g)) dynamicPrefixes.add(match[1])
check('the bundle performs localised lookups', literalKeys.size + dynamicPrefixes.size > 0,
  `${literalKeys.size} literal / ${dynamicPrefixes.size} dynamic`)
const missingLiterals = [...literalKeys].filter((key) => !(key in zh))
check('every literal key exists in both dictionaries', missingLiterals.length === 0, missingLiterals.join(','))

// Every error code the host can return must have a message, because the client
// renders `error.<code>` straight from the response.
const hostCodes = new Set()
for (const match of hostSource.matchAll(/new HttpError\(\s*\d+\s*,\s*'([a-z-]+)'/g)) hostCodes.add(match[1])
for (const match of hostSource.matchAll(/code:\s*'([a-z-]+)'/g)) hostCodes.add(match[1])
check('the host error-code surface was discovered', hostCodes.size >= 5, [...hostCodes].join(','))
const unmappedCodes = [...hostCodes].filter((code) => !(`error.${code}` in zh))
check('every host error code has a message in zh', unmappedCodes.length === 0, unmappedCodes.join(','))
const unmappedEn = [...hostCodes].filter((code) => !(`error.${code}` in en))
check('every host error code has a message in en', unmappedEn.length === 0, unmappedEn.join(','))

// The codes the client itself publishes.
const clientCodes = new Set()
for (const match of clientSource.matchAll(/(?:failure|notice):\s*'([a-z-]+)'/g)) clientCodes.add(match[1])
for (const match of clientSource.matchAll(/(?:failure|notice)\s*=\s*'([a-z-]+)'/g)) clientCodes.add(match[1])
for (const match of clientSource.matchAll(/publish\(\{\s*failure:\s*'([a-z-]+)'/g)) clientCodes.add(match[1])
const unmappedClient = [...clientCodes].filter((code) => !(`error.${code}` in zh))
check('every client-published code has a message', unmappedClient.length === 0, unmappedClient.join(','))

// --- 3. stylesheet coverage ---------------------------------------------------

console.log('\n3. every class the code applies is styled')
const css = styleTags[0].textContent
const REQUIRED_CLASSES = [
  'dshet-action',
  'dshet-action-host',
  'dshet-row',
  'dshet-floating',
  'dshet-collapsing',
  'dshet-editor',
  'dshet-note',
  'dshet-warn',
  'dshet-error',
  'dshet-footer',
  'dshet-btn',
  'dshet-btn-primary',
  'dshet-notice',
]
for (const className of REQUIRED_CLASSES) {
  check(`.${className} is styled`, css.includes(`.${className}`))
}
const usedClasses = new Set([...clientSource.matchAll(/dshet-[a-z0-9-]+/g)].map((match) => match[0]))
const unstyled = [...usedClasses].filter((name) => !css.includes(`.${name}`) && !REQUIRED_CLASSES.includes(name))
if (unstyled.length > 0) console.log(`  · marker classes without their own rule (review): ${unstyled.join(', ')}`)
const hiddenSelector = '[data-dshet-hidden="1"]'
check('the row-hiding selector is present', css.includes(hiddenSelector))
check('the code sets the matching data attribute', clientSource.includes('dshetHidden'))

// A rolled-back row gives up its message, not its action bar: the platform's
// time / copy / delete buttons live in the same row, and displaying the row
// away took them with it. These two rules are what keep them, and neither can
// be seen by the DOM tests (they assert markers, not layout).
console.log('\n  — a hidden row keeps its action bar —')
check(
  'the stylesheet exempts rows that keep their bar',
  css.includes('[data-dshet-hidden="1"]:not([data-dshet-keep-actions])'),
  'the exemption is what stops the bar going away with the message',
)
check('the code marks the rows that keep their bar', clientSource.includes('dshetKeepActions'))
console.log('\n  — the fallback gutter keeps the pencil off the text —')
check(
  'the code reserves the gutter on the revision bubble',
  clientSource.includes('dshet-revision-action') && css.includes('.dshet-revision.dshet-revision-action'),
)
const revisionHost = /\.dshet-revision \.dshet-action-host\{[^}]*\}/.exec(css)?.[0] ?? ''
check('the revision action is pinned in that gutter', revisionHost.includes('inset-inline-end') && revisionHost.includes('top:6px'), revisionHost)
check(
  'the revision action is not centred over the bubble text',
  !revisionHost.includes('top:50%'),
  revisionHost,
)
// The bubble used to sit in a flex column, where `align-self` shrank it to its
// text; inside the row it is a block-level child, and without this it stretched
// into a pill as wide as the transcript.
const revisionRule = /\.dshet-revision\{[^}]*\}/.exec(css)?.[0] ?? ''
check(
  'the bubble is sized to its text, not to the row',
  revisionRule.includes('width:fit-content'),
  revisionRule,
)

// Where the two edit entries sit. Both belong to the row's own action group:
// the prompt pencil at the right end of the user bar, behind the clock and the
// copy button; the reply pencil at the left end of the reply strip, ahead of the
// copy button - which the host draws before the slot this entry is rendered
// into, so DOM position alone can never get it there.
console.log('\n  — each pencil sits where its row’s own actions sit —')
check(
  "the collapsed row's pencil joins the bar that survived",
  clientSource.includes('injectRowAction(row, editTarget, controller, t)'),
  'the rewritten prompt has to stay editable from its row, not from inside its own text',
)
check(
  'the collapsed row drops the pencil parked in its bubble',
  clientSource.includes('removeRowAction(bubble)'),
  'otherwise a roll back leaves two pencils for one message',
)
// A sibling plugin (dsh-delete-turn) appends its own button into the same bar
// whenever its pass runs, so DOM insertion order cannot hold the right end;
// this is what keeps the pencil last anyway.
check(
  'the row pencil sorts to the right end of its bar',
  /\.dshet-action-host\{[^}]*order:9/.test(css),
  'flex order, not DOM position - a sibling can append after us at any time',
)
// The pencil stands among the platform's own icons; our ink is a blue-grey and
// read as a different, "active" icon beside them. It has to take the platform
// label colours instead, on the same variable the platform's own actions use.
check(
  'the pencil borrows the platform icon colour',
  /\.dshet-action\{[^}]*color:var\(--dsw-alias-label-tertiary/.test(css),
  'otherwise it looks like a different kind of control than the copy next to it',
)
check(
  'the pencil darkens to the platform label colour on hover',
  /\.dshet-action:hover[^{]*\{[^}]*color:var\(--dsw-alias-label-primary/.test(css),
)
// The host can rebuild the row between mousedown and mouseup (it does so
// constantly while a turn streams), and then no click event ever fires - the
// button reads as dead. The actions ride on pointerdown so the press itself
// counts; the click path stays for the keyboard.
console.log('\n  — a press counts, even when the row is rebuilt under it —')
check(
  'the editor buttons are wired through the press helper',
  clientSource.includes('pressable(cancel,') && clientSource.includes('pressable(submit,'),
  'a click split across a re-render otherwise evaporates',
)
check(
  'the injected pencils are wired through the press helper too',
  clientSource.includes('pressable(button, () => controller.open(entry.target))'),
)
check(
  'the helper is wired once per button, not once per pass',
  clientSource.indexOf('pressable(button,') < clientSource.indexOf('entry.target = target'),
  're-wiring resets the guard between the press and the click it swallows',
)

// A rolled-back turn leaves its tail (duration, usage, actions) behind. The
// tail is not a message row: keeping its strip, right for a message, stacked
// one empty strip per edit and pushed the conversation down the page.
console.log('\n  — a rolled-back turn tail does not stack empty strips —')
check(
  'a turn tail is hidden whole, not collapsed around its strip',
  clientSource.includes("row.getAttribute('data-chat-flow-kind') === 'turn-tail'") &&
    clientSource.includes('const keepsStrip = isTail ? false : collapseRowContent(row, true)'),
  'without this every reply edit leaves another orphan strip above the answer',
)
check(
  'a tail hidden with keep-actions by an older pass is cleaned up',
  clientSource.includes('delete row.dataset.dshetKeepActions'),
  'the attribute would otherwise keep the row visible forever',
)

// The host re-renders the row freely; taking focus whenever the box is rebuilt
// is what pulled the caret out of the composer, so typing anywhere else stopped
// working while an editor was open.
console.log('\n  — the editor takes focus only when it should —')
check(
  'a rebuild refocuses only a fresh box or one that was being typed in',
  clientSource.includes('(fresh || wasFocused)'),
  'an unconditional focus() steals the caret from the composer on every re-render',
)
check(
  'the caret intent is released by pressing outside, not by blur',
  clientSource.includes("document.addEventListener('pointerdown'") &&
    clientSource.includes('controller.editorFocus = false'),
  'a host rebuild or a temporary disable also blurs, and treating that as "the user left" dropped the caret for good',
)
check(
  'the rebuilt box restores the caret, not the end of the text',
  clientSource.includes('const [start, stop] = caret === null ? [end, end] : caret'),
)

// The editor must not live inside the React-managed row: an input in a subtree
// the host rebuilds loses drag selection, IME composition and clicks piece by
// piece. It is hosted on a body-level layer instead.
console.log('\n  — the editor is hosted above the host tree —')
check(
  'the box lives on a layer pinned to the body',
  clientSource.includes("editorLayer.className = 'dshet-layer'") &&
    clientSource.includes('document.body.appendChild(editorLayer)'),
)
check(
  'the layer is inert, only the box takes pointer events',
  /\.dshet-layer\{[^}]*pointer-events:none/.test(css) &&
    /\.dshet-layer \.dshet-editor\{[^}]*pointer-events:auto/.test(css),
)
check(
  'the row check consults the controller, not the row',
  clientSource.includes('controller.editorBox !== null && controller.editorBox.isConnected === true'),
  'querying the row would rebuild the editor every time the host wipes it',
)
check(
  'the box is repositioned when the page scrolls or resizes',
  clientSource.includes("document.addEventListener('scroll', keepPlaced") &&
    clientSource.includes("window.addEventListener('resize', keepPlaced)"),
)

// The editor is an input box, not a fixed five-line slab: it grows with the
// text, and the keyboard habits from every other editor work.
console.log('\n  — the editor behaves like an input box —')
check(
  'the textarea grows with its content',
  clientSource.includes('function fitEditorHeight') && clientSource.includes('fitEditorHeight(area)'),
  'a fixed rows height leaves a two-line edit floating in half an empty box',
)
check(
  'the manual resize grip is gone and the box is block-level',
  /\.dshet-editor textarea\{[^}]*display:block[^}]*resize:none/.test(css),
  'the grip fights the auto-fit, and inline-block leaves a baseline gap',
)
check(
  'Enter acts, Shift+Enter breaks the line, Escape leaves',
  clientSource.includes("event.key === 'Enter' && event.shiftKey !== true") &&
    clientSource.includes("event.key === 'Escape'"),
)
check(
  'a composition owns its Enter, in both shapes the engines send it',
  clientSource.includes('event.isComposing === true || event.keyCode === 229'),
  'the commit-Enter of an IME can arrive with isComposing false and keyCode 229 - the platform guards both, and missing the second half saved on every 拼音 candidate pick',
)
check(
  'the box is not relaid out mid-composition',
  clientSource.includes("if (event.isComposing === true) return") &&
    clientSource.includes("area.addEventListener('compositionend'"),
  'moving the field under the candidate window is how a box eats pinyin',
)
// The box is the platform composer's shape: one rounded container, a bare
// transparent input inside it, focus shown on the container, actions bottom-right.
const editorAreaRule = /\.dshet-editor textarea\{[^}]*\}/.exec(css)?.[0] ?? ''
check(
  'the container is the composer shape',
  /\.dshet-editor\{[^}]*border-radius:16px/.test(css) &&
    /\.dshet-editor:focus-within\{/.test(css) &&
    editorAreaRule.includes('background:transparent') &&
    editorAreaRule.includes('border:0') &&
    /\.dshet-footer\{[^}]*justify-content:flex-end/.test(css),
  editorAreaRule,
)
check(
  'the reply pencil is pulled ahead of the strip',
  clientSource.includes('dshet-reply-action') && css.includes('.dshet-reply-action{order:-1}'),
  'the host renders the copy button before the slot this entry lands in',
)

// A skin is free to make the theme's surface colours translucent - that is what
// it is for - and it only compensates for its own elements. A plugin panel that
// borrows those variables can therefore end up painted with a fully transparent
// colour and become unreadable over the artwork, which is exactly what happened.
// These checks pin the self-contained surface.
console.log('\n  — readable under any skin —')
check('the panel defines its own surface variables', css.includes('--dshet-panel:') && css.includes('--dshet-field:'))
check('a dark-theme branch exists', css.includes('body[data-ds-dark-theme]'))
const borrowedSurfaces = [...css.matchAll(/background:\s*var\(--dsw-alias-bg-[a-z0-9-]+/g)].map((match) => match[0])
check('no surface is borrowed from a skin-mutable theme variable', borrowedSurfaces.length === 0, borrowedSurfaces.join(', '))
// The textarea itself is transparent now - that is the composer shape - so the
// surface that has to stay opaque moved one level out, to the container that
// paints behind it. A transparent input on top of a transparent container is
// what made the text sit straight on the skin's artwork.
const editorContainerRule = [...css.matchAll(/\.dshet-editor\{[^}]*\}/g)].map((match) => match[0]).find((rule) => rule.includes('background:var(--dshet-panel)')) ?? ''
check(
  'the box behind the transparent textarea paints its own surface',
  editorContainerRule.includes('background:var(--dshet-panel)') &&
    !/\.dshet-editor\{[^}]*background:[^;}]*transparent/.test(css),
  editorContainerRule,
)
check('the panel blurs what is behind it', css.includes('backdrop-filter'))
const definedVars = new Set([...css.matchAll(/(--dshet-[a-z0-9-]+)\s*:/g)].map((match) => match[1]))
const usedVars = new Set([...css.matchAll(/var\((--dshet-[a-z0-9-]+)/g)].map((match) => match[1]))
const undefinedVars = [...usedVars].filter((name) => !definedVars.has(name))
check('every --dshet-* variable used is defined', undefinedVars.length === 0, undefinedVars.join(', '))
const darkBlock = /body\[data-ds-dark-theme\]\{([^}]*)\}/.exec(css)?.[1] ?? ''
const mustFlip = ['--dshet-panel', '--dshet-field', '--dshet-ink', '--dshet-ink-dim', '--dshet-line', '--dshet-shadow']
const missingInDark = mustFlip.filter((name) => !darkBlock.includes(`${name}:`))
check('the dark branch overrides every surface variable that must flip', missingInDark.length === 0, missingInDark.join(', '))

// --- 4. version sync ----------------------------------------------------------

console.log('\n4. version is identical in all three places')
const hostVersion = /export const PLUGIN_VERSION = '([^']+)'/.exec(hostSource)[1]
const clientVersion = /const PLUGIN_VERSION = '([^']+)'/.exec(clientSource)[1]
check('package.json and lib/index.js agree', manifest.version === hostVersion, `${manifest.version} vs ${hostVersion}`)
check('package.json and lib/client.js agree', manifest.version === clientVersion, `${manifest.version} vs ${clientVersion}`)
check('the client exports the version it declares', moduleExports.PLUGIN_VERSION === manifest.version)

// --- 5. host/client contract --------------------------------------------------

console.log('\n5. host and client agree on the wire contract')
const routePrefix = /const ROUTE_PREFIX = '([^']+)'/.exec(clientSource)[1]
check('the client talks to the host route prefix', hostSource.includes(`const ROUTE_PREFIX = '${routePrefix}'`), routePrefix)
check('the client calls the state route', clientSource.includes('${ROUTE_PREFIX}/state'))
check('the client calls the apply route', clientSource.includes('${ROUTE_PREFIX}/apply'))
for (const field of ['sessionId', 'shadowed', 'applied', 'turns', 'replies', 'kind', 'hidden', 'config']) {
  check(`the host returns "${field}"`, hostSource.includes(field))
}
// The mapping a sibling plugin follows to a rewritten message's live node, in
// the same field names the apply response already published.
check(
  'the state route publishes the replacement ledger',
  hostSource.includes('revisions: ledger.edits') && hostSource.includes('replacementSeq: replacement.seq'),
)
// A sibling plugin warned that the marker must land on EVERY replacement, so it
// can recognise them without inferring from the window shape alone.
check(
  'every replacement event carries source.editedBy',
  (hostSource.match(/editedBy: PLUGIN_ID/g) ?? []).length >= 3,
  String((hostSource.match(/editedBy: PLUGIN_ID/g) ?? []).length),
)
// "The button does nothing" is undiagnosable without knowing whether the click
// ever reached the host; the request ring now records apply attempts too.
check(
  'the apply route records what it was asked for',
  hostSource.includes("kind: 'apply'") && hostSource.includes('kind: \'state\''),
)

// Nothing in the contract above says what the client does with the answer to a
// save, and what it did was leave the rewritten message off the screen: the
// row collapsed, the standing-in bubble was never built, and no later request
// corrected the view. These pin the three things that keep it there.
console.log('\n  — a save never leaves the transcript without its message —')
check(
  'the save records which message stands in for the old one',
  /revisions\.set\(\s*seq,\s*data\.replacementSeq\s*\)/.test(clientSource),
  'without the mapping renderRevision has nothing to look up',
)
check(
  'the save re-reads the host state',
  clientSource.includes('await this.load(true)'),
  'the optimistic view is not allowed to outlive the request that produced it',
)
check(
  'a refresh waits for the one already running',
  clientSource.includes('this.inflight.then(() => this.load(force))'),
  'or it can be answered by a snapshot taken before the save',
)
check(
  'a hidden message keeps its row until its replacement is drawn',
  clientSource.includes('hidden && canHide'),
  'the row must not collapse with nothing standing in for it',
)

// The bubble used to be planted after the row, so the collapsed row's own
// timestamp and copy button ended up above the message that replaced it - the
// rewrite read as though the bar belonged to the next line. It now goes inside
// the row, ahead of the node that carries the bar.
console.log('\n  — the rewritten prompt sits where the message it replaced sat —')
check(
  'the bubble is planted inside the row, ahead of its action bar',
  clientSource.includes('placeRevisionBubble') &&
    /insertBefore\(\s*bubble,\s*before\s*\)/.test(clientSource) &&
    !clientSource.includes('row.after(bubble)'),
  'planting it after the row puts the time and the copy above the message',
)
check(
  'the collapse cannot take the standing-in bubble down with it',
  clientSource.includes("child.classList.contains('dshet-revision')"),
  'once the bubble is inside the row, the walk that empties the row must skip it',
)

console.log(failures === 0 ? '\n全部通过：客户端半部静态检查通过。' : `\n${failures} 项失败。`)
process.exit(failures === 0 ? 0 : 1)
