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
    this.dataset = {}
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
    child.parentElement = this
    this.children.push(child)
    return child
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

  fire(type) {
    const event = { type, preventDefault() {}, stopPropagation() {} }
    // Both wiring styles are in use: `el.onclick = fn` on the injected actions,
    // `addEventListener` on the editor's textarea.
    const property = this[`on${type}`]
    if (typeof property === 'function') property(event)
    for (const handler of this.listeners.get(type) ?? []) handler(event)
    return event
  }

  getBoundingClientRect() {
    return { height: 20 }
  }

  focus() {}

  setSelectionRange() {}

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
  const document = {
    body: new StubElement('body'),
    head: new StubElement('head'),
    createElement: (tag) => new StubElement(tag),
    querySelector: (selector) => (rows.length > 0 ? matches(rows[0], selector) ? rows[0] : null : null),
    querySelectorAll(selector) {
      const all = walk(document.body)
      if (selector === '[data-chat-flow-key]') return all.filter((node) => 'data-chat-flow-key' in node.attributes)
      if (selector === '.dshet-editor') return all.filter((node) => node._classes.has('dshet-editor'))
      return []
    },
  }
  globalThis.document = document
  globalThis.window = {
    __ModuleLoader__: { load: ({ factory }) => { bundleFactory = factory } },
    setTimeout: (fn) => setTimeout(fn, 0),
    clearTimeout: (id) => clearTimeout(id),
  }
  globalThis.HTMLElement = StubElement
  globalThis.MutationObserver = class {
    observe() {}
    disconnect() {}
  }
  globalThis.requestAnimationFrame = (fn) => fn()

  // A React whose effects actually run, so the component's DOM pass happens.
  const react = { useEffect: (fn) => { const cleanup = fn(); if (typeof cleanup === 'function') cleanups.push(cleanup) } }
  const cleanups = []
  const jsx = (type, props) => ({ type, props: props ?? {} })
  const jsxs = (type, props) => ({ type, props: props ?? {} })
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
const editorText = (row) => {
  const box = row.querySelector('.dshet-editor')
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
  assert.equal(actions[0].getAttribute('aria-label'), '编辑这条消息并重跑')
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
  assert.ok(row.querySelector('.dshet-editor'), 'the editor appears on the row')
  assert.deepEqual(editorText(row).buttons, ['取消', '保存并重跑'])
  const area = walk(row.querySelector('.dshet-editor')).find((node) => node.tagName === 'TEXTAREA')
  assert.equal(area.value, 'original', 'the original text is pre-filled')
  assert.equal(area.disabled, false)
})

test('the opt-in confirmation step advances instead of doing nothing', async () => {
  const { harness, controller, snapshot, row } = await readyController()
  byClass(row, 'dshet-action')[0].fire('click')
  render(harness, controller, snapshot)

  const submit = byClass(row.querySelector('.dshet-editor'), 'dshet-btn-primary')[0]
  assert.equal(submit.textContent, '保存并重跑')
  submit.fire('click')
  render(harness, controller, snapshot)

  // This is the regression: the editor must be rebuilt for the new state.
  assert.deepEqual(editorText(row).buttons, ['取消', '确认执行'])
  const area = walk(row.querySelector('.dshet-editor')).find((node) => node.tagName === 'TEXTAREA')
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
  byClass(row.querySelector('.dshet-editor'), 'dshet-btn-primary')[0].fire('click')
  render(harness, controller, snapshot)
  byClass(row.querySelector('.dshet-editor'), 'dshet-btn-primary')[0].fire('click') // 确认回退
  await new Promise((resolve) => setTimeout(resolve, 0))
  render(harness, controller, snapshot)

  assert.equal(calls.length, 1)
  assert.equal(calls[0].url, '/dsh-edit-turn/apply')
  assert.equal(calls[0].init.method, 'POST')
  const body = JSON.parse(calls[0].init.body)
  assert.equal(body.sessionId, SESSION_ID)
  assert.equal(body.seq, 2)
  assert.equal(body.messageId, 'm-u1')
  assert.equal(body.text, 'original')
  assert.equal(row.querySelector('.dshet-editor'), null, 'the editor closes on success')
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
  const area = walk(row.querySelector('.dshet-editor')).find((node) => node.tagName === 'TEXTAREA')
  area.value = 'revised text'
  area.fire('input')
  byClass(row.querySelector('.dshet-editor'), 'dshet-btn-primary')[0].fire('click')
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
  byClass(row.querySelector('.dshet-editor'), 'dshet-btn-primary')[0].fire('click')
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
  const area = walk(row.querySelector('.dshet-editor')).find((node) => node.tagName === 'TEXTAREA')
  area.value = '   '
  area.fire('input')
  byClass(row.querySelector('.dshet-editor'), 'dshet-btn-primary')[0].fire('click')
  render(harness, controller, snapshot)

  assert.equal(posted, 0, 'nothing is posted')
  const errors = byClass(row.querySelector('.dshet-editor'), 'dshet-error')
  assert.equal(errors.length, 1)
  assert.equal(errors[0].textContent, '改写后的内容不能为空。')
})

test('a host failure is shown in the editor and the button recovers', async () => {
  const { harness, controller, snapshot, row } = await readyController()
  globalThis.fetch = async () => ({ ok: false, status: 409, json: async () => ({ ok: false, code: 'busy', error: 'the session is still working' }) })
  byClass(row, 'dshet-action')[0].fire('click')
  render(harness, controller, snapshot)
  byClass(row.querySelector('.dshet-editor'), 'dshet-btn-primary')[0].fire('click')
  render(harness, controller, snapshot)
  byClass(row.querySelector('.dshet-editor'), 'dshet-btn-primary')[0].fire('click')
  await new Promise((resolve) => setTimeout(resolve, 0))
  render(harness, controller, snapshot)

  const errors = byClass(row.querySelector('.dshet-editor'), 'dshet-error')
  assert.equal(errors.length, 1)
  assert.equal(errors[0].textContent, '该会话正在回复中，请等回复结束后再编辑。')
  const submit = byClass(row.querySelector('.dshet-editor'), 'dshet-btn-primary')[0]
  assert.equal(submit.disabled, false, 'the user can retry')
  assert.equal(controller.getSnapshot().pending, false)
})

test('an unknown host code falls back instead of printing the raw key', async () => {
  const { harness, controller, snapshot, row } = await readyController()
  globalThis.fetch = async () => ({ ok: false, status: 500, json: async () => ({ ok: false, code: 'something-new' }) })
  byClass(row, 'dshet-action')[0].fire('click')
  render(harness, controller, snapshot)
  byClass(row.querySelector('.dshet-editor'), 'dshet-btn-primary')[0].fire('click')
  render(harness, controller, snapshot)
  byClass(row.querySelector('.dshet-editor'), 'dshet-btn-primary')[0].fire('click')
  await new Promise((resolve) => setTimeout(resolve, 0))
  render(harness, controller, snapshot)

  const errors = byClass(row.querySelector('.dshet-editor'), 'dshet-error')
  assert.equal(errors[0].textContent, '编辑失败，请重试。')
  assert.ok(!errors[0].textContent.includes('error.'))
})

test('a rollback whose re-run did not start reaches the user', async () => {
  const { harness, controller, snapshot, row } = await readyController()
  globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ ok: true, shadowed: [2], promptAccepted: false, promptError: 'inbox closed' }) })
  byClass(row, 'dshet-action')[0].fire('click')
  render(harness, controller, snapshot)
  byClass(row.querySelector('.dshet-editor'), 'dshet-btn-primary')[0].fire('click')
  render(harness, controller, snapshot)
  byClass(row.querySelector('.dshet-editor'), 'dshet-btn-primary')[0].fire('click')
  await new Promise((resolve) => setTimeout(resolve, 0))

  const tree = harness.component({ useChat: () => snapshot, useEditTurn: () => controller.getSnapshot(), controller, t: harness.t })
  const notice = JSON.stringify(tree).includes('dshet-notice')
  assert.equal(notice, true, 'the editor is gone, so the failure needs the banner')
  const snapshotNow = controller.getSnapshot()
  assert.equal(snapshotNow.notice, 'prompt')
  assert.equal(snapshotNow.editing, null)
  assert.equal(row.querySelector('.dshet-editor'), null)
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

  const box = row.querySelector('.dshet-editor')
  assert.ok(box, 'the editor appears in the row holding the reply text')
  assert.deepEqual(byClass(box, 'dshet-editor-title').map((node) => node.textContent), ['编辑这条回答'])
  assert.equal(walk(box).find((node) => node.tagName === 'TEXTAREA').value, 'the original answer')
  assert.deepEqual(editorText(row).buttons, ['取消', '保存替换'])
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
  assert.match(byClass(row.querySelector('.dshet-editor'), 'dshet-warn')[0].textContent, /工具调用或思考过程/)
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

test("a reply whose strip entry never renders still gets a pencil in the platform bar", async () => {
  const harness = await loadBundle()
  const controller = harness.controller
  const { row, bar } = mountTurnTailRow(harness.document)
  globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => replyState() })
  await controller.load(true)
  render(harness, controller, turnTailSnapshot(5))

  const pencils = [...bar.querySelectorAll('.dshet-row-action')]
  assert.equal(pencils.length, 1, 'exactly one pencil')
  assert.equal(pencils[0].getAttribute('aria-label'), '编辑这条回答')
  assert.equal(pencils[0].closest('.dshet-action-host').dataset.dshetFallback, '1', 'marked as the fallback')

  pencils[0].fire('click')
  render(harness, controller, turnTailSnapshot(5))
  assert.ok(row.querySelector('.dshet-editor'), 'clicking it opens the editor under the turn')
  assert.deepEqual(byClass(row.querySelector('.dshet-editor'), 'dshet-editor-title').map((node) => node.textContent), ['编辑这条回答'])
})

test('the fallback never doubles an entry the strip did render', async () => {
  const harness = await loadBundle()
  const controller = harness.controller
  const row = mountRow(harness.document)
  // The strip's own entry: same class, no fallback marker.
  const stripPencil = harness.document.createElement('button')
  stripPencil.className = 'dshet-action dshet-row-action'
  row.querySelector('[class*="_actions"]').appendChild(stripPencil)

  globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => replyState() })
  await controller.load(true)
  render(harness, controller, turnTailSnapshot(5))

  const bar = row.querySelector('[class*="_actions"]')
  assert.equal(bar.querySelectorAll('.dshet-row-action').length, 1, 'no second pencil next to the strip entry')
  assert.equal(bar.querySelectorAll('[data-dshet-fallback]').length, 0, 'the fallback stood down')
})

test('the fallback stands down once the reply leaves the surface', async () => {
  const harness = await loadBundle()
  const controller = harness.controller
  const { row, bar } = mountTurnTailRow(harness.document)
  globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => replyState() })
  await controller.load(true)
  render(harness, controller, turnTailSnapshot(5))
  assert.equal(bar.querySelectorAll('.dshet-row-action').length, 1)

  // A rollback shadows the reply, so the pencil must go with it.
  controller.publish({ hidden: new Map([[5, 1]]) })
  render(harness, controller, turnTailSnapshot(5))
  assert.equal(bar.querySelectorAll('.dshet-row-action').length, 0, 'the pencil is removed with the reply')
  assert.equal(row.querySelectorAll('.dshet-editor').length, 0)
})

test('the fallback parks in the turn tail own strip, never in a tool-call bar', async () => {
  const harness = await loadBundle()
  const controller = harness.controller
  const row = mountRow(harness.document)
  // The row is a wrapper: the marker sits on an element inside it, and the
  // strip is that element's last direct child.
  const tailRoot = harness.document.createElement('div')
  tailRoot.setAttribute('data-turn-tail', '1')
  const tail = harness.document.createElement('div')
  tail.className = 'turn_tail'
  // A tool-call row inside the tail carries an action bar of its own: it is the
  // first _actions here, and it unmounts as the call expands, so a pencil parked
  // in it sits in the wrong place and blinks.
  const toolCall = harness.document.createElement('div')
  toolCall.className = 'tool_call_row'
  const toolBar = harness.document.createElement('span')
  toolBar.className = 'tool_call_actions'
  toolCall.appendChild(toolBar)
  tail.appendChild(toolCall)
  tailRoot.appendChild(tail)
  const ownBar = harness.document.createElement('span')
  ownBar.className = 'turn_tail_actions'
  tailRoot.appendChild(ownBar)
  row.appendChild(tailRoot)

  globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => replyState() })
  await controller.load(true)
  render(harness, controller, turnTailSnapshot(5))

  assert.equal(toolBar.querySelectorAll('.dshet-row-action').length, 0, 'not in the tool call bar')
  assert.equal(ownBar.querySelectorAll('.dshet-row-action').length, 1, 'in the turn tail own strip')
  assert.equal(ownBar.querySelector('.dshet-row-action').getAttribute('aria-label'), '编辑这条回答')
})

test('the fallback also works when the row itself is the turn tail root', async () => {
  const harness = await loadBundle()
  const controller = harness.controller
  const row = mountRow(harness.document)
  row.setAttribute('data-turn-tail', '1')
  const ownBar = harness.document.createElement('span')
  ownBar.className = 'turn_tail_actions'
  row.appendChild(ownBar)

  globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => replyState() })
  await controller.load(true)
  render(harness, controller, turnTailSnapshot(5))

  assert.equal(ownBar.querySelectorAll('.dshet-row-action').length, 1, 'the row is its own tail root')
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
  byClass(row.querySelector('.dshet-editor'), 'dshet-btn')[0].fire('click') // 取消
  render(harness, controller, snapshot)
  assert.equal(row.querySelector('.dshet-editor'), null)
  assert.equal(controller.getSnapshot().editing, null)
  assert.equal(posted, 0)
})
