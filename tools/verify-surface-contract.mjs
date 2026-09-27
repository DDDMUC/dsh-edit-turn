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
import { currentSessionMessageProjections } from '@deepseek-ai/dsh-session-format-catalog/message-projections'
import {
  PLUGIN_ID,
  buildCarrier,
  buildCorrection,
  editableReplies,
  editableTurns,
  foldSurface,
  isBusy,
  lastTurnOf,
  nextTurnOf,
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
    // The read path admits only system-prompt sources on a system message.
    source: { kind: 'system-prompt' },
  }
}

function toolResultMessage(id, callId) {
  // Mirrors a real record from a loadable session: role tool, `toolCallId` on
  // the message (not inside the content block), and the call id also on the
  // source. The old shape here was accepted by appends and refused by readers.
  return {
    id,
    role: 'tool',
    toolCallId: callId,
    content: [{ type: 'text', text: 'file body' }],
    source: { kind: 'tool', callId },
  }
}

/** The assistant message that advertises a tool call the result can pair with. */
function toolCallMessage(id, text, callId, name, args) {
  return {
    id,
    role: 'assistant',
    content: [
      { type: 'text', text },
      { type: 'tool-call', id: callId, name, arguments: args },
    ],
    source: { kind: 'model', provider: 'verify', model: 'verify-model' },
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
  // The tool call has to be advertised by an assistant message first, or the
  // read path has no lifecycle for the result that follows.
  session.append('assistant/message', { turn: 2, step: 1, message: toolCallMessage('m-a2-open', '', 'call-1', 'read_file', '{}'), stream: [] }, { surfaceOp: 'append' })
  session.append('tool/call', { turn: 2, step: 1, callId: 'call-1', name: 'read_file', arguments: '{}' })
  session.append('tool/result', { turn: 2, step: 1, message: toolResultMessage('m-t1', 'call-1') }, { surfaceOp: 'append' })
  session.append('assistant/message', { turn: 2, step: 1, message: modelMessage('m-a2', '第二轮回答'), stream: [] }, { surfaceOp: 'append' })
  session.append('step/end', { turn: 2, step: 1 })
  session.append('turn/end', { turn: 2, reason: { kind: 'completed' } })
}

function freshSession(label) {
  return Session.create(`session-00000000-0000-4000-8000-${label}`)
}

// The append path is lenient; the READ path is not. A session whose log does
// not survive this call is unreadable in DSH - the plugin once wrote a carrier
// that append accepted and every reader refused, which bricked the session for
// good (SessionFormatError on load, no edit entries afterwards). Every write
// sequence in this file is checked through the read path for exactly that
// reason: this is the validator that bites users.
function loadFailure(session) {
  try {
    Session.create('session-00000000-0000-4000-8000-reload', session.snapshotEvents(), undefined, undefined, currentSessionMessageProjections)
    return null
  } catch (error) {
    return String((error && error.message) || error)
  }
}

const texts = (messages) => messages.map((message) => message.content.map((block) => block.text ?? '').join(''))

// ---------------------------------------------------------------------------
console.log('1. build a two-turn log through the real append path')
const session = freshSession('000000000001')
buildTwoTurnLog(session)
const events = session.snapshotEvents()
const fold = foldSurface(events)
const derived = session.deriveMessages()

check('log has 16 events', events.length === 16, `got ${events.length}`)
check('surface has 7 nodes (system, u1, a1, u2, a2-open, tool-result, a2)', fold.nodes.length === 7, `got ${fold.nodes.length}`)
check('derived history has all 7 messages', derived.length === 7, `got ${derived.length}`)
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
check('the context kept its size (nothing else was dropped)', afterDerived.length === 7, `got ${afterDerived.length}`)
check('surviving prefix is the system prompt', afterTexts[0] === 'VERIFY SYSTEM PROMPT', afterTexts[0])
// The prompt write is only real if the log still LOADS: the append path is
// lenient, the read path is what users hit.
check(
  'the prompt edit survives the read-path validator',
  loadFailure(session) === null,
  String(loadFailure(session)),
)
check('the model now reads the revised wording', afterTexts.includes(REVISED))
check('the old wording is gone', !afterTexts.includes('第一轮提问'))
check(
  'the revised wording sits exactly where the old one was',
  afterTexts.indexOf(REVISED) === afterTexts.indexOf('第一轮回答') - 1,
  JSON.stringify(afterTexts),
)
check('the reply under the edited prompt SURVIVES', afterTexts.includes('第一轮回答'))
check('the LATER turn survives untouched', afterTexts.includes('第二轮提问') && afterTexts.includes('第二轮回答'))
check('the tool result survives with its call', afterDerived.some((m) => m.role === 'tool' && m.toolCallId === 'call-1'))

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
console.log('\n6. the default carrier: an EMPTY developer/message acts as an invisible replacement')
const probe = freshSession('000000000002')
buildTwoTurnLog(probe)
const probeEvents = probe.snapshotEvents()
const probeFold = foldSurface(probeEvents)
const probePlan = planRollback(probeEvents, probeFold.nodes, { seq: editableTurns(probeEvents, probeFold.nodes)[0].seq })
const probeCarrier = buildCarrier(probePlan, lastTurnOf(probeEvents), { carrier: 'system/message' })
check('default carrier is an empty developer/message', probeCarrier.type === 'developer/message', probeCarrier.type)
check('its content is empty', probeCarrier.data.message.content.length === 0)
// Every replacement carries the marker, this one included: a sibling plugin that
// recognises rewrites by `editedBy` must not have to special-case empty carriers.
check(
  'the silent carrier also says who wrote it',
  probeCarrier.data.message.source.editedBy === PLUGIN_ID,
  JSON.stringify(probeCarrier.data.message.source),
)
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
  check('the validator ACCEPTED the empty developer/message carrier', true)
  check('the empty carrier projects to NO model message', probeDerived.length === 6, `got ${probeDerived.length}`)
  check('the system prompt survives the rollback intact', probeTexts[0] === 'VERIFY SYSTEM PROMPT', probeTexts[0])
  check('the edited prompt is the only thing that left', !probeTexts.includes('第一轮提问'))
  check('the reply and the later turn survive the silent carrier too', probeTexts.includes('第一轮回答') && probeTexts.includes('第二轮回答'))
} catch (error) {
  check('the validator ACCEPTED the empty developer/message carrier', false, String((error && error.message) || error))
}
console.log(`  · verdict: ${silentOk ? 'the default carrier is model-invisible' : 'fall back to the user/message marker'}`)
check(
  'the silent carrier write survives the read-path validator',
  loadFailure(probe) === null,
  String(loadFailure(probe)),
)

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
check('the marker replaces the prompt, everything else stays', fallbackTexts.length === 7, `got ${fallbackTexts.length}`)
check('the marker is the second message', fallbackTexts[1] === MARKER, fallbackTexts[1])
check('the reply behind the edited prompt is untouched', fallbackTexts.includes('第一轮回答'))

// ---------------------------------------------------------------------------
console.log('\n8. a SECOND rollback of the revised prompt is accepted')
// A prompt edit does NOT take `config.carrier` as given: applyEdit forces
// `carrier: 'user/message'` with the revised text as the marker (lib/index.js,
// `const carrier = buildCarrier(...)`), because the revision has to travel as
// the replace-carrier or it would be lost from the model context - and an
// appended user message would be answered. The empty `system/message` carrier
// is therefore never produced for a prompt; building one here would test a path
// production cannot take, and would silently drop the wording it is supposed to
// keep.
const promptCarrier = (plan, lastTurn, markerText) =>
  buildCarrier(plan, lastTurn, { carrier: 'user/message', markerText })

const twice = freshSession('000000000004')
buildTwoTurnLog(twice)
const firstEvents = twice.snapshotEvents()
const firstFold = foldSurface(firstEvents)
const firstPlan = planRollback(firstEvents, firstFold.nodes, { seq: editableTurns(firstEvents, firstFold.nodes)[0].seq })
const firstCarrier = promptCarrier(firstPlan, lastTurnOf(firstEvents), REVISED)
twice.append(firstCarrier.type, firstCarrier.data, {
  surfaceOp: { op: 'replace', startSeq: firstPlan.startSeq, endSeq: firstPlan.endSeq },
  sourceEventSeqs: firstPlan.shadowed,
})

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

const REVISED_TWICE = '再次改后的第一轮提问'
const secondPlan = planRollback(secondEvents, secondFold.nodes, { seq: secondTargets[0].seq })
check('the second window is the revised prompt itself', secondPlan.original === REVISED, secondPlan.original)
const secondCarrier = promptCarrier(secondPlan, lastTurnOf(secondEvents), REVISED_TWICE)
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
  !afterSecond.includes(REVISED) && afterSecond.includes(REVISED_TWICE) && afterSecond.length === 7,
  JSON.stringify(afterSecond),
)
check(
  'the later turn survived both edits',
  afterSecond.includes('第二轮提问') && afterSecond.includes('第二轮回答'),
  JSON.stringify(afterSecond),
)
const thirdFold = foldSurface(twice.snapshotEvents())
const thirdTargets = editableTurns(twice.snapshotEvents(), thirdFold.nodes)
check(
  'the later turn is still editable after two edits',
  thirdTargets.length === 2 &&
    thirdTargets.map((entry) => entry.text).join('|') === [REVISED_TWICE, '第二轮提问'].join('|'),
  // Two in-place edits: each carrier replaced the wording before it, so the
  // newest revision and the untouched later turn are what the host still offers.
  JSON.stringify(thirdTargets.map((entry) => entry.text)),
)

// ---------------------------------------------------------------------------
// The shape a sibling plugin is told it can rely on: a rewritten message keeps
// its original transcript row, so an entry that validates by surface
// (dsh-delete-turn's delete action) can only keep working if the rewrite lands
// the way these checks pin. Break one and that action silently withdraws from
// the row - nothing throws, the entry just stops resolving its target.
console.log('\n8b. invariants a sibling plugin builds on')
const firstTarget = editableTurns(firstEvents, firstFold.nodes)[0]
const firstTargetEvent = firstEvents.find((event) => event.seq === firstTarget.seq)
const landedCarrier = secondEvents.find(
  (event) => event.data && event.data.id === firstCarrier.data.id,
)
check(
  'a prompt rewrite keeps a single-node window on the message it replaces',
  firstPlan.shadowed.length === 1 && firstPlan.shadowed[0] === firstTarget.seq,
  JSON.stringify({ shadowed: firstPlan.shadowed, target: firstTarget.seq }),
)
check(
  'the replacement event has the type of the message it replaces',
  firstTargetEvent !== undefined && firstCarrier.type === firstTargetEvent.type && firstTargetEvent.type === 'user/message',
  `${firstTargetEvent === undefined ? '?' : firstTargetEvent.type} -> ${firstCarrier.type}`,
)
check(
  'the landed replacement lists the whole window it shadows',
  landedCarrier !== undefined && JSON.stringify(landedCarrier.sourceEventSeqs) === JSON.stringify(firstPlan.shadowed),
  JSON.stringify(landedCarrier === undefined ? null : landedCarrier.sourceEventSeqs),
)
check(
  'the landed replacement carries the semantic marker',
  landedCarrier !== undefined &&
    landedCarrier.data.source.kind === `plugin:${PLUGIN_ID}` &&
    landedCarrier.data.source.editedBy === PLUGIN_ID,
  JSON.stringify(landedCarrier === undefined ? null : landedCarrier.data.source),
)
// Documented behaviour, not an accident: a consumer that finds human prompts by
// `source.kind === 'user'` will classify the revision as plugin content. That is
// deliberate - it is not a fresh human turn, and the platform must not answer it.
check(
  'a rewritten prompt is plugin content, not a fresh human turn',
  landedCarrier !== undefined && landedCarrier.data.source.kind !== 'user',
  JSON.stringify(landedCarrier === undefined ? null : landedCarrier.data.source.kind),
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
check('the plan names the original turn and step', replyPlan.turn === 1 && replyPlan.step === 1)
// The correction cannot reuse the original turn: by the time it is written that
// turn is closed, and the read path refuses a step message outside an open turn
// and step. It gets a turn of its own, which also advances the runtime's own
// counter (it projects `lastTurn` from every turn/start it observes).
const replyTurn = nextTurnOf(replyEvents)
check('the correction gets the next turn in the log', replyTurn === 3, String(replyTurn))

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

// What is accepted instead: open a turn, roll back invisibly, append the
// correction inside it, close it.
const replyCarrier = buildCarrier(replyPlan, replyTurn, { carrier: 'system/message' })
let replyFailure = null
try {
  replySession.append('turn/start', { turn: replyTurn })
  replySession.append('step/start', { turn: replyTurn, step: 1 })
  replySession.append(replyCarrier.type, replyCarrier.data, {
    surfaceOp: { op: 'replace', startSeq: replyPlan.startSeq, endSeq: replyPlan.endSeq },
    sourceEventSeqs: replyPlan.shadowed,
  })
  const correction = buildCorrection(replyPlan, '改写后的回答', replyTurn, 1)
  replySession.append(correction.type, correction.data, { surfaceOp: 'append' })
  replySession.append('step/end', { turn: replyTurn, step: 1 })
  replySession.append('turn/end', { turn: replyTurn, reason: { kind: 'completed' } })
} catch (error) {
  replyFailure = String((error && error.message) || error)
}
check('turn + rollback + appended correction is ACCEPTED', replyFailure === null, replyFailure)
check(
  'the turn is closed behind the correction',
  replySession.snapshotEvents().slice(-3).map((event) => event.type).join(',') === 'assistant/message,step/end,turn/end',
  replySession.snapshotEvents().slice(-3).map((event) => event.type).join(','),
)
check(
  'the closing turn/end names the correction turn',
  replySession.snapshotEvents().at(-1).data.turn === replyTurn,
  String(replySession.snapshotEvents().at(-1).data.turn),
)
// THE check this file was missing: the read path. Without it the suite blessed
// a write that only the lenient append accepted.
const replyLoadFailure = loadFailure(replySession)
check('the reply edit survives the read-path validator', replyLoadFailure === null, String(replyLoadFailure))
const afterReply = texts(replySession.deriveMessages())
const rolesAfterReply = replySession.deriveMessages().map((message) => message.role)
check('the model now sees the corrected text as its own reply',
  afterReply.length === 3 && afterReply[2] === '改写后的回答', JSON.stringify(afterReply))
check('the earlier prompt is untouched and still first', afterReply[1] === '第一轮提问', JSON.stringify(afterReply))
check('the history stays strictly alternating', rolesAfterReply.join(',') === 'system,user,assistant', rolesAfterReply.join(','))
check('the tool result left together with the reply it belonged to',
  !replySession.deriveMessages().some((message) => (message.content || []).some((block) => block.type === 'tool-result')))
// Found by its marker, not by position: the closing events now come after it.
// The type is part of the search: the silent carrier of the rollback carries the
// same marker, and this is about the correction that follows it.
const appendedCorrection = replySession
  .snapshotEvents()
  .find((event) => event.type === 'assistant/message' &&
    event.data && event.data.message && event.data.message.source &&
    event.data.message.source.editedBy === PLUGIN_ID)
check('the correction can be found by its marker', appendedCorrection !== undefined)
check('the silent carrier is an empty developer message', replyCarrier.type === 'developer/message' && replyCarrier.data.message.content.length === 0, replyCarrier.type)
check('the correction is a model-kind reply, so it renders as one', appendedCorrection.data.message.source.kind === 'model')
check('the correction records who wrote the text', appendedCorrection.data.message.source.editedBy === PLUGIN_ID)
check('the correction carries a turn and a step, so reply nodes cannot collide',
  appendedCorrection.data.turn === replyTurn && appendedCorrection.data.step === 1)
// A reply edit is a multi-node rollback plus an appended correction, never an
// in-place swap: an assistant message may not carry `sourceEventSeqs`, and the
// old reply row is meant to keep no entry - the new row carries it. Pinning
// this so a future "keep the old row's actions" change cannot sneak in.
check(
  'the correction carries no sourceEventSeqs',
  appendedCorrection.sourceEventSeqs === undefined,
  JSON.stringify(appendedCorrection.sourceEventSeqs),
)
let continueFailure = null
try {
  replySession.append('user/message', userMessage('m-next', '下一个问题'), { surfaceOp: 'append' })
} catch (error) {
  continueFailure = String((error && error.message) || error)
}
check('the conversation can continue from a corrected reply', continueFailure === null, continueFailure)
check('the follow-up lands after the correction', texts(replySession.deriveMessages()).at(-1) === '下一个问题')
// And a full turn after a reply edit opens the turn the format expects (the one
// our edit consumed), which is what keeps the NEXT user message writable and
// readable. This is the other half of what the old write got wrong.
let nextTurnFailure = null
try {
  replySession.append('turn/start', { turn: replyTurn + 1 })
  replySession.append('step/start', { turn: replyTurn + 1, step: 1 })
  replySession.append('user/message', userMessage('m-later', '再下一个问题'), { surfaceOp: 'append' })
  replySession.append('step/end', { turn: replyTurn + 1, step: 1 })
  replySession.append('turn/end', { turn: replyTurn + 1, reason: { kind: 'completed' } })
} catch (error) {
  nextTurnFailure = String((error && error.message) || error)
}
check('the next real turn opens the expected number', nextTurnFailure === null, nextTurnFailure)
check(
  'the log still loads after the next real turn',
  loadFailure(replySession) === null,
  String(loadFailure(replySession)),
)

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
