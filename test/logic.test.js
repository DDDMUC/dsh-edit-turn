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
  admitUpload,
  assembleBlocks,
  blockSummaries,
  buildCarrier,
  buildCorrection,
  canPreviewAttachments,
  isTextBlock,
  normalizeParts,
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
  planBlockLayout,
  resolveAttachmentStore,
  sameJson,
  syncLoopTurn,
  planRollback,
  readMessageBlocks,
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

test('a prompt is rewritten in place: the window is exactly that message', () => {
  const log = twoTurnLog()
  const { nodes } = foldSurface(log)
  const plan = planRollback(log, nodes, { seq: 2 })
  assert.equal(plan.startSeq, 2)
  assert.equal(plan.endSeq, 2)
  assert.deepEqual(plan.shadowed, [2])
  assert.equal(plan.turn, 1)
  assert.equal(plan.original, '第一问')
})

test('a later prompt is rewritten in place too', () => {
  const log = twoTurnLog()
  const { nodes } = foldSurface(log)
  const plan = planRollback(log, nodes, { turn: 2 })
  assert.deepEqual(plan.shadowed, [6])
  assert.equal(plan.endSeq, 6)
})

test('a target resolves by durable messageId too', () => {
  const log = twoTurnLog()
  const { nodes } = foldSurface(log)
  assert.equal(planRollback(log, nodes, { messageId: 'u2' }).targetSeq, 6)
})

test('the window is always exactly the edited prompt', () => {
  const log = twoTurnLog()
  const { nodes } = foldSurface(log)
  for (const seq of [2, 6]) {
    const plan = planRollback(log, nodes, { seq })
    assert.deepEqual(plan.shadowed, [seq])
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
  // In place: the LATER prompt never left the surface, so it is still editable.
  const remaining = editableTurns(log, foldSurface(log).nodes)
  assert.equal(remaining.length, 1, 'the untouched later prompt stays editable')
  assert.notEqual(remaining[0].seq, 2, 'the shadowed prompt is gone from the editable set')
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
  assert.deepEqual(ledger.hidden.map((entry) => entry.seq), [2])
  assert.deepEqual(ledger.hidden.map((entry) => entry.turn), [1])
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

// --- the loop counter ---------------------------------------------------------

test('syncLoopTurn moves an idle loop forward, and nothing else', () => {
  const idle = { phase: { kind: 'idle', lastTurn: 2 } }
  assert.equal(syncLoopTurn(idle, 5), 'synced')
  assert.equal(idle.phase.lastTurn, 5, 'the loop opens the turn after the one we consumed')

  assert.equal(syncLoopTurn(idle, 5), 'already-current', 'never moves it backwards')
  assert.equal(idle.phase.lastTurn, 5)

  // Not our shape, or not idle: leave it alone rather than guessing.
  assert.equal(syncLoopTurn({ phase: { kind: 'running', lastTurn: 2 } }, 9), 'unavailable')
  assert.equal(syncLoopTurn({ phase: { kind: 'idle' } }, 9), 'unavailable')
  assert.equal(syncLoopTurn(null, 9), 'unavailable')
  assert.equal(syncLoopTurn(undefined, 9), 'unavailable')
})

// --- carrier ----------------------------------------------------------------

test('the default carrier is an empty dormant developer message', () => {
  const log = twoTurnLog()
  const plan = planRollback(log, foldSurface(log).nodes, { seq: 2 })
  const carrier = buildCarrier(plan, lastTurnOf(log), { carrier: 'system/message' })
  // Not a system/message: the format admits only system-prompt sources there,
  // and an empty plugin-owned system node makes every session that contains one
  // unreadable (SessionFormatError on load, after an accepted append).
  assert.equal(carrier.type, 'developer/message')
  assert.equal(carrier.data.message.role, 'developer')
  assert.deepEqual(carrier.data.message.content, [])
  assert.equal(carrier.data.message.source.kind, `plugin:${PLUGIN_ID}`)
  // Every replacement this plugin lands says who wrote it; a sibling plugin
  // that recognises replacements by `editedBy` must find this one too, even
  // when it carries no text at all.
  assert.equal(carrier.data.message.source.editedBy, PLUGIN_ID)
  assert.equal(carrier.data.turn, 2)
})

test('the fallback carrier is a non-empty user prompt that keeps kind "user"', () => {
  const log = twoTurnLog()
  const plan = planRollback(log, foldSurface(log).nodes, { seq: 2 })
  const carrier = buildCarrier(plan, lastTurnOf(log), { carrier: 'user/message', markerText: 'MARK' })
  assert.equal(carrier.type, 'user/message')
  assert.deepEqual(carrier.data.content, [{ type: 'text', text: 'MARK' }])
  assert.deepEqual(carrier.data.source, { kind: 'user', editedBy: PLUGIN_ID })
  assert.equal(carrier.data.role, 'user')
})

// --- the appended correction (editing a model reply) ------------------------

test('the correction is an assistant message the model will treat as its own', () => {
  const log = twoTurnLog()
  const plan = planRollback(log, foldSurface(log).nodes, { seq: 3 })
  const correction = buildCorrection(plan, '改写后的回答', 3, 1)
  assert.equal(correction.type, 'assistant/message')
  // The correction lands in the freshly opened turn, not in the original one:
  // by the time it is written, the original turn is closed, and the read path
  // refuses a step message outside an open turn and step.
  assert.equal(correction.data.turn, 3)
  assert.equal(correction.data.step, 1)
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

// --- blocks travel with the edit --------------------------------------------
//
// A revised message carries everything it carried before, not only its text. The
// rules are three: a block the user did not touch is copied verbatim, a block the
// user removed is not written, and the revised text goes back where the first
// text block was. Nothing below asks what a block IS - which is the whole point,
// because a block type the platform adds later has to travel the same way.

const IMAGE_REF = { attachmentId: `sha256:${'a'.repeat(64)}`, mediaType: 'image/png', width: 4, height: 3, bytes: 1234, name: 'shot.png' }
const FILE_REF = { attachmentId: `sha256:${'b'.repeat(64)}`, name: 'notes.pdf', bytes: 5678 }
const IMAGE_BLOCK = { type: 'image', attachment: IMAGE_REF }
const FILE_BLOCK = { type: 'file', attachment: FILE_REF }
// A block from a platform this plugin has never seen. Nothing in the edit path
// may need to know it: it is kept, copied and written like any other.
const ALIEN_BLOCK = { type: 'quote-card', payload: { quote: '引用卡片', source: '第 3 页' }, rank: 2 }

function blockyPrompt(blocks) {
  return ev(20, 'user/message', { id: 'ub', role: 'user', content: blocks, source: { kind: 'user' } }, append)
}

function keepAll(blocks) {
  return normalizeParts(blocks.map((_, index) => ({ keep: index })), blocks.length)
}

test('readMessageText and readMessageBlocks read the same blocks', () => {
  const blocks = [{ type: 'text', text: '看图' }, IMAGE_BLOCK]
  const event = blockyPrompt(blocks)
  assert.deepEqual(readMessageText(event), { text: '看图', attachments: 1 })
  assert.deepEqual(readMessageBlocks(event), blocks)
  assert.equal(isTextBlock(blocks[0]), true)
  assert.equal(isTextBlock(IMAGE_BLOCK), false)
  assert.equal(isTextBlock(null), false)
  // The reply shape nests its message one level deeper; the block readers do not
  // care which shape they were handed.
  const reply = ev(21, 'assistant/message', { turn: 1, step: 1, message: { id: 'a', role: 'assistant', content: [IMAGE_BLOCK] }, stream: [] }, append)
  assert.deepEqual(readMessageBlocks(reply), [IMAGE_BLOCK])
})

test('blockSummaries describes a block from its own fields, never from its type', () => {
  const blocks = [{ type: 'text', text: 'x' }, IMAGE_BLOCK, FILE_BLOCK, ALIEN_BLOCK]
  const summaries = blockSummaries(blocks, true)
  assert.deepEqual(summaries, [
    { index: 1, type: 'image', name: 'shot.png', mediaType: 'image/png', bytes: 1234, width: 4, height: 3, preview: true },
    { index: 2, type: 'file', name: 'notes.pdf', bytes: 5678, preview: true },
    // No attachment, so nothing to read and nothing to preview: the chip shows
    // the block's own name, which is all this knows.
    { index: 3, type: 'quote-card', preview: false },
  ])
  assert.equal(blockSummaries(blocks, false)[0].preview, false, 'a deployment with no read path promises no thumbnail')
})

test('a submitted block list names kept blocks and uploads, nothing else', () => {
  assert.deepEqual(normalizeParts([{ keep: 1 }, { add: { data: 'AA==', name: 'a.bin' } }], 3), [
    { keep: 1 },
    { add: { data: 'AA==', name: 'a.bin' } },
  ])
  const invalid = (value, count) => assert.throws(() => normalizeParts(value, count), (error) => error.code === 'invalid')
  invalid([{ keep: 3 }], 3)
  invalid([{ keep: -1 }], 3)
  invalid([{ keep: 1.5 }], 3)
  invalid([{ keep: 0 }, { keep: 0 }], 2)
  invalid([{}], 1)
  invalid([{ add: { name: 'no bytes' } }], 1)
  invalid([null], 1)
  invalid('nope', 1)
})

test('an untouched block crosses the edit verbatim, byte for byte', () => {
  const original = [
    { type: 'text', text: '第一段' },
    IMAGE_BLOCK,
    FILE_BLOCK,
    ALIEN_BLOCK,
    { type: 'text', text: '第二段' },
  ]
  const layout = planBlockLayout(original, keepAll(original))
  const content = assembleBlocks(original, layout, [], '改过的文字')
  // Two text blocks become one, at the first one's position; every other block
  // is exactly where it was and exactly what it was.
  assert.equal(content.length, 4)
  assert.deepEqual(content[0], { type: 'text', text: '改过的文字' })
  assert.deepEqual(content.map((block) => block.type), ['text', 'image', 'file', 'quote-card'])
  for (const index of [1, 2, 3]) {
    assert.equal(JSON.stringify(content[index]), JSON.stringify(original[index]))
    assert.notEqual(content[index], original[index], 'a copy, so nothing can reach back into the log')
  }
})

test('a block the user removes is simply not written', () => {
  const original = [{ type: 'text', text: 't' }, IMAGE_BLOCK, FILE_BLOCK]
  const parts = normalizeParts([{ keep: 0 }, { keep: 2 }], 3)
  const content = assembleBlocks(original, planBlockLayout(original, parts), [], 't2')
  assert.equal(content.length, 2)
  assert.deepEqual(content.map((block) => block.type), ['text', 'file'])
})

test('the revised text lands where the first text block was', () => {
  const textFirst = [{ type: 'text', text: 't' }, IMAGE_BLOCK]
  const imageFirst = [IMAGE_BLOCK, { type: 'text', text: 't' }]
  const betweenImages = [IMAGE_BLOCK, { type: 'text', text: 't' }, { ...IMAGE_BLOCK }]
  const after = assembleBlocks(textFirst, planBlockLayout(textFirst, keepAll(textFirst)), [], 'T')
  const before = assembleBlocks(imageFirst, planBlockLayout(imageFirst, keepAll(imageFirst)), [], 'T')
  const middle = assembleBlocks(betweenImages, planBlockLayout(betweenImages, keepAll(betweenImages)), [], 'T')
  assert.deepEqual(after.map((block) => block.type), ['text', 'image'])
  assert.deepEqual(before.map((block) => block.type), ['image', 'text'])
  assert.deepEqual(middle.map((block) => block.type), ['image', 'text', 'image'])
  assert.equal(JSON.stringify(before[0]), JSON.stringify(IMAGE_BLOCK), 'the image did not move')
  assert.equal(JSON.stringify(middle[2]), JSON.stringify(IMAGE_BLOCK), 'neither did the second one')
})

test('a message with no text block gets the text appended, not prepended', () => {
  const original = [IMAGE_BLOCK, ALIEN_BLOCK]
  const content = assembleBlocks(original, planBlockLayout(original, keepAll(original)), [], 'caption')
  assert.deepEqual(content.map((block) => block.type), ['image', 'quote-card', 'text'])
})

test('an added block lands where the user put it, and is not confused with a kept one', () => {
  const original = [{ type: 'text', text: 't' }, IMAGE_BLOCK]
  const added = { type: 'image', attachment: { ...IMAGE_REF, attachmentId: `sha256:${'c'.repeat(64)}` } }
  const parts = normalizeParts([{ keep: 1 }, { add: { data: 'AA==' } }], 2)
  const layout = planBlockLayout(original, parts)
  assert.equal(layout.added, 1)
  const content = assembleBlocks(original, layout, [added], 'T')
  assert.deepEqual(content.map((block) => block.type), ['text', 'image', 'image'])
  assert.equal(content[2], added)
})

test('sameJson compares values, not key order', () => {
  assert.equal(sameJson({ a: 1, b: [1, { c: 2 }] }, { b: [1, { c: 2 }], a: 1 }), true)
  assert.equal(sameJson([{ type: 'text', text: 'x' }], [{ text: 'x', type: 'text' }]), true)
  assert.equal(sameJson({ a: 1 }, { a: 1, b: undefined }), false)
  assert.equal(sameJson([1, 2], [1, 2, 3]), false)
  assert.equal(sameJson('a', 'a'), true)
  assert.equal(sameJson(null, {}), false)
  // The comparison the no-op guard makes: an edit that keeps everything and
  // changes nothing must land on the original blocks exactly.
  const original = [{ type: 'text', text: 't' }, IMAGE_BLOCK]
  const rebuilt = assembleBlocks(original, planBlockLayout(original, keepAll(original)), [], 't')
  assert.equal(sameJson(rebuilt, original), true)
  assert.equal(sameJson(assembleBlocks(original, planBlockLayout(original, keepAll(original)), [], 't '), original), false)
})

test('an upload becomes whichever block the store accepts it as', async () => {
  const calls = []
  const store = {
    imageLimits: { mediaTypes: ['image/png', 'image/jpeg'] },
    async saveImage(input) {
      calls.push(['image', input])
      return IMAGE_REF
    },
    async saveFile(input) {
      calls.push(['file', input])
      return FILE_REF
    },
  }
  const png = await admitUpload(store, { data: Buffer.from('png-bytes').toString('base64'), mediaType: 'image/png', name: 'shot.png' })
  assert.deepEqual(png, { type: 'image', attachment: IMAGE_REF })
  assert.equal(calls[0][1].mediaType, 'image/png')
  assert.equal(calls[0][1].name, 'shot.png')
  assert.equal(Buffer.from(calls[0][1].data).toString(), 'png-bytes')
  const pdf = await admitUpload(store, { data: Buffer.from('file-bytes').toString('base64'), mediaType: 'application/pdf', name: 'notes.pdf' })
  assert.deepEqual(pdf, { type: 'file', attachment: FILE_REF })
  assert.equal(Buffer.from(calls[1][1].data).toString(), 'file-bytes')
  const nameless = await admitUpload(store, { data: Buffer.from('x').toString('base64') })
  assert.deepEqual(nameless, { type: 'file', attachment: FILE_REF }, 'a payload with no declared type is stored verbatim')
  assert.deepEqual(calls[2][1], { data: calls[2][1].data })
})

test('a store that refuses a payload produces a refusal, not a broken block', async () => {
  const store = {
    imageLimits: { mediaTypes: ['image/png'] },
    async saveImage() {
      throw new Error('Image batch exceeds the configured aggregate image-byte limit.')
    },
  }
  await assert.rejects(
    () => admitUpload(store, { data: Buffer.from('x').toString('base64'), mediaType: 'image/png' }),
    (error) => error.code === 'attachment-refused' && error.status === 400 && /aggregate/.test(error.message),
  )
  // Nothing the platform's own wire admission would refuse may reach the store.
  await assert.rejects(
    () => admitUpload(store, { data: 'not base64 at all!!', mediaType: 'image/png' }),
    (error) => error.code === 'invalid',
  )
  await assert.rejects(() => admitUpload(store, { data: '' }), (error) => error.code === 'invalid')
})

test('the attachment store is only used when the deployment really has one', () => {
  const store = { saveImage() {}, saveFile() {} }
  const named = (name) => ({ get: (asked) => (asked === name ? store : undefined) })
  assert.equal(resolveAttachmentStore(named('attachments')), store)
  assert.equal(resolveAttachmentStore(named('attachment-local')), store, 'the package spelling is accepted too')
  assert.equal(resolveAttachmentStore({ get: () => undefined }), null)
  assert.equal(resolveAttachmentStore({ get: () => ({}) }), null, 'a service that cannot admit anything is not a store')
  assert.equal(resolveAttachmentStore({ get: () => ({ saveImage: true }) }), null, 'nor is one whose methods are not callable')
  assert.equal(
    resolveAttachmentStore({
      get: () => {
        throw new Error('unknown service')
      },
    }),
    null,
    'a context that refuses the lookup is an absent store, not a crash',
  )
  assert.equal(resolveAttachmentStore(null), null)
  assert.equal(resolveAttachmentStore({}), null)
  assert.equal(canPreviewAttachments(store), false, 'a store with no read seam draws no thumbnails')
  assert.equal(canPreviewAttachments({ readImage() {} }), true)
  assert.equal(canPreviewAttachments({ fileHostPath() {} }), true)
  assert.equal(canPreviewAttachments(null), false)
})

test('the carrier carries the block list it is given', () => {
  const log = twoTurnLog()
  const plan = planRollback(log, foldSurface(log).nodes, { seq: 2 })
  const content = [{ type: 'text', text: 'MARK' }, IMAGE_BLOCK]
  const carrier = buildCarrier(plan, lastTurnOf(log), { carrier: 'user/message', markerText: 'MARK' }, content)
  assert.deepEqual(carrier.data.content, content)
  // The developer carrier never carries blocks: nothing may project into the
  // model's context from a silent replacement.
  const silent = buildCarrier(plan, lastTurnOf(log), { carrier: 'system/message' }, content)
  assert.deepEqual(silent.data.message.content, [])
})

test('editableTurns publishes the blocks a prompt carries', () => {
  const log = twoTurnLog()
  log.splice(2, 0, blockyPrompt([{ type: 'text', text: '看图' }, IMAGE_BLOCK, ALIEN_BLOCK]))
  const turns = editableTurns(log, foldSurface(log).nodes, { preview: true })
  const blocky = turns.find((turn) => turn.seq === 20)
  assert.deepEqual(blocky.blocks.map((block) => block.index), [1, 2])
  assert.equal(blocky.blocks[0].preview, true)
  assert.equal(blocky.blocks[1].preview, false, 'a block with no attachment reference has nothing to preview')
  const plain = turns.find((turn) => turn.seq === 2)
  assert.deepEqual(plain.blocks, [], 'a message with only text has no chips')
})

