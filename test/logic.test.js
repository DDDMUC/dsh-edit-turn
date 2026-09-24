// Pure-logic tests for dsh-edit-turn.
//
// These run against synthetic event arrays with no DSH server and no model
// call. They cover the decisions that are cheap to get wrong and expensive to
// notice: which rows may be edited, where the rollback window ends, and how the
// client ledger is rebuilt from the log alone.
//
//   node --test "test/*.test.js"
import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  PLUGIN_ID,
  buildCarrier,
  buildCorrection,
  editableReplies,
  editableTurns,
  foldSurface,
  isAssistantReply,
  isBusy,
  isHumanPrompt,
  isSurfaceEvent,
  lastTurnOf,
  messageIdOf,
  noteRequest,
  openTurn,
  planRollback,
  readMessageText,
  recentRequests,
  rollbackLedger,
  turnIndex,
} from '../lib/index.js'

// --- fixtures ---------------------------------------------------------------

function ev(seq, type, data, extra) {
  return { type, seq, time: 1_700_000_000_000 + seq, data, ...extra }
}

const append = { surfaceOp: 'append' }

/** system, u1, a1 | u2, tool-result, a2 - two completed turns. */
function twoTurnLog() {
  return [
    ev(0, 'turn/start', { turn: 1 }),
    ev(1, 'system/message', { turn: 1, step: 1, message: { id: 'sys', role: 'system', content: [{ type: 'text', text: 'SYS' }] } }, append),
    ev(2, 'user/message', { id: 'u1', role: 'user', content: [{ type: 'text', text: '第一问' }], source: { kind: 'user' } }, append),
    ev(3, 'assistant/message', { turn: 1, step: 1, message: { id: 'a1', role: 'assistant', content: [{ type: 'text', text: '第一答' }] }, stream: [] }, append),
    ev(4, 'turn/end', { turn: 1, reason: { kind: 'completed' } }),
    ev(5, 'turn/start', { turn: 2 }),
    ev(6, 'user/message', { id: 'u2', role: 'user', content: [{ type: 'text', text: '第二问' }], source: { kind: 'user' } }, append),
    ev(7, 'tool/result', { turn: 2, step: 1, message: { id: 't1', role: 'user', content: [{ type: 'tool-result', toolCallId: 'c1' }] } }, append),
    ev(8, 'assistant/message', { turn: 2, step: 1, message: { id: 'a2', role: 'assistant', content: [{ type: 'text', text: '第二答' }] }, stream: [] }, append),
    ev(9, 'turn/end', { turn: 2, reason: { kind: 'completed' } }),
  ]
}

// --- surface fold -----------------------------------------------------------

test('foldSurface collects append nodes in order', () => {
  const { nodes, replacements } = foldSurface(twoTurnLog())
  assert.deepEqual(nodes, [1, 2, 3, 6, 7, 8])
  assert.deepEqual(replacements, [])
})

test('foldSurface swaps an inclusive window for the replacing node', () => {
  const log = twoTurnLog()
  // Replace [u1(2) .. a2(8)] with the node at seq 10.
  log.push(
    ev(10, 'system/message', { turn: 2, step: 1, message: { id: 'c', role: 'system', content: [] } }, {
      surfaceOp: { op: 'replace', startSeq: 2, endSeq: 8 },
      sourceEventSeqs: [2, 3, 6, 7, 8],
    }),
  )
  const { nodes, replacements } = foldSurface(log)
  assert.deepEqual(nodes, [1, 10])
  assert.equal(replacements.length, 1)
  assert.deepEqual(replacements[0].shadowed, [2, 3, 6, 7, 8])
})

test('foldSurface ignores a replacement whose anchors are gone', () => {
  const log = twoTurnLog()
  log.push(
    ev(10, 'user/message', { id: 'x', role: 'user', content: [{ type: 'text', text: 'x' }], source: { kind: 'plugin', plugin: PLUGIN_ID } }, {
      surfaceOp: { op: 'replace', startSeq: 999, endSeq: 1000 },
      sourceEventSeqs: [999, 1000],
    }),
  )
  assert.deepEqual(foldSurface(log).nodes, [1, 2, 3, 6, 7, 8])
})

test('isSurfaceEvent accepts exactly the four message-producing types', () => {
  for (const type of ['system/message', 'user/message', 'assistant/message', 'tool/result']) {
    assert.equal(isSurfaceEvent({ type }), true, type)
  }
  for (const type of ['turn/start', 'turn/end', 'tool/call', 'step/start', 'session/end-seed']) {
    assert.equal(isSurfaceEvent({ type }), false, type)
  }
})

// --- turns ------------------------------------------------------------------

test('turnIndex maps assistant and tool events to their own turn', () => {
  const turnOf = turnIndex(twoTurnLog())
  assert.equal(turnOf.get(1), 1)
  assert.equal(turnOf.get(2), 1) // user message: from the bracket
  assert.equal(turnOf.get(6), 2)
  assert.equal(turnOf.get(7), 2)
})

test('openTurn reports the unclosed turn', () => {
  assert.equal(openTurn(twoTurnLog()), null)
  assert.equal(openTurn(twoTurnLog().slice(0, 8)), 2)
})

test('isBusy is true while a turn is open and while compaction runs', () => {
  assert.equal(isBusy(twoTurnLog()), false)
  assert.equal(isBusy(twoTurnLog().slice(0, 8)), true)
  assert.equal(isBusy([...twoTurnLog(), ev(20, 'compaction/start', {})]), true)
  assert.equal(isBusy([...twoTurnLog(), ev(20, 'compaction/start', {}), ev(21, 'compaction/end', {})]), false)
})

test('lastTurnOf finds the highest turn', () => {
  assert.equal(lastTurnOf(twoTurnLog()), 2)
  assert.equal(lastTurnOf([]), undefined)
})

// --- prompt recognition -----------------------------------------------------

test('only source.kind === user counts as a human prompt', () => {
  const [prompt] = twoTurnLog().filter((event) => event.data && event.data.id === 'u1')
  assert.equal(isHumanPrompt(prompt), true)
  const injected = ev(30, 'user/message', { id: 'i', role: 'user', content: [{ type: 'text', text: 'ctx' }], source: { kind: 'plugin', plugin: 'other' } })
  assert.equal(isHumanPrompt(injected), false)
  assert.equal(isHumanPrompt(ev(31, 'assistant/message', {})), false)
})

test('readMessageText joins text blocks and counts attachments', () => {
  const event = ev(40, 'user/message', {
    id: 'u',
    role: 'user',
    content: [{ type: 'text', text: 'a' }, { type: 'image', mediaType: 'image/png', data: 'x' }, { type: 'text', text: 'b' }],
    source: { kind: 'user' },
  })
  assert.deepEqual(readMessageText(event), { text: 'a\nb', attachments: 1 })
})

test('messageIdOf reads the durable id of each surface type', () => {
  const log = twoTurnLog()
  assert.equal(messageIdOf(log[2]), 'u1')
  assert.equal(messageIdOf(log[3]), 'a1')
  assert.equal(messageIdOf(log[7]), 't1')
  assert.equal(messageIdOf(log[0]), undefined)
})

// --- planning ---------------------------------------------------------------

test('the rollback window opens at the prompt and ends at the last surface node', () => {
  const log = twoTurnLog()
  const { nodes } = foldSurface(log)
  const plan = planRollback(log, nodes, { seq: 2 })
  assert.equal(plan.startSeq, 2)
  assert.equal(plan.endSeq, 8)
  assert.deepEqual(plan.shadowed, [2, 3, 6, 7, 8])
  assert.equal(plan.turn, 1)
  assert.equal(plan.original, '第一问')
})

test('a later prompt narrows the window to just its own turn', () => {
  const log = twoTurnLog()
  const { nodes } = foldSurface(log)
  const plan = planRollback(log, nodes, { turn: 2 })
  assert.deepEqual(plan.shadowed, [6, 7, 8])
  assert.equal(plan.endSeq, 8)
})

test('a target resolves by durable messageId too', () => {
  const log = twoTurnLog()
  const { nodes } = foldSurface(log)
  assert.equal(planRollback(log, nodes, { messageId: 'u2' }).targetSeq, 6)
})

test('the window is always contiguous and ends on the tail', () => {
  const log = twoTurnLog()
  const { nodes } = foldSurface(log)
  for (const seq of [2, 6]) {
    const plan = planRollback(log, nodes, { seq })
    const startIdx = nodes.indexOf(plan.startSeq)
    assert.deepEqual(plan.shadowed, nodes.slice(startIdx))
  }
})

test('the system prompt head is never editable', () => {
  const log = twoTurnLog()
  const { nodes } = foldSurface(log)
  assert.throws(() => planRollback(log, nodes, { seq: 1 }), (error) => error.code === 'not-editable')
  assert.throws(() => planRollback(log, nodes, { seq: nodes[0] }), (error) => error.code === 'not-editable')
})

test('tool results and injected rows are not editable', () => {
  const log = twoTurnLog()
  log.push(ev(11, 'user/message', { id: 'inj', role: 'user', content: [{ type: 'text', text: 'ctx' }], source: { kind: 'plugin', plugin: 'x' } }, append))
  const { nodes } = foldSurface(log)
  for (const seq of [7, 11]) {
    assert.throws(() => planRollback(log, nodes, { seq }), (error) => error.code === 'not-editable', `seq ${seq}`)
  }
})

test('a model reply is planned as a reply edit that re-runs nothing', () => {
  const log = twoTurnLog()
  const { nodes } = foldSurface(log)
  const plan = planRollback(log, nodes, { seq: 3 })
  assert.equal(plan.mode, 'reply')
  assert.equal(plan.original, '第一答')
  assert.equal(plan.turn, 1)
  assert.equal(plan.step, 1)
  // The window still runs to the tail: a corrected answer invalidates everything
  // that was built on top of it.
  assert.deepEqual(plan.shadowed, [3, 6, 7, 8])
})

test('a prompt editing target reports the prompt mode', () => {
  const log = twoTurnLog()
  const { nodes } = foldSurface(log)
  assert.equal(planRollback(log, nodes, { seq: 2 }).mode, 'prompt')
})

test('editableReplies lists replies with text, in conversation order', () => {
  const log = twoTurnLog()
  const { nodes } = foldSurface(log)
  const replies = editableReplies(log, nodes)
  assert.deepEqual(replies.map((entry) => entry.seq), [3, 8])
  assert.deepEqual(replies.map((entry) => entry.text), ['第一答', '第二答'])
  assert.deepEqual(replies.map((entry) => entry.turn), [1, 2])
  assert.equal(replies[0].attachments, 0)
})

test('a reply with no text is not offered for editing', () => {
  const log = twoTurnLog()
  // A step that only produced tool calls has nothing to put in a text editor.
  log.push(ev(12, 'assistant/message', { turn: 2, step: 2, message: { id: 'a3', role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'c9', toolName: 'x', input: {} }], source: { kind: 'model', provider: 'p', model: 'm' } }, stream: [] }, append))
  const { nodes } = foldSurface(log)
  assert.deepEqual(editableReplies(log, nodes).map((entry) => entry.seq), [3, 8])
})

test('a reply carrying tool calls is offered, and counts them as non-text parts', () => {
  const log = twoTurnLog()
  log.push(ev(12, 'assistant/message', {
    turn: 2,
    step: 2,
    message: {
      id: 'a3',
      role: 'assistant',
      content: [
        { type: 'text', text: '我来查一下' },
        { type: 'tool-call', toolCallId: 'c9', toolName: 'x', input: {} },
      ],
      source: { kind: 'model', provider: 'p', model: 'm' },
    },
    stream: [],
  }, append))
  const { nodes } = foldSurface(log)
  const last = editableReplies(log, nodes).at(-1)
  assert.equal(last.seq, 12)
  assert.equal(last.text, '我来查一下')
  assert.equal(last.attachments, 1)
})

test('a shadowed reply is no longer offered', () => {
  const log = twoTurnLog()
  const first = planRollback(log, foldSurface(log).nodes, { seq: 3 })
  log.push(
    ev(12, 'system/message', { turn: 2, step: 1, message: { id: 'c', role: 'system', content: [], source: { kind: 'plugin', plugin: PLUGIN_ID } } }, {
      surfaceOp: { op: 'replace', startSeq: first.startSeq, endSeq: first.endSeq },
      sourceEventSeqs: first.shadowed,
    }),
  )
  assert.deepEqual(editableReplies(log, foldSurface(log).nodes), [])
})

test('an already shadowed prompt is refused as stale rather than replanned', () => {
  const log = twoTurnLog()
  const { nodes } = foldSurface(log)
  const plan = planRollback(log, nodes, { seq: 2 })
  log.push(
    ev(12, 'system/message', { turn: 2, step: 1, message: { id: 'c', role: 'system', content: [] } }, {
      surfaceOp: { op: 'replace', startSeq: plan.startSeq, endSeq: plan.endSeq },
      sourceEventSeqs: plan.shadowed,
    }),
  )
  const refolded = foldSurface(log).nodes
  assert.throws(() => planRollback(log, refolded, { seq: 2 }), (error) => error.code === 'already-rolled-back')
})

test('a missing target is refused', () => {
  const log = twoTurnLog()
  const { nodes } = foldSurface(log)
  assert.throws(() => planRollback(log, nodes, {}), (error) => error.code === 'not-editable')
  assert.throws(() => planRollback(log, nodes, { seq: 404 }), (error) => error.code === 'not-editable')
})

// --- editable turn list -----------------------------------------------------

test('editableTurns lists human prompts in conversation order, minus the head', () => {
  const log = twoTurnLog()
  const { nodes } = foldSurface(log)
  const turns = editableTurns(log, nodes)
  assert.deepEqual(turns.map((turn) => turn.seq), [2, 6])
  assert.deepEqual(turns.map((turn) => turn.turn), [1, 2])
  assert.equal(turns[0].messageId, 'u1')
  assert.equal(turns[1].text, '第二问')
})

test('editableTurns drops a prompt an earlier rollback shadowed', () => {
  const log = twoTurnLog()
  const first = planRollback(log, foldSurface(log).nodes, { seq: 2 })
  log.push(
    ev(12, 'system/message', { turn: 2, step: 1, message: { id: 'c', role: 'system', content: [] } }, {
      surfaceOp: { op: 'replace', startSeq: first.startSeq, endSeq: first.endSeq },
      sourceEventSeqs: first.shadowed,
    }),
  )
  assert.deepEqual(editableTurns(log, foldSurface(log).nodes), [])
})

// --- ledger -----------------------------------------------------------------

test('rollbackLedger records the shadowed seqs and their turns', () => {
  const log = twoTurnLog()
  const first = planRollback(log, foldSurface(log).nodes, { seq: 2 })
  log.push(
    ev(
      12,
      'system/message',
      { turn: 2, step: 1, message: { id: 'c', role: 'system', content: [], source: { kind: 'plugin', plugin: PLUGIN_ID } } },
      {
        surfaceOp: { op: 'replace', startSeq: first.startSeq, endSeq: first.endSeq },
        sourceEventSeqs: first.shadowed,
      },
    ),
  )
  const ledger = rollbackLedger(log)
  assert.deepEqual(ledger.hidden.map((entry) => entry.seq), [2, 3, 6, 7, 8])
  assert.deepEqual(ledger.hidden.map((entry) => entry.turn), [1, 1, 2, 2, 2])
  assert.equal(ledger.edits.length, 1)
  assert.equal(ledger.edits[0].replacementSeq, 12)
})

test('rollbackLedger ignores a replacement another producer landed', () => {
  const log = twoTurnLog()
  const first = planRollback(log, foldSurface(log).nodes, { seq: 6 })
  log.push(
    ev(12, 'user/message', { id: 'c', role: 'user', content: [{ type: 'text', text: 'summary' }], source: { kind: 'plugin', plugin: 'compact' } }, {
      surfaceOp: { op: 'replace', startSeq: first.startSeq, endSeq: first.endSeq },
      sourceEventSeqs: first.shadowed,
    }),
  )
  assert.deepEqual(rollbackLedger(log).hidden, [])
})

// --- carrier ----------------------------------------------------------------

test('the default carrier is an empty dormant system message', () => {
  const log = twoTurnLog()
  const plan = planRollback(log, foldSurface(log).nodes, { seq: 2 })
  const carrier = buildCarrier(plan, lastTurnOf(log), { carrier: 'system/message' })
  assert.equal(carrier.type, 'system/message')
  assert.deepEqual(carrier.data.message.content, [])
  assert.equal(carrier.data.message.source.kind, `plugin:${PLUGIN_ID}`)
  assert.equal(carrier.data.turn, 2)
})

test('the fallback carrier is a non-empty plugin-sourced user message', () => {
  const log = twoTurnLog()
  const plan = planRollback(log, foldSurface(log).nodes, { seq: 2 })
  const carrier = buildCarrier(plan, lastTurnOf(log), { carrier: 'user/message', markerText: 'MARK' })
  assert.equal(carrier.type, 'user/message')
  assert.deepEqual(carrier.data.content, [{ type: 'text', text: 'MARK' }])
  assert.deepEqual(carrier.data.source, { kind: `plugin:${PLUGIN_ID}` })
  assert.equal(carrier.data.role, 'user')
})

// --- the appended correction (editing a model reply) ------------------------

test('the correction is an assistant message the model will treat as its own', () => {
  const log = twoTurnLog()
  const plan = planRollback(log, foldSurface(log).nodes, { seq: 3 })
  const correction = buildCorrection(plan, '改写后的回答')
  assert.equal(correction.type, 'assistant/message')
  assert.equal(correction.data.turn, plan.turn)
  assert.equal(correction.data.step, plan.step)
  assert.equal(correction.data.message.role, 'assistant')
  assert.deepEqual(correction.data.message.content, [{ type: 'text', text: '改写后的回答' }])
  assert.equal(typeof correction.data.message.id, 'string')
  assert.ok(correction.data.message.id.length > 0)
  assert.equal(Array.isArray(correction.data.stream), true)
})

test('the correction stays a model reply and records who wrote the text', () => {
  const log = twoTurnLog()
  const plan = planRollback(log, foldSurface(log).nodes, { seq: 3 })
  const source = buildCorrection(plan, 'x').data.message.source
  // `kind: model` so it renders and projects exactly like an ordinary reply ...
  assert.equal(source.kind, 'model')
  // ... plus an honest marker that these words are not the model's.
  assert.equal(source.editedBy, PLUGIN_ID)
})

test('the correction carries over the provider that produced the original', () => {
  const log = twoTurnLog()
  log[3].data.message.source = { kind: 'model', provider: 'stepfun', model: 'step-5-preview' }
  const plan = planRollback(log, foldSurface(log).nodes, { seq: 3 })
  const source = buildCorrection(plan, 'x').data.message.source
  assert.equal(source.provider, 'stepfun')
  assert.equal(source.model, 'step-5-preview')
  assert.equal(source.editedBy, PLUGIN_ID)
})

test('the correction always carries turn and step', () => {
  const log = twoTurnLog()
  const plan = planRollback(log, foldSurface(log).nodes, { seq: 3 })
  // The client keys a reply node by turn:step, so a missing step would make two
  // corrections collide on "undefined:undefined".
  const correction = buildCorrection({ ...plan, turn: null, step: null }, 'x')
  assert.equal(correction.data.turn, 0)
  assert.equal(correction.data.step, 1)
})

test('isAssistantReply tells replies apart from prompts and tool results', () => {
  const log = twoTurnLog()
  assert.equal(isAssistantReply(log.find((event) => event.type === 'assistant/message')), true)
  assert.equal(isAssistantReply(log.find((event) => event.type === 'user/message')), false)
  assert.equal(isAssistantReply(log.find((event) => event.type === 'tool/result')), false)
  assert.equal(isAssistantReply(undefined), false)
})

test('the request log records failures too, and stays bounded', () => {
  const before = recentRequests().length
  noteRequest({ kind: 'state', ok: false, code: 'session-not-found', sessionId: 'x' })
  const after = recentRequests()
  // A failure is exactly the entry a diagnosis needs: "the client asked and got
  // nothing" must not look like "the client never asked".
  assert.equal(after.length >= before + 1, true)
  assert.deepEqual(
    after.at(-1),
    { at: after.at(-1).at, kind: 'state', ok: false, code: 'session-not-found', sessionId: 'x' },
  )
  for (let index = 0; index < 60; index += 1) noteRequest({ kind: 'state', ok: true, n: index })
  assert.equal(recentRequests().length, 40, 'the ring drops the oldest')
  assert.equal(recentRequests().at(-1).n, 59)
})
