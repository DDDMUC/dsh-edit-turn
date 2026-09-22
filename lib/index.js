// dsh-edit-turn - host half.
//
// Two loopback-only JSON routes:
//
//   GET  /dsh-edit-turn/state?sessionId=<id>
//   POST /dsh-edit-turn/apply   { sessionId, seq|messageId|turn, text }
//
// An edit is two official operations, in order:
//
//   1. ROLLBACK - append ONE surface event whose `surfaceOp` is
//      `{ op: 'replace', startSeq, endSeq }` over the inclusive surface window
//      "the addressed user message .. the last surface node". The official fold
//      swaps that whole window for the replacing event, so every event recorded
//      after the edit point leaves the derived model context while the
//      append-only log keeps every original byte ("Committed events are never
//      rewritten"). The window always ends at the last surface node, so an
//      assistant message (which carries its own tool_use blocks) and the
//      tool/result it produced are always shadowed together: no call/result
//      pair can be left dangling.
//
//   2. RE-RUN - `ctx.sessionController.prompt(...)`, the one official prompt
//      admission path. It resumes the Session when cold and starts exactly one
//      new turn from the revised text.
//
// The replacement carrier defaults to an EMPTY `system/message`. The official
// format documents an empty later system node as dormant - "empty later nodes
// are dormant and project to no message" - so the rollback adds nothing the
// model can see and the derived context after an edit is exactly what it would
// be had the conversation really stopped at the edit point. `carrier:
// 'user/message'` switches to a short marker text instead; that shape is what
// an equivalent plugin already runs in production, so it is the fallback.
// Either way `sourceEventSeqs` must list the complete shadowed node set, which
// is why an `assistant/message` carrier is impossible (it forbids
// `sourceEventSeqs` outright).
//
// The module imports only `@deepseek-ai/schemastery` and
// `@deepseek-ai/dsh-tools` (both declared). Every DSH service is resolved
// through the cordis context at call time, so the plugin still loads on a
// profile that lacks one and degrades to a clear HTTP failure instead.
import { randomUUID } from 'node:crypto'
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'

/** Plugin id shared by the host and browser halves. */
export const PLUGIN_ID = 'dsh-edit-turn'

/** Cordis plugin name. */
export const name = PLUGIN_ID

/** Keep in sync with package.json and lib/client.js. */
export const PLUGIN_VERSION = '0.1.1'

const ROUTE_PREFIX = '/dsh-edit-turn'
const SESSION_ID_RE = /^(session-)?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const MAX_TEXT = 200_000
const PROMPT_DEADLINE_MS = 30_000
const FLUSH_DEADLINE_MS = 5_000

/**
 * Model-visible text of the replacement carrier.
 *
 * A `user/message` carrier always projects into the model context, so the
 * default states the one fact the revised context cannot express on its own:
 * earlier turns were deliberately dropped. Keep it short and factual.
 */
const DEFAULT_MARKER = '[dsh-edit-turn] The user revised an earlier message. Every turn after that message was rolled back; the revised message follows. Send your reply to the revised message.'

/** Deployment policy for the rollback. */
export const Config = z.object({
  markerText: z.string().default(DEFAULT_MARKER),
  confirm: z.boolean().default(true),
})

// ---------------------------------------------------------------------------
// pure session-log logic (no DSH SDK imports; unit-testable under node --test)
// ---------------------------------------------------------------------------

/** The four event types that may carry `surfaceOp` (official surface contract). */
const SURFACE_TYPES = new Set([
  'system/message',
  'user/message',
  'assistant/message',
  'tool/result',
])

/**
 * Whether one event participates in the model-visible surface.
 * @param event - raw session event.
 * @returns true for a message-producing event type.
 */
export function isSurfaceEvent(event) {
  const type = event && event.type
  return typeof type === 'string' && SURFACE_TYPES.has(type)
}

/**
 * Replay the surface operations of a complete log.
 *
 * Mirrors the official fold: `append` pushes the event onto the tail; a
 * `replace` swaps the inclusive window between its two surface nodes for the
 * replacing event. Replacements whose anchors are no longer present are skipped
 * defensively - a corrupt log must not throw inside an HTTP handler.
 *
 * @param events - complete contiguous raw event log in seq order.
 * @returns current surface seqs in model order plus every landed replacement.
 */
export function foldSurface(events) {
  const nodes = []
  const replacements = []
  for (const event of events) {
    const op = event.surfaceOp
    if (op === undefined) continue
    if (op === 'append') {
      nodes.push(event.seq)
      continue
    }
    if (op === null || typeof op !== 'object' || op.op !== 'replace') continue
    const startIdx = nodes.indexOf(op.startSeq)
    const endIdx = nodes.indexOf(op.endSeq)
    if (startIdx === -1 || endIdx === -1 || startIdx > endIdx) continue
    const shadowed = nodes.slice(startIdx, endIdx + 1)
    nodes.splice(startIdx, endIdx - startIdx + 1, event.seq)
    replacements.push({ seq: event.seq, startSeq: op.startSeq, endSeq: op.endSeq, shadowed })
  }
  return { nodes, replacements }
}

/**
 * Map every event seq to the turn that encloses it.
 *
 * Turn brackets are the durable source for user messages (their payload has no
 * turn field); assistant and tool events carry their own turn and override the
 * bracket reading.
 *
 * @param events - complete contiguous raw event log.
 * @returns seq -> turn number (undefined outside any turn).
 */
export function turnIndex(events) {
  const turnOf = new Map()
  let current
  for (const event of events) {
    if (event.type === 'turn/start') {
      current = event.data && event.data.turn
      turnOf.set(event.seq, current)
      continue
    }
    if (event.type === 'turn/end') {
      turnOf.set(event.seq, current)
      current = undefined
      continue
    }
    const data = event.data
    const explicit =
      (event.type === 'assistant/message' || event.type === 'tool/result' || event.type === 'tool/call') &&
      data &&
      typeof data.turn === 'number'
        ? data.turn
        : undefined
    turnOf.set(event.seq, explicit !== undefined ? explicit : current)
  }
  return turnOf
}

/** The turn still awaiting its `turn/end`, or null when every turn closed. */
export function openTurn(events) {
  let open = null
  for (const event of events) {
    if (event.type === 'turn/start') open = event.data && event.data.turn
    else if (event.type === 'turn/end' && (open === null || event.data.turn === open)) open = null
  }
  return open
}

/** Whether an operation is in flight that will still write the surface. */
export function isBusy(events) {
  if (openTurn(events) !== null) return true
  let compaction = false
  for (const event of events) {
    if (event.type === 'compaction/start') compaction = true
    else if (event.type === 'compaction/end') compaction = false
  }
  return compaction
}

/**
 * Durable message identity of one surface event.
 * @param event - raw session event.
 * @returns the message id, or undefined for an event without one.
 */
export function messageIdOf(event) {
  const data = event.data
  if (!data || typeof data !== 'object') return undefined
  if (event.type === 'user/message') return typeof data.id === 'string' ? data.id : undefined
  if (event.type === 'assistant/message' || event.type === 'tool/result' || event.type === 'system/message') {
    const message = data.message
    return message && typeof message.id === 'string' ? message.id : undefined
  }
  return undefined
}

/**
 * Whether one event is a human-authored prompt.
 *
 * Injected context, this plugin's own placeholder and compaction checkpoints
 * are all `user/message` events too; only `source.kind === 'user'` is a prompt
 * the user actually typed, so only those are editable.
 *
 * @param event - raw session event.
 * @returns true for a human prompt.
 */
export function isHumanPrompt(event) {
  if (!event || event.type !== 'user/message') return false
  const data = event.data
  return Boolean(data && data.source && data.source.kind === 'user')
}

/**
 * Read the plain text of a message payload, plus how many non-text parts it
 * carries. Editing is text-only, so a caller must be told when a rewrite would
 * drop attachments.
 * @param event - raw session event.
 * @returns `{ text, attachments }`.
 */
export function readMessageText(event) {
  const data = (event && event.data) || {}
  const blocks = Array.isArray(data.content) ? data.content : []
  let text = ''
  let attachments = 0
  for (const block of blocks) {
    if (!block || typeof block !== 'object') continue
    if (block.type === 'text' && typeof block.text === 'string') text += (text === '' ? '' : '\n') + block.text
    else attachments += 1
  }
  return { text, attachments }
}

/**
 * Rebuild this plugin's rollback ledger from the log alone.
 *
 * Every rollback is one replacement event whose message source is
 * `{ kind: 'plugin', plugin: 'dsh-edit-turn' }`. A replacement landed by any
 * other producer - compaction, for instance - is ignored.
 *
 * @param events - complete contiguous raw event log.
 * @returns `{ hidden, edits }`: one hidden entry per shadowed seq, and one
 *   record per landed rollback.
 */
export function rollbackLedger(events) {
  const folded = foldSurface(events)
  const bySeq = new Map(events.map((event) => [event.seq, event]))
  const turnOf = turnIndex(events)
  const hidden = []
  const edits = []
  for (const replacement of folded.replacements) {
    const event = bySeq.get(replacement.seq)
    const data = event && event.data
    const source = data && (data.source || (data.message && data.message.source))
    if (!source || source.kind !== 'plugin' || source.plugin !== PLUGIN_ID) continue
    for (const seq of replacement.shadowed) {
      const turn = turnOf.get(seq)
      hidden.push({ seq, turn: typeof turn === 'number' ? turn : null, replacement: replacement.seq })
    }
    edits.push({
      replacementSeq: replacement.seq,
      startSeq: replacement.startSeq,
      endSeq: replacement.endSeq,
      shadowed: replacement.shadowed,
    })
  }
  return { hidden, edits }
}

/** Highest turn number recorded in the log, or undefined for an empty log. */
export function lastTurnOf(events) {
  let last
  for (const event of events) {
    const turn = event.data && event.data.turn
    if (typeof turn === 'number' && (last === undefined || turn > last)) last = turn
  }
  return last
}

/** Planner rejection with a machine code the HTTP layer forwards verbatim. */
export class EditPlanError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'EditPlanError'
    this.code = code
  }
}

/**
 * Resolve one editing target inside a log.
 * @param events - complete contiguous raw event log.
 * @param request - `{ seq?, messageId?, turn? }`.
 * @returns the target event.
 * @throws {EditPlanError} with `not-editable` when no unique target exists.
 */
function resolveTarget(events, request) {
  let targetSeq = typeof request.seq === 'number' ? request.seq : undefined
  if (targetSeq === undefined && typeof request.messageId === 'string' && request.messageId !== '') {
    for (const event of events) {
      if (messageIdOf(event) === request.messageId) {
        targetSeq = event.seq
        break
      }
    }
  }
  if (targetSeq === undefined && typeof request.turn === 'number') {
    for (const event of events) {
      if (!isHumanPrompt(event)) continue
      if (turnIndex(events).get(event.seq) !== request.turn) continue
      targetSeq = event.seq
      break
    }
  }
  if (targetSeq === undefined) throw new EditPlanError('not-editable', 'no editing target was found')
  const target = events.find((event) => event.seq === targetSeq)
  if (!target) throw new EditPlanError('not-editable', 'the target event does not exist')
  return target
}

/**
 * Turn one UI target into the canonical rollback window.
 *
 * The window is `[the addressed prompt .. the last surface node]`: the complete
 * remainder of the conversation in surface order. It is contiguous by
 * construction, it always ends on a completed turn's last node, and its left
 * edge is exactly the prompt being rewritten, so the surviving prefix ends on
 * the previous turn's boundary.
 *
 * @param events - complete contiguous raw event log.
 * @param surfaceNodes - current surface seqs in model order.
 * @param request - `{ seq?, messageId?, turn? }`.
 * @returns `{ targetSeq, startSeq, endSeq, shadowed, turn, original, attachments }`.
 * @throws {EditPlanError} with a stable code when the target cannot be planned.
 */
export function planRollback(events, surfaceNodes, request) {
  const nodeIndex = new Map(surfaceNodes.map((seq, index) => [seq, index]))
  const turnOf = turnIndex(events)
  const target = resolveTarget(events, request, turnOf)
  if (!nodeIndex.has(target.seq)) {
    throw new EditPlanError('already-rolled-back', 'this message is no longer on the current surface')
  }
  // Surface node 0 is the system prompt head: the official append contract only
  // lets a system/message rewrite exactly that node, and no UI row targets it.
  if (target.seq === surfaceNodes[0]) {
    throw new EditPlanError('not-editable', 'the system prompt head cannot be edited')
  }
  if (!isHumanPrompt(target)) {
    throw new EditPlanError('not-editable', 'only messages you typed can be edited and re-run')
  }
  const startIdx = nodeIndex.get(target.seq)
  const shadowed = surfaceNodes.slice(startIdx)
  if (shadowed.length === 0 || shadowed[0] !== target.seq) {
    throw new EditPlanError('not-editable', 'the target does not open a rollback window')
  }
  const { text, attachments } = readMessageText(target)
  const turn = turnOf.get(target.seq)
  return {
    targetSeq: target.seq,
    messageId: messageIdOf(target),
    startSeq: shadowed[0],
    endSeq: shadowed[shadowed.length - 1],
    shadowed,
    turn: typeof turn === 'number' ? turn : null,
    original: text,
    attachments,
  }
}

/**
 * Every human prompt that can currently be edited.
 *
 * A prompt that already left the surface (an earlier rollback shadowed it, or a
 * compaction consumed it) keeps its transcript row on purpose, so it must not
 * be offered again.
 *
 * @param events - complete contiguous raw event log.
 * @param surfaceNodes - current surface seqs in model order.
 * @returns one entry per editable prompt, in conversation order.
 */
export function editableTurns(events, surfaceNodes) {
  const nodeIndex = new Map(surfaceNodes.map((seq, index) => [seq, index]))
  const turnOf = turnIndex(events)
  const head = surfaceNodes[0]
  const out = []
  for (const event of events) {
    if (!isHumanPrompt(event)) continue
    if (!nodeIndex.has(event.seq)) continue
    if (event.seq === head) continue
    const { text, attachments } = readMessageText(event)
    const turn = turnOf.get(event.seq)
    out.push({
      seq: event.seq,
      turn: typeof turn === 'number' ? turn : null,
      messageId: messageIdOf(event) ?? null,
      text,
      attachments,
    })
  }
  return out
}

// ---------------------------------------------------------------------------
// host service plumbing
// ---------------------------------------------------------------------------

class HttpError extends Error {
  constructor(status, code, message) {
    super(message)
    this.name = 'HttpError'
    this.status = status
    this.code = code
  }
}

// A session id travels in two spellings: the raw uuid and `session-<uuid>`.
// The store, the persistence directories and the workspace rows disagree about
// which one they hold, so every lookup tries both.
function idVariants(sessionId) {
  const out = new Set([sessionId])
  if (sessionId.startsWith('session-')) out.add(sessionId.slice('session-'.length))
  else out.add(`session-${sessionId}`)
  return [...out]
}

function findLiveSession(ctx, sessionId) {
  const sessions = ctx.get('sessions')
  if (!sessions || typeof sessions.get !== 'function') return undefined
  for (const variant of idVariants(sessionId)) {
    const found = sessions.get(variant)
    if (found) return found
  }
  return undefined
}

// Resolve the live Session that owns the append. An already-open session is
// used directly; a cold one is resumed through the official controller, which
// is exactly what the web UI does when the user opens it.
async function resolveSession(ctx, sessionId) {
  const live = findLiveSession(ctx, sessionId)
  if (live) return live
  const controller = ctx.get('sessionController')
  if (controller && typeof controller.resolveAgent === 'function') {
    try {
      const result = await controller.resolveAgent(sessionId)
      if (result && result.agent && result.agent.session) return result.agent.session
    } catch {
      // fall through to the explicit failure below
    }
  }
  return undefined
}

function eventsFromLive(session) {
  if (session && typeof session.snapshotEvents === 'function') {
    try {
      const events = session.snapshotEvents()
      if (Array.isArray(events)) return events
    } catch {
      // fall through to the query service
    }
  }
  return undefined
}

// Live-preferred read through the public query service; the live session's own
// snapshot is the fallback when the service is absent.
async function readEvents(ctx, sessionId) {
  const query = ctx.get('sessionQuery')
  if (query && typeof query.readSession === 'function') {
    try {
      const snapshot = await query.readSession(sessionId)
      if (snapshot && Array.isArray(snapshot.events)) return snapshot.events
    } catch {
      // fall through to the live snapshot
    }
  }
  const events = eventsFromLive(findLiveSession(ctx, sessionId))
  return events ?? null
}

function surfaceOf(ctx, sessionId, events) {
  const live = findLiveSession(ctx, sessionId)
  const nodes = live && live.surface && Array.isArray(live.surface.nodes) ? live.surface.nodes : undefined
  return nodes ?? foldSurface(events).nodes
}

// The append is committed in memory the moment `session.append` returns; the
// persistence writer buffers asynchronously. Await the official durability
// checkpoint so a reload or a DSH restart still sees the rollback.
async function flushSession(ctx, session) {
  const errors = []
  const sessions = ctx.get('sessions')
  if (sessions && typeof sessions.flush === 'function') {
    try {
      await Promise.race([sessions.flush(session), new Promise((resolve) => setTimeout(resolve, FLUSH_DEADLINE_MS))])
      return { flushed: true }
    } catch (error) {
      errors.push(String((error && error.message) || error))
    }
  } else {
    errors.push('sessions.flush unavailable')
  }
  const persistence = ctx.get('sessionPersistence')
  if (persistence && typeof persistence.flush === 'function') {
    try {
      await Promise.race([persistence.flush(), new Promise((resolve) => setTimeout(resolve, FLUSH_DEADLINE_MS))])
      return { flushed: true }
    } catch (error) {
      errors.push(String((error && error.message) || error))
    }
  } else {
    errors.push('sessionPersistence.flush unavailable')
  }
  return { flushed: false, flushError: errors.join(' | ') }
}

// --- operations --------------------------------------------------------------

async function stateOf(ctx, sessionId, config) {
  const events = await readEvents(ctx, sessionId)
  if (!events) throw new HttpError(404, 'session-not-found', 'no session log for this id')
  const folded = foldSurface(events)
  const ledger = rollbackLedger(events)
  const live = findLiveSession(ctx, sessionId)
  return {
    hidden: ledger.hidden,
    edits: ledger.edits.length,
    surface: folded.nodes,
    turns: editableTurns(events, folded.nodes),
    live: Boolean(live),
    busy: isBusy(events),
    lastSeq: events.length > 0 ? events[events.length - 1].seq : -1,
    config: { confirm: config.confirm },
    version: PLUGIN_VERSION,
  }
}

/**
 * Build the event that carries one rollback replacement.
 *
 * @param plan - the planned window.
 * @param lastTurn - highest turn number in the log, for a coherent bracket.
 * @param config - resolved deployment policy.
 * @returns `{ type, data }` for `session.append`.
 */
export function buildCarrier(plan, lastTurn, config) {
  const silent = config.carrier !== 'user/message'
  if (silent) {
    // An empty later system node is dormant and projects to no model message.
    return {
      type: 'system/message',
      data: {
        turn: typeof lastTurn === 'number' ? lastTurn : 0,
        step: 1,
        message: {
          id: randomUUID(),
          role: 'system',
          content: [],
          source: { kind: 'plugin', plugin: PLUGIN_ID },
        },
      },
    }
  }
  return {
    type: 'user/message',
    data: {
      id: randomUUID(),
      role: 'user',
      content: [{ type: 'text', text: config.markerText }],
      source: { kind: 'plugin', plugin: PLUGIN_ID },
    },
  }
}

async function applyEdit(ctx, sessionId, body, config) {
  const text = typeof body.text === 'string' ? body.text : ''
  if (text.trim() === '') throw new HttpError(400, 'invalid', 'the revised message cannot be empty')
  if (text.length > MAX_TEXT) throw new HttpError(400, 'invalid', 'the revised message is too long')

  const session = await resolveSession(ctx, sessionId)
  if (!session || typeof session.append !== 'function') {
    throw new HttpError(409, 'session-not-active', 'the session is not open in DSH')
  }
  const events = await readEvents(ctx, sessionId)
  if (!events) throw new HttpError(404, 'session-not-found', 'no session log for this id')
  if (isBusy(events)) throw new HttpError(409, 'busy', 'the session is still working')

  const surfaceNodes = surfaceOf(ctx, sessionId, events)
  let plan
  try {
    plan = planRollback(events, surfaceNodes, {
      seq: typeof body.seq === 'number' ? body.seq : undefined,
      messageId: typeof body.messageId === 'string' ? body.messageId : undefined,
      turn: typeof body.turn === 'number' ? body.turn : undefined,
    })
  } catch (error) {
    if (error instanceof EditPlanError) {
      const status = error.code === 'not-editable' ? 400 : 409
      throw new HttpError(status, error.code, error.message)
    }
    throw error
  }

  // The live surface is the append authority; a node that vanished between the
  // read and this check means another writer landed first.
  for (const seq of plan.shadowed) {
    if (!surfaceNodes.includes(seq)) throw new HttpError(409, 'stale', 'the session changed, retry')
  }

  const carrier = buildCarrier(plan, lastTurnOf(events), config)
  let replacement
  try {
    // A replacement carrier has to be a surface event with non-empty
    // `sourceEventSeqs` coverage of the whole shadowed window. An assistant
    // message forbids `sourceEventSeqs` outright, so the carrier is either an
    // empty `system/message` (default, dormant, invisible) or a short
    // `user/message` marker.
    replacement = session.append(carrier.type, carrier.data, {
      surfaceOp: { op: 'replace', startSeq: plan.startSeq, endSeq: plan.endSeq },
      sourceEventSeqs: plan.shadowed,
    })
  } catch (error) {
    throw new HttpError(409, 'stale', `the surface refused the rollback: ${String((error && error.message) || error)}`)
  }
  const flush = await flushSession(ctx, session)

  // Step two: admit the revised prompt. This is the only official prompt path,
  // so it also resumes a cold Session and starts exactly one new turn.
  const controller = ctx.get('sessionController')
  if (!controller || typeof controller.prompt !== 'function') {
    return {
      replacementSeq: replacement.seq,
      promptAccepted: false,
      promptError: 'sessionController.prompt unavailable',
      shadowed: plan.shadowed,
      ...flush,
    }
  }
  try {
    await controller.prompt(
      {
        requestId: randomUUID(),
        sessionId,
        mode: 'queue',
        content: [{ type: 'text', text }],
      },
      AbortSignal.timeout(PROMPT_DEADLINE_MS),
    )
  } catch (error) {
    return {
      replacementSeq: replacement.seq,
      promptAccepted: false,
      promptError: String((error && error.message) || error),
      shadowed: plan.shadowed,
      ...flush,
    }
  }

  return {
    replacementSeq: replacement.seq,
    promptAccepted: true,
    shadowed: plan.shadowed,
    ...flush,
  }
}

// --- tool --------------------------------------------------------------------

/**
 * Session id the calling agent runs in, when the tool context exposes one.
 * @param exec - tool execution context.
 * @returns the session id, or undefined when the caller has no agent.
 */
function sessionIdFromExec(exec) {
  const agent = exec && exec.agent
  const session = agent && agent.session
  if (session && typeof session.id === 'string' && session.id !== '') return session.id
  if (agent && typeof agent.sessionId === 'string' && agent.sessionId !== '') return agent.sessionId
  if (exec && typeof exec.sessionId === 'string' && exec.sessionId !== '') return exec.sessionId
  return undefined
}

function registerTool(ctx) {
  const tools = ctx.get('tools')
  if (!tools || typeof tools.register !== 'function') return
  tools.register(
    defineTool({
      name: 'edit_turn_targets',
      description:
        'List the user turns of a DeepSeek Harness session that the edit-turn plugin can rewrite and re-run, with each prompt\'s original text. Read-only: it changes nothing.',
      parameters: {
        sessionId: {
          type: 'string',
          description: 'Session id to inspect. Defaults to the session this agent is running in.',
        },
        limit: { type: 'number', description: 'Maximum number of turns to return (default 20).' },
      },
      output: {
        schema: { type: 'string' },
        render: (_args, value) => [{ type: 'text', text: value }],
      },
      async execute(args, exec) {
        const sessionId = typeof args.sessionId === 'string' && args.sessionId !== '' ? args.sessionId : sessionIdFromExec(exec)
        if (sessionId === undefined) {
          throw new Error('no sessionId was supplied and the calling agent has no session')
        }
        const events = await readEvents(ctx, sessionId)
        if (!events) throw new Error(`no session log for ${sessionId}`)
        const nodes = surfaceOf(ctx, sessionId, events)
        const turns = editableTurns(events, nodes)
        const limit = typeof args.limit === 'number' && args.limit > 0 ? Math.floor(args.limit) : 20
        const shown = turns.slice(-limit)
        const lines = [
          `session ${sessionId}: ${turns.length} editable turn(s), ${isBusy(events) ? 'BUSY' : 'idle'}`,
        ]
        for (const turn of shown) {
          const preview = turn.text.length > 160 ? `${turn.text.slice(0, 160)}...` : turn.text
          lines.push(`- turn ${turn.turn} (seq ${turn.seq}, ${turn.attachments} attachment(s)): ${preview}`)
        }
        if (turns.length > shown.length) lines.push(`(${turns.length - shown.length} earlier turn(s) omitted)`)
        return lines.join('\n')
      },
    }),
  )
}

// --- http --------------------------------------------------------------------

function isLoopbackAddress(address) {
  if (typeof address !== 'string' || address.length === 0) return false
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1' || address.startsWith('127.')
}

function isLocalHostHeader(host) {
  if (typeof host !== 'string' || host.length === 0) return false
  const trimmed = host.trim().toLowerCase()
  // A bracketed IPv6 literal keeps its colons, so the port can only be split
  // off after the closing bracket, and nothing but an optional port may follow.
  if (trimmed.startsWith('[')) {
    const end = trimmed.indexOf(']')
    if (end === -1) return false
    const rest = trimmed.slice(end + 1)
    if (rest !== '' && !/^:[0-9]+$/.test(rest)) return false
    return trimmed.slice(1, end) === '::1'
  }
  const match = /^([^:]*)(?::([0-9]+))?$/.exec(trimmed)
  if (match === null) return false
  // Exact matches only: a name like `127.0.0.1.evil.test` must not pass.
  return match[1] === 'localhost' || match[1] === '127.0.0.1' || match[1] === '::1'
}

function sendJson(res, status, body) {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
  })
  res.end(payload)
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = ''
    req.on('data', (chunk) => {
      data += chunk
      if (data.length > 1e6) req.destroy()
    })
    req.on('end', () => resolve(data))
    req.on('error', reject)
    req.on('aborted', () => reject(new Error('aborted')))
  })
}

// Rewriting the derived context is destructive for the model, so every route
// demands a loopback socket, a loopback Host header, and a same-origin check
// when the browser sends Origin.
function guard(req, res) {
  if (!isLoopbackAddress(req.socket && req.socket.remoteAddress)) {
    sendJson(res, 403, { ok: false, code: 'forbidden', error: 'loopback only' })
    return false
  }
  const host = req.headers.host
  if (!isLocalHostHeader(host)) {
    sendJson(res, 403, { ok: false, code: 'forbidden', error: 'unexpected host' })
    return false
  }
  const origin = req.headers.origin
  if (typeof origin === 'string' && origin.length > 0) {
    let originHost = null
    try {
      originHost = new URL(origin).host
    } catch {
      originHost = null
    }
    if (originHost !== host) {
      sendJson(res, 403, { ok: false, code: 'forbidden', error: 'cross-origin request' })
      return false
    }
  }
  return true
}

function sessionIdFromQuery(url) {
  try {
    return (new URL(url, 'http://localhost').searchParams.get('sessionId') || '').trim()
  } catch {
    return ''
  }
}

function requireSessionId(value) {
  if (!value) throw new HttpError(400, 'invalid', 'sessionId required')
  if (!SESSION_ID_RE.test(value)) throw new HttpError(400, 'invalid', 'invalid session id')
  return value
}

function failure(res, error) {
  const status = error instanceof HttpError ? error.status : 500
  const code = error instanceof HttpError ? error.code : 'internal'
  sendJson(res, status, { ok: false, code, error: String((error && error.message) || error) })
}

// --- plugin ------------------------------------------------------------------

export function apply(ctx, config) {
  const resolved = {
    markerText:
      config && typeof config.markerText === 'string' && config.markerText.trim() !== ''
        ? config.markerText
        : DEFAULT_MARKER,
    carrier: config && config.carrier === 'user/message' ? 'user/message' : 'system/message',
    confirm: config && typeof config.confirm === 'boolean' ? config.confirm : true,
  }

  const registerRoutes = (webServer, fiber) => {
    fiber.effect(() =>
      webServer.register({
        kind: 'exact',
        path: `${ROUTE_PREFIX}/state`,
        handler: async (req, res) => {
          if (!guard(req, res)) return
          if (req.method !== 'GET') {
            sendJson(res, 405, { ok: false, code: 'method', error: 'GET only' })
            return
          }
          try {
            const sessionId = requireSessionId(sessionIdFromQuery(req.url))
            sendJson(res, 200, { ok: true, ...(await stateOf(ctx, sessionId, resolved)) })
          } catch (error) {
            failure(res, error)
          }
        },
      }),
    )

    fiber.effect(() =>
      webServer.register({
        kind: 'exact',
        path: `${ROUTE_PREFIX}/apply`,
        handler: async (req, res) => {
          if (!guard(req, res)) return
          if (req.method !== 'POST') {
            sendJson(res, 405, { ok: false, code: 'method', error: 'POST only' })
            return
          }
          let body = {}
          try {
            const raw = await readBody(req)
            if (raw) body = JSON.parse(raw)
          } catch {
            sendJson(res, 400, { ok: false, code: 'invalid', error: 'malformed JSON body' })
            return
          }
          try {
            const sessionId = requireSessionId(typeof body.sessionId === 'string' ? body.sessionId.trim() : '')
            sendJson(res, 200, { ok: true, ...(await applyEdit(ctx, sessionId, body, resolved)) })
          } catch (error) {
            failure(res, error)
          }
        },
      }),
    )
  }

  const webServer = ctx.get('webServer')
  if (webServer) {
    registerRoutes(webServer, ctx)
  } else {
    ctx.inject(['webServer'], (sub) => registerRoutes(sub.webServer, sub))
  }

  const tools = ctx.get('tools')
  if (tools) {
    registerTool(ctx)
  } else {
    ctx.inject(['tools'], (sub) => registerTool(sub))
  }
}

export default apply
