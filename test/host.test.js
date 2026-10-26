// Host-half integration tests: real HTTP, real Session validator, stubbed DSH
// services.
//
// `applyEdit` is the only place where the plugin can do real damage, and it is
// also the least testable by inspection: it talks to four services through the
// cordis context, mutates a live log, and then starts a model turn. This file
// drives it the way production does - over a real HTTP socket, against the real
// `session.append` validator - while the four DSH services are local stubs, so
// the whole path is exercised with no DSH server, no model call and no tokens.
//
//   node --test "test/*.test.js"
import assert from 'node:assert/strict'
import { writeFileSync, rmSync } from 'node:fs'
import { createServer } from 'node:http'
import net from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { Session, appendPluginRecord } from '@deepseek-ai/dsh-session'
import { PLUGIN_ID, PLUGIN_VERSION, apply, isProjectionUnavailable } from '../lib/index.js'
import { PATCH_TYPE, buildPatchData } from '../lib/patch.js'
import { foldSurface } from '../lib/index.js'

const SESSION_ID = 'session-11111111-2222-4333-8444-555555555555'

// --- fixtures ---------------------------------------------------------------

function modelMessage(id, text) {
  return { id, role: 'assistant', content: [{ type: 'text', text }], source: { kind: 'model', provider: 'p', model: 'm' } }
}

/** Two completed turns whose second ends with a tool call/result pair. */
function buildTwoTurnLog(session) {
  session.append('turn/start', { turn: 1 })
  session.append(
    'system/message',
    { turn: 1, step: 1, message: { id: 'sys', role: 'system', content: [{ type: 'text', text: 'SYS' }], source: { kind: 'system-prompt' } } },
    { surfaceOp: 'append' },
  )
  session.append('user/message', { id: 'u1', role: 'user', content: [{ type: 'text', text: 'original prompt' }], source: { kind: 'user' } }, { surfaceOp: 'append' })
  session.append('assistant/message', { turn: 1, step: 1, message: modelMessage('a1', 'first answer'), stream: [] }, { surfaceOp: 'append' })
  session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  session.append('turn/start', { turn: 2 })
  session.append('user/message', { id: 'u2', role: 'user', content: [{ type: 'text', text: 'second prompt' }], source: { kind: 'user' } }, { surfaceOp: 'append' })
  session.append(
    'tool/result',
    { turn: 2, step: 1, message: { id: 't1', role: 'user', content: [{ type: 'tool-result', toolCallId: 'c1' }], source: { kind: 'tool', callId: 'c1' } } },
    { surfaceOp: 'append' },
  )
  session.append('assistant/message', { turn: 2, step: 1, message: modelMessage('a2', 'second answer'), stream: [] }, { surfaceOp: 'append' })
  session.append('turn/end', { turn: 2, reason: { kind: 'completed' } })
}

/** One turn with a reasoning block, answer text, then a second turn. */
function buildReasoningLog(session) {
  session.append('turn/start', { turn: 1 })
  session.append('system/message', { turn: 1, step: 1, message: { id: 'sys', role: 'system', content: [{ type: 'text', text: 'SYS' }], source: { kind: 'system-prompt' } } }, { surfaceOp: 'append' })
  session.append('step/start', { turn: 1, step: 1 })
  session.append('user/message', { id: 'u1', role: 'user', content: [{ type: 'text', text: 'Q1' }], source: { kind: 'user' } }, { surfaceOp: 'append' })
  session.append('assistant/message', {
    turn: 1,
    step: 1,
    message: {
      id: 'a1',
      role: 'assistant',
      content: [
        { type: 'thinking', text: 'OLD THOUGHT', signature: 'sig-1' },
        { type: 'text', text: 'OLD ANSWER' },
      ],
      source: { kind: 'model', provider: 'p', model: 'm' },
    },
    stream: [],
  }, { surfaceOp: 'append' })
  session.append('step/end', { turn: 1, step: 1 })
  session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  session.append('turn/start', { turn: 2 })
  session.append('step/start', { turn: 2, step: 1 })
  session.append('user/message', { id: 'u2', role: 'user', content: [{ type: 'text', text: 'Q2' }], source: { kind: 'user' } }, { surfaceOp: 'append' })
  session.append('assistant/message', { turn: 2, step: 1, message: modelMessage('a2', 'LATER ANSWER'), stream: [] }, { surfaceOp: 'append' })
  session.append('step/end', { turn: 2, step: 1 })
  session.append('turn/end', { turn: 2, reason: { kind: 'completed' } })
}

/** A log whose last turn never closed: the session is still working. */
function buildBusyLog(session) {
  buildReasoningLog(session)
  session.append('turn/start', { turn: 3 })
  session.append('step/start', { turn: 3, step: 1 })
  session.append('user/message', { id: 'u3', role: 'user', content: [{ type: 'text', text: 'Q3' }], source: { kind: 'user' } }, { surfaceOp: 'append' })
}

// --- harness ----------------------------------------------------------------

/**
 * Compose the plugin against stub DSH services and serve its routes on a real
 * loopback socket.
 * @param options - `{ session, config, services }`.
 * @returns `{ base, port, prompts, toolCalls, session, close }`.
 */
async function harness(options = {}) {
  const session =
    options.session ??
    (() => {
      const created = Session.create(SESSION_ID)
      buildTwoTurnLog(created)
      return created
    })()
  const prompts = []
  const toolCalls = []
  const routes = new Map()
  const projections = []
  const existingProjections = options.existingProjection === true
    ? [{ type: PATCH_TYPE, project: () => new Map() }]
    : []

  const ctx = {
    toolCalls,
    get(name) {
      if (options.services && name in options.services) return options.services[name]
      switch (name) {
        case 'sessions':
          return {
            get: () => session,
            flush: async () => {},
            messageProjections: existingProjections,
            ...(options.patch === true
              ? {
                  registerMessageProjection: (projection) => {
                    if (existingProjections.some((entry) => entry.type === projection.type)) {
                      throw new Error(`session message projection "${projection.type}" is already registered`)
                    }
                    existingProjections.push(projection)
                    projections.push(projection)
                    return () => {}
                  },
                }
              : {}),
          }
        case 'sessionQuery':
          return { readSession: async () => ({ events: session.snapshotEvents() }) }
        case 'sessionController':
          return {
            resolveAgent: async () => ({ agent: { session } }),
            prompt: async (request) => {
              prompts.push(request)
              return { accepted: true }
            },
          }
        case 'tools':
          return {
            register: (definition) => {
              toolCalls.push(definition)
            },
          }
        case 'webServer':
          return { register: ({ path, handler }) => routes.set(path, handler) }
        default:
          return undefined
      }
    },
    effect(fn) {
      const disposer = fn()
      return () => {
        if (typeof disposer === 'function') disposer()
      }
    },
    inject(_deps, callback) {
      callback(ctx)
    },
  }

  apply(ctx, options.config)

  const server = createServer((req, res) => {
    const path = new URL(req.url, 'http://127.0.0.1').pathname
    const handler = routes.get(path)
    if (handler === undefined) {
      res.writeHead(404, { 'content-type': 'application/json' })
      res.end('{"ok":false}')
      return
    }
    Promise.resolve(handler(req, res)).catch(() => {
      if (!res.headersSent) res.writeHead(500)
      res.end()
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port

  return {
    session,
    prompts,
    toolCalls,
    routes,
    projections,
    port,
    close: () => new Promise((resolve) => server.close(resolve)),
  }
}

/** One request over a raw socket, so Host and Origin stay under test control. */
function raw(port, { method = 'GET', path = '/', headers = {}, body = '' }) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1')
    let received = ''
    socket.setEncoding('utf8')
    socket.on('error', reject)
    socket.on('data', (chunk) => {
      received += chunk
    })
    socket.on('close', () => {
      const split = received.indexOf('\r\n\r\n')
      const head = split === -1 ? received : received.slice(0, split)
      const payload = split === -1 ? '' : received.slice(split + 4)
      const status = Number((head.split(' ')[1] || '0'))
      let json
      try {
        json = JSON.parse(payload)
      } catch {
        json = undefined
      }
      resolve({ status, json, head, payload })
    })
    const lines = [`${method} ${path} HTTP/1.1`, `Host: ${headers.host ?? '127.0.0.1'}`, 'Connection: close']
    if (headers.origin !== undefined) lines.push(`Origin: ${headers.origin}`)
    if (body !== '') {
      lines.push('Content-Type: application/json')
      lines.push(`Content-Length: ${Buffer.byteLength(body)}`)
    }
    socket.write(`${lines.join('\r\n')}\r\n\r\n${body}`)
  })
}

const getState = async (port, id = SESSION_ID) => raw(port, { path: `/dsh-edit-turn/state?sessionId=${encodeURIComponent(id)}` })

const applyEdit = async (port, body) =>
  raw(port, { method: 'POST', path: '/dsh-edit-turn/apply', body: JSON.stringify(body) })

test('a session whose projection left the registry answers 409, not 500 with a stack', async () => {
  // `SurfaceManager` refuses to derive a session once a projection it folded with
  // is gone. That is a known state (the plugin was reloaded while the session was
  // open), so it must answer 409 with the host's own words - and must not look
  // like an internal fault in the log.
  const h = await harness({ patch: true })
  const errors = []
  const original = console.error
  console.error = (...args) => errors.push(args)
  try {
    const session = h.session
    // The session has already folded with a projection that the registry no
    // longer holds: exactly what a reload leaves behind.
    const missing = { type: PATCH_TYPE, project: () => new Map() }
    session.surface._state.projections.add(missing)
    const answer = await raw(h.port, {
      method: 'POST',
      path: '/dsh-edit-turn/apply',
      body: JSON.stringify({ sessionId: SESSION_ID, mode: 'reply', seq: 5, blockIndex: 1, kind: 'text', text: 'rewritten' }),
    })
    assert.equal(answer.status, 409)
    assert.equal(answer.json.code, 'projection-missing')
    assert.match(String(answer.json.error), /was removed or replaced/)
    assert.equal(errors.length, 0, 'a known state is not logged as an internal error')
  } finally {
    console.error = original
    await h.close()
  }
})

test('a reloaded host half re-registers the SAME projection object, so live sessions keep folding', async () => {
  // The host registry compares projection IDENTITY, and `SurfaceManager` throws
  // once a projection a live session already folded with leaves the registry.
  // A reload disposes the previous fiber (which splices the object out), so a
  // freshly built object would leave every open session that carries a patch
  // event unreadable: this plugin's routes answer 500, and so does any sibling
  // that reads `session.surface.nodes`.
  const registry = []
  const sessions = {
    messageProjections: registry,
    registerMessageProjection: (projection) => {
      if (registry.some((entry) => entry.type === projection.type)) {
        throw new Error(`session message projection "${projection.type}" is already registered`)
      }
      registry.push(projection)
      return () => {
        registry.splice(registry.indexOf(projection), 1)
      }
    },
  }
  const stashed = globalThis.__DSH_EDIT_TURN_PATCH_PROJECTION__
  delete globalThis.__DSH_EDIT_TURN_PATCH_PROJECTION__
  const opened = []
  try {
    opened.push(await harness({ services: { sessions }, patch: true }))
    const registered = registry[0]
    assert.ok(registered, 'the first load registers the projection')
    assert.equal(registered.type, PATCH_TYPE)

    // The reload: the old fiber is disposed (the object leaves the registry),
    // and a new instance loads.
    registry.length = 0
    opened.push(await harness({ services: { sessions }, patch: true }))
    assert.equal(
      registry[0],
      registered,
      'the reloaded instance hands back the SAME object, so a session that already folded with it stays readable',
    )

    // Control: a genuinely fresh process (no stash) builds its own definition.
    delete globalThis.__DSH_EDIT_TURN_PATCH_PROJECTION__
    registry.length = 0
    opened.push(await harness({ services: { sessions }, patch: true }))
    assert.notEqual(registry[0], registered, 'a fresh process builds its own definition')
  } finally {
    if (stashed === undefined) delete globalThis.__DSH_EDIT_TURN_PATCH_PROJECTION__
    else globalThis.__DSH_EDIT_TURN_PATCH_PROJECTION__ = stashed
    // The harness opens a real server per load; a leaked one keeps the runner
    // alive after the last assertion.
    for (const h of opened) await h.close()
  }
})

// --- state ------------------------------------------------------------------

test('GET /state reports the editable turns of a live session', async () => {
  const h = await harness()
  try {
    const res = await getState(h.port)
    assert.equal(res.status, 200)
    assert.equal(res.json.ok, true)
    assert.equal(res.json.live, true)
    assert.equal(res.json.busy, false)
    assert.deepEqual(res.json.hidden, [])
    assert.equal(res.json.surface.length, 6)
    assert.deepEqual(res.json.turns.map((turn) => turn.seq), [2, 6])
    assert.deepEqual(res.json.turns.map((turn) => turn.text), ['original prompt', 'second prompt'])
    // The model's answers are editable too, as a separate list.
    assert.deepEqual(res.json.replies.map((reply) => reply.seq), [3, 8])
    assert.deepEqual(res.json.replies.map((reply) => reply.text), ['first answer', 'second answer'])
    // Compared against the module, not a literal: a version bump must not require
    // editing a test.
    assert.equal(res.json.version, PLUGIN_VERSION)
    // Saving applies in one click by default; the second confirmation step is
    // opt-in. The client mirrors whatever this endpoint reports.
    assert.equal(res.json.config.confirm, false)
  } finally {
    await h.close()
  }
})

test('every route is mounted, so a missing one never silently passes', async () => {
  const h = await harness()
  try {
    assert.deepEqual([...h.routes.keys()].sort(), [
      '/dsh-edit-turn/apply',
      '/dsh-edit-turn/attachment',
      '/dsh-edit-turn/debug',
      '/dsh-edit-turn/state',
    ])
  } finally {
    await h.close()
  }
})

test('the debug route reports what the browser half asked for', async () => {
  const h = await harness()
  try {
    await getState(h.port)
    const res = await raw(h.port, { path: '/dsh-edit-turn/debug' })
    assert.equal(res.status, 200)
    assert.equal(res.json.ok, true)
    assert.equal(res.json.version, PLUGIN_VERSION)
    // The log is module-level, so earlier tests in this file are in it too: what
    // matters is the entry this test's request just produced.
    const last = res.json.requests.at(-1)
    assert.equal(last.kind, 'state')
    assert.equal(last.ok, true)
    assert.equal(last.sessionId, SESSION_ID)
    assert.equal(last.turns, 2, 'the counts the client would have received')
    assert.equal(last.replies, 2)
    // The diagnostic route itself is not worth recording.
    assert.equal(res.json.requests.some((entry) => entry.kind === 'debug'), false)
  } finally {
    await h.close()
  }
})

// --- apply ------------------------------------------------------------------

test('POST /apply rolls the context back and admits the revised prompt', async () => {
  const h = await harness()
  try {
    const before = h.session.seq
    const res = await applyEdit(h.port, { sessionId: SESSION_ID, seq: 2, text: 'revised prompt' })
    assert.equal(res.status, 200, res.payload)
    assert.equal(res.json.ok, true)
    assert.equal(res.json.kind, 'prompt')
    assert.equal(res.json.applied, true)
    assert.equal(res.json.flushed, true)
    // In place: only the edited message leaves the surface.
    assert.deepEqual(res.json.shadowed, [2])

    // The log grew by exactly one event: the replacement, append-only.
    assert.equal(h.session.seq, before + 1)

    // The derived model context is exactly the surviving system prompt: the
    // default carrier is an empty dormant system node, so it adds no message.
    // The whole point: the revision is in the context, in the old prompt's place,
    // and the reply behind it was never touched.
    const derived = h.session.deriveMessages()
    assert.equal(derived.length, 6, 'nothing else left the context')
    assert.equal(derived[0].content[0].text, 'SYS')
    const revised = derived.findIndex((message) => message.content.some((block) => block.type === 'text' && block.text === 'revised prompt'))
    assert.ok(revised > 0, 'the revised wording is in the context')
    assert.ok(!derived.some((message) => message.content.some((block) => block.type === 'text' && block.text === 'original prompt')))

    // ...and no model call was made for it.
    assert.deepEqual(h.prompts, [], 'saving does not start a turn')
  } finally {
    await h.close()
  }
})

test('the carrier lands with complete shadow coverage and the platform human identity', async () => {
  const h = await harness()
  try {
    const res = await applyEdit(h.port, { sessionId: SESSION_ID, seq: 2, text: 'revised' })
    const carrier = h.session.snapshotEvents().find((event) => event.seq === res.json.replacementSeq)
    assert.equal(carrier.type, 'user/message')
    assert.deepEqual(carrier.sourceEventSeqs, [2])
    assert.deepEqual(carrier.surfaceOp, { op: 'replace', startSeq: 2, endSeq: 2 })
    assert.deepEqual(carrier.data.content, [{ type: 'text', text: 'revised' }], 'the carrier IS the revision')
    // The platform decides "this is the human's prompt" by `source.kind === 'user'`
    // (turn-outline, Trajectory, ui-chat, inbox steering, lastPromptAt). A carrier
    // standing in the user's place must keep that kind, and `editedBy` carries the
    // provenance the old producer-owned kind used to.
    assert.equal(carrier.data.source.kind, 'user', 'the carrier keeps the platform human identity')
    assert.deepEqual(carrier.data.source, { kind: 'user', editedBy: PLUGIN_ID })
    assert.equal(carrier.data.content.length, 1, 'a rewritten prompt carrier carries text')
  } finally {
    await h.close()
  }
})

test('after the rollback the state hides the discarded rows', async () => {
  const h = await harness()
  try {
    await applyEdit(h.port, { sessionId: SESSION_ID, seq: 2, text: 'revised' })
    const res = await getState(h.port)
    assert.equal(res.status, 200)
    assert.deepEqual(res.json.hidden.map((entry) => entry.seq), [2])
    assert.deepEqual(res.json.hidden.map((entry) => entry.turn), [1])
    assert.deepEqual(res.json.surface, (await getState(h.port)).json.surface)
    assert.equal(res.json.edits, 1)
    // The mapping a sibling plugin needs to follow the rewritten message to its
    // live node: same field names the apply response uses.
    assert.equal(res.json.revisions.length, 1)
    assert.deepEqual(res.json.revisions[0].shadowed, [2])
    assert.equal(res.json.revisions[0].startSeq, 2)
    assert.equal(res.json.revisions[0].endSeq, 2)
    assert.equal(typeof res.json.revisions[0].replacementSeq, 'number')
    // The revision stands where the old prompt did, and stays editable; the later
    // prompt was never touched, so it is offered too (listed by sequence, which is
    // why the revision - the newer event - comes last).
    assert.deepEqual([...res.json.turns.map((turn) => turn.text)].sort(), ['revised', 'second prompt'].sort())
  } finally {
    await h.close()
  }
})

test('editing the LAST turn keeps every earlier turn editable', async () => {
  const h = await harness()
  try {
    const res = await applyEdit(h.port, { sessionId: SESSION_ID, turn: 2, text: 'revised second' })
    assert.deepEqual(res.json.shadowed, [6])
    const state = await getState(h.port)
    assert.deepEqual(state.json.hidden.map((entry) => entry.seq), [6])
    assert.deepEqual(state.json.turns.map((turn) => turn.text), ['original prompt', 'revised second'])
    assert.equal(state.json.turns[0].text, 'original prompt')
  } finally {
    await h.close()
  }
})

test('the fallback user/message carrier is used when configured', async () => {
  const h = await harness({ config: { carrier: 'user/message', markerText: 'MARK' } })
  try {
    const res = await applyEdit(h.port, { sessionId: SESSION_ID, seq: 2, text: 'revised' })
    const carrier = h.session.snapshotEvents().find((event) => event.seq === res.json.replacementSeq)
    assert.equal(carrier.type, 'user/message')
    assert.deepEqual(carrier.data.content, [{ type: 'text', text: 'revised' }])
    // System prompt + the revision + the reply and later turn it never touched.
    assert.equal(h.session.deriveMessages().length, 6)
  } finally {
    await h.close()
  }
})

test('the second confirmation step is opt-in, and honoured when asked for', async () => {
  const off = await harness()
  try {
    assert.equal((await getState(off.port)).json.config.confirm, false, 'off by default')
  } finally {
    await off.close()
  }
  const on = await harness({ config: { confirm: true } })
  try {
    assert.equal((await getState(on.port)).json.config.confirm, true, 'on when configured')
  } finally {
    await on.close()
  }
})

// --- a save that changes nothing ---------------------------------------------
//
// The editor opens prefilled with the live text - the host's own parse, the very
// one `/state` publishes as `turns[].text` - so "open the editor and save
// without typing" reaches /apply as an exact copy of that text. It used to write
// anyway: for a prompt, a replacement event with no revision behind it (one real
// session collected three of those on one unchanged question, and every save
// added a row to the ledger); for a reply, a synthetic turn plus a fresh answer
// (two phantom rounds in the rail for one unchanged reply). Neither is a lie the
// log can afford, and both are avoided by comparing the draft with the live text
// before anything is appended.

test('a save whose text is already the live prompt writes nothing at all', async () => {
  const h = await harness()
  try {
    const before = h.session.seq
    const events = h.session.snapshotEvents()
    const res = await applyEdit(h.port, { sessionId: SESSION_ID, seq: 2, text: 'original prompt' })
    assert.equal(res.status, 200, res.payload)
    assert.equal(res.json.ok, true)
    assert.equal(res.json.unchanged, true, 'the caller is told nothing was written')
    assert.equal(res.json.applied, false)
    assert.deepEqual(res.json.shadowed, [], 'nothing left the surface')
    assert.equal(res.json.replacementSeq, undefined, 'no replacement was written')
    assert.equal(res.json.original, 'original prompt', 'and it names what it compared against')
    // A no-op writes nothing, so there is nothing to flush either.
    assert.equal(res.json.flushed, undefined)

    // Not one event: the log is exactly what it was.
    assert.equal(h.session.seq, before)
    assert.deepEqual(h.session.snapshotEvents(), events)

    // Pressing it again is just as quiet - which is the shape the real session was
    // in, five identical saves on one wording.
    const again = await applyEdit(h.port, { sessionId: SESSION_ID, seq: 2, text: 'original prompt' })
    assert.equal(again.status, 200)
    assert.equal(again.json.unchanged, true)
    assert.deepEqual(h.session.snapshotEvents(), events)

    // The conversation did not move: no row is hidden, the ledger has no entry,
    // both prompts are still offered, and the model was not asked anything.
    const state = await getState(h.port)
    assert.deepEqual(state.json.hidden, [])
    assert.equal(state.json.edits, 0)
    assert.deepEqual(state.json.turns.map((turn) => turn.text), ['original prompt', 'second prompt'])
    assert.deepEqual(h.prompts, [])
  } finally {
    await h.close()
  }
})

test('a save whose text is already the live reply writes nothing and opens no turn', async () => {
  const h = await harness()
  try {
    const before = h.session.seq
    const events = h.session.snapshotEvents()
    const derived = h.session.deriveMessages().length
    const res = await applyEdit(h.port, { sessionId: SESSION_ID, seq: 3, text: 'first answer' })
    assert.equal(res.status, 200, res.payload)
    assert.equal(res.json.unchanged, true)
    assert.equal(res.json.applied, false)
    assert.equal(res.json.kind, 'reply', 'the caller still knows which editor asked')
    assert.deepEqual(res.json.shadowed, [], 'the reply is still on the surface')

    // Both things a reply edit adds are absent: the synthetic turn (turn/start +
    // step/start) and the appended correction.
    assert.equal(h.session.seq, before)
    assert.deepEqual(h.session.snapshotEvents(), events, 'the log is untouched')
    const types = h.session.snapshotEvents().map((event) => event.type)
    assert.equal(types.filter((type) => type === 'turn/start').length, 2, 'no phantom round in the rail')
    assert.equal(types.filter((type) => type === 'assistant/message').length, 2, 'and no second answer')
    assert.equal(h.session.deriveMessages().length, derived, 'the derived context is exactly what it was')
    assert.equal(res.json.appendedSeq, undefined)
    assert.equal(res.json.loopTurn, undefined, 'the live loop counter was not touched')
    assert.deepEqual(h.prompts, [])
  } finally {
    await h.close()
  }
})

test('a real revision is still written verbatim, and then it is the live text', async () => {
  const h = await harness()
  try {
    const before = h.session.seq
    // Compared verbatim: whitespace is a difference, not a normalisation, and the
    // write path trims nothing either (the only trim in the handler is the
    // emptiness check, which is about validity, not equality).
    const text = 'original prompt '
    const res = await applyEdit(h.port, { sessionId: SESSION_ID, seq: 2, text })
    assert.equal(res.status, 200, res.payload)
    assert.equal(res.json.unchanged, undefined, 'a changed draft is not reported as unchanged')
    assert.equal(res.json.applied, true)
    assert.deepEqual(res.json.shadowed, [2])
    assert.equal(res.json.flushed, true)
    assert.equal(h.session.seq, before + 1, 'exactly the one replacement, as before')
    const carrier = h.session.snapshotEvents().find((event) => event.seq === res.json.replacementSeq)
    assert.deepEqual(carrier.data.content, [{ type: 'text', text }], 'the text is stored as typed')

    // The same draft, addressed at the node it just wrote, is now a no-op: the
    // guard compares against the wording the surface carries, not the old row.
    const after = h.session.seq
    const again = await applyEdit(h.port, { sessionId: SESSION_ID, seq: res.json.replacementSeq, text })
    assert.equal(again.status, 200, again.payload)
    assert.equal(again.json.unchanged, true)
    assert.equal(h.session.seq, after, 'the second save wrote nothing')
  } finally {
    await h.close()
  }
})

test('the no-op answer sits behind the same refusals as a real edit', async () => {
  // A guard that answered "nothing to do" before the target was resolved would
  // report success for a message that cannot be edited at all, and would hide a
  // busy session from the user.
  const busy = await harness()
  try {
    busy.session.append('turn/start', { turn: 3 })
    const res = await applyEdit(busy.port, { sessionId: SESSION_ID, seq: 2, text: 'original prompt' })
    assert.equal(res.status, 409)
    assert.equal(res.json.code, 'busy')
  } finally {
    await busy.close()
  }

  const head = await harness()
  try {
    // Seq 1 is the system-prompt head: never editable, and identical text must
    // not turn that into a quiet success.
    const res = await applyEdit(head.port, { sessionId: SESSION_ID, seq: 1, text: 'SYS' })
    assert.equal(res.status, 400)
    assert.equal(res.json.code, 'not-editable')
    assert.equal(head.session.seq, 10, 'and nothing was written for it')
  } finally {
    await head.close()
  }
})

// --- refusals ---------------------------------------------------------------

test('a second edit of the same turn is refused as already rolled back', async () => {
  const h = await harness()
  try {
    await applyEdit(h.port, { sessionId: SESSION_ID, seq: 2, text: 'revised' })
    const res = await applyEdit(h.port, { sessionId: SESSION_ID, seq: 2, text: 'again' })
    assert.equal(res.status, 409)
    assert.equal(res.json.code, 'already-rolled-back')
    assert.deepEqual(h.prompts, [], 'no model call was made')
    assert.equal(h.session.seq, 11)
  } finally {
    await h.close()
  }
})

test('a tool result row is still refused', async () => {
  const h = await harness()
  try {
    const res = await applyEdit(h.port, { sessionId: SESSION_ID, seq: 7, text: 'x' })
    assert.equal(res.status, 400)
    assert.equal(res.json.code, 'not-editable')
  } finally {
    await h.close()
  }
})

// --- editing what the model said -------------------------------------------

test('editing a reply replaces it and replays the later turns', async () => {
  const h = await harness()
  try {
    const before = h.session.seq
    const res = await applyEdit(h.port, { sessionId: SESSION_ID, seq: 3, text: 'corrected answer' })
    assert.equal(res.status, 200, res.payload)
    assert.equal(res.json.kind, 'reply')
    assert.equal(res.json.applied, true)
    assert.equal(typeof res.json.appendedSeq, 'number')
    // The window still runs to the tail: the correction can only be appended,
    // so everything from the old answer on leaves the surface first.
    assert.deepEqual(res.json.shadowed, [3, 6, 7, 8])
    // ... and the later turn is then replayed behind the correction, with fresh
    // turn numbers, so the model keeps it.
    assert.equal(res.json.replay.replayed, res.json.replay.total)
    assert.equal(res.json.replay.turns, 1)
    assert.equal(res.json.replay.error, undefined)

    // Ten appends: the turn and step the correction lands in, the invisible
    // rollback carrier, the corrected reply, the two events that close that
    // turn, and the four events of the replayed later turn.
    assert.equal(h.session.seq, before + 10)
    const derived = h.session.deriveMessages()
    assert.deepEqual(derived.map((message) => message.role), ['system', 'user', 'assistant', 'user', 'assistant'])
    assert.equal(derived[2].content[0].text, 'corrected answer')
    assert.equal(derived[1].content[0].text, 'original prompt')
    // The later turn survived, in order, after the correction.
    assert.equal(derived[3].content[0].text, 'second prompt')
    assert.equal(derived[4].content[0].text, 'second answer')
    // The replayed copy is a fresh event carrying the replay marker.
    const copy = h.session.snapshotEvents().find((event) =>
      event.type === 'user/message' && event.data.id !== 'u2' &&
      event.data.source && event.data.source.replayId === res.json.replay.id)
    assert.notEqual(copy, undefined)
    assert.equal(copy.data.source.originalSeq, 6)

    // Crucially: the model was NOT asked again.
    assert.deepEqual(h.prompts, [])
  } finally {
    await h.close()
  }
})

test('a reply edit pushes the live loop past the turn it consumed', async () => {
  // The loop's own counter lives in an idle-phase field seeded when the loop was
  // built, so the turn a reply edit opens is invisible to it: the next prompt
  // would open the same number and the whole session would stop loading.
  const agent = { session: undefined, phase: { kind: 'idle', lastTurn: 2 } }
  const services = {
    sessionController: {
      resolveAgent: async () => ({ agent }),
      prompt: async () => ({ accepted: true }),
    },
  }
  const h = await harness({ services })
  try {
    const res = await applyEdit(h.port, { sessionId: SESSION_ID, seq: 8, text: 'corrected answer' })
    assert.equal(res.status, 200, res.payload)
    assert.equal(res.json.kind, 'reply')
    assert.equal(res.json.loopTurn, 'synced', 'the loop counter moved with the edit')
    assert.equal(agent.phase.lastTurn, 3, 'and it names the turn just opened, not the one before')

    // A second edit - of the first turn's reply (seq 3) - replays that turn and
    // then the correction written by the first edit, so the counter moves to the
    // last replay turn, never backwards.
    const second = await applyEdit(h.port, { sessionId: SESSION_ID, seq: 3, text: 'colder' })
    assert.equal(second.json.applied, true, second.payload)
    assert.equal(second.json.loopTurn, 'synced')
    assert.equal(second.json.replay.turns, 2)
    assert.equal(agent.phase.lastTurn, 6, 'the highest turn the replay wrote')
  } finally {
    await h.close()
  }
})

test('a reply edit leaves a loop it cannot reach alone', async () => {
  // Cold session, or the loop running: the edit lands either way, the counter
  // stays untouched, and the ring says so instead of the client guessing.
  const h = await harness({ services: { sessionController: { resolveAgent: async () => undefined } } })
  try {
    const res = await applyEdit(h.port, { sessionId: SESSION_ID, seq: 3, text: 'corrected answer' })
    assert.equal(res.json.applied, true, res.payload)
    assert.equal(res.json.loopTurn, 'unavailable')
    const ring = (await raw(h.port, { path: '/dsh-edit-turn/debug' })).json.requests
    const note = ring.filter((entry) => entry.kind === 'reply' && entry.loopTurn === 'unavailable')
    assert.equal(note.length >= 1, true, 'the unsynced attempt is recorded for diagnosis')
  } finally {
    await h.close()
  }
})

test('the appended correction is a normal reply that says who wrote it', async () => {
  const h = await harness()
  try {
    const res = await applyEdit(h.port, { sessionId: SESSION_ID, seq: 3, text: 'corrected answer' })
    const appended = h.session.snapshotEvents().find((event) => event.seq === res.json.appendedSeq)
    assert.equal(appended.type, 'assistant/message')
    assert.equal(appended.surfaceOp, 'append')
    // The correction lands in a turn of its own: the original turn is closed by
    // the time it is written, and the read path only admits a step message
    // inside an open turn and step.
    assert.equal(appended.data.turn, 3)
    assert.equal(appended.data.step, 1)
    assert.equal(appended.data.message.role, 'assistant')
    // `model` so it renders as an ordinary reply, plus an honest marker.
    assert.equal(appended.data.message.source.kind, 'model')
    assert.equal(appended.data.message.source.editedBy, PLUGIN_ID)
    assert.equal(appended.data.message.source.provider, 'p')
    assert.equal(appended.data.message.source.model, 'm')
    assert.deepEqual(appended.data.message.content, [{ type: 'text', text: 'corrected answer' }])
  } finally {
    await h.close()
  }
})

test('editing a middle reply keeps the turns before and after it', async () => {
  // Three completed turns, no tools: the correction of turn 2 must land after
  // turn 2's prompt, and turn 3 must come back behind it.
  const session = Session.create(SESSION_ID)
  session.append('turn/start', { turn: 1 })
  session.append('system/message', { turn: 1, step: 1, message: { id: 'sys', role: 'system', content: [{ type: 'text', text: 'SYS' }], source: { kind: 'system-prompt' } } }, { surfaceOp: 'append' })
  session.append('step/start', { turn: 1, step: 1 })
  session.append('user/message', { id: 'u1', role: 'user', content: [{ type: 'text', text: 'Q1' }], source: { kind: 'user' } }, { surfaceOp: 'append' })
  session.append('assistant/message', { turn: 1, step: 1, message: modelMessage('a1', 'A1'), stream: [] }, { surfaceOp: 'append' })
  session.append('step/end', { turn: 1, step: 1 })
  session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  const turn = (number, prompt, answer) => {
    session.append('turn/start', { turn: number })
    session.append('step/start', { turn: number, step: 1 })
    session.append('user/message', { id: `u${number}`, role: 'user', content: [{ type: 'text', text: prompt }], source: { kind: 'user' } }, { surfaceOp: 'append' })
    session.append('assistant/message', { turn: number, step: 1, message: modelMessage(`a${number}`, answer), stream: [] }, { surfaceOp: 'append' })
    session.append('step/end', { turn: number, step: 1 })
    session.append('turn/end', { turn: number, reason: { kind: 'completed' } })
  }
  turn(2, 'Q2', 'A2')
  turn(3, 'Q3', 'A3')
  const secondReply = session.snapshotEvents().find((event) =>
    event.type === 'assistant/message' && event.data.message.id === 'a2')
  const thirdPrompt = session.snapshotEvents().find((event) =>
    event.type === 'user/message' && event.data.id === 'u3')

  const h = await harness({ session })
  try {
    const res = await applyEdit(h.port, { sessionId: SESSION_ID, seq: secondReply.seq, text: 'corrected A2' })
    assert.equal(res.status, 200, res.payload)
    assert.equal(res.json.kind, 'reply')
    assert.deepEqual(res.json.shadowed, [secondReply.seq, thirdPrompt.seq, thirdPrompt.seq + 1])
    assert.equal(res.json.replay.turns, 1)
    const derived = h.session.deriveMessages()
    assert.deepEqual(
      derived.map((message) => message.content[0].text),
      ['SYS', 'Q1', 'A1', 'Q2', 'corrected A2', 'Q3', 'A3'],
    )
    // The replayed prompt is a live, editable prompt again.
    const state = await raw(h.port, { path: `/dsh-edit-turn/state?sessionId=${SESSION_ID}` })
    assert.equal(state.json.turns.map((entry) => entry.text).join('|'), 'Q1|Q2|Q3')
    // The old turn 3 row is gone from the surface; the copy is what carries it.
    const copied = h.session.snapshotEvents().find((event) =>
      event.type === 'user/message' && event.data.source && event.data.source.originalSeq === thirdPrompt.seq)
    assert.notEqual(copied, undefined)
    assert.equal(h.session.deriveMessages().at(-1).content[0].text, 'A3')
  } finally {
    await h.close()
  }
})

test('editing the last reply keeps the earlier conversation intact', async () => {
  const h = await harness()
  try {
    const res = await applyEdit(h.port, { sessionId: SESSION_ID, seq: 8, text: 'rewritten second answer' })
    assert.equal(res.json.kind, 'reply')
    assert.deepEqual(res.json.shadowed, [8])
    const derived = h.session.deriveMessages()
    // Turn 2 delivered a tool result, which derives as a user-role message too.
    assert.deepEqual(derived.map((message) => message.role), ['system', 'user', 'assistant', 'user', 'user', 'assistant'])
    assert.equal(derived[2].content[0].text, 'first answer')
    assert.equal(derived[5].content[0].text, 'rewritten second answer')
  } finally {
    await h.close()
  }
})

test('a corrected reply can be corrected again', async () => {
  const h = await harness()
  try {
    const first = await applyEdit(h.port, { sessionId: SESSION_ID, seq: 3, text: 'version one' })
    // The correction now sits before the replayed later turn, so the second edit
    // targets the correction by the seq the host reported, not the tail.
    const second = await applyEdit(h.port, { sessionId: SESSION_ID, seq: first.json.appendedSeq, text: 'version two' })
    assert.equal(second.status, 200, second.payload)
    assert.equal(second.json.kind, 'reply')
    const derived = h.session.deriveMessages()
    const corrected = derived.filter((message) =>
      (message.content || []).some((block) => block.type === 'text' && block.text === 'version two'))
    assert.equal(corrected.length, 1)
    assert.equal(derived.some((message) => (message.content || []).some((block) => block.type === 'text' && block.text === 'version one')), false)
    // The later turn was replayed again behind the new correction.
    assert.equal(derived.at(-1).content[0].text, 'second answer')
  } finally {
    await h.close()
  }
})

test('a reply edit lands while the turn is still running', async () => {
  const session = Session.create(SESSION_ID)
  buildBusyLog(session)
  const assistant = session.snapshotEvents().find((event) => event.type === 'assistant/message' && event.data.message.id === 'a1')
  const h = await harness({ session, patch: true })
  try {
    const before = h.session.seq
    const res = await applyEdit(h.port, { sessionId: SESSION_ID, seq: assistant.seq, blockIndex: 1, kind: 'text', text: 'patched mid-turn' })
    assert.equal(res.status, 200, res.payload)
    assert.equal(res.json.mode, 'patch')
    // One ignorable record between the running turn's own events; the surface is
    // untouched, so the model picks it up on its next fold.
    assert.equal(h.session.seq, before + 1)
    const record = h.session.snapshotEvents().at(-1)
    assert.equal(record.type, PATCH_TYPE)
    assert.equal(record.ignorable, true)
  } finally {
    await h.close()
  }
})

test('a prompt rewrite still waits for a running turn', async () => {
  const session = Session.create(SESSION_ID)
  buildBusyLog(session)
  const h = await harness({ session, patch: true })
  try {
    const before = h.session.seq
    const res = await applyEdit(h.port, { sessionId: SESSION_ID, seq: 3, text: 'rewritten prompt' })
    assert.equal(res.status, 409, res.payload)
    assert.equal(res.json.code, 'busy')
    assert.equal(h.session.seq, before, 'nothing was written')
  } finally {
    await h.close()
  }
})

test('an all-blocks save lands while the turn is still running', async () => {
  const session = Session.create(SESSION_ID)
  buildBusyLog(session)
  const assistant = session.snapshotEvents().find((event) => event.type === 'assistant/message' && event.data.message.id === 'a1')
  const h = await harness({ session, patch: true })
  try {
    const res = await applyEdit(h.port, {
      sessionId: SESSION_ID,
      targets: [
        { seq: assistant.seq, blockIndex: 0, kind: 'reasoning', text: 'thought mid-turn' },
        { seq: assistant.seq, blockIndex: 1, kind: 'text', text: 'answer mid-turn' },
      ],
    })
    assert.equal(res.status, 200, res.payload)
    assert.equal(res.json.mode, 'patch')
    assert.deepEqual(res.json.targets.map((target) => target.text), ['thought mid-turn', 'answer mid-turn'])
  } finally {
    await h.close()
  }
})

test('an inserted block lands as one record and stays a draft until it has text', async () => {
  const session = Session.create(SESSION_ID)
  buildReasoningLog(session)
  const assistant = session.snapshotEvents().find((event) => event.type === 'assistant/message' && event.data.message.id === 'a1')
  const h = await harness({ session, patch: true })
  try {
    const before = h.session.seq
    const res = await applyEdit(h.port, {
      sessionId: SESSION_ID,
      targets: [{ seq: assistant.seq, kind: 'text', text: 'a paragraph I added', insert: { id: 'ins-1', position: 1 } }],
    })
    assert.equal(res.status, 200, res.payload)
    assert.equal(res.json.mode, 'patch')
    assert.equal(res.json.applied, true)
    assert.equal(h.session.seq, before + 1, 'one record, no synthetic turn')
    const record = h.session.snapshotEvents().at(-1)
    assert.equal(record.type, PATCH_TYPE)
    assert.deepEqual(record.data.targets, [
      { seq: assistant.seq, kind: 'text', text: 'a paragraph I added', insert: { id: 'ins-1', position: 1 } },
    ])
    // No record for a blank draft: nothing was ever written, so nothing is
    // removed and the log does not grow.
    const blankSeq = h.session.seq
    const blank = await applyEdit(h.port, {
      sessionId: SESSION_ID,
      targets: [{ seq: assistant.seq, kind: 'text', text: '', insert: { id: 'ins-never', position: 0 } }],
    })
    assert.equal(blank.status, 200, blank.payload)
    assert.equal(blank.json.applied, false)
    assert.equal(blank.json.unchanged, true)
    assert.equal(h.session.seq, blankSeq, 'a draft that was never written costs no record')
  } finally {
    await h.close()
  }
})

/** A closed turn whose assistant reply has NO text block - reasoning only. */
function buildThinkingOnlyLog(session) {
  session.append('turn/start', { turn: 1 })
  session.append('system/message', { turn: 1, step: 1, message: { id: 'sys', role: 'system', content: [{ type: 'text', text: 'SYS' }], source: { kind: 'system-prompt' } } }, { surfaceOp: 'append' })
  session.append('step/start', { turn: 1, step: 1 })
  session.append('user/message', { id: 'u1', role: 'user', content: [{ type: 'text', text: 'Q1' }], source: { kind: 'user' } }, { surfaceOp: 'append' })
  session.append('assistant/message', {
    turn: 1,
    step: 1,
    message: {
      id: 'a1',
      role: 'assistant',
      content: [{ type: 'thinking', text: 'ONLY THINKING', signature: 'sig-1' }],
      source: { kind: 'model', provider: 'p', model: 'm' },
    },
    stream: [],
  }, { surfaceOp: 'append' })
  session.append('step/end', { turn: 1, step: 1 })
  session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
}

test('a body block can be added to a reply that has no body yet', async () => {
  // The whole reply went into reasoning: there is no text block to point at, and
  // demanding one (the way a block REWRITE must) rejected the insertion with
  // "the requested block changed kind". This is the case the feature exists for.
  const session = Session.create(SESSION_ID)
  buildThinkingOnlyLog(session)
  const assistant = session.snapshotEvents().find((event) => event.type === 'assistant/message' && event.data.message.id === 'a1')
  const h = await harness({ session, patch: true })
  try {
    const res = await applyEdit(h.port, {
      sessionId: SESSION_ID,
      targets: [{ seq: assistant.seq, kind: 'text', text: 'added body', insert: { id: 'ins-body', position: 1 } }],
    })
    assert.equal(res.status, 200, res.payload)
    assert.equal(res.json.applied, true)
    const record = h.session.snapshotEvents().at(-1)
    assert.deepEqual(record.data.targets[0].insert, { id: 'ins-body', position: 1 })
  } finally {
    await h.close()
  }
})

test('clearing a block that was inserted removes it through a tombstone', async () => {
  const session = Session.create(SESSION_ID)
  buildReasoningLog(session)
  const assistant = session.snapshotEvents().find((event) => event.type === 'assistant/message' && event.data.message.id === 'a1')
  const h = await harness({ session, patch: true })
  try {
    const written = await applyEdit(h.port, {
      sessionId: SESSION_ID,
      targets: [{ seq: assistant.seq, kind: 'reasoning', text: 'inserted thought', insert: { id: 'ins-2', position: 0 } }],
    })
    assert.equal(written.status, 200, written.payload)
    const cleared = await applyEdit(h.port, {
      sessionId: SESSION_ID,
      targets: [{ seq: assistant.seq, kind: 'reasoning', text: '', insert: { id: 'ins-2', position: 0 } }],
    })
    assert.equal(cleared.status, 200, cleared.payload)
    assert.equal(cleared.json.applied, true, 'the removal is a real record')
    const record = h.session.snapshotEvents().at(-1)
    assert.equal(record.data.targets[0].removed, true)
  } finally {
    await h.close()
  }
})

test('editing a reply block appends one patch record and no turn', async () => {
  const session = Session.create(SESSION_ID)
  buildReasoningLog(session)
  const assistant = session.snapshotEvents().find((event) => event.type === 'assistant/message' && event.data.message.id === 'a1')
  const h = await harness({ session, patch: true })
  try {
    const before = h.session.seq
    const res = await applyEdit(h.port, { sessionId: SESSION_ID, seq: assistant.seq, blockIndex: 1, kind: 'text', text: 'patched answer' })
    assert.equal(res.status, 200, res.payload)
    assert.equal(res.json.kind, 'reply')
    assert.equal(res.json.mode, 'patch')
    assert.equal(res.json.applied, true)
    assert.deepEqual(res.json.shadowed, [])
    assert.equal(typeof res.json.recordSeq, 'number')

    // One small record; no synthetic turn, no correction, no replay.
    assert.equal(h.session.seq, before + 1)
    const record = h.session.snapshotEvents().at(-1)
    assert.equal(record.type, PATCH_TYPE)
    assert.equal(record.ignorable, true)
    assert.equal(record.surfaceOp, undefined)
    assert.deepEqual(record.data.targets, [{ seq: assistant.seq, blockIndex: 1, kind: 'text', text: 'patched answer' }])

    // The host projection is what changes the model context: rebuild a session
    // with the registered definition and read the same log.
    const patched = Session.create('session-22222222-2222-4222-8222-222222222222', h.session.snapshotEvents(), undefined, 0, h.projections)
    const target = patched.deriveMessages().find((message) => message.content.some((block) => block.type === 'thinking'))
    assert.equal(target.content[0].text, 'OLD THOUGHT')
    assert.equal(target.content[1].text, 'patched answer')
    // The turn after it is untouched.
    assert.equal(patched.deriveMessages().at(-1).content[0].text, 'LATER ANSWER')
    // The recorded log still carries the original text for the original event.
    const original = h.session.snapshotEvents().find((event) => event.seq === assistant.seq)
    assert.equal(original.data.message.content[1].text, 'OLD ANSWER')

    const state = await raw(h.port, { path: `/dsh-edit-turn/state?sessionId=${SESSION_ID}` })
    assert.equal(state.json.mode, 'patch')
    assert.equal(state.json.patches.length, 1)
    assert.deepEqual(state.json.patches[0], { seq: assistant.seq, blockIndex: 1, kind: 'text', text: 'patched answer' })
    const reply = state.json.replies.find((entry) => entry.seq === assistant.seq)
    assert.equal(reply.blocks.length, 2)
    assert.equal(reply.blocks[1].text, 'patched answer')
    assert.equal(reply.blocks[1].original, 'OLD ANSWER')
    assert.equal(reply.patched, true)
  } finally {
    await h.close()
  }
})

test('a reasoning block is editable and the answer beside it is untouched', async () => {
  const session = Session.create(SESSION_ID)
  buildReasoningLog(session)
  const assistant = session.snapshotEvents().find((event) => event.type === 'assistant/message' && event.data.message.id === 'a1')
  const h = await harness({ session, patch: true })
  try {
    const res = await applyEdit(h.port, { sessionId: SESSION_ID, seq: assistant.seq, blockIndex: 0, kind: 'reasoning', text: 'NEW THOUGHT' })
    assert.equal(res.status, 200, res.payload)
    assert.equal(res.json.mode, 'patch')
    assert.equal(res.json.target.kind, 'reasoning')

    const patched = Session.create('session-33333333-3333-4333-8333-333333333333', h.session.snapshotEvents(), undefined, 0, h.projections)
    const target = patched.deriveMessages().find((message) => message.content.some((block) => block.type === 'thinking'))
    assert.equal(target.content[0].text, 'NEW THOUGHT')
    assert.equal(target.content[0].signature, undefined)
    assert.equal(target.content[1].text, 'OLD ANSWER')
    // The later turn is untouched.
    assert.equal(patched.deriveMessages().at(-1).content[0].text, 'LATER ANSWER')

    // A second patch on the answer composes with the reasoning patch.
    const text = await applyEdit(h.port, { sessionId: SESSION_ID, seq: assistant.seq, blockIndex: 1, kind: 'text', text: 'NEW ANSWER' })
    assert.equal(text.json.mode, 'patch')
    const both = Session.create('session-44444444-4444-4444-8444-444444444444', h.session.snapshotEvents(), undefined, 0, h.projections)
    const composed = both.deriveMessages().find((message) => message.content.some((block) => block.type === 'thinking'))
    assert.equal(composed.content[0].text, 'NEW THOUGHT')
    assert.equal(composed.content[1].text, 'NEW ANSWER')

    const same = await applyEdit(h.port, { sessionId: SESSION_ID, seq: assistant.seq, blockIndex: 1, kind: 'text', text: 'NEW ANSWER' })
    assert.equal(same.json.applied, false)
    assert.equal(same.json.unchanged, true)
    assert.equal(h.session.snapshotEvents().filter((event) => event.type === PATCH_TYPE).length, 2)
  } finally {
    await h.close()
  }
})

test('one all-blocks save writes a single record with every edited target', async () => {
  const session = Session.create(SESSION_ID)
  buildReasoningLog(session)
  const assistant = session.snapshotEvents().find((event) => event.type === 'assistant/message' && event.data.message.id === 'a1')
  const h = await harness({ session, patch: true })
  try {
    const res = await applyEdit(h.port, {
      sessionId: SESSION_ID,
      targets: [
        { seq: assistant.seq, blockIndex: 0, kind: 'reasoning', text: 'NEW THOUGHT' },
        { seq: assistant.seq, blockIndex: 1, kind: 'text', text: 'NEW ANSWER' },
      ],
    })
    assert.equal(res.status, 200, res.payload)
    assert.equal(res.json.applied, true)
    assert.equal(res.json.targets.length, 2, 'both blocks travel in the answer')
    assert.equal(h.session.snapshotEvents().filter((event) => event.type === PATCH_TYPE).length, 1, 'one record, not two')

    const patched = Session.create('session-55555555-5555-4555-8555-555555555555', h.session.snapshotEvents(), undefined, 0, h.projections)
    const target = patched.deriveMessages().find((message) => message.content.some((block) => block.type === 'thinking'))
    assert.equal(target.content[0].text, 'NEW THOUGHT')
    assert.equal(target.content[1].text, 'NEW ANSWER')
  } finally {
    await h.close()
  }
})

test('the projection-gone refusal is recognised so the save can replay instead', () => {
  assert.equal(
    isProjectionUnavailable('session message projection "plugin:dsh-edit-turn/patch" was removed or replaced; restore the session with its owning plugin'),
    true,
  )
  assert.equal(isProjectionUnavailable('the session is still working'), false)
  assert.equal(isProjectionUnavailable(undefined), false)
})

test('a live reload reuses the already registered projection instead of falling back', async () => {
  const h = await harness({ patch: true, existingProjection: true })
  try {
    const state = await raw(h.port, { path: `/dsh-edit-turn/state?sessionId=${SESSION_ID}` })
    assert.equal(state.status, 200, state.payload)
    assert.equal(state.json.mode, 'patch', 'the old registration is still good')
    assert.equal(h.projections.length, 0, 'no duplicate registration was attempted')
  } finally {
    await h.close()
  }
})

test('/state publishes only patches whose target is still on the surface', async () => {
  const h = await harness({ patch: true })
  try {
    appendPluginRecord(h.session, PATCH_TYPE, buildPatchData([
      { seq: 999, blockIndex: 0, kind: 'text', text: 'stale patch' },
    ]))
    const state = await raw(h.port, { path: `/dsh-edit-turn/state?sessionId=${SESSION_ID}` })
    assert.equal(state.status, 200, state.payload)
    assert.deepEqual(state.json.patches, [], 'a retired target is not a live patch')
  } finally {
    await h.close()
  }
})

test('/state publishes the editor style and defaults it to frame', async () => {
  const chosen = await harness({ config: { editorStyle: 'bubble' } })
  try {
    const state = await raw(chosen.port, { path: `/dsh-edit-turn/state?sessionId=${SESSION_ID}` })
    assert.equal(state.status, 200, state.payload)
    assert.equal(state.json.config.editorStyle, 'bubble')
  } finally {
    await chosen.close()
  }
  const fallback = await harness({})
  try {
    const state = await raw(fallback.port, { path: `/dsh-edit-turn/state?sessionId=${SESSION_ID}` })
    assert.equal(state.json.config.editorStyle, 'frame')
  } finally {
    await fallback.close()
  }
})

test('the answer picker lists every step reasoning of the same turn', async () => {
  const session = Session.create(SESSION_ID)
  session.append('turn/start', { turn: 1 })
  session.append('system/message', { turn: 1, step: 1, message: { id: 'sys', role: 'system', content: [{ type: 'text', text: 'SYS' }], source: { kind: 'system-prompt' } } }, { surfaceOp: 'append' })
  session.append('user/message', { id: 'u1', role: 'user', content: [{ type: 'text', text: 'Q' }], source: { kind: 'user' } }, { surfaceOp: 'append' })
  session.append('step/start', { turn: 1, step: 1 })
  session.append('assistant/message', { turn: 1, step: 1, message: { id: 'a1', role: 'assistant', content: [{ type: 'thinking', text: 'STEP ONE THOUGHT' }], source: { kind: 'model', provider: 'p', model: 'm' } }, stream: [] }, { surfaceOp: 'append' })
  session.append('step/end', { turn: 1, step: 1 })
  session.append('step/start', { turn: 1, step: 2 })
  session.append('assistant/message', { turn: 1, step: 2, message: { id: 'a2', role: 'assistant', content: [{ type: 'thinking', text: 'STEP TWO THOUGHT' }, { type: 'text', text: 'FINAL ANSWER' }], source: { kind: 'model', provider: 'p', model: 'm' } }, stream: [] }, { surfaceOp: 'append' })
  session.append('step/end', { turn: 1, step: 2 })
  session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })

  const h = await harness({ session, patch: true })
  try {
    const state = await raw(h.port, { path: `/dsh-edit-turn/state?sessionId=${SESSION_ID}` })
    const replies = state.json.replies
    const answer = replies.find((reply) => Array.isArray(reply.blocks) && reply.blocks.some((block) => block.kind === 'text'))
    assert.ok(answer, 'the answer row is offered')
    assert.deepEqual(
      answer.blocks.map((block) => [block.kind, block.text]),
      [['reasoning', 'STEP ONE THOUGHT'], ['reasoning', 'STEP TWO THOUGHT'], ['text', 'FINAL ANSWER']],
      'every reasoning block of the turn is listed, in order, before the answer',
    )
    assert.equal(new Set(answer.blocks.map((block) => block.seq)).size, 2, 'the blocks name the two messages they live in')
  } finally {
    await h.close()
  }
})

test('a reply with no text is not editable', async () => {
  const session = Session.create(SESSION_ID)
  buildTwoTurnLog(session)
  session.append(
    'assistant/message',
    { turn: 2, step: 2, message: { id: 'a3', role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'c9', toolName: 'x', input: {} }], source: { kind: 'model', provider: 'p', model: 'm' } }, stream: [] },
    { surfaceOp: 'append' },
  )
  const h = await harness({ session })
  try {
    const res = await applyEdit(h.port, { sessionId: SESSION_ID, seq: 11, text: 'x' })
    assert.equal(res.status, 400)
    assert.equal(res.json.code, 'not-editable')
  } finally {
    await h.close()
  }
})

test('empty and oversized revised text are refused before anything is written', async () => {
  const h = await harness()
  try {
    const before = h.session.seq
    const empty = await applyEdit(h.port, { sessionId: SESSION_ID, seq: 2, text: '   ' })
    assert.equal(empty.status, 400)
    assert.equal(empty.json.code, 'invalid')
    const huge = await applyEdit(h.port, { sessionId: SESSION_ID, seq: 2, text: 'x'.repeat(200_001) })
    assert.equal(huge.status, 400)
    assert.equal(h.session.seq, before)
    assert.deepEqual(h.prompts, [])
  } finally {
    await h.close()
  }
})

test('a busy session is refused', async () => {
  const session = Session.create(SESSION_ID)
  buildTwoTurnLog(session)
  session.append('turn/start', { turn: 3 })
  const h = await harness({ session })
  try {
    const res = await applyEdit(h.port, { sessionId: SESSION_ID, seq: 2, text: 'x' })
    assert.equal(res.status, 409)
    assert.equal(res.json.code, 'busy')
    assert.equal(res.json.error, 'the session is still working')
  } finally {
    await h.close()
  }
})

test('a legal id with no log is an empty state; a malformed id is a 400', async () => {
  const h = await harness({
    services: {
      sessionQuery: { readSession: async () => undefined },
      sessions: { get: () => undefined, flush: async () => {} },
    },
  })
  try {
    // No log for this id: an EMPTY session, not a failure. The panel used to
    // print "状态加载失败，稍后重试。" for exactly this case.
    const missing = await getState(h.port)
    assert.equal(missing.status, 200)
    assert.equal(missing.json.ok, true)
    assert.deepEqual(missing.json.replies, [], 'nothing to edit')
    assert.deepEqual(missing.json.turns, [])
    assert.equal(missing.json.busy, false)
    // A NAMED session is a session: the GUI creates ids like this one, and DSH
    // itself treats an id as an opaque string (`z.string().min(1)`).
    const named = await getState(h.port, 'bili-whale')
    assert.equal(named.status, 200, 'a named session id is well formed')
    assert.equal(named.json.ok, true)
    // Malformed stays refused - nothing that could leave a path or a URL.
    for (const bad of ['../etc/passwd', 'a/b', 'a\\b', '.hidden', 'has space', 'x'.repeat(200)]) {
      const malformed = await getState(h.port, bad)
      assert.equal(malformed.status, 400, JSON.stringify(bad) + ' must be refused')
      assert.equal(malformed.json.code, 'invalid')
    }
    const absent = await raw(h.port, { path: '/dsh-edit-turn/state' })
    assert.equal(absent.status, 400)
  } finally {
    await h.close()
  }
})

test('a session with no live writer is refused', async () => {
  const h = await harness({ services: { sessions: { get: () => undefined, flush: async () => {} }, sessionController: { resolveAgent: async () => undefined } } })
  try {
    const res = await applyEdit(h.port, { sessionId: SESSION_ID, seq: 2, text: 'x' })
    assert.equal(res.status, 409)
    assert.equal(res.json.code, 'session-not-active')
  } finally {
    await h.close()
  }
})

// --- guards -----------------------------------------------------------------

test('only POST reaches /apply', async () => {
  const h = await harness()
  try {
    const res = await raw(h.port, { path: '/dsh-edit-turn/apply' })
    assert.equal(res.status, 405)
    assert.equal(res.json.code, 'method')
  } finally {
    await h.close()
  }
})

test('only GET reaches /state', async () => {
  const h = await harness()
  try {
    const res = await raw(h.port, { method: 'PUT', path: `/dsh-edit-turn/state?sessionId=${SESSION_ID}` })
    assert.equal(res.status, 405)
  } finally {
    await h.close()
  }
})

test('a malformed JSON body is refused', async () => {
  const h = await harness()
  try {
    const res = await raw(h.port, { method: 'POST', path: '/dsh-edit-turn/apply', body: '{nope' })
    assert.equal(res.status, 400)
    assert.equal(res.json.code, 'invalid')
  } finally {
    await h.close()
  }
})

test('a cross-origin request is refused', async () => {
  const h = await harness()
  try {
    const res = await raw(h.port, { path: `/dsh-edit-turn/state?sessionId=${SESSION_ID}`, headers: { origin: 'http://evil.test' } })
    assert.equal(res.status, 403)
    assert.equal(res.json.code, 'forbidden')
  } finally {
    await h.close()
  }
})

test('a same-origin request passes the origin check', async () => {
  const h = await harness()
  try {
    // A real browser sends the port in both headers when the port is not 80.
    const host = `127.0.0.1:${h.port}`
    const res = await raw(h.port, {
      path: `/dsh-edit-turn/state?sessionId=${SESSION_ID}`,
      headers: { origin: `http://${host}`, host },
    })
    assert.equal(res.status, 200, res.payload)
  } finally {
    await h.close()
  }
})

test('a non-loopback Host header is refused', async () => {
  const h = await harness()
  try {
    const res = await raw(h.port, { path: `/dsh-edit-turn/state?sessionId=${SESSION_ID}`, headers: { host: 'evil.test' } })
    assert.equal(res.status, 403)
    assert.equal(res.json.code, 'forbidden')
  } finally {
    await h.close()
  }
})

test('loopback host spellings are accepted and impostors are not', async () => {
  const h = await harness()
  try {
    for (const host of ['localhost', 'localhost:1234', '127.0.0.1', '127.0.0.1:3080', '[::1]', '[::1]:3080']) {
      const res = await raw(h.port, { path: `/dsh-edit-turn/state?sessionId=${SESSION_ID}`, headers: { host } })
      assert.equal(res.status, 200, `host ${host} -> ${res.status}`)
    }
    for (const host of ['127.0.0.1.evil.test', '[::1]evil.test', 'localhost.evil.test', '', 'localhost:12:34']) {
      const res = await raw(h.port, { path: `/dsh-edit-turn/state?sessionId=${SESSION_ID}`, headers: { host } })
      assert.equal(res.status, 403, `host ${host} -> ${res.status}`)
    }
  } finally {
    await h.close()
  }
})

// --- tool -------------------------------------------------------------------

test('the read-only tool is registered with a valid contract', async () => {
  const h = await harness()
  try {
    assert.equal(h.toolCalls.length, 1)
    const tool = h.toolCalls[0]
    assert.equal(tool.name, 'edit_turn_targets')
    assert.equal(typeof tool.execute, 'function')
    assert.equal(typeof tool.output.render, 'function')
    // `render` must return ContentBlock[], never a bare string.
    const rendered = tool.output.render({}, 'hello')
    assert.ok(Array.isArray(rendered))
    assert.deepEqual(rendered[0], { type: 'text', text: 'hello' })
    assert.ok(tool.parameters.properties.sessionId)
    assert.ok(tool.parameters.properties.limit)
  } finally {
    await h.close()
  }
})

test('the tool lists the editable turns and changes nothing', async () => {
  const h = await harness()
  try {
    const before = h.session.seq
    const tool = h.toolCalls[0]
    const text = await tool.execute({ sessionId: SESSION_ID, limit: 10 }, {})
    assert.equal(typeof text, 'string')
    assert.match(text, /2 editable turn\(s\), 2 editable reply\/replies, idle/)
    assert.match(text, /turn 1 \(seq 2/)
    assert.match(text, /original prompt/)
    assert.match(text, /reply \(seq 3/)
    assert.match(text, /first answer/)
    assert.match(text, /editing a turn replaces its wording in place/)
    assert.equal(h.session.seq, before)
  } finally {
    await h.close()
  }
})

test('the tool admits when it has no session to inspect', async () => {
  const h = await harness()
  try {
    await assert.rejects(() => h.toolCalls[0].execute({}, {}), /no sessionId/)
  } finally {
    await h.close()
  }
})

// --- blocks: a revised message carries everything it carried -----------------
//
// The edit is rebuilt from the submitted block list: a block the user left alone
// is copied verbatim, one they removed is not written, and a newly picked one is
// admitted through the platform's attachment store. The fixtures below are the
// real shapes (an image reference, a file reference) plus a block type this
// plugin has never heard of, which has to travel exactly like the others.

const IMAGE_REF = { attachmentId: `sha256:${'a'.repeat(64)}`, mediaType: 'image/png', width: 4, height: 3, bytes: 1234, name: 'shot.png' }
const FILE_REF = { attachmentId: `sha256:${'b'.repeat(64)}`, name: 'notes.pdf', bytes: 5678 }
const BLOCKS = [
  { type: 'text', text: '看图' },
  { type: 'image', attachment: IMAGE_REF },
  { type: 'file', attachment: FILE_REF },
  // A block from a platform this plugin has never seen. The real validator
  // accepts it and the projection passes it through, so nothing here may need to
  // know what it is.
  { type: 'quote-card', payload: { quote: '引用卡片', page: 3 } },
]

/** One completed turn whose prompt carries blocks of every kind. */
function buildBlockyLog(session, blocks = BLOCKS) {
  session.append('turn/start', { turn: 1 })
  session.append(
    'system/message',
    { turn: 1, step: 1, message: { id: 'sys', role: 'system', content: [{ type: 'text', text: 'SYS' }], source: { kind: 'system-prompt' } } },
    { surfaceOp: 'append' },
  )
  session.append('user/message', { id: 'u1', role: 'user', content: blocks, source: { kind: 'user' } }, { surfaceOp: 'append' })
  session.append('assistant/message', { turn: 1, step: 1, message: modelMessage('a1', 'first answer'), stream: [] }, { surfaceOp: 'append' })
  session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
}

/** A store that admits everything and remembers what it was handed. */
function stubStore() {
  const calls = []
  return {
    calls,
    imageLimits: { mediaTypes: ['image/png', 'image/jpeg'] },
    async saveImage(input) {
      calls.push({ kind: 'image', input })
      return {
        attachmentId: `sha256:${'c'.repeat(64)}`,
        mediaType: input.mediaType,
        bytes: input.data.byteLength,
        width: 2,
        height: 2,
        ...(input.name === undefined ? {} : { name: input.name }),
      }
    },
    async saveFile(input) {
      calls.push({ kind: 'file', input })
      return { attachmentId: `sha256:${'d'.repeat(64)}`, name: input.name === undefined ? 'file' : input.name, bytes: input.data.byteLength }
    },
  }
}

const blockySession = (blocks = BLOCKS) => {
  const session = Session.create(SESSION_ID)
  buildBlockyLog(session, blocks)
  return session
}

const carrierOf = (h, response) => h.session.snapshotEvents().find((event) => event.seq === response.json.replacementSeq)

test('a revised message keeps every block the user did not touch, byte for byte', async () => {
  const h = await harness({ session: blockySession(), services: { attachments: stubStore() } })
  try {
    const res = await applyEdit(h.port, {
      sessionId: SESSION_ID,
      seq: 2,
      text: '改过的文字',
      parts: [{ keep: 0 }, { keep: 1 }, { keep: 2 }, { keep: 3 }],
    })
    assert.equal(res.status, 200, res.payload)
    assert.equal(res.json.applied, true)
    const content = carrierOf(h, res).data.content
    assert.equal(content.length, 4)
    assert.deepEqual(content[0], { type: 'text', text: '改过的文字' }, 'the revised text stands in the text block, in place')
    for (const index of [1, 2, 3]) {
      assert.equal(JSON.stringify(content[index]), JSON.stringify(BLOCKS[index]), `block ${index} must cross the edit byte for byte`)
    }
    assert.equal(res.json.dropped, false)
    // The derived context carries the blocks too: the model sees the picture,
    // not a note about a picture.
    const derived = h.session.deriveMessages()
    const message = derived.find((entry) => entry.role === 'user')
    assert.deepEqual(message.content.map((block) => block.type), ['text', 'image', 'file', 'quote-card'])
    assert.equal(JSON.stringify(message.content[1]), JSON.stringify(BLOCKS[1]), 'and the picture the model sees is the original one')
  } finally {
    await h.close()
  }
})

test('a block the user removes is not written, and nothing else moves', async () => {
  const store = stubStore()
  const h = await harness({ session: blockySession(), services: { attachments: store } })
  try {
    const res = await applyEdit(h.port, {
      sessionId: SESSION_ID,
      seq: 2,
      text: '改过的文字',
      parts: [{ keep: 0 }, { keep: 2 }],
    })
    assert.equal(res.json.applied, true)
    const content = carrierOf(h, res).data.content
    assert.deepEqual(content.map((block) => block.type), ['text', 'file'])
    assert.equal(JSON.stringify(content[1]), JSON.stringify(BLOCKS[2]))
    assert.deepEqual(store.calls, [], 'removing a block asks the store for nothing')
  } finally {
    await h.close()
  }
})

test('the revised text lands where the original text block was', async () => {
  // The layout the real logs show as often as the other one: picture first.
  const blocks = [{ type: 'image', attachment: IMAGE_REF }, { type: 'text', text: '看图' }, { type: 'quote-card', payload: { page: 1 } }]
  const h = await harness({ session: blockySession(blocks), services: { attachments: stubStore() } })
  try {
    const res = await applyEdit(h.port, {
      sessionId: SESSION_ID,
      seq: 2,
      text: '改过的文字',
      parts: [{ keep: 0 }, { keep: 1 }, { keep: 2 }],
    })
    const content = carrierOf(h, res).data.content
    assert.deepEqual(content.map((block) => block.type), ['image', 'text', 'quote-card'])
    assert.equal(JSON.stringify(content[0]), JSON.stringify(blocks[0]), 'the picture did not move')
    assert.equal(JSON.stringify(content[2]), JSON.stringify(blocks[2]))
  } finally {
    await h.close()
  }
})

test('a block type this plugin has never seen travels like any other', async () => {
  const store = stubStore()
  const h = await harness({ session: blockySession(), services: { attachments: store } })
  try {
    const res = await applyEdit(h.port, {
      sessionId: SESSION_ID,
      seq: 2,
      text: '改过的文字',
      parts: [{ keep: 3 }, { keep: 0 }],
    })
    const content = carrierOf(h, res).data.content
    assert.equal(content.length, 2)
    // The text keeps ITS place from the original message, whatever order the
    // submitted list happened to name the blocks in: it stood before the card,
    // so it still does.
    assert.deepEqual(content.map((block) => block.type), ['text', 'quote-card'])
    assert.equal(JSON.stringify(content[1]), JSON.stringify(BLOCKS[3]), 'no field of it is interpreted')
    assert.deepEqual(store.calls, [])
  } finally {
    await h.close()
  }
})

test('a newly picked block is admitted through the store and cited by the carrier', async () => {
  const store = stubStore()
  const h = await harness({ session: blockySession(), services: { attachments: store } })
  try {
    const bytes = Buffer.from('png-bytes')
    const res = await applyEdit(h.port, {
      sessionId: SESSION_ID,
      seq: 2,
      text: '改过的文字',
      parts: [{ keep: 1 }, { add: { data: bytes.toString('base64'), mediaType: 'image/png', name: 'new.png' } }],
    })
    assert.equal(res.status, 200, res.payload)
    assert.equal(store.calls.length, 1)
    assert.equal(store.calls[0].kind, 'image')
    assert.equal(Buffer.from(store.calls[0].input.data).toString(), 'png-bytes')
    assert.equal(store.calls[0].input.name, 'new.png')
    const content = carrierOf(h, res).data.content
    assert.deepEqual(content.map((block) => block.type), ['text', 'image', 'image'])
    assert.equal(content[2].attachment.attachmentId, `sha256:${'c'.repeat(64)}`, 'the carrier cites what the store returned')
    // ...and the answer describes the blocks the carrier now carries, so the
    // editor can be reopened on the row it just rewrote.
    assert.deepEqual(res.json.blocks.map((block) => block.index), [1, 2])
  } finally {
    await h.close()
  }
})

test('a tag-along file is stored verbatim, not forced through the image path', async () => {
  const store = stubStore()
  const h = await harness({ session: blockySession(), services: { attachments: store } })
  try {
    const res = await applyEdit(h.port, {
      sessionId: SESSION_ID,
      seq: 2,
      text: '改过的文字',
      parts: [{ keep: 0 }, { add: { data: Buffer.from('pdf-bytes').toString('base64'), mediaType: 'application/pdf', name: 'new.pdf' } }],
    })
    assert.equal(res.status, 200, res.payload)
    assert.equal(store.calls[0].kind, 'file')
    const content = carrierOf(h, res).data.content
    assert.deepEqual(content.map((block) => block.type), ['text', 'file'])
    assert.equal(content[1].attachment.name, 'new.pdf')
  } finally {
    await h.close()
  }
})

test('a store that refuses an upload leaves the log exactly as it was', async () => {
  const store = {
    imageLimits: { mediaTypes: ['image/png'] },
    async saveImage() {
      throw new Error('Image batch exceeds the configured aggregate image-byte limit.')
    },
    async saveFile() {
      throw new Error('this deployment cannot store files')
    },
  }
  const h = await harness({ session: blockySession(), services: { attachments: store } })
  try {
    const before = h.session.seq
    const res = await applyEdit(h.port, {
      sessionId: SESSION_ID,
      seq: 2,
      text: '改过的文字',
      parts: [{ keep: 0 }, { add: { data: Buffer.from('x').toString('base64'), mediaType: 'image/png' } }],
    })
    assert.equal(res.status, 400, res.payload)
    assert.equal(res.json.code, 'attachment-refused')
    assert.equal(h.session.seq, before, 'a refused upload must not leave a rollback behind')
    assert.deepEqual(h.session.deriveMessages().find((entry) => entry.id === 'u1').content, BLOCKS)
  } finally {
    await h.close()
  }
})

test('a message rewritten on a deployment with no attachment store degrades to text only', async () => {
  // The store is the ONE thing that can turn bytes into a reference a session
  // may cite. Without it nothing new may be written - and nothing that is
  // already in the log may be promised either: the carrier is exactly what this
  // plugin wrote before blocks travelled, and the answer says what it cost.
  const h = await harness({ session: blockySession() })
  try {
    const state = await getState(h.port)
    assert.deepEqual(state.json.capabilities, { attachments: false, preview: false })
    const res = await applyEdit(h.port, {
      sessionId: SESSION_ID,
      seq: 2,
      text: '改过的文字',
      parts: [{ keep: 0 }, { keep: 1 }, { keep: 2 }, { keep: 3 }],
    })
    assert.equal(res.status, 200, res.payload)
    assert.equal(res.json.applied, true)
    assert.equal(res.json.dropped, true, 'the answer states what the save left behind')
    const carrier = carrierOf(h, res)
    assert.deepEqual(carrier.data.content, [{ type: 'text', text: '改过的文字' }])
    // Nothing broken was written: no block cites a reference, and the real
    // loader still reads the whole log.
    assert.equal(carrier.data.content.some((block) => block.attachment !== undefined), false)
    assert.equal(h.session.deriveMessages().length > 0, true)
    assert.equal(h.session.snapshotEvents().length, 6, 'one replacement event, and nothing else')
  } finally {
    await h.close()
  }
})

test('an unchanged save that keeps every block writes nothing at all', async () => {
  const store = stubStore()
  const h = await harness({ session: blockySession(), services: { attachments: store } })
  try {
    const before = h.session.seq
    const res = await applyEdit(h.port, {
      sessionId: SESSION_ID,
      seq: 2,
      text: '看图',
      parts: [{ keep: 0 }, { keep: 1 }, { keep: 2 }, { keep: 3 }],
    })
    assert.equal(res.status, 200, res.payload)
    assert.equal(res.json.applied, false)
    assert.equal(res.json.unchanged, true)
    assert.deepEqual(res.json.shadowed, [], 'nothing left the surface, so nothing may be hidden')
    assert.equal(res.json.dropped, false)
    assert.equal(h.session.seq, before, 'no replacement, no synthetic turn, no appended answer')
    assert.deepEqual(store.calls, [])
    // The editor gets the block list it opened with back, so a second save is
    // the same no-op rather than a rewrite that drops everything.
    assert.deepEqual(res.json.blocks.map((block) => block.index), [1, 2, 3])
  } finally {
    await h.close()
  }
})

test('a save that removes a block IS a change, even with the text untouched', async () => {
  const h = await harness({ session: blockySession(), services: { attachments: stubStore() } })
  try {
    const res = await applyEdit(h.port, { sessionId: SESSION_ID, seq: 2, text: '看图', parts: [{ keep: 0 }, { keep: 1 }] })
    assert.equal(res.status, 200, res.payload)
    assert.equal(res.json.applied, true, 'the message is not what it was')
    assert.deepEqual(carrierOf(h, res).data.content.map((block) => block.type), ['text', 'image'])
  } finally {
    await h.close()
  }
})

test('a client from before blocks travelled still works, and is told what it cost', async () => {
  const h = await harness({ session: blockySession(), services: { attachments: stubStore() } })
  try {
    const res = await applyEdit(h.port, { sessionId: SESSION_ID, seq: 2, text: '改过的文字' })
    assert.equal(res.status, 200, res.payload)
    assert.equal(res.json.applied, true)
    assert.deepEqual(carrierOf(h, res).data.content, [{ type: 'text', text: '改过的文字' }])
    assert.equal(res.json.dropped, true)
    // The same caller's unchanged save is still the no-op it was in 0.2.18:
    // text-only carriers are not compared against blocks the caller never saw.
    const again = await applyEdit(h.port, { sessionId: SESSION_ID, seq: res.json.replacementSeq, text: '改过的文字' })
    assert.equal(again.json.unchanged, true)
    assert.equal(again.json.applied, false)
  } finally {
    await h.close()
  }
})

test('the state describes what a prompt carries, and what this host can do', async () => {
  const store = stubStore()
  const h = await harness({ session: blockySession(), services: { attachments: store } })
  try {
    const res = await getState(h.port)
    assert.deepEqual(res.json.capabilities, { attachments: true, preview: false }, 'this stub store has no read seam')
    const turn = res.json.turns[0]
    assert.equal(turn.attachments, 3)
    assert.deepEqual(turn.blocks, [
      { index: 1, type: 'image', name: 'shot.png', mediaType: 'image/png', bytes: 1234, width: 4, height: 3, preview: false },
      { index: 2, type: 'file', name: 'notes.pdf', bytes: 5678, preview: false },
      { index: 3, type: 'quote-card', preview: false },
    ])
  } finally {
    await h.close()
  }
})

test('the attachment route serves the bytes of a cited block, and nothing else', async () => {
  const store = {
    ...stubStore(),
    async readImage(ref) {
      return { ref, data: Buffer.from('PNG!') }
    },
  }
  // A store that answers for one session only, so "another session's block" is
  // a real case and not an artefact of the stubs (the default stub answers for
  // whatever id it is asked about).
  const session = blockySession()
  const h = await harness({
    session,
    services: {
      attachments: store,
      sessions: { get: (id) => (id === SESSION_ID ? session : undefined), flush: async () => {} },
      sessionQuery: {
        readSession: async (id) => {
          if (id !== SESSION_ID) throw new Error('session-not-found')
          return { events: session.snapshotEvents() }
        },
      },
    },
  })
  try {
    const res = await raw(h.port, { path: `/dsh-edit-turn/attachment?sessionId=${SESSION_ID}&seq=2&index=1` })
    assert.equal(res.status, 200)
    assert.equal(res.payload, 'PNG!')
    assert.equal(res.head.includes('image/png'), true, 'the media type the reference declares')
    // A block with no attachment reference has no bytes to serve.
    const text = await raw(h.port, { path: `/dsh-edit-turn/attachment?sessionId=${SESSION_ID}&seq=2&index=0` })
    assert.equal(text.status, 404)
    // Nor does a message that does not exist, or another session's.
    const missing = await raw(h.port, { path: `/dsh-edit-turn/attachment?sessionId=${SESSION_ID}&seq=99&index=1` })
    assert.equal(missing.status, 404)
    const foreign = await raw(h.port, { path: '/dsh-edit-turn/attachment?sessionId=session-99999999-2222-4333-8444-555555555555&seq=2&index=1' })
    assert.equal(foreign.status, 404)
    const post = await raw(h.port, { method: 'POST', path: `/dsh-edit-turn/attachment?sessionId=${SESSION_ID}&seq=2&index=1`, body: '{}' })
    assert.equal(post.status, 405)
    const bad = await raw(h.port, { path: `/dsh-edit-turn/attachment?sessionId=${SESSION_ID}&seq=x&index=1` })
    assert.equal(bad.status, 400)
  } finally {
    await h.close()
  }
})

test('a file block is served verbatim when the store backs it with a host path', async () => {
  const path = join(tmpdir(), `dshet-attachment-${process.pid}-${Date.now()}.pdf`)
  writeFileSync(path, 'PDF!')
  const store = {
    ...stubStore(),
    fileHostPath(ref) {
      return String(ref.attachmentId) === FILE_REF.attachmentId ? path : (() => { throw new Error('not a file reference') })()
    },
  }
  const h = await harness({ session: blockySession(), services: { attachments: store } })
  try {
    const res = await raw(h.port, { path: `/dsh-edit-turn/attachment?sessionId=${SESSION_ID}&seq=2&index=2` })
    assert.equal(res.status, 200)
    assert.equal(res.payload, 'PDF!')
    assert.equal(res.head.includes('application/octet-stream'), true, 'a verbatim file has no declared media type')
  } finally {
    await h.close()
    rmSync(path, { force: true })
  }
})

