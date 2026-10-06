// Behavioural tests for the browser half, against a small DOM implementation.
//
// The static checker proves the bundle is shaped correctly; it cannot see what
// happens when a button is clicked. Two shipped defects lived exactly there:
// the notice banner printed `error.undefined`, and the editor's re-render marker
// only tracked the target seq, so the save button never advanced to the
// confirmation step and the editor became a dead end.
//
// This file drives the real `OverlayEntry` component - the real controller, the
// real DOM code - against a DOM stub, and asserts what a user would see and what
// the network would receive. No browser, no React, no DSH server, no tokens.
//
//   node --test "test/*.test.js"
import assert from 'node:assert/strict'
import { test } from 'node:test'

// --- a DOM small enough to read, complete enough to run the plugin ----------

/** `dshetRevisionFor` -> `data-dshet-revision-for`: what the DOM does to a dataset key. */
function attributeName(key) {
  return `data-${String(key).replace(/[A-Z]/g, (char) => `-${char.toLowerCase()}`)}`
}

class StubElement {
  constructor(tag) {
    this.tagName = String(tag).toUpperCase()
    this.children = []
    this.parentElement = null
    // `dataset.x` and `data-x` are the same thing in the DOM, and the plugin
    // relies on that: it marks a pencil through dataset and finds it again with
    // an attribute selector. Two detached objects here would hide that contract.
    // Deletion is part of that contract too: `delete el.dataset.x` removes the
    // attribute, so a sweep that selects by attribute cannot still see a node
    // the plugin has already given up.
    this.dataset = new Proxy(
      {},
      {
        set: (target, key, value) => {
          target[key] = value
          this.attributes[attributeName(key)] = String(value)
          return true
        },
        deleteProperty: (target, key) => {
          delete target[key]
          delete this.attributes[attributeName(key)]
          return true
        },
      },
    )
    this.style = {}
    this.attributes = {}
    this.listeners = new Map()
    this._classes = new Set()
    this._text = ''
    this.value = ''
    this.disabled = false
    this.innerHTML = ''
  }

  get classList() {
    const set = this._classes
    return {
      add: (...names) => names.forEach((name) => set.add(name)),
      remove: (...names) => names.forEach((name) => set.delete(name)),
      contains: (name) => set.has(name),
    }
  }

  get className() {
    return [...this._classes].join(' ')
  }

  set className(value) {
    this._classes = new Set(String(value).split(/\s+/).filter(Boolean))
  }

  get textContent() {
    return this._text
  }

  set textContent(value) {
    this._text = String(value)
    this.children = []
  }

  appendChild(child) {
    // The DOM moves an attached node; a stub that leaves it in its old parent
    // makes the same object appear twice in the tree and hides real bugs.
    if (child.parentElement !== null && child.parentElement !== this) {
      const siblings = child.parentElement.children
      const index = siblings.indexOf(child)
      if (index !== -1) siblings.splice(index, 1)
    }
    child.parentElement = this
    this.children.push(child)
    return child
  }

  /** DOM semantics: moves an existing child, and appends when the reference is null. */
  insertBefore(child, reference) {
    if (child.parentElement !== null) {
      const index = child.parentElement.children.indexOf(child)
      if (index !== -1) child.parentElement.children.splice(index, 1)
    }
    const at = reference === null || reference === undefined ? this.children.length : this.children.indexOf(reference)
    child.parentElement = this
    this.children.splice(at === -1 ? this.children.length : at, 0, child)
    return child
  }

  /** Same, for the revision bubble the plugin plants right after a rewritten row. */
  get nextElementSibling() {
    if (this.parentElement === null) return null
    const siblings = this.parentElement.children
    const index = siblings.indexOf(this)
    return index === -1 || index === siblings.length - 1 ? null : siblings[index + 1]
  }

  /**
   * The mirror of the above, for the bubble planted *before* a rewritten row:
   * that is where it goes when the row has no action bar to keep alive, so
   * displaying the row away cannot take the message with it.
   */
  get previousElementSibling() {
    if (this.parentElement === null) return null
    const siblings = this.parentElement.children
    const index = siblings.indexOf(this)
    return index <= 0 ? null : siblings[index - 1]
  }

  /** Insert a sibling right after this node: how the revision bubble is planted. */
  after(sibling) {
    if (this.parentElement === null) return
    const siblings = this.parentElement.children
    const index = siblings.indexOf(this)
    if (index === -1) return
    const existing = siblings.indexOf(sibling)
    if (existing !== -1) siblings.splice(existing, 1)
    sibling.parentElement = this.parentElement
    this.parentElement.children.splice(index + 1, 0, sibling)
  }

  /** The plugin positions its action relative to a sibling, so this has to exist. */
  get nextSibling() {
    if (this.parentElement === null) return null
    const siblings = this.parentElement.children
    const index = siblings.indexOf(this)
    return index === -1 || index === siblings.length - 1 ? null : siblings[index + 1]
  }

  remove() {
    if (this.parentElement === null) return
    const index = this.parentElement.children.indexOf(this)
    if (index !== -1) this.parentElement.children.splice(index, 1)
    this.parentElement = null
  }

  setAttribute(name, value) {
    this.attributes[name] = String(value)
    // The DOM reflects a `data-*` attribute into `dataset` as well, and this
    // plugin reads those markers both ways (it writes through `dataset` and
    // finds the node again by attribute). A stub that only reflected one way
    // would make a fixture built with `setAttribute('data-dsrr-action', ...)`
    // invisible to a `dataset.dsrrAction` lookup - which is a difference no
    // browser has.
    if (name.startsWith('data-')) {
      const key = name.slice(5).replace(/-([a-z0-9])/g, (_match, char) => char.toUpperCase())
      this.dataset[key] = String(value)
    }
  }

  getAttribute(name) {
    return name in this.attributes ? this.attributes[name] : null
  }

  /** Attribute presence: what a hide-attribution guard asks the DOM. */
  hasAttribute(name) {
    return name in this.attributes
  }

  addEventListener(type, handler, options) {
    const list = this.listeners.get(type) ?? []
    const capture = options === true || (options !== null && options !== undefined && options.capture === true)
    list.push({ handler, capture })
    this.listeners.set(type, list)
  }

  /**
   * Dispatch on this element.
   *
   * The real DOM runs a capture phase from the root down and a bubble phase back
   * up, and React listens for clicks at the root, in the bubble phase. That split
   * is what the plugin relies on when it answers a platform button's press (its
   * listener is registered with `capture: true` and calls `stopPropagation()`),
   * so the two phases are modelled: capture listeners run first, bubble listeners
   * after, and a stopped event reaches neither the later ones nor the element's
   * own `onclick`.
   */
  fire(type, extra = {}) {
    let stopped = false
    const event = {
      type,
      preventDefault() {},
      stopPropagation() {
        stopped = true
      },
      ...extra,
    }
    const handlers = this.listeners.get(type) ?? []
    const run = (item) => {
      if (!stopped) item.handler(event)
    }
    for (const item of handlers) if (item.capture === true) run(item)
    // Both wiring styles are in use: `el.onclick = fn` on the injected actions,
    // `addEventListener` on the editor's textarea.
    const property = this[`on${type}`]
    if (typeof property === 'function' && !stopped) property(event)
    for (const item of handlers) if (item.capture !== true) run(item)
    return event
  }

  getBoundingClientRect() {
    return { x: 0, y: 0, left: 0, top: 0, right: 100, bottom: 20, width: 100, height: 20 }
  }

  get isConnected() {
    let node = this
    while (node !== null && node !== undefined) {
      if (node === globalThis.document.body) return true
      node = node.parentElement
    }
    return false
  }

  focus() {
    this.focusCalls = (this.focusCalls ?? 0) + 1
  }

  setSelectionRange(start, end) {
    this.selectionStart = start
    this.selectionEnd = end
  }

  /** Every selector form the plugin uses on an element, lists included. */
  querySelector(selector) {
    const hits = walk(this).filter((node) => matchesAny(node, selector))
    return hits[0] ?? null
  }

  /** Same matcher, every hit: the fallback path counts the pencils in a bar. */
  querySelectorAll(selector) {
    return walk(this).filter((node) => matchesAny(node, selector))
  }

  /** Nearest ancestor (or self) matching the selector. */
  closest(selector) {
    let node = this
    while (node !== null && node !== undefined) {
      if (matchesAny(node, selector)) return node
      node = node.parentElement
    }
    return null
  }

  /** Element.matches, so the plugin can test the row element itself. */
  matches(selector) {
    return matchesAny(this, selector)
  }
}

/** Pre-order (document order) traversal: a stack would reverse every sibling list. */
function walk(root) {
  const out = []
  const visit = (node) => {
    for (const child of node.children) {
      out.push(child)
      visit(child)
    }
  }
  visit(root)
  return out
}

/**
 * A selector list is the union of its parts.
 *
 * The plugin namespaces its injected nodes with `[data-dshet-action-host="1"]`
 * and probes for them with an exact-value selector, plus a class fallback a
 * bundle older than this one left behind - one comma-separated query in the
 * browser, and therefore one here.
 */
function matchesAny(node, selector) {
  const parts = String(selector)
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean)
  return parts.some((part) => matches(node, part))
}

function matches(node, selector) {
  // `.class:not([attr])` - a class plus the absence of an attribute. The
  // fallback path uses it to tell its own pencil apart from the strip's.
  const negated = /^\.([\w-]+):not\(\[([\w-]+)\]\)$/.exec(selector)
  if (negated !== null) {
    const [, name, attr] = negated
    return node._classes.has(name) && !(attr in node.attributes)
  }
  if (selector.startsWith('.') && !selector.includes('[')) return node._classes.has(selector.slice(1))
  const contains = /^\[([a-z-]+)\*="([^"]+)"\]$/.exec(selector)
  if (contains !== null) {
    const [, attr, needle] = contains
    const value = attr === 'class' ? node.className : node.attributes[attr]
    return typeof value === 'string' && value.includes(needle)
  }
  // `[data-x="1"]` - the namespace attribute of an injected node.
  const valued = /^\[([a-z-]+)="([^"]*)"\]$/.exec(selector)
  if (valued !== null) return node.attributes[valued[1]] === valued[2]
  const exact = /^\[([a-z-]+)\]$/.exec(selector)
  if (exact !== null) return exact[1] in node.attributes
  return false
}

// --- harness ----------------------------------------------------------------

const SESSION_ID = 'session-11111111-2222-4333-8444-555555555555'
const ROW_KEY = 'row-1'

/**
 * The bundle registers its factory through `window.__ModuleLoader__` exactly
 * once per process, and ESM caching means a second `import()` never re-runs it.
 * Caching the factory is also what gives each test its own instance: calling it
 * builds fresh closures over the current stubs.
 */
let bundleFactory = null

/**
 * Load the bundle and return the registered overlay component plus its deps.
 *
 * `shared.document` reuses the page an earlier call built. That is the reload
 * case: the factory runs again - a genuinely new module instance with its own
 * closures, its own WeakMap and its own layer - over the DOM the previous
 * instance had already injected into, which is where the pencils used to stack.
 */
async function loadBundle(shared = null) {
  const reused = shared !== null && shared !== undefined && shared.document !== undefined
  const rows = []
  const documentListeners = new Map()
  const document = reused ? shared.document : {
    body: new StubElement('body'),
    head: new StubElement('head'),
    createElement: (tag) => new StubElement(tag),
    // The plugin watches document-level pointerdown to learn "the user pressed
    // outside the editor"; tests fire it through `fireDocument`.
    addEventListener(type, handler) {
      const list = documentListeners.get(type) ?? []
      list.push(handler)
      documentListeners.set(type, list)
    },
    removeEventListener(type, handler) {
      const list = documentListeners.get(type) ?? []
      documentListeners.set(type, list.filter((item) => item !== handler))
    },
    fireDocument(type, event) {
      for (const handler of documentListeners.get(type) ?? []) handler(event)
    },
    querySelector: (selector) => walk(document.body).find((node) => matchesAny(node, selector)) ?? null,
    querySelectorAll(selector) {
      const all = walk(document.body)
      if (selector === '[data-chat-flow-key]') return all.filter((node) => 'data-chat-flow-key' in node.attributes)
      return all.filter((node) => matchesAny(node, selector))
    },
  }
  globalThis.document = document
  // Where the platform's own clipboard writer lands, so a test can read back
  // what a press would have pasted. It hangs off the document because a reload
  // reuses the page, and both instances write into the same record.
  if (document.clipboard === undefined) document.clipboard = []
  const clipboard = document.clipboard
  const windowListeners = new Map()
  globalThis.window = {
    __ModuleLoader__: { load: ({ factory }) => { bundleFactory = factory } },
    setTimeout: (fn) => setTimeout(fn, 0),
    clearTimeout: (id) => clearTimeout(id),
    addEventListener(type, handler) {
      const list = windowListeners.get(type) ?? []
      list.push(handler)
      windowListeners.set(type, list)
    },
    removeEventListener(type, handler) {
      const list = windowListeners.get(type) ?? []
      windowListeners.set(type, list.filter((item) => item !== handler))
    },
  }
  globalThis.HTMLElement = StubElement
  globalThis.MutationObserver = class {
    observe() {}
    disconnect() {}
  }
  globalThis.requestAnimationFrame = (fn) => fn()

  // A React whose effects actually run, so the component's DOM pass happens.
  const react = {
    useEffect: (fn) => {
      const cleanup = fn()
      if (typeof cleanup === 'function') cleanups.push(cleanup)
    },
    // Read through the initialiser on every render: the component under test
    // subscribes to its own controller, and a fresh render must see the state
    // the test just published.
    useState: (init) => {
      const slot = { value: typeof init === 'function' ? init() : init }
      return [slot.value, (next) => { slot.value = next }]
    },
  }
  const cleanups = []
  // The runtime the host ships reads `config.key` without a null check, so a
  // `jsx(Type, null)` that a tolerant stub waved through threw in the browser,
  // the slot boundary caught it and the entry was abdicated for the whole page -
  // the pencil simply never appeared, with nothing in the console the user saw.
  // Fail here instead, on the same call the runtime would have made.
  const assertConfig = (type, props) => {
    if (props === null || props === undefined) {
      throw new TypeError(`Cannot read properties of ${props} (reading 'key')`)
    }
    return { type, props }
  }
  const jsx = assertConfig
  const jsxs = assertConfig
  const requireStub = (id) => {
    if (id === 'react') return react
    if (id === 'react/jsx-runtime') return { jsx, jsxs, Fragment: 'Fragment' }
    if (id === '@deepseek-ai/dsh-client-ui-primitives') return {
      // The platform's own clipboard write, which its copy button (and now this
      // plugin, on a rewritten row) calls. Same shape - a promise for "accepted" -
      // and it records the text where the real one would put it.
      writeClipboard: (text) => {
        clipboard.push(text)
        return Promise.resolve(true)
      },
    }
    throw new Error(`unexpected require(${id})`)
  }

  if (bundleFactory === null) await import(new URL('../lib/client.js', import.meta.url).href)
  const exports = bundleFactory(requireStub)

  const dictionaries = []
  const registrations = []
  // What the plugin asked to be cleaned up when it goes away. The host keeps
  // these and runs them when the fiber is disposed (a reload, a toggle), and the
  // harness does the same, so a test can play that unload.
  const effectDisposers = []
  const ctx = {
    effect: (fn) => {
      const cleanup = fn()
      if (typeof cleanup === 'function') effectDisposers.push(cleanup)
      return () => {}
    },
    locale: { register: (namespace, dict) => dictionaries.push({ namespace, dict }) },
    slots: {
      inject: (_name, callback) => callback(),
      register: (definition, component) => registrations.push({ definition, component }),
    },
  }
  exports.apply(ctx)

  // Picked by name, not by index: this plugin registers more than one entry, and
  // the order they were added in is not part of any contract.
  const overlay = registrations.find((entry) => entry.definition.name === 'conversation.input.overlay')
  if (overlay === undefined) throw new Error('the overlay entry was never registered')
  const { definition, component } = overlay
  const props = definition.inject(SESSION_ID)
  const dict = dictionaries[0].dict.zh
  // A key an entry's own namespace does not define resolves against the SHARED
  // `common` dictionary in the host (dsh-client-locale's `translate` does the
  // fallback). The platform's own copy button is labelled from there, so a
  // harness that stopped at the plugin's dictionary would read the key itself.
  const common = { copy: '复制', copied: '复制成功' }
  const t = (key) => (key in dict ? dict[key] : key in common ? common[key] : key)
  return {
    component,
    controller: props.controller,
    t,
    document,
    clipboard,
    cleanups,
    rows,
    fresh: () => cleanups.splice(0).forEach((fn) => fn()),
    // The plugin fiber going away: every disposer it registered runs, newest
    // first, the way the host disposes a fiber.
    dispose: () => effectDisposers.splice(0).reverse().forEach((fn) => fn()),
    registrations,
  }
}

/** One user row whose only editable target is seq 2. */
function mountRow(document, key = ROW_KEY) {
  const row = document.createElement('div')
  // `row.dataset` is left as the element's own (proxied) dataset: the plugin
  // marks a row it hides through `dataset`, and the sweep that takes that hide
  // back selects the row by the attribute that write produces. A fixture with a
  // plain object for a dataset would make that marker invisible to the query and
  // hide exactly the behaviour under test.
  row.setAttribute('data-chat-flow-key', key)
  const actions = document.createElement('span')
  actions.className = 'message_actions'
  row.appendChild(actions)
  document.body.appendChild(row)
  return row
}

/**
 * A user row shaped the way the platform actually ships one: a slot container,
 * a layout row, the message stack and the action bar as siblings of it.
 *
 * The class names are CSS-module hashes exactly as the browser sees them, which
 * is the point: the plugin may only rely on the stable `_actions` suffix, and a
 * fixture built out of plugin class names would prove nothing about that. The
 * idealised single-child row above cannot express "the message and the bar are
 * separate branches", which is what hiding a row has to get right.
 */
function mountHostUserRow(document, key = ROW_KEY) {
  const row = document.createElement('div')
  row.setAttribute('data-chat-flow-key', key)
  row.setAttribute('data-chat-flow-kind', 'user')

  const slot = document.createElement('div')
  slot.setAttribute('data-slot', 'conversation.chat.node')

  const layout = document.createElement('div')
  layout.className = 'Sixlwa_userRow'

  const stack = document.createElement('div')
  stack.className = 'Sixlwa_userStack'
  const bubble = document.createElement('div')
  bubble.className = 'Sixlwa_bubble'
  stack.appendChild(bubble)

  const bar = document.createElement('div')
  bar.className = 'xzv4MW_actions'
  const time = document.createElement('span')
  time.className = 'xzv4MW_timeStart'
  time.textContent = '9月25日 19:19'
  const copy = document.createElement('button')
  copy.className = 'xzv4MW_action'
  copy.setAttribute('aria-label', '复制')
  bar.appendChild(time)
  bar.appendChild(copy)

  layout.appendChild(stack)
  layout.appendChild(bar)
  slot.appendChild(layout)
  row.appendChild(slot)
  document.body.appendChild(row)
  return { row, stack, bubble, bar, time, copy }
}

const snapshotFor = (seq) => ({ nodes: new Map([[ROW_KEY, { kind: 'user', data: { seq }, anchorSeq: seq }]]) })

/** Render the component the way the slot runtime does, then return the DOM. */
function render(harness, controller, snapshot) {
  harness.fresh()
  harness.component({
    useChat: () => snapshot,
    useEditTurn: () => controller.getSnapshot(),
    controller,
    t: harness.t,
  })
}

const byClass = (root, className) => walk(root).filter((node) => node._classes.has(className))

/**
 * The bubble standing in for a rewritten prompt, wherever the plugin planted it.
 *
 * Normally it sits inside the row it replaced, ahead of the action bar; a row
 * with no bar to keep is displayed away entirely, so the bubble is then parked
 * before the row where hiding the row cannot take it.
 */
function revisionBubble(row) {
  const inside = row.querySelector('.dshet-revision')
  if (inside !== null) return inside
  const previous = row.previousElementSibling
  return previous !== null && previous.classList.contains('dshet-revision') ? previous : null
}

// The editor is hosted on a layer of its own (outside the message row, where
// the host's re-renders cannot reach it), so tests look it up in the document.
const editorIn = (harness) => harness.document.body.querySelector('.dshet-editor')

const editorText = (harness) => {
  const box = editorIn(harness)
  if (box === null) return null
  const buttons = byClass(box, 'dshet-btn')
  return { button: buttons[0] ? buttons[0].textContent : null, buttons: buttons.map((b) => b.textContent) }
}

async function readyController() {
  const harness = await loadBundle()
  mountRow(harness.document)
  const snapshot = snapshotFor(2)
  // The controller loads `/state` first; answer it with one editable turn.
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    json: async () => ({ ok: true, hidden: [], turns: [{ seq: 2, turn: 1, messageId: 'm-u1', text: 'original', attachments: 0 }], config: { confirm: true } }),
  })
  await harness.controller.load()
  render(harness, harness.controller, snapshot)
  // The first DOM pass sees a changed row count and refreshes; let it settle so
  // a later explicit load(true) is not answered by a stale in-flight request.
  await harness.controller.load()
  return { harness, controller: harness.controller, snapshot, row: harness.document.body.children[0] }
}

// --- tests ------------------------------------------------------------------

test('the edit action is injected onto the user row', async () => {
  const { row, harness } = await readyController()
  const actions = byClass(row, 'dshet-action')
  assert.equal(actions.length, 1, 'one edit action')
  assert.equal(actions[0].getAttribute('aria-label'), '编辑这条消息')
  // It is placed in the row's own action bar when the host UI has one.
  assert.equal(actions[0].parentElement.className, 'dshet-action-host')
  assert.equal(actions[0].parentElement.parentElement.className, 'message_actions')
  assert.equal(harness.document.body.children.length, 1)
})

test('no notice banner is rendered while nothing has failed', async () => {
  const { harness, controller, snapshot } = await readyController()
  const tree = harness.component({ useChat: () => snapshot, useEditTurn: () => controller.getSnapshot(), controller, t: harness.t })
  const found = JSON.stringify([tree], (key, value) => value).includes('dshet-notice')
  assert.equal(found, false, 'the notice div must not exist when notice is null')
})

test('clicking the action opens a prefilled in-place editor', async () => {
  const { harness, controller, snapshot, row } = await readyController()
  byClass(row, 'dshet-action')[0].fire('click')
  render(harness, controller, snapshot)
  assert.ok(editorIn(harness), 'the editor appears on the row')
  assert.deepEqual(editorText(harness).buttons, ['取消', '保存'])
  const area = walk(editorIn(harness)).find((node) => node.tagName === 'TEXTAREA')
  assert.equal(area.value, 'original', 'the original text is pre-filled')
  assert.equal(area.disabled, false)
})

test('a pointer press opens the pencil even if the host rebuilds the row under it', async () => {
  const { harness, controller, snapshot, row } = await readyController()
  const pencil = byClass(row, 'dshet-action')[0]
  // The press is the action, not the click that follows it: when the host
  // re-renders the row between mousedown and mouseup, the click never fires,
  // and from outside the button simply "does nothing".
  pencil.fire('pointerdown')
  render(harness, controller, snapshot)
  assert.ok(editorIn(harness), 'the editor appeared on the press')
  // The pass re-ran above (as it does on every snapshot) but the button keeps
  // its press guard, so the release-click on the same node must not open again
  // and reset the draft.
  const area = walk(editorIn(harness)).find((node) => node.tagName === 'TEXTAREA')
  area.value = 'already typing'
  area.fire('input')
  pencil.fire('click')
  render(harness, controller, snapshot)
  const again = walk(editorIn(harness)).find((node) => node.tagName === 'TEXTAREA')
  assert.equal(again.value, 'already typing', 'the swallowed click did not re-open the editor')
})

test('Enter acts, Shift+Enter breaks the line, Escape leaves', async () => {
  const { harness, controller, snapshot, row } = await readyController()
  byClass(row, 'dshet-action')[0].fire('pointerdown')
  render(harness, controller, snapshot)

  const area = walk(editorIn(harness)).find((node) => node.tagName === 'TEXTAREA')
  area.value = 'typed instead'
  area.fire('input')
  area.fire('keydown', { key: 'Enter', shiftKey: true })
  render(harness, controller, snapshot)
  assert.deepEqual(editorText(harness).buttons, ['取消', '保存'], 'Shift+Enter writes a newline, it does not save')
  // A composition in progress owns its Enter: committing Chinese/Japanese text
  // must never count as saving. Two shapes arrive - the conventional
  // `isComposing` one and the legacy `keyCode 229` one the platform also guards.
  area.fire('keydown', { key: 'Enter', isComposing: true })
  render(harness, controller, snapshot)
  assert.deepEqual(editorText(harness).buttons, ['取消', '保存'], 'a composing Enter does not save')
  area.fire('keydown', { key: 'Enter', keyCode: 229 })
  render(harness, controller, snapshot)
  assert.deepEqual(editorText(harness).buttons, ['取消', '保存'], 'the commit-Enter of an IME does not save either')

  area.fire('keydown', { key: 'Enter' })
  render(harness, controller, snapshot)
  assert.deepEqual(editorText(harness).buttons, ['取消', '确认执行'], 'Enter advances like the save button')

  const frozen = walk(editorIn(harness)).find((node) => node.tagName === 'TEXTAREA')
  frozen.fire('keydown', { key: 'Escape' })
  render(harness, controller, snapshot)
  assert.deepEqual(editorText(harness).buttons, ['取消', '保存'], 'Escape steps back out of the confirmation')

  const back = walk(editorIn(harness)).find((node) => node.tagName === 'TEXTAREA')
  back.fire('keydown', { key: 'Escape' })
  render(harness, controller, snapshot)
  assert.equal(editorIn(harness), null, 'Escape again closes the editor')
})

test('the editor box grows with its text instead of leaving an empty half', async () => {
  const { harness, controller, snapshot, row } = await readyController()
  byClass(row, 'dshet-action')[0].fire('pointerdown')
  render(harness, controller, snapshot)
  const area = walk(editorIn(harness)).find((node) => node.tagName === 'TEXTAREA')
  // A real browser measures the content; the stub reports one from a set height.
  area.scrollHeight = 120
  area.fire('input')
  assert.equal(area.style.height, '122px', 'the measured height is applied')
})

test('a rebuilt editor never steals focus from what the user is typing in', async () => {
  const { harness, controller, snapshot, row } = await readyController()
  byClass(row, 'dshet-action')[0].fire('pointerdown')
  render(harness, controller, snapshot)
  const first = walk(editorIn(harness)).find((node) => node.tagName === 'TEXTAREA')
  assert.equal(first.focusCalls, 1, 'opening the editor focuses it')

  // The user moves to the composer and the host re-renders the row: the box is
  // rebuilt, and it must not pull the caret back out of the composer.
  controller.editorFocus = false
  controller.publish({ failure: 'generic' })
  render(harness, controller, snapshot)
  const second = walk(editorIn(harness)).find((node) => node.tagName === 'TEXTAREA')
  assert.notEqual(second, first, 'the host re-render rebuilt the box')
  assert.equal(second.focusCalls ?? 0, 0, 'and the rebuild left the focus alone')
})

test('a rebuild mid-typing hands the focus back, at the caret', async () => {
  const { harness, controller, snapshot, row } = await readyController()
  byClass(row, 'dshet-action')[0].fire('pointerdown')
  render(harness, controller, snapshot)
  const first = walk(editorIn(harness)).find((node) => node.tagName === 'TEXTAREA')
  controller.editorFocus = true
  first.selectionStart = 1
  first.selectionEnd = 1

  controller.publish({ failure: 'generic' })
  render(harness, controller, snapshot)
  const second = walk(editorIn(harness)).find((node) => node.tagName === 'TEXTAREA')
  assert.equal(second.focusCalls, 1, 'the user was typing here, so the rebuild refocuses')
  assert.equal(second.selectionStart, 1, 'and the caret is where it was')
})

test('pressing the pencil again keeps what was typed', async () => {
  const { harness, controller, snapshot, row } = await readyController()
  const pencil = byClass(row, 'dshet-action')[0]
  pencil.fire('pointerdown')
  render(harness, controller, snapshot)
  const area = walk(editorIn(harness)).find((node) => node.tagName === 'TEXTAREA')
  area.value = 'half-written'
  area.fire('input')

  pencil.fire('pointerdown')
  render(harness, controller, snapshot)
  const again = walk(editorIn(harness)).find((node) => node.tagName === 'TEXTAREA')
  assert.equal(again.value, 'half-written', 're-opening the same edit must not reset the draft')
})

test('the editor leaves when the conversation view does', async () => {
  const { harness, controller, snapshot, row } = await readyController()
  byClass(row, 'dshet-action')[0].fire('pointerdown')
  render(harness, controller, snapshot)
  assert.ok(editorIn(harness), 'the editor is open')

  // The composer card - and this entry with it - unmounts: the user switched
  // to Settings. Nothing re-adds the editor afterwards, so it must clear up
  // after itself; left behind it floated over whatever came next.
  harness.fresh()
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.equal(editorIn(harness), null, 'the editor did not stay behind')
  assert.equal(byClass(harness.document.body, 'dshet-layer').length, 0, 'and neither did its layer')
})

test('a strayed revision bubble is reused, not duplicated', async () => {
  const harness = await loadBundle()
  const controller = harness.controller
  const host = mountHostUserRow(harness.document, 'row-stray')
  // A bubble for this row parked where the old lookup could not see it: not a
  // child of the row, and not its immediate previous sibling. The next pass
  // used to plant a second bubble next to it - two identical bubbles on screen.
  const stray = harness.document.createElement('div')
  stray.className = 'dshet-revision'
  stray.dataset.dshetRevisionFor = 'row-stray'
  harness.document.body.appendChild(stray)
  const spacer = harness.document.createElement('div')
  harness.document.body.appendChild(spacer)

  globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => revisedState() })
  await controller.load(true)
  render(harness, controller, { nodes: new Map([['row-stray', { kind: 'user', data: { seq: 2 }, anchorSeq: 2 }]]) })

  const bubbles = byClass(harness.document.body, 'dshet-revision')
  assert.equal(bubbles.length, 1, 'exactly one bubble for the row')
  assert.equal(bubbles[0], stray, 'the stray one was adopted rather than a second one planted')
  assert.equal(bubbles[0].textContent, 'revised prompt', 'and it carries the current wording')
})

test('rewriting the same prompt twice keeps the bubble and the pencil', async () => {
  const harness = await loadBundle()
  const controller = harness.controller
  const host = mountHostUserRow(harness.document, 'row-chain')
  // Two rewrites of one message: 2 -> 7, then 7 -> 9. The row stands for 2, so
  // a single hop lands on 7 - shadowed, no entry left - and the bubble and the
  // pencil used to disappear after the second save.
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      ok: true,
      hidden: [{ seq: 2, turn: 1, replacement: 7 }, { seq: 7, turn: 1, replacement: 9 }],
      turns: [{ seq: 9, turn: 1, messageId: 'm-u1', text: '改了两遍', attachments: 0 }],
      replies: [],
      config: { confirm: false },
    }),
  })
  await controller.load(true)
  const snapshot = { nodes: new Map([['row-chain', { kind: 'user', data: { seq: 2 }, anchorSeq: 2 }]]) }
  render(harness, controller, snapshot)

  const bubbles = byClass(harness.document.body, 'dshet-revision')
  assert.equal(bubbles.length, 1, 'the bubble is still drawn')
  assert.equal(bubbles[0].textContent, '改了两遍', 'showing the wording of the LAST rewrite')
  const pencil = byClass(host.row, 'dshet-action')[0]
  assert.ok(pencil, 'and the pencil is still there')

  pencil.fire('pointerdown')
  render(harness, controller, snapshot)
  const area = walk(editorIn(harness)).find((node) => node.tagName === 'TEXTAREA')
  assert.equal(area.value, '改了两遍', 'editing the head of the chain, not the shadowed one')
})

test('the pencil on a rewritten prompt still opens its editor', async () => {
  const harness = await loadBundle()
  const controller = harness.controller
  const host = mountHostUserRow(harness.document, 'row-rev')
  // revisedState: the prompt is rewritten, so the row is collapsed and its
  // pencil points at the revision - a replacement event, which no row covers.
  globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => revisedState() })
  await controller.load(true)
  render(harness, controller, { nodes: new Map([['row-rev', { kind: 'user', data: { seq: 2 }, anchorSeq: 2 }]]) })

  const pencil = byClass(host.row, 'dshet-action')[0]
  assert.ok(pencil, 'the collapsed row still carries the pencil')
  pencil.fire('pointerdown')
  render(harness, controller, { nodes: new Map([['row-rev', { kind: 'user', data: { seq: 2 }, anchorSeq: 2 }]]) })

  const box = editorIn(harness)
  assert.ok(box, 'pressing it opens the editor')
  const area = walk(box).find((node) => node.tagName === 'TEXTAREA')
  assert.equal(area.value, 'revised prompt', 'prefilled with the wording that stands in for it')
  assert.equal(box.parentElement.className, 'dshet-layer', 'and it is hosted on the layer')
})

test('a rolled-back turn tail disappears instead of stacking an empty strip', async () => {
  const harness = await loadBundle()
  const controller = harness.controller
  const host = mountHostUserRow(harness.document, 'row-keep')
  const tail = mountTurnTailRow(harness.document, 'row-tail')
  tail.row.setAttribute('data-chat-flow-kind', 'turn-tail')
  // The same state the keep-the-bar rule was pinned with: a rewritten prompt
  // stands in for the message, so the row may collapse.
  globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => revisedState() })
  await controller.load(true)
  const snapshot = {
    nodes: new Map([
      ['row-keep', { kind: 'user', data: { seq: 2 }, anchorSeq: 2 }],
      ['row-tail', { kind: 'turn-tail', anchorSeq: 2, data: { closing: { finalNode: { seq: 2 } } } }],
    ]),
  }
  render(harness, controller, snapshot)

  // The message row keeps its action bar: that is what the earlier fix pinned.
  assert.equal(host.row.dataset.dshetHidden, '1')
  assert.equal(host.row.dataset.dshetKeepActions, '1')
  assert.notEqual(host.row.style.display, 'none')
  // The turn tail has no message left to act on, so it goes away entirely.
  // Keeping it stacked one empty strip per edit and pushed the conversation
  // down the page on every save.
  assert.equal(tail.row.dataset.dshetHidden, '1')
  assert.equal(tail.row.dataset.dshetKeepActions, undefined, 'a tail must not keep its strip')
  assert.equal(tail.row.style.display, 'none', 'the whole tail row is hidden')
})

test('a host re-render of the row cannot take the editor with it', async () => {
  const { harness, controller, snapshot, row } = await readyController()
  byClass(row, 'dshet-action')[0].fire('pointerdown')
  render(harness, controller, snapshot)

  const box = editorIn(harness)
  assert.ok(box, 'the editor is open')
  assert.equal(box.parentElement.className, 'dshet-layer', 'it is hosted on its own layer')
  assert.equal(row.querySelector('.dshet-editor'), null, 'and not inside the row the host owns')
  const area = walk(box).find((node) => node.tagName === 'TEXTAREA')
  area.value = 'half-written'
  area.fire('input')
  controller.editorFocus = true

  // The host replaces the row's DOM wholesale - this used to wipe the editor
  // mid-gesture, which is what killed drag selection, IME and clicks.
  for (const child of [...row.children]) child.remove()
  render(harness, controller, snapshot)

  assert.equal(editorIn(harness), box, 'the same box is still there')
  assert.equal(area.value, 'half-written', 'with everything that was typed')
  assert.equal(area.focusCalls, 1, 'and it never had to be rebuilt')
})

test('a refused save gives the focus back to the rebuilt box', async () => {
  const { harness, controller, snapshot, row } = await readyController()
  byClass(row, 'dshet-action')[0].fire('pointerdown')
  render(harness, controller, snapshot)
  assert.equal(walk(editorIn(harness)).find((n) => n.tagName === 'TEXTAREA').focusCalls, 1)

  // In flight: the box is rebuilt disabled, so it cannot hold the focus.
  controller.publish({ pending: true })
  render(harness, controller, snapshot)
  // The host refuses the save: rebuilt again, enabled - the caret belongs here.
  controller.publish({ pending: false, failure: 'generic' })
  render(harness, controller, snapshot)
  const third = walk(editorIn(harness)).find((node) => node.tagName === 'TEXTAREA')
  assert.equal(third.focusCalls, 1, 'the rebuild after a refused save takes the focus back')
})

test('pressing outside the editor releases the caret', async () => {
  const { harness, controller, snapshot, row } = await readyController()
  byClass(row, 'dshet-action')[0].fire('pointerdown')
  render(harness, controller, snapshot)
  // The user presses somewhere else (the composer, a rename field, anywhere).
  harness.document.fireDocument('pointerdown', { target: harness.document.body })
  controller.publish({ failure: 'generic' })
  render(harness, controller, snapshot)
  const next = walk(editorIn(harness)).find((node) => node.tagName === 'TEXTAREA')
  assert.equal(next.focusCalls ?? 0, 0, 'the rebuild leaves the focus where the user put it')
})

test('the save button acts on the press, not only on a completed click', async () => {
  const { harness, controller, snapshot, row } = await readyController()
  byClass(row, 'dshet-action')[0].fire('pointerdown')
  render(harness, controller, snapshot)
  const submit = byClass(editorIn(harness), 'dshet-btn-primary')[0]
  submit.fire('pointerdown')
  render(harness, controller, snapshot)
  assert.deepEqual(editorText(harness).buttons, ['取消', '确认执行'], 'the press advanced to the confirmation step')
})

test('the opt-in confirmation step advances instead of doing nothing', async () => {
  const { harness, controller, snapshot, row } = await readyController()
  byClass(row, 'dshet-action')[0].fire('click')
  render(harness, controller, snapshot)

  const submit = byClass(editorIn(harness), 'dshet-btn-primary')[0]
  assert.equal(submit.textContent, '保存')
  submit.fire('click')
  render(harness, controller, snapshot)

  // This is the regression: the editor must be rebuilt for the new state.
  assert.deepEqual(editorText(harness).buttons, ['取消', '确认执行'])
  const area = walk(editorIn(harness)).find((node) => node.tagName === 'TEXTAREA')
  assert.equal(area.disabled, true, 'the draft is frozen during confirmation')
})

test('the confirmation click posts the revised text and closes on success', async () => {
  const { harness, controller, snapshot, row } = await readyController()
  const calls = []
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init })
    return { ok: true, status: 200, json: async () => ({ ok: true, shadowed: [2, 3], promptAccepted: true, replacementSeq: 9 }) }
  }

  byClass(row, 'dshet-action')[0].fire('click')
  render(harness, controller, snapshot)
  byClass(editorIn(harness), 'dshet-btn-primary')[0].fire('click')
  render(harness, controller, snapshot)
  byClass(editorIn(harness), 'dshet-btn-primary')[0].fire('click') // 确认回退
  await new Promise((resolve) => setTimeout(resolve, 0))
  render(harness, controller, snapshot)

  const applies = calls.filter((call) => call.url.includes('/apply'))
  const states = calls.filter((call) => call.url.includes('/state'))
  assert.equal(applies.length, 1, 'one save')
  assert.equal(states.length >= 1, true, 'and the save re-reads the host state')
  assert.equal(applies[0].url, '/dsh-edit-turn/apply')
  assert.equal(applies[0].init.method, 'POST')
  const body = JSON.parse(applies[0].init.body)
  assert.equal(body.sessionId, SESSION_ID)
  assert.equal(body.seq, 2)
  assert.equal(body.messageId, 'm-u1')
  assert.equal(body.text, 'original')
  assert.equal(editorIn(harness), null, 'the editor closes on success')
  assert.equal(controller.getSnapshot().pending, false)
})

test('a revised draft is what gets posted', async () => {
  const { harness, controller, snapshot, row } = await readyController()
  const bodies = []
  globalThis.fetch = async (url, init) => {
    if (String(url).includes('/state')) {
      // Keep the turn editable so the editor can open; only confirm is off.
      return { ok: true, status: 200, json: async () => ({ ok: true, hidden: [], turns: [{ seq: 2, turn: 1, messageId: 'm-u1', text: 'original', attachments: 0 }], config: { confirm: false } }) }
    }
    bodies.push(JSON.parse(init.body))
    return { ok: true, status: 200, json: async () => ({ ok: true, shadowed: [2], promptAccepted: true }) }
  }
  await controller.load(true)

  byClass(row, 'dshet-action')[0].fire('click')
  render(harness, controller, snapshot)
  const area = walk(editorIn(harness)).find((node) => node.tagName === 'TEXTAREA')
  area.value = 'revised text'
  area.fire('input')
  byClass(editorIn(harness), 'dshet-btn-primary')[0].fire('click')
  await new Promise((resolve) => setTimeout(resolve, 0))
  render(harness, controller, snapshot)

  assert.equal(bodies.length, 1)
  assert.equal(bodies[0].text, 'revised text')
})

test('one click applies directly on the default configuration', async () => {
  const { harness, controller, snapshot, row } = await readyController()
  const bodies = []
  globalThis.fetch = async (url, init) => {
    if (String(url).includes('/state')) {
      return { ok: true, status: 200, json: async () => ({ ok: true, hidden: [], turns: [{ seq: 2, turn: 1, messageId: 'm-u1', text: 'original', attachments: 0 }], config: { confirm: false } }) }
    }
    bodies.push(JSON.parse(init.body))
    return { ok: true, status: 200, json: async () => ({ ok: true, shadowed: [2], promptAccepted: true }) }
  }
  await controller.load(true)
  byClass(row, 'dshet-action')[0].fire('click')
  render(harness, controller, snapshot)
  byClass(editorIn(harness), 'dshet-btn-primary')[0].fire('click')
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.equal(bodies.length, 1, 'no confirmation step was configured')
})

test('an empty draft is refused with a message, not silently', async () => {
  const { harness, controller, snapshot, row } = await readyController()
  let posted = 0
  globalThis.fetch = async (url) => {
    if (String(url).includes('/dsh-edit-turn/apply')) posted += 1
    // The sibling probe must answer 404: no re-run button, and it is not a save.
    return { ok: false, status: 404, json: async () => ({ ok: false }) }
  }
  byClass(row, 'dshet-action')[0].fire('click')
  render(harness, controller, snapshot)
  const area = walk(editorIn(harness)).find((node) => node.tagName === 'TEXTAREA')
  area.value = '   '
  area.fire('input')
  byClass(editorIn(harness), 'dshet-btn-primary')[0].fire('click')
  render(harness, controller, snapshot)

  assert.equal(posted, 0, 'nothing is posted')
  const errors = byClass(editorIn(harness), 'dshet-error')
  assert.equal(errors.length, 1)
  assert.equal(errors[0].textContent, '改写后的内容不能为空。')
})

test('a host failure is shown in the editor and the button recovers', async () => {
  const { harness, controller, snapshot, row } = await readyController()
  globalThis.fetch = async () => ({ ok: false, status: 409, json: async () => ({ ok: false, code: 'busy', error: 'the session is still working' }) })
  byClass(row, 'dshet-action')[0].fire('click')
  render(harness, controller, snapshot)
  byClass(editorIn(harness), 'dshet-btn-primary')[0].fire('click')
  render(harness, controller, snapshot)
  byClass(editorIn(harness), 'dshet-btn-primary')[0].fire('click')
  await new Promise((resolve) => setTimeout(resolve, 0))
  render(harness, controller, snapshot)

  const errors = byClass(editorIn(harness), 'dshet-error')
  assert.equal(errors.length, 1)
  assert.equal(errors[0].textContent, '该会话正在回复中，请等回复结束后再编辑。')
  const submit = byClass(editorIn(harness), 'dshet-btn-primary')[0]
  assert.equal(submit.disabled, false, 'the user can retry')
  assert.equal(controller.getSnapshot().pending, false)
})

test('an unknown host code falls back instead of printing the raw key', async () => {
  const { harness, controller, snapshot, row } = await readyController()
  globalThis.fetch = async () => ({ ok: false, status: 500, json: async () => ({ ok: false, code: 'something-new' }) })
  byClass(row, 'dshet-action')[0].fire('click')
  render(harness, controller, snapshot)
  byClass(editorIn(harness), 'dshet-btn-primary')[0].fire('click')
  render(harness, controller, snapshot)
  byClass(editorIn(harness), 'dshet-btn-primary')[0].fire('click')
  await new Promise((resolve) => setTimeout(resolve, 0))
  render(harness, controller, snapshot)

  const errors = byClass(editorIn(harness), 'dshet-error')
  assert.equal(errors[0].textContent, '编辑失败，请重试。')
  assert.ok(!errors[0].textContent.includes('error.'))
})

test('a rollback whose re-run did not start reaches the user', async () => {
  const { harness, controller, snapshot, row } = await readyController()
  globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ ok: true, shadowed: [2], applied: false, applyError: 'the revised prompt was refused' }) })
  byClass(row, 'dshet-action')[0].fire('click')
  render(harness, controller, snapshot)
  byClass(editorIn(harness), 'dshet-btn-primary')[0].fire('click')
  render(harness, controller, snapshot)
  byClass(editorIn(harness), 'dshet-btn-primary')[0].fire('click')
  await new Promise((resolve) => setTimeout(resolve, 0))

  const tree = harness.component({ useChat: () => snapshot, useEditTurn: () => controller.getSnapshot(), controller, t: harness.t })
  const notice = JSON.stringify(tree).includes('dshet-notice')
  assert.equal(notice, true, 'the editor is gone, so the failure needs the banner')
  const snapshotNow = controller.getSnapshot()
  assert.equal(snapshotNow.notice, 'prompt')
  assert.equal(snapshotNow.editing, null)
  assert.equal(editorIn(harness), null)
})

test('a prompt created by a re-run becomes editable without a page reload', async () => {
  const { harness, controller, snapshot, row } = await readyController()
  const asked = []
  // The host now reports the revised prompt as editable and the old one hidden.
  globalThis.fetch = async (url) => {
    asked.push(String(url))
    return {
      ok: true,
      status: 200,
      json: async () => ({
        ok: true,
        hidden: [{ seq: 2, turn: 1 }],
        turns: [{ seq: 20, turn: 3, messageId: 'm-u3', text: 'revised prompt', attachments: 0 }],
        config: { confirm: true },
      }),
    }
  }
  // The re-run added a row to the transcript; that is the refresh signal.
  const second = mountRow(harness.document, 'row-2')
  const widened = {
    nodes: new Map([
      [ROW_KEY, { kind: 'user', data: { seq: 2 }, anchorSeq: 2 }],
      ['row-2', { kind: 'user', data: { seq: 20 }, anchorSeq: 20 }],
    ]),
  }
  render(harness, controller, widened)
  await new Promise((resolve) => setTimeout(resolve, 0))
  render(harness, controller, widened)

  assert.ok(asked.some((url) => url.includes('/state')), 'the client asked the host again')
  assert.equal(byClass(second, 'dshet-action').length, 1, 'the revised prompt offers an edit action')
  assert.equal(byClass(row, 'dshet-action').length, 0, 'the rolled-back prompt does not')
  assert.equal(row.dataset.dshetHidden, '1', 'the rolled-back row stays hidden')
  void snapshot
})

test('an unchanged row count does not re-ask the host', async () => {
  const { harness, controller, snapshot } = await readyController()
  const asked = []
  globalThis.fetch = async (url) => {
    asked.push(String(url))
    return { ok: true, status: 200, json: async () => ({ ok: true, hidden: [], turns: [], config: {} }) }
  }
  render(harness, controller, snapshot)
  render(harness, controller, snapshot)
  assert.equal(asked.length, 0, 'no redundant /state traffic while nothing changed')
})

// --- the reply entry, which lives in the official action strip ---------------

test('the reply edit entry is registered in the assistant-actions strip', async () => {
  const harness = await loadBundle()
  const entry = harness.registrations.find((item) => item.definition.name === 'conversation.chat.assistant-actions')
  assert.ok(entry, 'an assistant-actions entry is registered')
  assert.equal(entry.definition.id, 'edit-turn-reply')
  assert.equal(typeof entry.definition.order, 'number', 'order decides where it sits among the host buttons')
  // What the inject returns is what the component receives, plus the messageId
  // the host adds. It has to give the component its controller.
  const props = entry.definition.inject(SESSION_ID)
  assert.equal(typeof props.controller, 'object')
  assert.equal(typeof props.hooks.editTurn, 'object')
})

test('the reply entry draws a pencil only for an editable reply', async () => {
  const harness = await loadBundle()
  const controller = harness.controller
  const entry = harness.registrations.find((item) => item.definition.name === 'conversation.chat.assistant-actions')
  const props = entry.definition.inject(SESSION_ID)
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      ok: true,
      hidden: [],
      turns: [],
      replies: [{ seq: 5, turn: 1, messageId: 'm-a1', text: 'the original answer', attachments: 0 }],
      config: { confirm: false },
    }),
  })
  await controller.load(true)
  const useEditTurn = (select) => select(controller.getSnapshot())

  const unknown = entry.component({ ...props, messageId: 'm-other', useEditTurn, t: harness.t })
  assert.equal(unknown, null, 'a reply the host did not report renders nothing')

  const button = entry.component({ ...props, messageId: 'm-a1', useEditTurn, t: harness.t })
  assert.equal(button.type, 'button')
  assert.match(button.props.className, /dshet-action/)
  assert.match(button.props.className, /dshet-reply-action/,
    'the class whose flex order pulls the pencil ahead of the copy button')
  assert.equal(button.props['aria-label'], '编辑这条回答')

  button.props.onClick({ preventDefault() {}, stopPropagation() {} })
  const editing = controller.getSnapshot().editing
  assert.equal(editing.seq, 5, 'it opens the reply the host named')
  assert.equal(editing.mode, 'reply')
})

test('the editor still anchors under the reply, not under its action strip', async () => {
  const harness = await loadBundle()
  const controller = harness.controller
  const row = mountRow(harness.document, 'row-r')
  const snapshot = { nodes: new Map([['row-r', { kind: 'assistant-step', anchorSeq: 5, data: { finalNode: { seq: 5 } } }]]) }
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      ok: true,
      hidden: [],
      turns: [],
      replies: [{ seq: 5, turn: 1, messageId: 'm-a1', text: 'the original answer', attachments: 0 }],
      config: { confirm: false },
    }),
  })
  await controller.load(true)
  controller.open({ seq: 5, mode: 'reply', turn: 1, messageId: 'm-a1', text: 'the original answer', attachments: 0 })
  render(harness, controller, snapshot)

  const box = editorIn(harness)
  assert.ok(box, 'the editor appears in the row holding the reply text')
  const area = walk(box).find((node) => node.tagName === 'TEXTAREA')
  assert.equal(area.getAttribute('aria-label'), '编辑这条回答', 'the box names itself for assistive tech')
  assert.equal(area.value, 'the original answer')
  assert.deepEqual(editorText(harness).buttons, ['取消', '保存'])
})

test('a reply that carries tool calls warns before being replaced', async () => {
  const harness = await loadBundle()
  const controller = harness.controller
  const row = mountRow(harness.document, 'row-r')
  const snapshot = { nodes: new Map([['row-r', { kind: 'assistant-step', anchorSeq: 5, data: { finalNode: { seq: 5 } } }]]) }
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      ok: true,
      hidden: [],
      turns: [],
      replies: [{ seq: 5, turn: 1, messageId: 'm-a1', text: '我来查一下', attachments: 1 }],
      config: { confirm: false },
    }),
  })
  await controller.load(true)
  controller.open({ seq: 5, mode: 'reply', turn: 1, messageId: 'm-a1', text: '我来查一下', attachments: 1 })
  render(harness, controller, snapshot)
  assert.match(byClass(editorIn(harness), 'dshet-warn')[0].textContent, /工具调用或思考过程/)
})

test('a row the host does not report as editable gets no action', async () => {
  const harness = await loadBundle()
  const strayRow = mountRow(harness.document, 'row-stray')
  const controller = harness.controller
  const snapshot = { nodes: new Map([['row-stray', { kind: 'assistant-step', anchorSeq: 5, data: { finalNode: { seq: 5 } } }]]) }
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    json: async () => ({ ok: true, hidden: [], turns: [], replies: [], config: { confirm: false } }),
  })
  await controller.load(true)
  render(harness, controller, snapshot)
  assert.equal(byClass(strayRow, 'dshet-action').length, 0, 'no action without an editable entry')
})

// --- the fallback for a reply whose strip entry never renders ---------------

const turnTailSnapshot = (seq) => ({
  nodes: new Map([
    [
      ROW_KEY,
      { kind: 'turn-tail', anchorSeq: seq, data: { closing: { finalNode: { seq } } } },
    ],
  ]),
})

/** A turn-tail row shaped like the host's: marker element, strip as its child. */
function mountTurnTailRow(document, key = ROW_KEY) {
  const row = mountRow(document, key)
  const tailRoot = document.createElement('div')
  tailRoot.setAttribute('data-turn-tail', '1')
  const bar = document.createElement('span')
  bar.className = 'turn_tail_actions'
  tailRoot.appendChild(bar)
  row.appendChild(tailRoot)
  return { row, bar, tailRoot }
}

const replyState = () => ({
  ok: true,
  hidden: [],
  turns: [],
  replies: [{ seq: 5, turn: 1, messageId: 'm-a1', text: 'the original answer', attachments: 0 }],
  config: { confirm: false },
})

// --- the re-run button (owned by dsh-rerun-turn) -----------------------------

const pluginState = () => ({
  ok: true,
  status: 200,
  json: async () => ({
    ok: true,
    hidden: [],
    turns: [{ seq: 2, turn: 1, messageId: 'm-u1', text: 'original', attachments: 0 }],
    replies: [],
    config: { confirm: false },
  }),
})

test('the re-run button appears only when dsh-rerun-turn is mounted', async () => {
  const { harness, controller, snapshot, row } = await readyController()
  let sibling = { ok: false, status: 404, json: async () => ({ ok: false }) }
  globalThis.fetch = async (url) => (String(url) === '/dsh-rerun-turn/state' ? sibling : pluginState())
  byClass(row, 'dshet-action')[0].fire('pointerdown')
  await new Promise((resolve) => setTimeout(resolve, 0))
  render(harness, controller, snapshot)
  assert.deepEqual(editorText(harness).buttons, ['取消', '保存'], 'no sibling, no re-run button')

  // Mounted: its state route answers 400 without a sessionId, the way our own
  // loader probe does. The button shows up on the next pass.
  sibling = { ok: false, status: 400, json: async () => ({ ok: false }) }
  await controller.probeSiblingRerun()
  render(harness, controller, snapshot)
  assert.deepEqual(editorText(harness).buttons, ['取消', '重跑', '保存'])
})

test('re-run saves first, then re-runs that turn through the sibling', async () => {
  const harness = await loadBundle()
  const controller = harness.controller
  const host = mountHostUserRow(harness.document, 'row-rerun')
  const snapshot = { nodes: new Map([['row-rerun', { kind: 'user', data: { seq: 2 }, anchorSeq: 2 }]]) }
  const calls = []
  globalThis.fetch = async (url, init) => {
    const target = String(url)
    calls.push({ url: target, body: init && init.body })
    if (target === '/dsh-rerun-turn/state') return { ok: false, status: 400, json: async () => ({ ok: false }) }
    if (target.startsWith('/dsh-rerun-turn/state?sessionId=')) {
      // Two replies belong to the edited turn; the newest one is the target.
      return { ok: true, status: 200, json: async () => ({ ok: true, replies: [{ seq: 3, turn: 1 }, { seq: 9, turn: 1 }, { seq: 4, turn: 2 }] }) }
    }
    if (target === '/dsh-rerun-turn/apply') return { ok: true, status: 200, json: async () => ({ ok: true, started: true }) }
    if (target.includes('/dsh-edit-turn/apply')) {
      return { ok: true, status: 200, json: async () => ({ ok: true, kind: 'prompt', replacementSeq: 7, shadowed: [2], applied: true }) }
    }
    return pluginState()
  }
  await controller.load(true)
  render(harness, controller, snapshot)
  byClass(host.row, 'dshet-action')[0].fire('pointerdown')
  await new Promise((resolve) => setTimeout(resolve, 0))
  render(harness, controller, snapshot)
  const rerun = byClass(editorIn(harness), 'dshet-btn').find((button) => button.textContent === '重跑')
  assert.ok(rerun, 'the re-run button is there')

  rerun.fire('pointerdown')
  for (let attempt = 0; attempt < 20 && !calls.some((call) => call.url === '/dsh-rerun-turn/apply'); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0))
  }

  const applies = calls.filter((call) => call.url.includes('/apply')).map((call) => call.url)
  assert.deepEqual(applies, ['/dsh-edit-turn/apply', '/dsh-rerun-turn/apply'], 'save first, re-run second')
  const chained = calls.find((call) => call.url === '/dsh-rerun-turn/apply')
  assert.equal(JSON.parse(chained.body).seq, 9, "the turn's newest reply is the target the sibling reruns")
  assert.equal(JSON.parse(chained.body).sessionId, SESSION_ID)
})

test('a turn with no reply to re-run is saved with a notice, nothing else', async () => {
  const harness = await loadBundle()
  const controller = harness.controller
  const host = mountHostUserRow(harness.document, 'row-norerun')
  const snapshot = { nodes: new Map([['row-norerun', { kind: 'user', data: { seq: 2 }, anchorSeq: 2 }]]) }
  const calls = []
  globalThis.fetch = async (url, init) => {
    const target = String(url)
    calls.push(target)
    if (target === '/dsh-rerun-turn/state') return { ok: false, status: 400, json: async () => ({ ok: false }) }
    if (target.startsWith('/dsh-rerun-turn/state?sessionId=')) {
      return { ok: true, status: 200, json: async () => ({ ok: true, replies: [{ seq: 4, turn: 2 }] }) }
    }
    if (target === '/dsh-rerun-turn/apply') return { ok: true, status: 200, json: async () => ({ ok: true }) }
    if (target.includes('/dsh-edit-turn/apply')) {
      return { ok: true, status: 200, json: async () => ({ ok: true, kind: 'prompt', replacementSeq: 7, shadowed: [2], applied: true }) }
    }
    return pluginState()
  }
  await controller.load(true)
  render(harness, controller, snapshot)
  byClass(host.row, 'dshet-action')[0].fire('pointerdown')
  await new Promise((resolve) => setTimeout(resolve, 0))
  render(harness, controller, snapshot)
  byClass(editorIn(harness), 'dshet-btn').find((button) => button.textContent === '重跑').fire('pointerdown')
  for (let attempt = 0; attempt < 20 && controller.getSnapshot().notice === null; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
  assert.equal(controller.getSnapshot().notice, 'rerun-nothing', 'the save landed, the re-run did not')
  assert.equal(calls.includes('/dsh-rerun-turn/apply'), false, 'the sibling is never asked')
})

test('a failed save never asks the sibling to re-run', async () => {
  const harness = await loadBundle()
  const controller = harness.controller
  const host = mountHostUserRow(harness.document, 'row-failsave')
  const snapshot = { nodes: new Map([['row-failsave', { kind: 'user', data: { seq: 2 }, anchorSeq: 2 }]]) }
  const calls = []
  globalThis.fetch = async (url, init) => {
    const target = String(url)
    calls.push(target)
    if (target === '/dsh-rerun-turn/state') return { ok: false, status: 400, json: async () => ({ ok: false }) }
    if (target.includes('/dsh-edit-turn/apply')) {
      return { ok: false, status: 409, json: async () => ({ ok: false, code: 'stale' }) }
    }
    return pluginState()
  }
  await controller.load(true)
  render(harness, controller, snapshot)
  byClass(host.row, 'dshet-action')[0].fire('pointerdown')
  await new Promise((resolve) => setTimeout(resolve, 0))
  render(harness, controller, snapshot)
  byClass(editorIn(harness), 'dshet-btn').find((button) => button.textContent === '重跑').fire('pointerdown')
  for (let attempt = 0; attempt < 10; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 0))
  assert.equal(calls.some((target) => target.startsWith('/dsh-rerun-turn/state?sessionId=')), false,
    'the chain starts from a landed save only')
  assert.equal(controller.getSnapshot().failure, 'stale', 'and the refusal is shown as usual')
})

test('a reply edit offers no re-run button', async () => {
  const harness = await loadBundle()
  const controller = harness.controller
  const row = mountRow(harness.document, 'row-reply-rerun')
  const snapshot = { nodes: new Map([['row-reply-rerun', { kind: 'assistant-step', anchorSeq: 5, data: { finalNode: { seq: 5 } } }]]) }
  globalThis.fetch = async (url) => {
    if (String(url) === '/dsh-rerun-turn/state') return { ok: false, status: 400, json: async () => ({ ok: false }) }
    return {
      ok: true,
      status: 200,
      json: async () => ({ ok: true, hidden: [], turns: [], replies: [{ seq: 5, turn: 1, messageId: 'm-a1', text: 'the original answer', attachments: 0 }], config: { confirm: false } }),
    }
  }
  await controller.load(true)
  controller.open({ seq: 5, mode: 'reply', turn: 1, messageId: 'm-a1', text: 'the original answer', attachments: 0 })
  await new Promise((resolve) => setTimeout(resolve, 0))
  render(harness, controller, snapshot)
  assert.deepEqual(editorText(harness).buttons, ['取消', '保存'],
    'the reply bar already carries the sibling’s own button')
})

test('cancel closes the editor without posting', async () => {
  const { harness, controller, snapshot, row } = await readyController()
  let posted = 0
  globalThis.fetch = async (url) => {
    // Count our own saves only; the sibling probe is neither a save nor ours.
    if (String(url).includes('/dsh-edit-turn/apply')) posted += 1
    return { ok: false, status: 404, json: async () => ({ ok: false }) }
  }
  byClass(row, 'dshet-action')[0].fire('click')
  render(harness, controller, snapshot)
  byClass(editorIn(harness), 'dshet-btn')[0].fire('click') // 取消
  render(harness, controller, snapshot)
  assert.equal(editorIn(harness), null)
  assert.equal(controller.getSnapshot().editing, null)
  assert.equal(posted, 0)
})

// --- what the platform's own row looks like ----------------------------------

/** The /state a rolled-back prompt answers with: seq 2 hidden, seq 7 in its place. */
const revisedState = () => ({
  ok: true,
  hidden: [{ seq: 2, turn: 1, replacement: 7 }],
  turns: [{ seq: 7, turn: 1, messageId: 'm-u1', text: 'revised prompt', attachments: 0 }],
  replies: [],
  config: { confirm: false },
})

const plainState = () => ({
  ok: true,
  hidden: [],
  turns: [{ seq: 2, turn: 1, messageId: 'm-u1', text: 'original', attachments: 0 }],
  replies: [],
  config: { confirm: false },
})

test('the pencil joins the platform action bar and leaves its buttons alone', async () => {
  const harness = await loadBundle()
  const controller = harness.controller
  const host = mountHostUserRow(harness.document, 'row-host')
  const snapshot = { nodes: new Map([['row-host', { kind: 'user', data: { seq: 2 }, anchorSeq: 2 }]]) }
  globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => plainState() })
  await controller.load(true)
  render(harness, controller, snapshot)

  assert.equal(host.bar.children.length, 3, 'time, copy, pencil - nothing displaced')
  assert.equal(host.time.parentElement, host.bar, 'the timestamp stays in the bar')
  assert.equal(host.copy.parentElement, host.bar, 'the copy button stays in the bar')
  assert.equal(host.bar.children[2].className, 'dshet-action-host', 'the pencil sits after the last platform action')
  assert.ok(byClass(host.bar, 'dshet-action').length === 1, 'and it is inside the bar, not floating over the row')
  assert.equal(host.row._classes.has('dshet-row'), false, 'no floating overlay fallback was used')
})

test('a rolled-back row loses its message but keeps its action bar', async () => {
  const harness = await loadBundle()
  const controller = harness.controller
  const host = mountHostUserRow(harness.document, 'row-revised')
  const snapshot = { nodes: new Map([['row-revised', { kind: 'user', data: { seq: 2 }, anchorSeq: 2 }]]) }
  globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => revisedState() })
  await controller.load(true)
  render(harness, controller, snapshot)

  assert.equal(host.row.dataset.dshetHidden, '1', 'the original row is marked hidden')
  assert.equal(host.row.dataset.dshetKeepActions, '1', 'and told the stylesheet its bar survives')
  assert.notEqual(host.row.style.display, 'none', 'the row itself is not displayed away')
  assert.equal(host.stack.style.display, 'none', 'the superseded message is gone')
  assert.notEqual(host.bar.style.display, 'none', 'time / copy / delete stay reachable')
  assert.equal(host.copy.parentElement, host.bar, 'the platform buttons never move')

  // The rewrite goes back: the row has to come back with it. Let the refresh the
  // first render asked for finish first, or `load` short-circuits onto it.
  globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => plainState() })
  await new Promise((resolve) => setTimeout(resolve, 0))
  await controller.load(true)
  render(harness, controller, snapshot)
  assert.equal(host.row.dataset.dshetHidden, undefined, 'the marker is cleared')
  assert.equal(host.stack.style.display, '', 'the message is shown again')
  assert.equal(byClass(harness.document.body, 'dshet-revision').length, 0,
    'the revision bubble is gone with it')
})

// The collapsed row keeps its bar, so the rewrite stays editable from exactly
// where the user reads "this message's actions": after the clock and the copy
// button. Parking the pencil inside the bubble instead hid it behind a hover
// and put an action on top of the message text.
test('the revision pencil joins the bar that survived, at its right end', async () => {
  const harness = await loadBundle()
  const controller = harness.controller
  const host = mountHostUserRow(harness.document, 'row-gutter')
  const snapshot = { nodes: new Map([['row-gutter', { kind: 'user', data: { seq: 2 }, anchorSeq: 2 }]]) }
  globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => revisedState() })
  await controller.load(true)
  render(harness, controller, snapshot)

  const bubble = revisionBubble(host.row)
  assert.ok(bubble, 'the rewritten prompt renders in its own bubble')
  assert.equal(bubble.textContent, 'revised prompt', 'the text is intact')
  assert.equal(byClass(bubble, 'dshet-floating').length, 0,
    'no floating overlay inside the bubble - that is what covered the text')
  assert.equal(byClass(bubble, 'dshet-action').length, 0, 'the bubble carries the text, not the action')
  assert.equal(bubble._classes.has('dshet-revision-action'), false, 'so it reserves no gutter')

  assert.equal(host.bar.children.length, 3, 'time, copy, pencil')
  assert.equal(host.time.parentElement, host.bar, 'the timestamp stays where it was')
  assert.equal(host.copy.parentElement, host.bar, 'and so does the copy button')
  assert.equal(host.bar.children[2].className, 'dshet-action-host', 'the pencil sits after them, at the right end')
  assert.equal(byClass(host.bar, 'dshet-action').length, 1, 'one pencil, and it is in the bar')

  // Order, as the platform draws a message: text above, time and copy below it.
  // Planting the bubble after the row put the bar on top of the message, which
  // read as though the timestamp belonged to the next line.
  assert.equal(bubble.parentElement, host.row, 'the rewritten prompt stands inside the row it replaced')
  assert.equal(host.row.children[0], bubble, 'and ahead of the bar, not under it')
  assert.equal(bubble.dataset.dshetCollapsed, undefined, 'the collapse did not collapse the bubble itself')
  assert.notEqual(host.bar.style.display, 'none', 'while the bar it sits above still shows')
})

// The row is displayed away entirely when it has no action bar to keep, so a
// bubble planted inside it would go with it - the same hole the collapse fix
// closed for the bar, one layer down. The bubble then stands before the row.
test('a row with no bar to keep still shows the rewritten prompt', async () => {
  const harness = await loadBundle()
  const controller = harness.controller
  const row = harness.document.createElement('div')
  row.setAttribute('data-chat-flow-key', 'row-nobar')
  row.setAttribute('data-chat-flow-kind', 'user')
  const slot = harness.document.createElement('div')
  const stack = harness.document.createElement('div')
  stack.className = 'Sixlwa_userStack'
  slot.appendChild(stack)
  row.appendChild(slot)
  harness.document.body.appendChild(row)

  const snapshot = { nodes: new Map([['row-nobar', { kind: 'user', data: { seq: 2 }, anchorSeq: 2 }]]) }
  globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => revisedState() })
  await controller.load(true)
  render(harness, controller, snapshot)

  assert.equal(row.style.display, 'none', 'with no bar to keep, the whole row goes away')
  const bubble = revisionBubble(row)
  assert.ok(bubble, 'the rewritten prompt is still there, outside the row')
  assert.equal(bubble.textContent, 'revised prompt')
  assert.equal(bubble.dataset.dshetCollapsed, undefined, 'and hiding the row did not take it')
  assert.equal(bubble.parentElement, harness.document.body, 'it is planted before the row')
  assert.equal(bubble.nextElementSibling, row, 'so it stays on screen above where the row was')
  // No bar to join, so the pencil falls back to the bubble's own gutter - the
  // one place left where it can sit without covering the text.
  assert.equal(byClass(bubble, 'dshet-action').length, 1, 'the rewrite is still editable')
  assert.equal(bubble._classes.has('dshet-revision-action'), true, 'and the bubble reserves its gutter')
})

// --- the rewritten row's own copy --------------------------------------------
//
// The platform's copy action hands over the text of the message it DREW the row
// for. A prompt this plugin rewrote in place gets no row of its own - the host
// draws rows for append-origin surface events only - so the row that stands for
// it is the ORIGINAL one, still carrying the wording the user replaced: rewrite
// 回复1 into 回复2, press copy on that row, paste 回复1.
//
// The button is the host's and stays exactly where it is; this half answers the
// press before the host's own handler sees it, with the text the row shows.

test('copying from a rewritten row hands over the rewritten text, not the old one', async () => {
  const harness = await loadBundle()
  const controller = harness.controller
  const host = mountHostUserRow(harness.document, 'row-copy')
  const snapshot = { nodes: new Map([['row-copy', { kind: 'user', data: { seq: 2 }, anchorSeq: 2 }]]) }
  globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => revisedState() })
  await controller.load(true)
  render(harness, controller, snapshot)

  assert.equal(revisionBubble(host.row).textContent, 'revised prompt', 'the row shows the rewritten text')
  assert.equal(host.copy.dataset.dshetCopyText, 'revised prompt', 'and its copy button hands that text over')

  // The host's own handler is still on the button - modelled both ways a host
  // owns a press (its own handler on the element, and a listener the plugin did
  // not plant) - and it writes the message the row was drawn for. The plugin
  // answers first, so it never gets the press.
  const hostWrites = []
  host.copy.addEventListener('click', () => hostWrites.push('original'))
  host.copy.onclick = () => hostWrites.push('original')
  host.copy.fire('click')
  assert.deepEqual(hostWrites, [], 'the host handler never saw the press')

  await Promise.resolve()
  assert.deepEqual(harness.clipboard, ['revised prompt'], 'the rewritten text is what landed')
  assert.equal(host.copy.dataset.dshetCopyFlash, '1', 'and the button shows the host’s own "copied" moment')
  assert.equal(host.copy.getAttribute('aria-label'), '复制成功', 'labelled the way the host labels its own')

  // The check is this half's own draw, and it goes back by itself.
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.equal(host.copy.dataset.dshetCopyFlash, undefined, 'the check is taken back')
  assert.equal(host.copy.getAttribute('aria-label'), '复制', 'and the host’s own label with it')

  // Nothing about the button itself was touched.
  assert.equal(host.copy.parentElement, host.bar, 'the host’s button never moved')
  assert.equal(host.copy.disabled, false, 'and is not disabled')
  assert.equal(host.copy.style.display, undefined, 'and is not hidden')
  assert.equal(host.copy.dataset.dshetCopyOwn, '1', 'the one write on it is this half’s own marker')
})

test('a row that was never rewritten is left to the host', async () => {
  const harness = await loadBundle()
  const controller = harness.controller
  const host = mountHostUserRow(harness.document, 'row-plain-copy')
  const snapshot = { nodes: new Map([['row-plain-copy', { kind: 'user', data: { seq: 2 }, anchorSeq: 2 }]]) }
  globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => plainState() })
  await controller.load(true)
  render(harness, controller, snapshot)

  assert.equal(host.copy.dataset.dshetCopyText, undefined, 'no text is handed over from here')
  assert.equal(host.copy.dataset.dshetCopyOwn, undefined, 'and no listener was planted on a row that needs none')
  host.copy.addEventListener('click', () => harness.clipboard.push('original'))
  host.copy.fire('click')
  assert.deepEqual(harness.clipboard, ['original'], 'the press reaches the host’s own handler')
})

test('a sibling plugin’s button in the bar is not mistaken for the host’s copy', async () => {
  const harness = await loadBundle()
  const controller = harness.controller
  const host = mountHostUserRow(harness.document, 'row-copy-foreign')
  const snapshot = { nodes: new Map([['row-copy-foreign', { kind: 'user', data: { seq: 2 }, anchorSeq: 2 }]]) }
  const foreign = harness.document.createElement('button')
  foreign.className = 'xzv4MW_action dsrr-turn-action'
  foreign.setAttribute('data-dsrr-action', '1')
  // In front of the host's own button, which is where a bar rebuilt by a sibling
  // would put it: the bar's first button is not automatically the host's.
  host.bar.insertBefore(foreign, host.copy)

  globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => revisedState() })
  await controller.load(true)
  render(harness, controller, snapshot)

  assert.equal(host.copy.dataset.dshetCopyText, 'revised prompt', 'the host’s own copy button answers')
  assert.equal(foreign.dataset.dshetCopyText, undefined, 'the sibling’s button is left alone')
  assert.equal(foreign.dataset.dshetCopyOwn, undefined, 'no listener of ours on it either')
  assert.equal(foreign.attributes['data-dsrr-action'], '1', 'nor is its own marker touched')
})

// The host's own wording is what names its copy button, and a host that cannot
// resolve it must not cost the row its handover: the structural rule behind it
// still answers - the first button in the bar no plugin claims.
test('a host whose copy wording this plugin cannot resolve still gets the handover', async () => {
  const harness = await loadBundle()
  const controller = harness.controller
  const host = mountHostUserRow(harness.document, 'row-copy-unlabelled')
  const snapshot = { nodes: new Map([['row-copy-unlabelled', { kind: 'user', data: { seq: 2 }, anchorSeq: 2 }]]) }
  // A wording the plugin's own dictionary does not carry (say, a locale this
  // build predates), and a sibling's button sitting in front of it.
  host.copy.setAttribute('aria-label', 'Kopieren')
  const foreign = harness.document.createElement('button')
  foreign.className = 'xzv4MW_action dsrr-turn-action'
  foreign.setAttribute('data-dsrr-action', '1')
  host.bar.insertBefore(foreign, host.copy)

  globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => revisedState() })
  await controller.load(true)
  render(harness, controller, snapshot)

  assert.equal(host.copy.dataset.dshetCopyText, 'revised prompt', 'the unlabelled host button is recognised anyway')
  assert.equal(foreign.dataset.dshetCopyText, undefined, 'and the sibling’s is still not')
})

test('a marked button is found again after the bar has grown around it (I3)', async () => {
  const harness = await loadBundle()
  const controller = harness.controller
  const host = mountHostUserRow(harness.document, 'row-copy-i3')
  const snapshot = { nodes: new Map([['row-copy-i3', { kind: 'user', data: { seq: 2 }, anchorSeq: 2 }]]) }
  globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => revisedState() })
  // A wording the label rule cannot resolve, so the only way back to this button
  // is the marker this half wrote on it.
  host.copy.setAttribute('aria-label', 'Kopieren')
  await controller.load(true)
  render(harness, controller, snapshot)
  assert.equal(host.copy.dataset.dshetCopyText, 'revised prompt', 'the first pass handed the press over')

  // A button that marks nothing lands in FRONT of it, and the row is rewritten
  // again: the handover has to follow the button this half marked, not whatever
  // happens to be first now.
  const stray = harness.document.createElement('button')
  stray.className = 'xzv4MW_action'
  host.bar.insertBefore(stray, host.copy)
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    json: async () => ({ ...revisedState(), turns: [{ seq: 7, turn: 1, messageId: 'm-u1', text: 'second wording', attachments: 0 }] }),
  })
  await controller.load(true)
  render(harness, controller, snapshot)

  assert.equal(host.copy.dataset.dshetCopyText, 'second wording', 'the marked button took the new wording')
  assert.equal(stray.dataset.dshetCopyText, undefined, 'and the stray in front of it got nothing')
})

test('the copy handover goes back when the row stops being rewritten', async () => {
  const harness = await loadBundle()
  const controller = harness.controller
  const host = mountHostUserRow(harness.document, 'row-copy-release')
  const snapshot = { nodes: new Map([['row-copy-release', { kind: 'user', data: { seq: 2 }, anchorSeq: 2 }]]) }
  globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => revisedState() })
  await controller.load(true)
  render(harness, controller, snapshot)
  assert.equal(host.copy.dataset.dshetCopyText, 'revised prompt', 'the row’s copy answers for the rewrite')

  globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => plainState() })
  await new Promise((resolve) => setTimeout(resolve, 0))
  await controller.load(true)
  render(harness, controller, snapshot)

  assert.equal(host.copy.dataset.dshetCopyText, undefined, 'the rewrite is over, so the handover is too')
  assert.equal(host.copy.dataset.dshetCopyLabel, undefined, 'nothing of ours is left written on the button')
  host.copy.addEventListener('click', () => harness.clipboard.push('original'))
  host.copy.fire('click')
  assert.deepEqual(harness.clipboard, ['original'], 'the host’s own handler answers again')
})

test('unloading gives the host’s copy button back, still working', async () => {
  const harness = await loadBundle()
  const controller = harness.controller
  const host = mountHostUserRow(harness.document, 'row-copy-unload')
  const snapshot = { nodes: new Map([['row-copy-unload', { kind: 'user', data: { seq: 2 }, anchorSeq: 2 }]]) }
  globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => revisedState() })
  await controller.load(true)
  render(harness, controller, snapshot)
  assert.equal(host.copy.dataset.dshetCopyText, 'revised prompt', 'the live row answers with the rewrite')

  harness.dispose()

  assert.equal(host.copy.dataset.dshetCopyText, undefined, 'the handover was taken back')
  assert.equal(host.copy.dataset.dshetCopyLabel, undefined, 'and so was every marker of ours on it')
  assert.equal(host.copy.parentElement, host.bar, 'the button stays where the host owns it')
  // A bundle that goes away has to leave a WORKING button behind, not a dead
  // one: the listener it planted is inert without the text marker, so the press
  // reaches the host’s own handler again.
  host.copy.addEventListener('click', () => harness.clipboard.push('original'))
  host.copy.fire('click')
  assert.deepEqual(harness.clipboard, ['original'], 'the host’s handler answers on its own again')
})

test('a reloaded bundle reuses the host’s copy button and plants no second listener', async () => {
  const first = await loadBundle()
  const host = mountHostUserRow(first.document, 'row-copy-reload')
  const snapshot = { nodes: new Map([['row-copy-reload', { kind: 'user', data: { seq: 2 }, anchorSeq: 2 }]]) }
  globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => revisedState() })
  await first.controller.load(true)
  render(first, first.controller, snapshot)
  assert.equal(host.copy.dataset.dshetCopyText, 'revised prompt', 'the first apply handed the press over')

  // The reload, in its worst ordering: a new module instance over the same DOM
  // while the previous one has not been disposed yet.
  const second = await loadBundle({ document: first.document })
  await second.controller.load(true)
  render(second, second.controller, snapshot)

  assert.equal(globalThis.document.clipboard.length, 0, 'nothing was copied by merely rendering')
  host.copy.fire('click')
  await Promise.resolve()
  assert.deepEqual(second.clipboard, ['revised prompt'],
    'the live instance’s text is written once - two listeners would write twice')
})

/** Open the pencil on `host`, type `text` and save it in one click. */
async function editAndSave(harness, controller, host, snapshot, text) {
  byClass(host.row, 'dshet-action')[0].fire('click')
  render(harness, controller, snapshot)
  const area = walk(editorIn(harness)).find((node) => node.tagName === 'TEXTAREA')
  area.value = text
  area.fire('input')
  byClass(editorIn(harness), 'dshet-btn-primary')[0].fire('click')
  await new Promise((resolve) => setTimeout(resolve, 0))
  render(harness, controller, snapshot)
}

// Saving has to leave the rewritten text on screen in the same pass that takes
// the old one down. It did not: the optimistic view recorded the rollback but
// never the message standing in for it, so the row collapsed with nothing to
// show - the transcript simply lost the message the user had just edited.
test('a save shows the rewritten prompt at once, before the host answers', async () => {
  const harness = await loadBundle()
  const controller = harness.controller
  const host = mountHostUserRow(harness.document, 'row-immediate')
  const snapshot = { nodes: new Map([['row-immediate', { kind: 'user', data: { seq: 2 }, anchorSeq: 2 }]]) }
  let stateCalls = 0
  let posted = null
  globalThis.fetch = async (url, init) => {
    if (String(url).includes('/apply')) {
      posted = JSON.parse(init.body)
      return { ok: true, status: 200, json: async () => ({ ok: true, kind: 'prompt', replacementSeq: 7, shadowed: [2], applied: true }) }
    }
    stateCalls += 1
    // The refresh the save asks for never comes back inside this test: the
    // message has to be readable on the strength of the save response alone.
    if (stateCalls > 1) return new Promise(() => {})
    return { ok: true, status: 200, json: async () => plainState() }
  }
  await controller.load(true)
  render(harness, controller, snapshot)

  await editAndSave(harness, controller, host, snapshot, 'revised text')

  assert.equal(posted.text, 'revised text', 'the draft was posted')
  assert.equal(host.stack.style.display, 'none', 'the superseded message is gone')
  const bubble = revisionBubble(host.row)
  assert.ok(bubble, 'the rewritten prompt stands in for it')
  assert.equal(bubble.textContent, 'revised text', 'with the text that was saved')
  assert.equal(bubble.parentElement, host.row, 'inside the row, so the bar does not sit on top of it')
  assert.equal(host.row.children[0], bubble, 'above the time and the copy, in reading order')
  assert.notEqual(host.bar.style.display, 'none', 'the platform buttons stay')
  assert.equal(host.copy.parentElement, host.bar, 'and they are still in the bar')
})

test('a save re-reads the state it just changed', async () => {
  const harness = await loadBundle()
  const controller = harness.controller
  const host = mountHostUserRow(harness.document, 'row-refresh')
  const snapshot = { nodes: new Map([['row-refresh', { kind: 'user', data: { seq: 2 }, anchorSeq: 2 }]]) }
  const asked = []
  globalThis.fetch = async (url) => {
    const isState = String(url).includes('/dsh-edit-turn/state')
    if (isState) asked.push(String(url))
    return {
      ok: true,
      status: 200,
      json: async () => (isState ? plainState() : { ok: true, kind: 'prompt', replacementSeq: 7, shadowed: [2], applied: true }),
    }
  }
  await controller.load(true)
  render(harness, controller, snapshot)
  const before = asked.length

  await editAndSave(harness, controller, host, snapshot, 'revised text')

  assert.equal(asked.length, before + 1,
    'only the host knows how many rows the platform drew for the new text')
})

// A rollback and the carrier that stands in for it are two events, and a view
// can hold one without the other. Hiding the row in that window is what turned
// the defect into a message the user could not read at all.
test('a replacement that has not arrived yet leaves the message on screen', async () => {
  const harness = await loadBundle()
  const controller = harness.controller
  const host = mountHostUserRow(harness.document, 'row-lagging')
  const snapshot = { nodes: new Map([['row-lagging', { kind: 'user', data: { seq: 2 }, anchorSeq: 2 }]]) }
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      ok: true,
      hidden: [{ seq: 2, turn: 1, replacement: 7 }],
      turns: [],
      replies: [],
      config: { confirm: false },
    }),
  })
  await controller.load(true)
  render(harness, controller, snapshot)

  assert.equal(host.row.dataset.dshetHidden, undefined, 'the row is not marked as collapsed')
  assert.notEqual(host.stack.style.display, 'none', 'the message stays readable')
  assert.equal(byClass(harness.document.body, 'dshet-revision').length, 0,
    'nothing stands in for it yet')
})

test('the reply entry cannot take the assistant-actions strip down with it', async () => {
  const harness = await loadBundle()
  const entry = harness.registrations.find((item) => item.definition.name === 'conversation.chat.assistant-actions')
  assert.ok(entry, 'an assistant-actions entry is registered')
  const t = harness.t

  // Every way the runtime could under-supply the component. An entry that
  // throws is retired for the life of the page - the cell renders an empty
  // placeholder and the pencil never comes back - so none of these may throw.
  const cases = [
    undefined,
    null,
    {},
    { messageId: 'm-a1' },
    { messageId: 'm-a1', controller: {} },
    { messageId: 'm-a1', controller: null, t },
    { messageId: 'm-a1', controller: { getSnapshot: () => null }, t },
    { messageId: 'm-a1', controller: { getSnapshot: () => ({}) }, t },
    { messageId: 'm-a1', controller: { getSnapshot: () => ({ repliesByMessage: new Map() }) }, t },
    { messageId: 'm-a1', controller: { getSnapshot: () => ({ repliesByMessage: null, hidden: new Map() }) }, t },
    { messageId: 'm-a1', controller: { getSnapshot: () => { throw new Error('boom') } }, t },
  ]
  for (const props of cases) {
    assert.equal(entry.component(props), null, `renders nothing instead of throwing: ${JSON.stringify(props)}`)
  }

  // And the happy path still draws the pencil - with a config object, because
  // this runtime reads `config.key` without a null check.
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      ok: true,
      hidden: [],
      turns: [],
      replies: [{ seq: 5, turn: 1, messageId: 'm-a1', text: 'the original answer', attachments: 0 }],
      config: { confirm: false },
    }),
  })
  await harness.controller.load(true)
  const button = entry.component({ ...entry.definition.inject(SESSION_ID), messageId: 'm-a1', t })
  assert.equal(button.type, 'button')
  assert.equal(typeof button.props.children.type, 'function', 'the icon is rendered with a config object, not null')
})
// --- the sibling probe is allowed to say "I do not know yet" (contract §3) ---

/** A promise the test settles when it decides the network answered. */
function deferredAnswer() {
  let settle = null
  const promise = new Promise((resolve) => {
    settle = resolve
  })
  return { promise, resolve: settle }
}

test('a probe that cannot reach the sibling is absent, and logs nothing', async () => {
  const { harness, controller, snapshot, row } = await readyController()
  const logged = []
  const original = console.error
  console.error = (...args) => {
    logged.push(args)
  }
  try {
    globalThis.fetch = async (url) => {
      if (String(url) === '/dsh-rerun-turn/state') throw new TypeError('Failed to fetch')
      return pluginState()
    }
    byClass(row, 'dshet-action')[0].fire('pointerdown')
    await new Promise((resolve) => setTimeout(resolve, 0))
    render(harness, controller, snapshot)
    assert.equal(controller.getSnapshot().siblingRerun, 'absent', 'a thrown fetch is an absent sibling')
    assert.deepEqual(editorText(harness).buttons, ['取消', '保存'], 'and no button is offered')
  } finally {
    console.error = original
  }
  assert.deepEqual(logged, [], 'an absent sibling is not an error (I5)')
})

test('no sibling button is drawn while the probe is still in the air', async () => {
  const { harness, controller, snapshot, row } = await readyController()
  const answer = deferredAnswer()
  globalThis.fetch = async (url) => {
    if (String(url) === '/dsh-rerun-turn/state') return answer.promise
    return pluginState()
  }
  byClass(row, 'dshet-action')[0].fire('pointerdown')
  await new Promise((resolve) => setTimeout(resolve, 0))
  render(harness, controller, snapshot)
  assert.equal(controller.getSnapshot().siblingRerun, 'unknown', 'the probe has not answered yet')
  assert.deepEqual(editorText(harness).buttons, ['取消', '保存'],
    'unknown is not present: the button would only flash once and leave')

  // The answer lands: it has to be published, or a redraw would never come.
  let published = 0
  const unsubscribe = controller.subscribe(() => {
    published += 1
  })
  answer.resolve({ ok: false, status: 400, json: async () => ({ ok: false }) })
  await new Promise((resolve) => setTimeout(resolve, 0))
  unsubscribe()
  assert.equal(controller.getSnapshot().siblingRerun, 'present')
  assert.ok(published >= 1, 'the probe publishes its answer, which is what redraws the editor')
  render(harness, controller, snapshot)
  assert.deepEqual(editorText(harness).buttons, ['取消', '重跑', '保存'], 'and the button is there now')
})

test('an older probe that answers late cannot take the sibling button back out', async () => {
  const harness = await loadBundle()
  const controller = harness.controller
  const first = deferredAnswer()
  const second = deferredAnswer()
  const queue = [first.promise, second.promise]
  let asked = 0
  globalThis.fetch = async (url) => {
    if (String(url) === '/dsh-rerun-turn/state') {
      asked += 1
      return queue.shift()
    }
    return pluginState()
  }
  const slow = controller.probeSiblingRerun()
  const fresh = controller.probeSiblingRerun()
  assert.equal(asked, 2, 'both probes are in flight')
  second.resolve({ ok: false, status: 400, json: async () => ({ ok: false }) })
  await fresh
  assert.equal(controller.getSnapshot().siblingRerun, 'present', 'the newest answer wins')
  first.resolve({ ok: false, status: 404, json: async () => ({ ok: false }) })
  await slow
  assert.equal(controller.getSnapshot().siblingRerun, 'present', 'the stale 404 is ignored')
})

// --- hiding is attributed, never assumed (contract I4) -----------------------

test('a row another plugin is keeping away stays away when this plugin restores it', async () => {
  const harness = await loadBundle()
  const controller = harness.controller
  const byDataset = mountHostUserRow(harness.document, 'row-foreign-dataset')
  const byAttribute = mountHostUserRow(harness.document, 'row-foreign-attr')
  // delete-turn and rerun-turn mark a row they displayed away with their own
  // attribute and their own `display:none` (contract §4). One writes through
  // dataset, the other through the raw attribute - both have to be seen.
  byDataset.row.dataset.dshdtHidden = '1'
  byDataset.row.style.display = 'none'
  byAttribute.row.attributes['data-dsrr-hidden'] = '1'
  byAttribute.row.style.display = 'none'
  const snapshot = {
    nodes: new Map([
      ['row-foreign-dataset', { kind: 'user', data: { seq: 2 }, anchorSeq: 2 }],
      ['row-foreign-attr', { kind: 'user', data: { seq: 2 }, anchorSeq: 2 }],
    ]),
  }
  globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => revisedState() })
  await controller.load(true)
  render(harness, controller, snapshot)
  assert.equal(byDataset.row.dataset.dshetHidden, '1', 'this plugin marked its own hide')
  assert.equal(byAttribute.row.dataset.dshetHidden, '1')

  // The rewrite goes back: this plugin may drop its own hide, nothing else.
  globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => plainState() })
  await new Promise((resolve) => setTimeout(resolve, 0))
  await controller.load(true)
  render(harness, controller, snapshot)

  assert.equal(byDataset.row.dataset.dshetHidden, undefined, 'our marker is gone')
  assert.equal(byAttribute.row.dataset.dshetHidden, undefined)
  assert.equal(byDataset.row.style.display, 'none', "delete-turn's hide still stands")
  assert.equal(byAttribute.row.style.display, 'none', "rerun-turn's hide still stands")
  assert.equal(byAttribute.row.attributes['data-dsrr-hidden'], '1', 'and their marker was left alone')
  assert.equal(byDataset.row.attributes['data-dshet-hidden'], undefined, 'ours was the only one removed')
})

test('a child another plugin had already displayed away is not shown again', async () => {
  const harness = await loadBundle()
  const controller = harness.controller
  const host = mountHostUserRow(harness.document, 'row-foreign-child')
  const snapshot = { nodes: new Map([['row-foreign-child', { kind: 'user', data: { seq: 2 }, anchorSeq: 2 }]]) }
  // The message stack was already `display:none` when this plugin's pass first
  // ran - another plugin's doing, with no marker of ours to prove otherwise.
  host.stack.style.display = 'none'
  globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => revisedState() })
  await controller.load(true)
  render(harness, controller, snapshot)
  assert.equal(host.row.dataset.dshetHidden, '1', 'our own collapse landed')
  assert.equal(host.stack.dataset.dshetCollapsed, undefined,
    'a `none` this plugin did not write is not claimed as its own')
  assert.equal(host.stack.style.display, 'none', 'and it is left exactly as it was found')

  globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => plainState() })
  await new Promise((resolve) => setTimeout(resolve, 0))
  await controller.load(true)
  render(harness, controller, snapshot)
  assert.equal(host.row.dataset.dshetHidden, undefined, 'this plugin gave its own hide up')
  assert.equal(host.stack.style.display, 'none', "the other plugin's hide was not lifted with it")
})

// --- injection is idempotent and touches nobody else's nodes (contract I3) ---

test('another plugin’s button in the bar survives every pass, and the pencil reuses its node', async () => {
  const harness = await loadBundle()
  const controller = harness.controller
  const host = mountHostUserRow(harness.document, 'row-foreign-button')
  const foreign = harness.document.createElement('button')
  foreign.className = 'xzv4MW_action dsrr-turn-action'
  foreign.setAttribute('data-dsrr-action', '1')
  foreign.textContent = '↻'
  host.bar.appendChild(foreign)
  const snapshot = { nodes: new Map([['row-foreign-button', { kind: 'user', data: { seq: 2 }, anchorSeq: 2 }]]) }

  globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => revisedState() })
  await controller.load(true)
  render(harness, controller, snapshot)
  const injected = byClass(host.bar, 'dshet-action-host')[0]
  assert.ok(injected, 'the pencil joined the bar')
  assert.equal(foreign.parentElement, host.bar, "the other plugin's button was not removed or moved")
  assert.equal(foreign.attributes['data-dsrr-action'], '1', 'and it kept its own marker')
  assert.equal(injected.previousElementSibling, foreign, 'the pencil sits after the last platform action')
  assert.equal(host.copy.parentElement, host.bar, 'the host’s own buttons never move')
  assert.equal(host.time.parentElement, host.bar)

  // Every later pass works on the nodes that are already there.
  render(harness, controller, snapshot)
  render(harness, controller, snapshot)
  assert.equal(byClass(host.bar, 'dshet-action-host').length, 1, 'no second pencil was planted')
  assert.equal(byClass(host.bar, 'dshet-action-host')[0], injected, 'the same node is reused, not replaced')
  assert.equal(foreign.parentElement, host.bar, 'and the foreign button is still where it was')

  globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => plainState() })
  await new Promise((resolve) => setTimeout(resolve, 0))
  await controller.load(true)
  render(harness, controller, snapshot)
  assert.equal(foreign.parentElement, host.bar, 'the restore pass leaves it alone too')
  assert.equal(byClass(host.bar, 'dshet-action-host').length, 1)
  assert.equal(host.bar.children.length, 4, 'time, copy, the sibling’s button, the pencil - nothing else')
})

test('opening and closing the editor repeatedly leaves one pencil and one box', async () => {
  const { harness, controller, snapshot, row } = await readyController()
  globalThis.fetch = async () => pluginState()
  const pencil = byClass(row, 'dshet-action')[0]
  assert.ok(pencil, 'the row carries its pencil')

  for (let cycle = 0; cycle < 3; cycle += 1) {
    pencil.fire('pointerdown')
    await new Promise((resolve) => setTimeout(resolve, 0))
    render(harness, controller, snapshot)
    assert.equal(byClass(harness.document.body, 'dshet-editor').length, 1, `one box on cycle ${cycle}`)
    assert.deepEqual(editorText(harness).buttons, ['取消', '保存'])
    byClass(editorIn(harness), 'dshet-btn')[0].fire('click') // 取消
    await new Promise((resolve) => setTimeout(resolve, 0))
    render(harness, controller, snapshot)
    assert.equal(byClass(harness.document.body, 'dshet-editor').length, 0, `no box left on cycle ${cycle}`)
  }

  assert.equal(byClass(harness.document.body, 'dshet-layer').length, 0, 'the empty overlay went with it')
  assert.equal(byClass(row, 'dshet-action-host').length, 1, 'exactly one pencil')
  assert.equal(byClass(row, 'dshet-action')[0], pencil, 'the same node, so a host re-render cannot flicker it')
  assert.equal(byClass(harness.document.body, 'dshet-notice').length, 0, 'and no ghost banner was left behind')
})

// --- a reload neither stacks nor forgets (contract I3, §5) --------------------
//
// The host applies this bundle more than once over the same page: an HMR
// reload, a plugin toggle, a bundle-group swap. Every apply is a NEW module
// instance - fresh closures, fresh WeakMap, fresh layer - and the DOM it finds
// was left behind by the one before it. Node identities cannot bridge that, so
// the namespace attributes have to: an injected host is found again and reused,
// and an unload takes everything of ours out. Without both halves the bar keeps
// collecting hosts - the probe counted seven of them and seventeen children in
// a single strip, and the user sees "three re-run buttons on one row".

test('unloading the plugin takes out everything it injected and gives the row back', async () => {
  const harness = await loadBundle()
  const controller = harness.controller
  const host = mountHostUserRow(harness.document, 'row-unload')
  const snapshot = { nodes: new Map([['row-unload', { kind: 'user', data: { seq: 2 }, anchorSeq: 2 }]]) }
  // A sibling plugin's button shares the bar: it belongs to that plugin and has
  // to survive this one's unload untouched (I3).
  const foreign = harness.document.createElement('button')
  foreign.className = 'xzv4MW_action dsrr-turn-action'
  foreign.setAttribute('data-dsrr-action', '1')
  host.bar.appendChild(foreign)

  globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => revisedState() })
  await controller.load(true)
  render(harness, controller, snapshot)
  assert.ok(byClass(host.bar, 'dshet-action-host')[0], 'the pencil was injected')
  assert.equal(byClass(host.row, 'dshet-revision').length, 1, 'so was the bubble for the rewritten prompt')
  assert.equal(host.stack.style.display, 'none', 'the message this plugin rolled back is collapsed')

  byClass(host.row, 'dshet-action')[0].fire('pointerdown')
  render(harness, controller, snapshot)
  assert.ok(editorIn(harness), 'the editor is open')
  assert.equal(byClass(harness.document.body, 'dshet-layer').length, 1, 'on a layer of its own')

  // The plugin is unloaded: the host disposes the fiber and runs every cleanup
  // it registered.
  harness.dispose()

  assert.equal(byClass(host.row, 'dshet-action-host').length, 0, 'the injected host is gone')
  assert.equal(byClass(harness.document.body, 'dshet-layer').length, 0, 'and the layer it was hosted on')
  assert.equal(byClass(harness.document.body, 'dshet-editor').length, 0, 'and the open editor')
  assert.equal(byClass(harness.document.body, 'dshet-revision').length, 0, 'and its revision bubble')
  assert.equal(host.row.dataset.dshetHidden, undefined, 'the hide this plugin wrote is given back')
  assert.equal(host.row.dataset.dshetKeepActions, undefined, 'and the marker that kept the bar')
  assert.equal(host.stack.dataset.dshetCollapsed, undefined, 'and the collapse marker')
  assert.equal(host.stack.style.display, '', 'so the message it had collapsed is readable again')
  assert.equal(foreign.parentElement, host.bar, "the sibling's button was not removed or moved")
  assert.equal(foreign.attributes['data-dsrr-action'], '1', 'nor changed')
  assert.equal(host.copy.parentElement, host.bar, "nor the host's own copy button")
  assert.equal(host.time.parentElement, host.bar, 'nor its timestamp')
  assert.equal(host.bar.children.length, 3, 'time, copy, the sibling button - nothing of ours left')
})

test('an apply over the same page adopts the host a previous apply injected', async () => {
  const first = await loadBundle()
  const host = mountHostUserRow(first.document, 'row-adopt')
  const snapshot = { nodes: new Map([['row-adopt', { kind: 'user', data: { seq: 2 }, anchorSeq: 2 }]]) }
  const foreign = first.document.createElement('button')
  foreign.className = 'xzv4MW_action dsrr-turn-action'
  foreign.setAttribute('data-dsrr-action', '1')
  host.bar.appendChild(foreign)

  globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => revisedState() })
  await first.controller.load(true)
  render(first, first.controller, snapshot)
  const injected = byClass(host.bar, 'dshet-action-host')[0]
  assert.ok(injected, 'the first apply injected its host')
  assert.equal(injected.attributes['data-dshet-action-host'], '1', 'and namespaced it (I3)')

  // The reload, in its worst ordering: a new module instance over the same DOM
  // while the previous one has not been disposed yet.
  const second = await loadBundle({ document: first.document })
  await second.controller.load(true)
  render(second, second.controller, snapshot)

  assert.equal(byClass(host.bar, 'dshet-action-host').length, 1, 'one host in the bar, not two')
  assert.equal(byClass(first.document.body, 'dshet-action-host').length, 1, 'and one on the whole page')
  assert.equal(byClass(host.bar, 'dshet-action-host')[0], injected, 'the very node the first apply injected')
  assert.equal(byClass(first.document.body, 'dshet-action').length, 1, 'one pencil, not a pile of them')
  assert.equal(byClass(first.document.body, 'dshet-revision').length, 1, 'and one bubble, not a second one')
  assert.equal(host.bar.children.length, 4, 'time, copy, the sibling button, one pencil - nothing else')
  assert.equal(foreign.parentElement, host.bar, "the sibling's button is still where it was")
  assert.equal(host.copy.parentElement, host.bar, "and so is the host's own")

  // The reused button must open the editor of the instance that is mounted NOW:
  // the one that wired it first is retired, and a captured closure would leave
  // the user with a pencil that does nothing at all.
  const reusedButton = byClass(injected, 'dshet-action')[0]
  assert.ok(reusedButton, 'the reused host still carries its button')
  reusedButton.fire('pointerdown')
  render(second, second.controller, snapshot)
  assert.ok(editorIn(second), 'the adopted pencil opened the editor of the live instance')
  assert.deepEqual(editorText(second).buttons, ['取消', '保存'])
})

test('apply, dispose, apply again leaves exactly one pencil on the row', async () => {
  const first = await loadBundle()
  const host = mountHostUserRow(first.document, 'row-cycle')
  const snapshot = { nodes: new Map([['row-cycle', { kind: 'user', data: { seq: 2 }, anchorSeq: 2 }]]) }
  const foreign = first.document.createElement('button')
  foreign.className = 'xzv4MW_action dsrr-turn-action'
  foreign.setAttribute('data-dsrr-action', '1')
  host.bar.appendChild(foreign)

  globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => revisedState() })
  await first.controller.load(true)
  render(first, first.controller, snapshot)
  assert.equal(byClass(host.bar, 'dshet-action-host').length, 1, 'the first apply injected one host')

  first.dispose()
  assert.equal(byClass(host.bar, 'dshet-action-host').length, 0, 'the unload took its host out')
  assert.equal(byClass(first.document.body, 'dshet-revision').length, 0, 'and its bubble')

  const second = await loadBundle({ document: first.document })
  await second.controller.load(true)
  render(second, second.controller, snapshot)
  // The pass runs again on the next snapshot, as it does in the browser.
  render(second, second.controller, snapshot)

  assert.equal(byClass(host.bar, 'dshet-action-host').length, 1, 'exactly one pencil after the reload')
  assert.equal(byClass(first.document.body, 'dshet-action-host').length, 1, 'and exactly one on the page')
  assert.equal(byClass(first.document.body, 'dshet-revision').length, 1, 'with exactly one bubble for the row')
  assert.equal(host.bar.children.length, 4, 'time, copy, the sibling button, one pencil')
  assert.equal(foreign.parentElement, host.bar, "the sibling's button was never touched")
  assert.equal(host.copy.parentElement, host.bar, "nor the host's own")
  assert.deepEqual(
    byClass(host.bar, 'dshet-action-host').map((node) => node.children.length),
    [1],
    'the reused host carries one button, not a second one stacked inside it',
  )

  byClass(host.bar, 'dshet-action')[0].fire('pointerdown')
  render(second, second.controller, snapshot)
  assert.ok(editorIn(second), 'and the pencil still opens the editor')
})

test('the pile-up the probe found: stray hosts of earlier applies are swept', async () => {
  const harness = await loadBundle()
  const controller = harness.controller
  const host = mountHostUserRow(harness.document, 'row-ghosts')
  const snapshot = { nodes: new Map([['row-ghosts', { kind: 'user', data: { seq: 2 }, anchorSeq: 2 }]]) }
  // What the CDP probe counted on the live page: several action hosts in one
  // strip, left by applies that are gone. The oldest predate the namespace
  // attribute, so they carry the class alone.
  const ghosts = []
  for (let index = 0; index < 6; index += 1) {
    const ghost = harness.document.createElement('span')
    ghost.className = 'dshet-action-host'
    if (index > 0) ghost.dataset.dshetActionHost = '1'
    const ghostButton = harness.document.createElement('button')
    ghostButton.className = 'dshet-action dshet-row-action'
    ghost.appendChild(ghostButton)
    host.bar.appendChild(ghost)
    ghosts.push(ghost)
  }

  globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => revisedState() })
  await controller.load(true)
  render(harness, controller, snapshot)

  assert.equal(byClass(host.bar, 'dshet-action-host').length, 1, 'the bar is down to one host')
  assert.equal(byClass(host.bar, 'dshet-action').length, 1, 'and to one pencil')
  assert.equal(host.bar.children.length, 3, 'time, copy, the one pencil that was adopted')
  assert.equal(ghosts.filter((ghost) => ghost.parentElement !== null).length, 1,
    'every stray host but the reused one is out of the document')
  const kept = ghosts.find((ghost) => ghost.parentElement !== null)
  assert.equal(kept, byClass(host.bar, 'dshet-action-host')[0], 'and the one kept is the one that was adopted')
  // Adopted means usable: it carries the current wording and the live action.
  kept.children[0].fire('pointerdown')
  render(harness, controller, snapshot)
  assert.ok(editorIn(harness), 'the adopted pencil opens the editor')
})

test('a late dispose from the replaced instance does not leave the row without a pencil', async () => {
  const first = await loadBundle()
  const host = mountHostUserRow(first.document, 'row-late')
  const snapshot = { nodes: new Map([['row-late', { kind: 'user', data: { seq: 2 }, anchorSeq: 2 }]]) }
  const foreign = first.document.createElement('button')
  foreign.className = 'xzv4MW_action dsrr-turn-action'
  foreign.setAttribute('data-dsrr-action', '1')
  host.bar.appendChild(foreign)

  globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => revisedState() })
  await first.controller.load(true)
  render(first, first.controller, snapshot)
  assert.equal(byClass(host.bar, 'dshet-action-host').length, 1)

  // The other ordering a reload can take: the new instance is already running
  // (and has adopted the host) when the old fiber is finally disposed.
  const second = await loadBundle({ document: first.document })
  await second.controller.load(true)
  render(second, second.controller, snapshot)
  assert.equal(byClass(host.bar, 'dshet-action-host').length, 1, 'the new instance reused the host')

  first.dispose()
  assert.equal(byClass(host.bar, 'dshet-action-host').length, 0,
    'the sweep works by namespace, so it takes out the adopted node too')

  // The sweep itself is a DOM change, so the observer runs the pass again - and
  // that pass must put a working pencil back instead of repositioning a node
  // that is no longer in the document.
  render(second, second.controller, snapshot)
  assert.equal(byClass(host.bar, 'dshet-action-host').length, 1, 'the live instance rebuilt its pencil')
  assert.equal(byClass(first.document.body, 'dshet-action-host').length, 1, 'exactly one, not two')
  assert.equal(host.bar.children.length, 4, 'time, copy, the sibling button, one pencil')
  assert.equal(foreign.parentElement, host.bar, "the sibling's button is untouched")
  byClass(host.bar, 'dshet-action')[0].fire('pointerdown')
  render(second, second.controller, snapshot)
  assert.ok(editorIn(second), 'and the rebuilt pencil opens the editor')
})

// --- a save that changes nothing ---------------------------------------------
//
// The host writes nothing when the draft IS the live text, and says so with
// `unchanged`. This half has to read that flag for what it is: not a failure (the
// old `applied === false` wording would tell the user the rollback failed), not a
// change (no row was shadowed, so none may be hidden), NOT a reason to skip the
// re-run the user asked for, and - since 0.2.20 - not something to announce: the
// save was simply not an edit, so the editor closes in silence.

const unchangedApply = (kind) => ({
  ok: true,
  status: 200,
  json: async () => ({ ok: true, kind, applied: false, unchanged: true, shadowed: [], original: 'original' }),
})

test('a save with no change keeps the message, announces nothing, and asks no re-run', async () => {
  const harness = await loadBundle()
  const controller = harness.controller
  const host = mountHostUserRow(harness.document, 'row-noop')
  const snapshot = { nodes: new Map([['row-noop', { kind: 'user', data: { seq: 2 }, anchorSeq: 2 }]]) }
  const calls = []
  globalThis.fetch = async (url, init) => {
    const target = String(url)
    calls.push({ url: target, body: init && init.body })
    if (target === '/dsh-rerun-turn/state') return { ok: false, status: 400, json: async () => ({ ok: false }) }
    if (target.includes('/dsh-edit-turn/apply')) return unchangedApply('prompt')
    return pluginState()
  }
  await controller.load(true)
  render(harness, controller, snapshot)
  byClass(host.row, 'dshet-action')[0].fire('pointerdown')
  await new Promise((resolve) => setTimeout(resolve, 0))
  render(harness, controller, snapshot)

  byClass(editorIn(harness), 'dshet-btn').find((button) => button.textContent === '保存').fire('pointerdown')
  await new Promise((resolve) => setTimeout(resolve, 0))
  // Read the notice immediately: the harness's `window.setTimeout` is a 0ms
  // timer, so a banner published here would be dismissed on the very next tick -
  // and a banner is exactly what this save must not publish any more.
  const notice = controller.getSnapshot().notice
  for (let attempt = 0; attempt < 10 && editorIn(harness) !== null; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
  render(harness, controller, snapshot)
  const tree = harness.component({ useChat: () => snapshot, useEditTurn: () => controller.getSnapshot(), controller, t: harness.t })

  assert.equal(JSON.parse(calls.find((call) => call.url.includes('/dsh-edit-turn/apply')).body).text, 'original',
    'the prefilled text was posted as it was')
  assert.equal(notice, null, 'a save that changed nothing announces nothing at all')
  assert.equal(JSON.stringify([tree]).includes('dshet-notice'), false, 'and the component draws no banner for it')
  assert.equal(byClass(harness.document.body, 'dshet-notice').length, 0, 'so nothing is laid over the composer')
  assert.equal(editorIn(harness), null, 'the editor closes like any save')
  assert.equal(controller.getSnapshot().hidden.size, 0, 'no row was shadowed')
  assert.equal(host.row.dataset.dshetHidden, undefined, 'so the message stays on screen')
  assert.equal(host.row.style.display, undefined, 'and its row is not displayed away')
  assert.equal(byClass(host.row, 'dshet-action').length, 1, 'the message keeps its pencil')
  assert.equal(calls.some((call) => call.url === '/dsh-rerun-turn/apply'), false, 'a plain save re-runs nothing')
})

test('a re-run with no change still re-runs the turn', async () => {
  const harness = await loadBundle()
  const controller = harness.controller
  const host = mountHostUserRow(harness.document, 'row-noop-rerun')
  const snapshot = { nodes: new Map([['row-noop-rerun', { kind: 'user', data: { seq: 2 }, anchorSeq: 2 }]]) }
  const calls = []
  globalThis.fetch = async (url, init) => {
    const target = String(url)
    calls.push({ url: target, body: init && init.body })
    if (target === '/dsh-rerun-turn/state') return { ok: false, status: 400, json: async () => ({ ok: false }) }
    if (target.startsWith('/dsh-rerun-turn/state?sessionId=')) {
      return { ok: true, status: 200, json: async () => ({ ok: true, replies: [{ seq: 3, turn: 1 }, { seq: 9, turn: 1 }, { seq: 4, turn: 2 }] }) }
    }
    if (target === '/dsh-rerun-turn/apply') return { ok: true, status: 200, json: async () => ({ ok: true, started: true }) }
    if (target.includes('/dsh-edit-turn/apply')) return unchangedApply('prompt')
    return pluginState()
  }
  await controller.load(true)
  render(harness, controller, snapshot)
  byClass(host.row, 'dshet-action')[0].fire('pointerdown')
  await new Promise((resolve) => setTimeout(resolve, 0))
  render(harness, controller, snapshot)
  const rerun = byClass(editorIn(harness), 'dshet-btn').find((button) => button.textContent === '重跑')
  assert.ok(rerun, 'the re-run button is there')

  rerun.fire('pointerdown')
  await new Promise((resolve) => setTimeout(resolve, 0))
  // Captured before the chain runs: a notice published during the save would
  // already be up by now (and, in this harness, dismissed on the next tick).
  const notice = controller.getSnapshot().notice
  for (let attempt = 0; attempt < 20 && !calls.some((call) => call.url === '/dsh-rerun-turn/apply'); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0))
  }

  const applies = calls.map((call) => call.url).filter((url) => url.includes('/apply'))
  assert.deepEqual(applies, ['/dsh-edit-turn/apply', '/dsh-rerun-turn/apply'],
    'the save wrote nothing and the re-run still started')
  const chained = calls.find((call) => call.url === '/dsh-rerun-turn/apply')
  assert.equal(JSON.parse(chained.body).seq, 9, "the turn's newest reply is still the target")
  assert.equal(notice, null, 'a re-run is its own feedback: no "nothing changed" banner')
  assert.equal(host.row.dataset.dshetHidden, undefined, 'the message is still on screen')
  assert.equal(controller.getSnapshot().hidden.size, 0)
})


// --- chips: a revised message keeps what it carries --------------------------
//
// The editor used to say "rewriting drops your attachments" and mean it. It now
// draws one chip per block the message carries, lets the user remove one, and
// posts the surviving list with the save - while a host that cannot admit a
// block gets the old warning instead, because there the old behaviour is the
// honest one.

const BLOCKS = [
  { index: 1, type: 'image', name: 'shot.png', mediaType: 'image/png', bytes: 1234, width: 4, height: 3, preview: false },
  { index: 2, type: 'file', name: 'notes.pdf', bytes: 5678, preview: false },
  { index: 3, type: 'quote-card', preview: false },
]

const blockyState = (options = {}) => ({
  ok: true,
  status: 200,
  json: async () => ({
    ok: true,
    hidden: [],
    turns: [{
      seq: 2,
      turn: 1,
      messageId: 'm-u1',
      text: '看图',
      attachments: BLOCKS.length,
      blocks: options.blocks === undefined ? BLOCKS : options.blocks,
    }],
    capabilities: { attachments: options.attachments !== false, preview: true },
    config: { confirm: false },
  }),
})

/** Open the editor on the one user row, with /state answered by the state above. */
async function openEditor(harness, snapshot, requests) {
  globalThis.fetch = async (url, init) => {
    const target = String(url)
    if (requests !== undefined) requests.push({ url: target, body: init && init.body })
    if (target.includes('/dsh-edit-turn/state')) return blockyState(harness.stateOptions)
    if (target === '/dsh-rerun-turn/state') return { ok: false, status: 404, json: async () => ({ ok: false }) }
    if (target.includes('/dsh-edit-turn/apply')) return harness.applyAnswer
    return { ok: false, status: 404, json: async () => ({ ok: false }) }
  }
  await harness.controller.load(true)
  render(harness, harness.controller, snapshot)
  const pencil = byClass(snapshot.row, 'dshet-action')[0]
  pencil.fire('pointerdown')
  await new Promise((resolve) => setTimeout(resolve, 0))
  render(harness, harness.controller, snapshot)
  return editorIn(harness)
}

const chipLabels = (box) => byClass(box, 'dshet-chip').map((chip) => {
  const label = byClass(chip, 'dshet-chip-label')[0]
  return label === undefined ? null : label.textContent
})

const simpleRow = (harness) => {
  const host = mountHostUserRow(harness.document)
  return { nodes: new Map([[ROW_KEY, { kind: 'user', data: { seq: 2 }, anchorSeq: 2 }]]), row: host.row }
}

test('a message that carries blocks shows one chip per block, and no warning', async () => {
  const harness = await loadBundle()
  const snapshot = simpleRow(harness)
  const box = await openEditor(harness, snapshot)
  assert.deepEqual(chipLabels(box), ['shot.png', 'notes.pdf', 'quote-card'], 'one chip per block, named from the block itself')
  const sizes = byClass(box, 'dshet-chip').map((chip) => {
    const size = byClass(chip, 'dshet-chip-size')[0]
    return size === undefined ? null : size.textContent
  })
  assert.deepEqual(sizes, ['1.2 KB', '5.5 KB', null], 'and its size, when the block reports one')
  assert.equal(byClass(box, 'dshet-chip-remove').length, 3, 'every chip can be removed')
  assert.equal(byClass(box, 'dshet-warn').length, 0, 'nothing is going to be dropped, so nothing warns')
  assert.equal(byClass(box, 'dshet-attach').length, 1, 'and there is somewhere to add one')
})

test('a host that cannot carry blocks keeps the old warning, and offers no picker', async () => {
  const harness = await loadBundle()
  harness.stateOptions = { attachments: false }
  const snapshot = simpleRow(harness)
  const box = await openEditor(harness, snapshot)
  assert.equal(byClass(box, 'dshet-chip').length, 0, 'no chip may promise a block this host cannot keep')
  assert.equal(byClass(box, 'dshet-attach').length, 0)
  const warn = byClass(box, 'dshet-warn')[0]
  assert.ok(warn, 'the warning this editor always had')
  assert.equal(warn.textContent, harness.t('editor.warn.attachments'))
})


test('removing a chip takes the block off the list that is saved', async () => {
  const harness = await loadBundle()
  const snapshot = simpleRow(harness)
  const requests = []
  const box = await openEditor(harness, snapshot, requests)
  assert.equal(chipLabels(box).length, 3)
  const removed = byClass(byClass(box, 'dshet-chip')[1], 'dshet-chip-remove')[0]
  removed.fire('pointerdown')
  await new Promise((resolve) => setTimeout(resolve, 0))
  render(harness, harness.controller, snapshot)
  const after = editorIn(harness)
  assert.deepEqual(chipLabels(after), ['shot.png', 'quote-card'], 'the chip is gone from the strip')

  harness.applyAnswer = {
    ok: true,
    status: 200,
    json: async () => ({ ok: true, kind: 'prompt', applied: true, shadowed: [2], replacementSeq: 99, dropped: false, blocks: [] }),
  }
  const save = byClass(after, 'dshet-btn').find((button) => button.textContent === '保存')
  save.fire('pointerdown')
  for (let attempt = 0; attempt < 10 && !requests.some((call) => call.url.includes('/dsh-edit-turn/apply')); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
  const sent = JSON.parse(requests.find((call) => call.url.includes('/dsh-edit-turn/apply')).body)
  assert.deepEqual(sent.parts, [{ keep: 1 }, { keep: 3 }], 'the block the user removed is not in the list')
  assert.equal(sent.text, '看图', 'and the text travelled unchanged')
})

test('a file the user picks becomes a chip and travels with the save', async () => {
  const harness = await loadBundle()
  const snapshot = simpleRow(harness)
  const requests = []
  const box = await openEditor(harness, snapshot, requests)
  globalThis.FileReader = class {
    readAsDataURL() {
      this.result = 'data:application/pdf;base64,UERG'
      this.onload()
    }
  }
  try {
    const picker = byClass(box, 'dshet-attach-input')[0]
    picker.files = [{ name: 'new.pdf', type: 'application/pdf', size: 3 }]
    picker.fire('change')
    await new Promise((resolve) => setTimeout(resolve, 0))
    render(harness, harness.controller, snapshot)
    const grown = editorIn(harness)
    assert.deepEqual(chipLabels(grown), ['shot.png', 'notes.pdf', 'quote-card', 'new.pdf'], 'the picked file is a chip of its own')
    const picked = byClass(grown, 'dshet-chip').at(-1)
    const ownBytes = byClass(picked, 'dshet-thumb')[0]
    assert.ok(ownBytes, 'a picked payload draws itself from the bytes it is already carrying')
    assert.equal(ownBytes.src.startsWith('data:application/pdf;base64,'), true)

    harness.applyAnswer = {
      ok: true,
      status: 200,
      json: async () => ({ ok: true, kind: 'prompt', applied: true, shadowed: [2], replacementSeq: 99, dropped: false, blocks: [] }),
    }
    const save = byClass(grown, 'dshet-btn').find((button) => button.textContent === '保存')
    save.fire('pointerdown')
    for (let attempt = 0; attempt < 10 && !requests.some((call) => call.url.includes('/dsh-edit-turn/apply')); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0))
    }
    const sent = JSON.parse(requests.find((call) => call.url.includes('/dsh-edit-turn/apply')).body)
    assert.deepEqual(sent.parts.at(-1), { add: { data: 'UERG', mediaType: 'application/pdf', name: 'new.pdf' } },
      'the bytes travel with the revision, in the canonical base64 the host wants')
  } finally {
    delete globalThis.FileReader
  }
})


test('a chip draws its thumbnail from the attachment route, and gives up when it cannot', async () => {
  const harness = await loadBundle()
  harness.stateOptions = { blocks: [{ ...BLOCKS[0], preview: true }, BLOCKS[1]] }
  const snapshot = simpleRow(harness)
  const box = await openEditor(harness, snapshot)
  const image = byClass(box, 'dshet-thumb')[0]
  assert.ok(image, 'a block whose bytes are reachable is drawn from them')
  assert.equal(image.src, '/dsh-edit-turn/attachment?sessionId=' + encodeURIComponent(SESSION_ID) + '&seq=2&index=1')
  assert.equal(byClass(box, 'dshet-thumb').length, 1, 'a block with nothing to read gets no thumbnail')

  // The browser is what decides whether those bytes are a picture: a block type
  // list here would make the next block kind invisible.
  image.fire('error')
  assert.equal(byClass(editorIn(harness), 'dshet-thumb').length, 0, 'the chip keeps its label instead')
  assert.deepEqual(chipLabels(editorIn(harness)), ['shot.png', 'notes.pdf'])
})

test('a save that could not keep the blocks says so', async () => {
  const harness = await loadBundle()
  const snapshot = simpleRow(harness)
  const box = await openEditor(harness, snapshot)
  harness.applyAnswer = {
    ok: true,
    status: 200,
    json: async () => ({ ok: true, kind: 'prompt', applied: true, shadowed: [2], replacementSeq: 99, dropped: true, blocks: [] }),
  }
  const save = byClass(box, 'dshet-btn').find((button) => button.textContent === '保存')
  save.fire('pointerdown')
  await new Promise((resolve) => setTimeout(resolve, 0))
  const notice = harness.controller.getSnapshot().notice
  assert.equal(notice, 'attachments-dropped', 'the editor is gone by now: the banner is the only thing that can say it')
  const tree = harness.component({ useChat: () => snapshot, useEditTurn: () => harness.controller.getSnapshot(), controller: harness.controller, t: harness.t })
  assert.equal(JSON.stringify(tree).includes('没能保留'), true, 'and it says so in the language on screen')
  harness.controller.dismissNotice()
})

test('an unchanged save keeps the message and posts the same block list', async () => {
  const harness = await loadBundle()
  const host = mountHostUserRow(harness.document)
  const snapshot = { nodes: new Map([[ROW_KEY, { kind: 'user', data: { seq: 2 }, anchorSeq: 2 }]]), row: host.row }
  const requests = []
  const box = await openEditor(harness, snapshot, requests)
  harness.applyAnswer = {
    ok: true,
    status: 200,
    json: async () => ({ ok: true, kind: 'prompt', applied: false, unchanged: true, shadowed: [], dropped: false, blocks: BLOCKS }),
  }
  const save = byClass(box, 'dshet-btn').find((button) => button.textContent === '保存')
  save.fire('pointerdown')
  for (let attempt = 0; attempt < 10 && !requests.some((call) => call.url.includes('/dsh-edit-turn/apply')); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
  const sent = JSON.parse(requests.find((call) => call.url.includes('/dsh-edit-turn/apply')).body)
  assert.deepEqual(sent.parts, [{ keep: 1 }, { keep: 2 }, { keep: 3 }], 'opening the editor and pressing save sends every block back untouched')
  assert.equal(host.row.dataset.dshetHidden, undefined, 'and nothing was hidden, because nothing was written')
})

