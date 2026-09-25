// Verify the rollback seam against the REAL Session validator, in process.
//
// No DSH server, no model call, no tokens: this builds a two-turn log through
// the same `session.append()` the host uses, then hands the rollback window to
// the same validator production traffic goes through. It is the only check that
// can prove four things the pure unit tests cannot:
//
//   1. `{ op: 'replace', startSeq, endSeq }` with our computed window is
//      ACCEPTED, including the complete-shadow-coverage rule for sourceEventSeqs;
//   2. the derived model history really loses the shadowed tail;
//   3. the raw log keeps every original event (append-only, never rewritten);
//   4. an assistant message and the tool/result it produced leave together, so
//      no call/result pair is ever left dangling.
//
// It also answers one open design question: whether an empty `system/message`
// replacement can act as a model-invisible carrier (it would project to no
// message) instead of the current short marker.
//
//   node tools/verify-surface-contract.mjs
import { Session } from '@deepseek-ai/dsh-session'
import {
  PLUGIN_ID,
  buildCarrier,
  buildCorrection,
  editableReplies,
  editableTurns,
  foldSurface,
  isBusy,
  lastTurnOf,
  planRollback,
  rollbackLedger,
} from '../lib/index.js'

const MARKER = `[${PLUGIN_ID}] test marker`

let failures = 0
function check(label, condition, detail) {
  if (condition) {
    console.log(`  ✓ ${label}`)
  } else {
    failures += 1
    console.log(`  ✗ ${label}${detail === undefined ? '' : ` — ${detail}`}`)
  }
}

function modelMessage(id, text) {
  return {
    id,
    role: 'assistant',
    content: [{ type: 'text', text }],
    source: { kind: 'model', provider: 'verify', model: 'verify-model' },
  }
}

function userMessage(id, text) {
  return { id, role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } }
}

function systemMessage(id) {
  return {
    id,
    role: 'system',
    content: [{ type: 'text', text: 'VERIFY SYSTEM PROMPT' }],
    source: { kind: 'plugin', plugin: 'verify-bundle' },
  }
}

function toolResultMessage(id, callId) {
  return {
    id,
    role: 'user',
    content: [{ type: 'tool-result', toolCallId: callId, content: [{ type: 'text', text: 'file body' }] }],
    source: { kind: 'tool', callId },
  }
}

/** Two completed turns; turn 2 ends with a real tool call/result pair. */
function buildTwoTurnLog(session) {
  session.append('turn/start', { turn: 1 })
  session.append('system/message', { turn: 1, step: 1, message: systemMessage('m-system') }, { surfaceOp: 'append' })
  session.append('step/start', { turn: 1, step: 1 })
  session.append('user/message', userMessage('m-u1', '第一轮提问'), { surfaceOp: 'append' })
  session.append('assistant/message', { turn: 1, step: 1, message: modelMessage('m-a1', '第一轮回答'), stream: [] }, { surfaceOp: 'append' })
  session.append('step/end', { turn: 1, step: 1 })
  session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })

  session.append('turn/start', { turn: 2 })
  session.append('step/start', { turn: 2, step: 1 })
  session.append('user/message', userMessage('m-u2', '第二轮提问'), { surfaceOp: 'append' })
  session.append('tool/call', { turn: 2, step: 1, callId: 'call-1', name: 'read_file', arguments: '{}' })
  session.append('tool/result', { turn: 2, step: 1, message: toolResultMessage('m-t1', 'call-1') }, { surfaceOp: 'append' })
  session.append('assistant/message', { turn: 2, step: 1, message: modelMessage('m-a2', '第二轮回答'), stream: [] }, { surfaceOp: 'append' })
  session.append('step/end', { turn: 2, step: 1 })
  session.append('turn/end', { turn: 2, reason: { kind: 'completed' } })
}

function freshSession(label) {
  return Session.create(`session-00000000-0000-4000-8000-${label}`)
}

const texts = (messages) => messages.map((message) => message.content.map((block) => block.text ?? '').join(''))

// ---------------------------------------------------------------------------
console.log('1. build a two-turn log through the real append path')
const session = freshSession('000000000001')
buildTwoTurnLog(session)
const events = session.snapshotEvents()
const fold = foldSurface(events)
const derived = session.deriveMessages()

check('log has 15 events', events.length === 15, `got ${events.length}`)
check('surface has 6 nodes (system, u1, a1, u2, tool-result, a2)', fold.nodes.length === 6, `got ${fold.nodes.length}`)
check('derived history has all 6 messages', derived.length === 6, `got ${derived.length}`)
check('session is idle (no open turn)', isBusy(events) === false)

// ---------------------------------------------------------------------------
console.log('\n2. plan the rollback for the FIRST user turn')
const targets = editableTurns(events, fold.nodes)
check('both human prompts are editable', targets.length === 2, `got ${targets.length}`)
check('first target text is the original prompt', targets[0] && targets[0].text === '第一轮提问', JSON.stringify(targets[0] && targets[0].text))

const plan = planRollback(events, fold.nodes, { seq: targets[0].seq })
check('window opens on the addressed prompt', plan.shadowed[0] === targets[0].seq)
// A revised prompt is replaced IN PLACE. The window is the message itself, so
// the reply under it and every later turn stay exactly where they were - that is
// what "edit the wording, keep the conversation" means.
check(
  'window is exactly the addressed message',
  plan.shadowed.length === 1 && plan.startSeq === plan.endSeq && plan.endSeq === targets[0].seq,
  `got ${JSON.stringify(plan.shadowed)}`,
)
check('plan reports the original text', plan.original === '第一轮提问', plan.original)

// ---------------------------------------------------------------------------
console.log('\n3. commit the rollback replacement and re-derive')
const REVISED = '改后的第一轮提问'
const before = session.seq
// The carrier IS the revision: one replace event removes the old wording and
// stands in its place, so nothing else has to be appended (appending a user
// message makes the platform answer it) and nothing else is disturbed.
const replacement = session.append(
  'user/message',
  {
    id: 'm-carrier',
    role: 'user',
    content: [{ type: 'text', text: REVISED }],
    source: { kind: `plugin:${PLUGIN_ID}`, editedBy: PLUGIN_ID },
  },
  { surfaceOp: { op: 'replace', startSeq: plan.startSeq, endSeq: plan.endSeq }, sourceEventSeqs: plan.shadowed },
)
const afterEvents = session.snapshotEvents()
const afterDerived = session.deriveMessages()
const afterTexts = texts(afterDerived)

check('the real validator ACCEPTED the replacement', typeof replacement.seq === 'number', `seq ${replacement.seq}`)
check('the context kept its size (nothing else was dropped)', afterDerived.length === 6, `got ${afterDerived.length}`)
check('surviving prefix is the system prompt', afterTexts[0] === 'VERIFY SYSTEM PROMPT', afterTexts[0])
check('the model now reads the revised wording', afterTexts.includes(REVISED))
check('the old wording is gone', !afterTexts.includes('第一轮提问'))
check(
  'the revised wording sits exactly where the old one was',
  afterTexts.indexOf(REVISED) === afterTexts.indexOf('第一轮回答') - 1,
  JSON.stringify(afterTexts),
)
check('the reply under the edited prompt SURVIVES', afterTexts.includes('第一轮回答'))
check('the LATER turn survives untouched', afterTexts.includes('第二轮提问') && afterTexts.includes('第二轮回答'))
check('the tool result survives with its call', afterDerived.some((m) => m.content.some((b) => b.type === 'tool-result')))

// ---------------------------------------------------------------------------
console.log('\n4. the log is append-only')
check('exactly one event was appended (the in-place replacement)', afterEvents.length === events.length + 1, `${events.length} -> ${afterEvents.length}`)
check('session.seq advanced by one', session.seq === before + 1)
check(
  'every original event survives byte-identical',
  events.every((event, index) => JSON.stringify(afterEvents[index]) === JSON.stringify(event)),
)
check('the shadowed events are still readable', afterEvents.some((e) => e.data && e.data.id === 'm-u1'))

// ---------------------------------------------------------------------------
console.log('\n5. the client ledger rebuilds from the log alone')
const ledger = rollbackLedger(afterEvents)
check('only the edited message is recorded as hidden', ledger.hidden.length === 1, `got ${ledger.hidden.length}`)
check('one rollback is recorded', ledger.edits.length === 1, `got ${ledger.edits.length}`)
check('the hidden entry carries its turn', ledger.hidden[0] && ledger.hidden[0].turn === 1, JSON.stringify(ledger.hidden))
const refold = foldSurface(afterEvents)
// Nothing was discarded, so the conversation goes on: the revised message and
// the later prompt are both still offered for editing.
check(
  'the revised prompt and the later turn are still editable',
  editableTurns(afterEvents, refold.nodes).length === 2,
  JSON.stringify(editableTurns(afterEvents, refold.nodes).map((entry) => entry.text)),
)

// ---------------------------------------------------------------------------
console.log('\n6. the default carrier: an EMPTY system/message acts as an invisible replacement')
const probe = freshSession('000000000002')
buildTwoTurnLog(probe)
const probeEvents = probe.snapshotEvents()
const probeFold = foldSurface(probeEvents)
const probePlan = planRollback(probeEvents, probeFold.nodes, { seq: editableTurns(probeEvents, probeFold.nodes)[0].seq })
const probeCarrier = buildCarrier(probePlan, lastTurnOf(probeEvents), { carrier: 'system/message' })
check('default carrier is an empty system/message', probeCarrier.type === 'system/message', probeCarrier.type)
check('its content is empty', probeCarrier.data.message.content.length === 0)
let silentOk = false
try {
  probe.append(probeCarrier.type, probeCarrier.data, {
    surfaceOp: { op: 'replace', startSeq: probePlan.startSeq, endSeq: probePlan.endSeq },
    sourceEventSeqs: probePlan.shadowed,
  })
  const probeDerived = probe.describe ? probe.deriveMessages() : probe.deriveMessages()
  const probeTexts = texts(probeDerived)
  // Baseline: the log has 6 messages; the silent carrier replaces one node and
  // projects to nothing, so 5 remain - and everything behind the edited message
  // is still there.
  silentOk = probeDerived.length === 5 && probeTexts[0] === 'VERIFY SYSTEM PROMPT'
  check('the validator ACCEPTED the empty system/message carrier', true)
  check('the empty carrier projects to NO model message', probeDerived.length === 5, `got ${probeDerived.length}`)
  check('the system prompt survives the rollback intact', probeTexts[0] === 'VERIFY SYSTEM PROMPT', probeTexts[0])
  check('the edited prompt is the only thing that left', !probeTexts.includes('第一轮提问'))
  check('the reply and the later turn survive the silent carrier too', probeTexts.includes('第一轮回答') && probeTexts.includes('第二轮回答'))
} catch (error) {
  check('the validator ACCEPTED the empty system/message carrier', false, String((error && error.message) || error))
}
console.log(`  · verdict: ${silentOk ? 'the default carrier is model-invisible' : 'fall back to the user/message marker'}`)

console.log('\n7. the fallback carrier: a short user/message marker')
const fallback = freshSession('000000000003')
buildTwoTurnLog(fallback)
const fallbackEvents = fallback.snapshotEvents()
const fallbackFold = foldSurface(fallbackEvents)
const fallbackPlan = planRollback(fallbackEvents, fallbackFold.nodes, {
  seq: editableTurns(fallbackEvents, fallbackFold.nodes)[0].seq,
})
const fallbackCarrier = buildCarrier(fallbackPlan, lastTurnOf(fallbackEvents), { carrier: 'user/message', markerText: MARKER })
check('fallback carrier is a user/message', fallbackCarrier.type === 'user/message', fallbackCarrier.type)
fallback.append(fallbackCarrier.type, fallbackCarrier.data, {
  surfaceOp: { op: 'replace', startSeq: fallbackPlan.startSeq, endSeq: fallbackPlan.endSeq },
  sourceEventSeqs: fallbackPlan.shadowed,
})
const fallbackTexts = texts(fallback.deriveMessages())
check('the marker replaces the prompt, everything else stays', fallbackTexts.length === 6, `got ${fallbackTexts.length}`)
check('the marker is the second message', fallbackTexts[1] === MARKER, fallbackTexts[1])
check('the reply behind the edited prompt is untouched', fallbackTexts.includes('第一轮回答'))

// ---------------------------------------------------------------------------
console.log('\n8. a SECOND rollback of the revised prompt is accepted')
const twice = freshSession('000000000004')
buildTwoTurnLog(twice)
const firstEvents = twice.snapshotEvents()
const firstFold = foldSurface(firstEvents)
const firstPlan = planRollback(firstEvents, firstFold.nodes, { seq: editableTurns(firstEvents, firstFold.nodes)[0].seq })
const firstCarrier = buildCarrier(firstPlan, lastTurnOf(firstEvents), { carrier: 'system/message' })
twice.append(firstCarrier.type, firstCarrier.data, {
  surfaceOp: { op: 'replace', startSeq: firstPlan.startSeq, endSeq: firstPlan.endSeq },
  sourceEventSeqs: firstPlan.shadowed,
})

// What the host's re-run does: prompt admission appends the revised prompt, and
// the turn it starts eventually closes.
// The new flow has no re-run here: the surface already holds the revision.

// A rewritten prompt stays editable (edit it again), and so does every later
// turn: an in-place edit takes nothing else away.
const secondEvents = twice.snapshotEvents()
const secondFold = foldSurface(secondEvents)
const secondTargets = editableTurns(secondEvents, secondFold.nodes)
check(
  'the revised prompt is still editable, together with the later turn',
  secondTargets.length === 2 &&
    [...secondTargets.map((entry) => entry.text)].sort().join('|') === [REVISED, '第二轮提问'].sort().join('|'),
  JSON.stringify(secondTargets.map((entry) => entry.text)),
)

const secondPlan = planRollback(secondEvents, secondFold.nodes, { seq: secondTargets[0].seq })
const secondCarrier = buildCarrier(secondPlan, lastTurnOf(secondEvents), { carrier: 'system/message' })
let secondFailure
try {
  twice.append(secondCarrier.type, secondCarrier.data, {
    surfaceOp: { op: 'replace', startSeq: secondPlan.startSeq, endSeq: secondPlan.endSeq },
    sourceEventSeqs: secondPlan.shadowed,
  })
} catch (error) {
  secondFailure = String((error && error.message) || error)
}
check('the validator ACCEPTED a second edit of the same message', secondFailure === undefined, secondFailure)
const afterSecond = texts(twice.deriveMessages())
check(
  'the second edit removed only that message',
  !afterSecond.some((text) => text.includes(REVISED)) && afterSecond.length === 5,
  JSON.stringify(afterSecond),
)
check(
  'the later turn survived both edits',
  afterSecond.includes('第二轮提问') && afterSecond.includes('第二轮回答'),
  JSON.stringify(afterSecond),
)
const thirdFold = foldSurface(twice.snapshotEvents())
check(
  'the later turn is still editable after two edits',
  editableTurns(twice.snapshotEvents(), thirdFold.nodes).map((entry) => entry.text).join('|') === '第二轮提问',
  // Two in-place edits: the second one replaced the revision with a silent carrier,
  // and the later turn is still there because nothing else was ever in the window.
  JSON.stringify(editableTurns(twice.snapshotEvents(), thirdFold.nodes).map((entry) => entry.text)),
)

// ---------------------------------------------------------------------------
console.log('\n9. editing what the model said')
const replySession = freshSession('000000000005')
buildTwoTurnLog(replySession)
const replyEvents = replySession.snapshotEvents()
const replyFold = foldSurface(replyEvents)
const replyTargets = editableReplies(replyEvents, replyFold.nodes)
check(
  'replies with text are offered for editing',
  replyTargets.length === 2 && replyTargets[0].text === '第一轮回答',
  JSON.stringify(replyTargets.map((entry) => entry.text)),
)
const replyPlan = planRollback(replyEvents, replyFold.nodes, { seq: replyTargets[0].seq })
check('a reply is planned as a reply edit, not a re-run', replyPlan.mode === 'reply', replyPlan.mode)
check('its window opens at the reply and ends on the last surface node',
  replyPlan.startSeq === replyPlan.shadowed[0] && replyPlan.endSeq === replyFold.nodes.at(-1))
check('the correction inherits the original turn and step', replyPlan.turn === 1 && replyPlan.step === 1)

// The rule the whole design has to work around.
let carrierRefusal = null
{
  const probe = freshSession('000000000006')
  buildTwoTurnLog(probe)
  const events = probe.snapshotEvents()
  const nodes = foldSurface(events).nodes
  const plan = planRollback(events, nodes, { seq: editableReplies(events, nodes)[0].seq })
  try {
    probe.append('assistant/message', { turn: 1, step: 1, message: modelMessage('m-x', 'x'), stream: [] }, {
      surfaceOp: { op: 'replace', startSeq: plan.startSeq, endSeq: plan.endSeq },
      sourceEventSeqs: plan.shadowed,
    })
  } catch (error) {
    carrierRefusal = String((error && error.message) || error)
  }
}
check('an assistant message is REFUSED as a replacement carrier',
  typeof carrierRefusal === 'string' && carrierRefusal.includes('sourceEventSeqs'), carrierRefusal)

// What is accepted instead: roll back invisibly, then append the correction.
const replyCarrier = buildCarrier(replyPlan, lastTurnOf(replyEvents), { carrier: 'system/message' })
let replyFailure = null
try {
  replySession.append(replyCarrier.type, replyCarrier.data, {
    surfaceOp: { op: 'replace', startSeq: replyPlan.startSeq, endSeq: replyPlan.endSeq },
    sourceEventSeqs: replyPlan.shadowed,
  })
  const correction = buildCorrection(replyPlan, '改写后的回答')
  replySession.append(correction.type, correction.data, { surfaceOp: 'append' })
  // The host anchors a turn's tail - its duration and action strip - at the turn's
  // LAST `turn/end`. A correction appended after the old one therefore lands
  // outside the turn and the tail renders above the corrected text, so the turn is
  // closed again behind it.
  replySession.append('step/end', { turn: correction.data.turn, step: correction.data.step })
  replySession.append('turn/end', { turn: correction.data.turn, reason: { kind: 'completed' } })
} catch (error) {
  replyFailure = String((error && error.message) || error)
}
check('rollback + appended correction is ACCEPTED', replyFailure === null, replyFailure)
check(
  'the turn is closed again behind the correction',
  replySession.snapshotEvents().slice(-3).map((event) => event.type).join(',') === 'assistant/message,step/end,turn/end',
  replySession.snapshotEvents().slice(-3).map((event) => event.type).join(','),
)
check(
  'the closing event names the edited turn',
  replySession.snapshotEvents().at(-1).data.turn === replyPlan.turn,
  String(replySession.snapshotEvents().at(-1).data.turn),
)
const afterReply = texts(replySession.deriveMessages())
const rolesAfterReply = replySession.deriveMessages().map((message) => message.role)
check('the model now sees the corrected text as its own reply',
  afterReply.length === 3 && afterReply[2] === '改写后的回答', JSON.stringify(afterReply))
check('the earlier prompt is untouched and still first', afterReply[1] === '第一轮提问', JSON.stringify(afterReply))
check('the history stays strictly alternating', rolesAfterReply.join(',') === 'system,user,assistant', rolesAfterReply.join(','))
check('the tool result left together with the reply it belonged to',
  !replySession.deriveMessages().some((message) => (message.content || []).some((block) => block.type === 'tool-result')))
// Found by its marker, not by position: the closing events now come after it.
const appendedCorrection = replySession
  .snapshotEvents()
  .find((event) => event.data && event.data.message && event.data.message.source && event.data.message.source.editedBy === PLUGIN_ID)
check('the correction can be found by its marker', appendedCorrection !== undefined)
check('the correction is a model-kind reply, so it renders as one', appendedCorrection.data.message.source.kind === 'model')
check('the correction records who wrote the text', appendedCorrection.data.message.source.editedBy === PLUGIN_ID)
check('the correction carries a turn and a step, so reply nodes cannot collide',
  appendedCorrection.data.turn === 1 && appendedCorrection.data.step === 1)
let continueFailure = null
try {
  replySession.append('user/message', userMessage('m-next', '下一个问题'), { surfaceOp: 'append' })
} catch (error) {
  continueFailure = String((error && error.message) || error)
}
check('the conversation can continue from a corrected reply', continueFailure === null, continueFailure)
check('the follow-up lands after the correction', texts(replySession.deriveMessages()).at(-1) === '下一个问题')

// ---------------------------------------------------------------------------
console.log('\n10. guard rails')
const rejected = []
try {
  planRollback(events, fold.nodes, { seq: fold.nodes[0] })
  rejected.push('system prompt head was editable')
} catch (error) {
  check('the system prompt head is refused', error.code === 'not-editable', `${error.code}: ${error.message}`)
}
try {
  planRollback(events, fold.nodes, { seq: -1 })
  rejected.push('a missing target was accepted')
} catch (error) {
  check('a missing target is refused', error.code === 'not-editable', `${error.code}: ${error.message}`)
}
const firstNode = events.find((event) => event.type === 'user/message' && event.data.source.kind === 'user')
check('a human prompt is recognised', firstNode !== undefined)
const injected = events.find((event) => event.type === 'system/message')
try {
  planRollback(events, fold.nodes, { seq: injected.seq })
  rejected.push('an injected context row was editable')
} catch (error) {
  check('a non-prompt user/system row is refused', error.code === 'not-editable', `${error.code}: ${error.message}`)
}
check('no guard rail was bypassed', rejected.length === 0, rejected.join(' | '))

console.log(failures === 0 ? '\n全部通过：回退 seam 已被真实校验器证实。' : `\n${failures} 项失败。`)
process.exit(failures === 0 ? 0 : 1)
