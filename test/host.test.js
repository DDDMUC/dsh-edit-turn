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
import { createServer } from 'node:http'
import net from 'node:net'
import { test } from 'node:test'

import { Session } from '@deepseek-ai/dsh-session'
import { PLUGIN_ID, apply } from '../lib/index.js'
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
    { turn: 1, step: 1, message: { id: 'sys', role: 'system', content: [{ type: 'text', text: 'SYS' }], source: { kind: 'plugin', plugin: 'stub-bundle' } } },
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

  const ctx = {
    toolCalls,
    get(name) {
      if (options.services && name in options.services) return options.services[name]
      switch (name) {
        case 'sessions':
          return { get: () => session, flush: async () => {} }
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
    assert.equal(res.json.version, '0.1.0')
    assert.equal(res.json.config.confirm, true)
  } finally {
    await h.close()
  }
})

test('both routes are mounted, so a missing one never silently passes', async () => {
  const h = await harness()
  try {
    assert.deepEqual([...h.routes.keys()].sort(), ['/dsh-edit-turn/apply', '/dsh-edit-turn/state'])
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
    assert.equal(res.json.promptAccepted, true)
    assert.equal(res.json.flushed, true)
    assert.deepEqual(res.json.shadowed, [2, 3, 6, 7, 8])

    // The log grew by exactly one event: the replacement, append-only.
    assert.equal(h.session.seq, before + 1)

    // The derived model context is exactly the surviving system prompt: the
    // default carrier is an empty dormant system node, so it adds no message.
    const derived = h.session.deriveMessages()
    assert.equal(derived.length, 1)
    assert.equal(derived[0].content[0].text, 'SYS')
    assert.deepEqual(foldSurface(h.session.snapshotEvents()).nodes, [1, res.json.replacementSeq])

    // Exactly one prompt was admitted, carrying the revised text.
    assert.equal(h.prompts.length, 1)
    assert.equal(h.prompts[0].sessionId, SESSION_ID)
    assert.equal(h.prompts[0].mode, 'queue')
    assert.deepEqual(h.prompts[0].content, [{ type: 'text', text: 'revised prompt' }])
    assert.equal(typeof h.prompts[0].requestId, 'string')
    assert.ok(h.prompts[0].requestId.length > 0)
  } finally {
    await h.close()
  }
})

test('the carrier lands with complete shadow coverage and a plugin source', async () => {
  const h = await harness()
  try {
    const res = await applyEdit(h.port, { sessionId: SESSION_ID, seq: 2, text: 'revised' })
    const carrier = h.session.snapshotEvents().find((event) => event.seq === res.json.replacementSeq)
    assert.equal(carrier.type, 'system/message')
    assert.deepEqual(carrier.sourceEventSeqs, [2, 3, 6, 7, 8])
    assert.deepEqual(carrier.surfaceOp, { op: 'replace', startSeq: 2, endSeq: 8 })
    assert.deepEqual(carrier.data.message.source, { kind: 'plugin', plugin: PLUGIN_ID })
    assert.deepEqual(carrier.data.message.content, [])
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
    assert.deepEqual(res.json.hidden.map((entry) => entry.seq), [2, 3, 6, 7, 8])
    assert.deepEqual(res.json.hidden.map((entry) => entry.turn), [1, 1, 2, 2, 2])
    assert.deepEqual(res.json.surface, (await getState(h.port)).json.surface)
    assert.equal(res.json.edits, 1)
    assert.deepEqual(res.json.turns, [])
  } finally {
    await h.close()
  }
})

test('editing the LAST turn keeps every earlier turn editable', async () => {
  const h = await harness()
  try {
    const res = await applyEdit(h.port, { sessionId: SESSION_ID, turn: 2, text: 'revised second' })
    assert.deepEqual(res.json.shadowed, [6, 7, 8])
    const state = await getState(h.port)
    assert.deepEqual(state.json.hidden.map((entry) => entry.seq), [6, 7, 8])
    assert.deepEqual(state.json.turns.map((turn) => turn.seq), [2])
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
    assert.deepEqual(carrier.data.content, [{ type: 'text', text: 'MARK' }])
    assert.equal(h.session.deriveMessages().length, 2)
  } finally {
    await h.close()
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
    assert.equal(h.prompts.length, 1)
    assert.equal(h.session.seq, 11)
  } finally {
    await h.close()
  }
})

test('an assistant row cannot be edited', async () => {
  const h = await harness()
  try {
    const res = await applyEdit(h.port, { sessionId: SESSION_ID, seq: 3, text: 'x' })
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

test('an unknown session id is a 404 and a malformed one a 400', async () => {
  const h = await harness({
    services: {
      sessionQuery: { readSession: async () => undefined },
      sessions: { get: () => undefined, flush: async () => {} },
    },
  })
  try {
    const missing = await getState(h.port)
    assert.equal(missing.status, 404)
    assert.equal(missing.json.code, 'session-not-found')
    const malformed = await getState(h.port, 'not-a-session')
    assert.equal(malformed.status, 400)
    assert.equal(malformed.json.code, 'invalid')
    const absent = await raw(h.port, { path: '/dsh-edit-turn/state' })
    assert.equal(absent.status, 400)
  } finally {
    await h.close()
  }
})

test('a failed re-run is reported without pretending the rollback failed', async () => {
  const services = {
    sessionController: {
      resolveAgent: async () => undefined,
      prompt: async () => {
        throw new Error('inbox closed')
      },
    },
  }
  const session = Session.create(SESSION_ID)
  buildTwoTurnLog(session)
  const h = await harness({ session, services })
  try {
    const res = await applyEdit(h.port, { sessionId: SESSION_ID, seq: 2, text: 'revised' })
    assert.equal(res.status, 200)
    assert.equal(res.json.promptAccepted, false)
    assert.match(res.json.promptError, /inbox closed/)
    assert.equal(session.deriveMessages().length, 1)
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
    assert.match(text, /2 editable turn\(s\), idle/)
    assert.match(text, /turn 1 \(seq 2/)
    assert.match(text, /original prompt/)
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
