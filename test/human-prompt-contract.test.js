// The platform's human-prompt contract, as a regression guard.
//
// About twenty places in DSH decide "this is the human's prompt" by testing
// `source.kind === 'user'`: dsh-session-turn-outline (the turn rail and the
// Trajectory view), dsh-client-ui-trajectory, dsh-client-ui-chat, the inbox
// steering filter, and `lastPromptAt` on the session list.
//
// dsh-edit-turn <= 0.2.15 wrote its prompt carrier as
// `{ kind: 'plugin:dsh-edit-turn', editedBy }`. That kind is legal - session
// format v4 has producer-owned sources - but it is not `'user'`, so every one of
// those consumers stopped seeing a prompt: the edited round rendered with no
// prompt at all, `turnOutline` reported `prompt: ""`, and the Trajectory view
// filed the wording under 上下文 instead of 用户.
//
// The old test suite passed throughout, because it asserted the carrier's own
// source rather than the platform's contract. These tests assert the contract,
// and they also pin the opposite direction: an upgrade must not stop recognising
// carriers that earlier releases already wrote into real logs.
import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  PLUGIN_ID,
  buildCarrier,
  foldSurface,
  isEditCarrier,
  isHumanPrompt,
  lastTurnOf,
  planRollback,
} from '../lib/index.js'

const ev = (seq, type, data, extra) => ({ type, seq, time: 1_700_000_000_000 + seq, data, ...extra })
const append = { surfaceOp: 'append' }

/** system, u1, a1 | u2, a2 - two completed turns. */
function twoTurnLog() {
  return [
    ev(0, 'turn/start', { turn: 1 }),
    ev(1, 'system/message', { turn: 1, step: 1, message: { id: 'sys', role: 'system', content: [{ type: 'text', text: 'SYS' }] } }, append),
    ev(2, 'user/message', { id: 'u1', role: 'user', content: [{ type: 'text', text: 'first' }], source: { kind: 'user' } }, append),
    ev(3, 'assistant/message', { turn: 1, step: 1, message: { id: 'a1', role: 'assistant', content: [{ type: 'text', text: 'answer' }] } }, append),
    ev(4, 'turn/end', { turn: 1, reason: { kind: 'completed' } }),
    ev(5, 'turn/start', { turn: 2 }),
    ev(6, 'user/message', { id: 'u2', role: 'user', content: [{ type: 'text', text: 'second' }], source: { kind: 'user' } }, append),
    ev(7, 'assistant/message', { turn: 2, step: 1, message: { id: 'a2', role: 'assistant', content: [{ type: 'text', text: 'answer 2' }] } }, append),
    ev(8, 'turn/end', { turn: 2, reason: { kind: 'completed' } }),
  ]
}

function promptCarrier(text) {
  const log = twoTurnLog()
  const plan = planRollback(log, foldSurface(log).nodes, { seq: 2 })
  return buildCarrier(plan, lastTurnOf(log), { carrier: 'user/message', markerText: text })
}

test('the prompt carrier keeps the platform human identity: kind "user"', () => {
  const carrier = promptCarrier('revised')
  assert.equal(carrier.type, 'user/message')
  assert.equal(
    carrier.data.source.kind,
    'user',
    "the platform's consumers all test kind === 'user'; any other kind loses the turn's prompt",
  )
  assert.equal(carrier.data.source.editedBy, PLUGIN_ID, 'provenance lives in editedBy now')
  assert.equal(carrier.data.role, 'user')
  assert.deepEqual(carrier.data.content, [{ type: 'text', text: 'revised' }], 'the carrier IS the revision')
})

test('a rewritten prompt is still offered for editing, like a human one', () => {
  const carrier = promptCarrier('revised')
  // The real shape the log receives: an event, not just a source.
  const event = { type: carrier.type, data: carrier.data }
  assert.equal(isHumanPrompt(event), true, 'the rewrite must stay editable or the feature is one-shot')
})

test('isHumanPrompt is exactly the platform test, plus our historical carriers', () => {
  const editable = [
    ['a plain human prompt', { kind: 'user' }],
    ['our rewrite', { kind: 'user', editedBy: PLUGIN_ID }],
    ['a carrier from <= 0.2.15', { kind: 'plugin:' + PLUGIN_ID, editedBy: PLUGIN_ID }],
    ['a carrier from <= 0.2.15 without editedBy', { kind: 'plugin:' + PLUGIN_ID }],
    ['a session format v3 carrier', { kind: 'plugin', plugin: PLUGIN_ID }],
  ]
  for (const [label, source] of editable) {
    assert.equal(isHumanPrompt({ type: 'user/message', data: { source } }), true, label)
  }
  const notEditable = [
    ['the runtime-context snapshot', { kind: 'runtime-context' }],
    ['the skill catalog', { kind: 'skill-catalog' }],
  ]
  for (const [label, source] of notEditable) {
    assert.equal(isHumanPrompt({ type: 'user/message', data: { source } }), false, label)
  }
  assert.equal(isHumanPrompt({ type: 'assistant/message', data: { source: { kind: 'user' } } }), false, 'only user/message')
  assert.equal(isHumanPrompt(null), false)
})

test('isEditCarrier recognises every shape this plugin has written', () => {
  assert.equal(isEditCarrier({ editedBy: PLUGIN_ID }), true, 'current')
  assert.equal(isEditCarrier({ kind: 'plugin:' + PLUGIN_ID, editedBy: PLUGIN_ID }), true, 'the silent reply carrier')
  assert.equal(isEditCarrier({ kind: 'plugin:' + PLUGIN_ID }), true, 'a legacy prompt carrier')
  assert.equal(isEditCarrier({ kind: 'plugin', plugin: PLUGIN_ID }), true, 'session format v3')
  assert.equal(isEditCarrier({ kind: 'user' }), false, "a plain human prompt is not this plugin's carrier")
  assert.equal(isEditCarrier({ kind: 'runtime-context' }), false)
  assert.equal(isEditCarrier({ kind: 'plugin:someone-else' }), false)
  assert.equal(isEditCarrier(null), false)
  assert.equal(isEditCarrier(undefined), false)
})
