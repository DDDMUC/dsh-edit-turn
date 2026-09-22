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
check('registers exactly one overlay entry', registrations.length === 1)
const registration = registrations[0] || { definition: {} }
check('the slot name matches the injection point', registration.definition.name === 'conversation.input.overlay')
check('the entry has a stable id', registration.definition.id === 'edit-turn')
check('the entry declares an order', typeof registration.definition.order === 'number')
check('the entry is localised', registration.definition.locale === 'dsh-edit-turn')
check('the entry renders a component', typeof registration.component === 'function')

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
  'revision',
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
  'dshet-editor-title',
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
check('the textarea is never left transparent', !/textarea\{[^}]*background:[^;}]*transparent/.test(css))
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
for (const field of ['sessionId', 'shadowed', 'promptAccepted', 'turns', 'hidden', 'config']) {
  check(`the host returns "${field}"`, hostSource.includes(field))
}

console.log(failures === 0 ? '\n全部通过：客户端半部静态检查通过。' : `\n${failures} 项失败。`)
process.exit(failures === 0 ? 0 : 1)
