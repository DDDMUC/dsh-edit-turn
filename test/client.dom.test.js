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

class StubElement {
  constructor(tag) {
    this.tagName = String(tag).toUpperCase()
    this.children = []
    this.parentElement = null
    // `dataset.x` and `data-x` are the same thing in the DOM, and the plugin
    // relies on that: it marks a pencil through dataset and finds it again with
    // an attribute selector. Two detached objects here would hide that contract.
    this.dataset = new Proxy(
      {},
      {
        set: (target, key, value) => {
          target[key] = value
          this.attributes[`data-${String(key).replace(/[A-Z]/g, (char) => `-${char.toLowerCase()}`)}`] = String(value)
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
  }

  getAttribute(name) {
    return name in this.attributes ? this.attributes[name] : null
  }

  addEventListener(type, handler) {
    const list = this.listeners.get(type) ?? []
    list.push(handler)
    this.listeners.set(type, list)
  }

  fire(type, extra = {}) {
    const event = { type, preventDefault() {}, stopPropagation() {}, ...extra }
    // Both wiring styles are in use: `el.onclick = fn` on the injected actions,
    // `addEventListener` on the editor's textarea.
    const property = this[`on${type}`]
    if (typeof property === 'function') property(event)
    for (const handler of this.listeners.get(type) ?? []) handler(event)
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

  /** Supports the two selector forms the plugin uses on an element. */
  querySelector(selector) {
    const hits = walk(this).filter((node) => matches(node, selector))
    return hits[0] ?? null
  }

  /** Same matcher, every hit: the fallback path counts the pencils in a bar. */
  querySelectorAll(selector) {
    return walk(this).filter((node) => matches(node, selector))
  }

  /** Nearest ancestor (or self) matching the selector. */
  closest(selector) {
    let node = this
    while (node !== null && node !== undefined) {
      if (matches(node, selector)) return node
      node = node.parentElement
    }
    return null
  }

  /** Element.matches, so the plugin can test the row element itself. */
  matches(selector) {
    return matches(this, selector)
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

/** Load the bundle and return the registered overlay component plus its deps. */
async function loadBundle() {
  const rows = []
  const documentListeners = new Map()
  const document = {
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
    querySelector: (selector) => (rows.length > 0 ? matches(rows[0], selector) ? rows[0] : null : null),
    querySelectorAll(selector) {
      const all = walk(document.body)
      if (selector === '[data-chat-flow-key]') return all.filter((node) => 'data-chat-flow-key' in node.attributes)
      if (selector === '.dshet-editor') return all.filter((node) => node._classes.has('dshet-editor'))
      if (selector === '.dshet-revision') return all.filter((node) => node._classes.has('dshet-revision'))
      return []
    },
  }
  globalThis.document = document
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
    if (id === '@deepseek-ai/dsh-client-ui-primitives') return {}
    throw new Error(`unexpected require(${id})`)
  }

  if (bundleFactory === null) await import(new URL('../lib/client.js', import.meta.url).href)
  const exports = bundleFactory(requireStub)

  const dictionaries = []
  const registrations = []
  const ctx = {
    effect: (fn) => {
      fn()
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
  const t = (key) => (key in dict ? dict[key] : key)
  return {
    component,
    controller: props.controller,
    t,
    document,
    cleanups,
    rows,
    fresh: () => cleanups.splice(0).forEach((fn) => fn()),
    registrations,
  }
}

/** One user row whose only editable target is seq 2. */
function mountRow(document, key = ROW_KEY) {
  const row = document.createElement('div')
  row.dataset = {}
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
  row.dataset = {}
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
  globalThis.fetch = async () => {
    posted += 1
    return { ok: true, status: 200, json: async () => ({ ok: true }) }
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

test('cancel closes the editor without posting', async () => {
  const { harness, controller, snapshot, row } = await readyController()
  let posted = 0
  globalThis.fetch = async () => {
    posted += 1
    return { ok: true, status: 200, json: async () => ({ ok: true }) }
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
  row.dataset = {}
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
    const isState = String(url).includes('/state')
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
