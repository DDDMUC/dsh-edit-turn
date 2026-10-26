// Pure tests for the in-place patch layer: payload validation, block
// selection, projection composition and the log overlay the browser half reads.
//
//   node --test "test/*.test.js"
import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  INSERT_INDEX_BASE,
  PATCH_TYPE,
  applyTargetsToMessage,
  buildPatchData,
  editableBlocks,
  kindOfBlock,
  patchList,
  patchProjection,
  patchesOf,
  projectedBlocks,
  validatePatchData,
} from '../lib/patch.js'

const message = () => ({
  id: 'a1',
  role: 'assistant',
  content: [
    { type: 'thinking', text: 'OLD THINK', signature: 'sig-1', thinkingSignature: 'sig-2' },
    { type: 'text', text: 'OLD ANSWER' },
    { type: 'tool-call', id: 'c1', name: 'read_file', arguments: '{}' },
  ],
  source: { kind: 'model', provider: 'p', model: 'm' },
})

function ev(seq, type, data, extra) {
  return { type, seq, time: 1_700_000_000_000 + seq, data, ...extra }
}

test('editableBlocks lists text and reasoning in message order', () => {
  assert.deepEqual(
    editableBlocks(message()),
    [
      { index: 0, kind: 'reasoning', text: 'OLD THINK' },
      { index: 1, kind: 'text', text: 'OLD ANSWER' },
    ],
  )
  assert.equal(kindOfBlock({ type: 'tool-call' }), null)
  assert.equal(kindOfBlock({ type: 'thinking', text: '' }), 'reasoning')
})

test('every text and reasoning block is editable, whatever field carries it', () => {
  const blocks = editableBlocks({
    content: [
      { type: 'reasoning', reasoning: 'R1' },
      { type: 'text', text: 'T1' },
      { type: 'thinking', thinking: 'R2' },
      { type: 'text', text: 'T2' },
      { type: 'tool-call', id: 'c1' },
    ],
  })
  assert.deepEqual(blocks, [
    { index: 0, kind: 'reasoning', text: 'R1' },
    { index: 1, kind: 'text', text: 'T1' },
    { index: 2, kind: 'reasoning', text: 'R2' },
    { index: 3, kind: 'text', text: 'T2' },
  ])
  const patched = applyTargetsToMessage(
    { content: [{ type: 'reasoning', reasoning: 'OLD' }] },
    [{ seq: 1, blockIndex: 0, kind: 'reasoning', text: 'NEW' }],
  )
  assert.equal(patched.content[0].reasoning, 'NEW', 'the field the block used is the field that is rewritten')
})

test('buildPatchData validates shape, bounds and kind', () => {
  const data = buildPatchData([{ seq: 4, blockIndex: 1, kind: 'text', text: 'NEW' }])
  assert.deepEqual(data, { version: 2, targets: [{ seq: 4, blockIndex: 1, kind: 'text', text: 'NEW' }] })
  for (const bad of [
    null,
    {},
    { version: 2, targets: [] },
    { version: 1, targets: [] },
    { version: 1, targets: [{ seq: -1, blockIndex: 0, kind: 'text', text: 'x' }] },
    { version: 1, targets: [{ seq: 1, blockIndex: 1.5, kind: 'text', text: 'x' }] },
    { version: 1, targets: [{ seq: 1, blockIndex: 0, kind: 'tool', text: 'x' }] },
    { version: 1, targets: [{ seq: 1, blockIndex: 0, kind: 'text', text: 3 }] },
    { version: 3, targets: [{ seq: 1, blockIndex: 0, kind: 'text', text: 'x' }] },
    // Inserts need a stable id and a position; a position alone is not an identity.
    { version: 2, targets: [{ seq: 1, kind: 'text', text: 'x', insert: { position: 0 } }] },
    { version: 2, targets: [{ seq: 1, kind: 'text', text: 'x', insert: { id: '', position: 0 } }] },
    { version: 2, targets: [{ seq: 1, kind: 'text', text: 'x', insert: { id: 'a', position: -1 } }] },
  ]) {
    assert.throws(() => validatePatchData(bad), PATCH_TYPE)
  }
})

test('applyTargetsToMessage patches selected blocks and leaves the rest alone', () => {
  const original = message()
  const patched = applyTargetsToMessage(original, [
    { seq: 4, blockIndex: 0, kind: 'reasoning', text: 'NEW THINK' },
    { seq: 4, blockIndex: 1, kind: 'text', text: 'NEW ANSWER' },
  ])
  assert.equal(patched.id, 'a1')
  assert.equal(patched.content[0].text, 'NEW THINK')
  assert.equal(patched.content[0].signature, undefined)
  assert.equal(patched.content[0].thinkingSignature, undefined)
  assert.equal(patched.content[1].text, 'NEW ANSWER')
  // The tool call is not a patch target and survives verbatim.
  assert.deepEqual(patched.content[2], original.content[2])
  // The recorded message is never mutated.
  assert.equal(original.content[0].text, 'OLD THINK')
  assert.equal(original.content[0].signature, 'sig-1')
})

test('a target whose block changed kind is skipped, not fatal', () => {
  const patched = applyTargetsToMessage(message(), [
    { seq: 4, blockIndex: 0, kind: 'text', text: 'WRONG KIND' },
    { seq: 4, blockIndex: 1, kind: 'text', text: 'RIGHT' },
  ])
  assert.equal(patched.content[0].text, 'OLD THINK')
  assert.equal(patched.content[1].text, 'RIGHT')
})

test('the projection composes successive patches on different blocks', () => {
  const event = ev(4, 'assistant/message', { turn: 1, step: 1, message: message(), stream: [] }, { surfaceOp: 'append' })
  const events = [
    ev(0, 'turn/start', { turn: 1 }),
    ev(1, 'system/message', { turn: 1, step: 1, message: { id: 's', role: 'system', content: [{ type: 'text', text: 'SYS' }], source: { kind: 'system-prompt' } } }, { surfaceOp: 'append' }),
    ev(2, 'step/start', { turn: 1, step: 1 }),
    ev(3, 'user/message', { id: 'u', role: 'user', content: [{ type: 'text', text: 'Q' }], source: { kind: 'user' } }, { surfaceOp: 'append' }),
    event,
  ]
  const first = ev(5, PATCH_TYPE, buildPatchData([{ seq: 4, blockIndex: 0, kind: 'reasoning', text: 'NEW THINK' }]))
  const second = ev(6, PATCH_TYPE, buildPatchData([{ seq: 4, blockIndex: 1, kind: 'text', text: 'NEW ANSWER' }]))
  const projection = patchProjection()
  const base = { nodes: [1, 3, 4], events, baseSeq: 0, messages: new Map() }
  const one = projection.project(first, base)
  assert.equal(one.get(4).content[0].text, 'NEW THINK')
  const two = projection.project(second, { ...base, messages: one })
  assert.equal(two.get(4).content[0].text, 'NEW THINK')
  assert.equal(two.get(4).content[1].text, 'NEW ANSWER')
  assert.equal(two.get(4).content[2].type, 'tool-call')
})

test('one record with several targets of the same message applies all of them', () => {
  const event = ev(4, 'assistant/message', { turn: 1, step: 1, message: message(), stream: [] }, { surfaceOp: 'append' })
  const patch = ev(5, PATCH_TYPE, buildPatchData([
    { seq: 4, blockIndex: 0, kind: 'reasoning', text: 'BOTH THINK' },
    { seq: 4, blockIndex: 1, kind: 'text', text: 'BOTH TEXT' },
  ]))
  const out = patchProjection().project(patch, { nodes: [4], events: [{ seq: 4, ...event }], baseSeq: 4, messages: new Map() })
  assert.equal(out.get(4).content[0].text, 'BOTH THINK')
  assert.equal(out.get(4).content[1].text, 'BOTH TEXT')
})

test('the projection never throws and skips retired targets', () => {
  const event = ev(4, 'assistant/message', { turn: 1, step: 1, message: message(), stream: [] }, { surfaceOp: 'append' })
  const patch = ev(5, PATCH_TYPE, buildPatchData([{ seq: 4, blockIndex: 1, kind: 'text', text: 'X' }]))
  const projection = patchProjection()
  assert.equal(projection.project(patch, { nodes: [], events: [event], baseSeq: 4, messages: new Map() }).size, 0)
  assert.equal(projection.project(ev(6, PATCH_TYPE, { broken: true }), { nodes: [4], events: [event], baseSeq: 4 }).size, 0)
  assert.equal(projection.project(patch, { nodes: [4], events: [], baseSeq: 0 }).size, 0)
})

test('patchesOf keeps the latest patch per block and skips invalid records', () => {
  const events = [
    ev(4, PATCH_TYPE, buildPatchData([{ seq: 3, blockIndex: 0, kind: 'text', text: 'ONE' }])),
    ev(5, PATCH_TYPE, buildPatchData([{ seq: 3, blockIndex: 0, kind: 'text', text: 'TWO' }])),
    ev(6, PATCH_TYPE, buildPatchData([{ seq: 3, blockIndex: 1, kind: 'reasoning', text: 'THINK' }])),
    ev(7, PATCH_TYPE, { broken: true }),
  ]
  const patches = patchesOf(events)
  assert.equal(patches.get(3).replacements.get(0).text, 'TWO')
  assert.equal(patches.get(3).replacements.get(1).text, 'THINK')
  assert.deepEqual(patchList(patches), [
    { seq: 3, blockIndex: 0, kind: 'text', text: 'TWO' },
    { seq: 3, blockIndex: 1, kind: 'reasoning', text: 'THINK' },
  ])
})

test('projectedBlocks reports the live text and what it replaced', () => {
  const patches = new Map([[4, { replacements: new Map([[1, { kind: 'text', text: 'NEW' }]]), inserts: new Map() }]])
  const blocks = projectedBlocks(message(), 4, patches)
  assert.deepEqual(blocks[1], { index: 1, kind: 'text', text: 'NEW', original: 'OLD ANSWER', patched: true })
  assert.equal(blocks[0].patched, false)
})

// --- inserted blocks ---------------------------------------------------------

test('an insert target carries a stable id and a position, not an index', () => {
  const data = buildPatchData([{ seq: 4, kind: 'text', text: 'NEW', insert: { id: 'ins-1', position: 2 } }])
  assert.deepEqual(data.targets[0], { seq: 4, kind: 'text', text: 'NEW', insert: { id: 'ins-1', position: 2 } })
  // The same id again is an EDIT of that block, not a second one.
  const again = buildPatchData([{ seq: 4, kind: 'text', text: 'NEWER', insert: { id: 'ins-1', position: 2 } }])
  const patches = patchesOf([ev(4, PATCH_TYPE, data), ev(5, PATCH_TYPE, again)])
  const inserts = [...patches.get(4).inserts.values()]
  assert.equal(inserts.length, 1, 'one block, one identity')
  assert.equal(inserts[0].text, 'NEWER')
})

test('inserts land at their position without moving the blocks they were resolved against', () => {
  const original = message()   // [reasoning 'OLD THINK', text 'OLD ANSWER']
  const withInsert = applyTargetsToMessage(original, [
    { seq: 4, blockIndex: 1, kind: 'text', text: 'REPLACED' },
    { seq: 4, kind: 'text', text: 'ADDED', insert: { id: 'a', position: 1 } },
  ])
  assert.deepEqual(withInsert.content.map((block) => block.text ?? block.type), ['OLD THINK', 'ADDED', 'REPLACED', 'tool-call'])
  assert.equal(original.content.length, 3, 'the recorded message is not mutated')
})

test('two inserts at the same position keep the order they were created in', () => {
  const out = applyTargetsToMessage(message(), [
    { seq: 4, kind: 'text', text: 'FIRST', insert: { id: 'a', position: 1 } },
    { seq: 4, kind: 'reasoning', text: 'SECOND', insert: { id: 'b', position: 1 } },
  ])
  assert.deepEqual(out.content.map((block) => block.text ?? block.type), ['OLD THINK', 'FIRST', 'SECOND', 'OLD ANSWER', 'tool-call'])
})

test('an insert past the end is appended, and a removed one is dropped', () => {
  const out = applyTargetsToMessage(message(), [
    { seq: 4, kind: 'text', text: 'TAIL', insert: { id: 'a', position: 99 } },
    { seq: 4, kind: 'text', text: 'GONE', insert: { id: 'b', position: 0 }, removed: true },
  ])
  assert.deepEqual(out.content.map((block) => block.text ?? block.type), ['OLD THINK', 'OLD ANSWER', 'tool-call', 'TAIL'])
})

test('the projection shows inserted blocks where the user put them', () => {
  const data = buildPatchData([
    { seq: 4, blockIndex: 1, kind: 'text', text: 'REPLACED' },
    { seq: 4, kind: 'text', text: 'ADDED', insert: { id: 'a', position: 1 } },
  ])
  const patches = patchesOf([ev(9, PATCH_TYPE, data)])
  const blocks = projectedBlocks(message(), 4, patches)
  assert.deepEqual(
    blocks.map((block) => [block.kind, block.text]),
    [['reasoning', 'OLD THINK'], ['text', 'ADDED'], ['text', 'REPLACED']],
  )
  // The inserted block is addressable: its index is outside the recorded range
  // and it carries the id the next save must reuse.
  assert.ok(blocks[1].index >= INSERT_INDEX_BASE, 'inserted blocks get a synthetic index')
  assert.equal(blocks[1].insertId, 'a')
})

test('a record written by the previous release is still read', () => {
  // Exactly what 0.5.4 wrote: version 1, plain block rewrites.
  const v1 = { version: 1, targets: [{ seq: 4, blockIndex: 1, kind: 'text', text: 'FROM V1' }] }
  const patches = patchesOf([ev(9, PATCH_TYPE, v1)])
  assert.equal(patches.get(4).replacements.get(1).text, 'FROM V1')
  assert.deepEqual(
    projectedBlocks(message(), 4, patches).map((block) => block.text),
    ['OLD THINK', 'FROM V1'],
  )
})
