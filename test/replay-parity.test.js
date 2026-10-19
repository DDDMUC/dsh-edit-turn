// Cross-plugin parity: a reply edit's replay must be the SAME splice
// dsh-rerun-turn performs after a regenerated answer.
//
// The two plugins ship as separate packages (edit-turn must work with no rerun
// installed), so the replay walk is carried in both. This test is the guard
// against the two copies drifting: it feeds one log and one window to both
// builders and compares their writes field for field. It runs only when the
// sibling repository is checked out next to this one; a published install skips
// it instead of failing a checkout that has only one plugin.
//
//   node --test "test/*.test.js"
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

import { buildReplayWrites } from '../lib/index.js'

const siblingUrl = new URL('../../dsh-rerun-turn/lib/index.js', import.meta.url)
const sibling = existsSync(fileURLToPath(siblingUrl)) ? await import(siblingUrl.href) : null

function ev(seq, type, data, extra) {
  return { type, seq, time: 1_700_000_000_000 + seq, data, ...extra }
}
const append = { surfaceOp: 'append' }

/** system, (u1 a1) | (u2 open call result a2) | (u3 a3) - three complete turns. */
function threeTurnLog() {
  return [
    ev(0, 'turn/start', { turn: 1 }),
    ev(1, 'system/message', { turn: 1, step: 1, message: { id: 'sys', role: 'system', content: [{ type: 'text', text: 'SYS' }] } }, append),
    ev(2, 'step/start', { turn: 1, step: 1 }),
    ev(3, 'user/message', { id: 'u1', role: 'user', content: [{ type: 'text', text: 'Q1' }], source: { kind: 'user' } }, append),
    ev(4, 'assistant/message', { turn: 1, step: 1, message: { id: 'a1', role: 'assistant', content: [{ type: 'text', text: 'A1' }], source: { kind: 'model', provider: 'p', model: 'm' } }, stream: [] }, append),
    ev(5, 'step/end', { turn: 1, step: 1 }),
    ev(6, 'turn/end', { turn: 1, reason: { kind: 'completed' } }),
    ev(7, 'turn/start', { turn: 2 }),
    ev(8, 'step/start', { turn: 2, step: 1 }),
    ev(9, 'user/message', { id: 'u2', role: 'user', content: [{ type: 'text', text: 'Q2' }], source: { kind: 'user' } }, append),
    ev(10, 'assistant/message', {
      turn: 2,
      step: 1,
      message: {
        id: 'open',
        role: 'assistant',
        content: [{ type: 'tool-call', id: 'c1', name: 'read_file', arguments: '{}' }],
        source: { kind: 'model', provider: 'p', model: 'm' },
      },
      stream: [],
    }, append),
    ev(11, 'tool/call', { turn: 2, step: 1, callId: 'c1', name: 'read_file', arguments: '{}' }),
    ev(12, 'tool/result', {
      turn: 2,
      step: 1,
      message: { id: 't1', role: 'tool', toolCallId: 'c1', content: [{ type: 'text', text: 'body' }], source: { kind: 'tool', callId: 'c1' } },
    }, append),
    ev(13, 'assistant/message', { turn: 2, step: 1, message: { id: 'a2', role: 'assistant', content: [{ type: 'text', text: 'A2' }], source: { kind: 'model', provider: 'p', model: 'm' } }, stream: [] }, append),
    ev(14, 'step/end', { turn: 2, step: 1 }),
    ev(15, 'turn/end', { turn: 2, reason: { kind: 'completed' } }),
    ev(16, 'turn/start', { turn: 3 }),
    ev(17, 'step/start', { turn: 3, step: 1 }),
    ev(18, 'user/message', { id: 'u3', role: 'user', content: [{ type: 'text', text: 'Q3' }], source: { kind: 'user' } }, append),
    ev(19, 'assistant/message', { turn: 3, step: 1, message: { id: 'a3', role: 'assistant', content: [{ type: 'text', text: 'A3' }], source: { kind: 'model', provider: 'p', model: 'm' } }, stream: [] }, append),
    ev(20, 'step/end', { turn: 3, step: 1 }),
    ev(21, 'turn/end', { turn: 3, reason: { kind: 'completed' } }),
  ]
}

/** Field names differ by design (replayBy vs rerunBy); ids are random. */
function normalize(value) {
  if (Array.isArray(value)) return value.map(normalize)
  if (value !== null && typeof value === 'object') {
    const out = {}
    for (const [key, child] of Object.entries(value)) {
      if (key === 'id') out[key] = '<id>'
      else if (key === 'replayBy' || key === 'rerunBy') out.by = '<by>'
      else if (key === 'replayId' || key === 'rerunId') out.op = '<op>'
      else out[key] = normalize(child)
    }
    return out
  }
  return value
}

test('the reply replay is write-for-write identical to dsh-rerun-turn', { skip: sibling === null ? 'dsh-rerun-turn is not checked out next to this repository' : false }, () => {
  const events = threeTurnLog()
  const shadowed = [4, 9, 10, 12, 13, 18, 19]
  const baseTurn = 4
  const startSeq = 100
  const mine = buildReplayWrites(events, { shadowed, replayFrom: 7, logTo: 21 }, baseTurn, 'op-1', startSeq)
  const theirs = sibling.buildReplayWrites(events, { shadowed, logFrom: 7, logTo: 21 }, baseTurn, 'op-1', startSeq, false)
  assert.deepEqual(normalize(mine), normalize(theirs))
  // And the shared answer is the splice the whole change is about: both later
  // turns come back, in order, with fresh turn numbers.
  assert.deepEqual(mine.filter((write) => write.type === 'turn/start').map((write) => write.data.turn), [4, 5])
  assert.deepEqual(
    mine.filter((write) => write.type === 'assistant/message').map((write) => write.data.turn),
    [4, 4, 5],
  )
})
