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
//
// A revised PROMPT carries the message itself: the carrier's content is the
// user's block list after the edit, rebuilt block by block. A block the user
// did not touch is copied out of the original message verbatim - same object,
// same fields, same attachment reference - a block the user added is admitted
// through the platform's attachment store (`ctx.get('attachments')`, the seam
// dsh-acp uses) and a block the user removed is simply not written. The revised
// text lands where the original's first text block was, so the layout survives
// the edit. Nothing in that path names a block shape: the only test in the
// module is "does this block carry text", which is the editor's own field, so a
// block type the platform adds later needs no change here.
//
// The silent replacement carrier is an EMPTY `developer/message` (0.2.12;
// before that an empty `system/message`, which no reader accepts - see the
// README). Empty content projects to no model message, so the rollback adds
// nothing the model can see and the derived context after an edit is exactly
// what it would be had the conversation really stopped at the edit point.
// `sourceEventSeqs` must list the complete shadowed node set, which
// is why an `assistant/message` carrier is impossible (it forbids
// `sourceEventSeqs` outright).
//
// The module resolves `@deepseek-ai/schemastery` defensively. `dsh-tools` is a
// host-provided peer (the loader resolves it for every plugin), but the schema
// package is a regular dependency: when it cannot be resolved - a pruned
// package cache, an installation that skipped dependencies - a static import
// takes the whole plugin down and the feature simply disappears from the UI
// with nothing but a line on the host's stdout to explain it. A guarded require
// degrades to "no config form, defaults apply" instead, which costs a settings
// surface rather than the feature. Every field is optional in `apply` anyway.
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { defineTool } from '@deepseek-ai/dsh-tools'

const nodeRequire = createRequire(import.meta.url)
const schemaPackage = (() => {
  try {
    return nodeRequire('@deepseek-ai/schemastery')
  } catch {
    return null
  }
})()
const z = schemaPackage === null ? null : (schemaPackage.default ?? schemaPackage)

/** Plugin id shared by the host and browser halves. */
export const PLUGIN_ID = 'dsh-edit-turn'

/** Cordis plugin name. */
export const name = PLUGIN_ID

/** Keep in sync with package.json and lib/client.js. */
export const PLUGIN_VERSION = '0.2.20'

// A ring of the last few requests, answering "did the browser half even ask, and
// what did it get?" without needing its console. Read-only diagnostics: the
// browser half's own state is otherwise invisible from the host side.
const REQUEST_LOG_LIMIT = 40
const requestLog = []

/** Record one request for the diagnostic route. */
export function noteRequest(entry) {
  requestLog.push({ at: Date.now(), ...entry })
  if (requestLog.length > REQUEST_LOG_LIMIT) requestLog.shift()
}

/** The recorded requests, oldest first. */
export function recentRequests() {
  return requestLog.slice()
}

const ROUTE_PREFIX = '/dsh-edit-turn'
const SESSION_ID_RE = /^(session-)?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const MAX_TEXT = 200_000
const FLUSH_DEADLINE_MS = 5_000

// A revised block list travels as base64 inside the JSON body, so the body limit
// IS the upload limit. The platform's own per-image ceiling defaults to 20 MiB
// (dsh-attachment-local), which base64 carries in ~27 MiB of text; the store
// enforces its own limit independently, this one only bounds the socket read.
const MAX_BODY_BYTES = 64 * 1024 * 1024
const MAX_UPLOAD_BYTES = 20 * 1024 * 1024
// A preview is a courtesy: above this the chip keeps its label and asks for
// nothing. Never worth streaming a whole file to draw a thumbnail.
const MAX_PREVIEW_BYTES = 32 * 1024 * 1024
// One message cannot carry more blocks than this. The cap exists so a malformed
// or hostile body cannot make the host loop over an unbounded list.
const MAX_PARTS = 64

/**
 * Service names the durable attachment store is reachable under.
 *
 * `attachments` is the platform's own registration (the `AttachmentStore`
 * base class in @deepseek-ai/dsh-attachment, and every `ctx.get('attachments')`
 * consumer such as dsh-acp); the other two are the package names, accepted so a
 * rename cannot silently cost the feature. Absence is a supported state, never
 * an error: the edit degrades to the text-only rewrite it was before blocks.
 */
const ATTACHMENT_SERVICES = ['attachments', 'attachment', 'attachment-local']

/**
 * Model-visible text of the replacement carrier.
 *
 * A `user/message` carrier always projects into the model context, so the
 * default states the one fact the revised context cannot express on its own:
 * earlier turns were deliberately dropped. Keep it short and factual.
 */
const DEFAULT_MARKER = '[dsh-edit-turn] The user revised an earlier message. Every turn after that message was rolled back; the revised message follows. Send your reply to the revised message.'

/**
 * Deployment policy for the rollback.
 *
 * `undefined` when the schema package could not be resolved - DSH then hands
 * `apply` no config at all, and every field below is read with the same default
 * there, so the plugin behaves identically minus the settings form.
 */
export const Config =
  z === null
    ? undefined
    : z.object({
        markerText: z.string().default(DEFAULT_MARKER),
        /**
         * Whether the client asks for a second confirmation before applying. Off
         * by default: the editor is already an explicit action the user opened, and
         * the panel states what saving does. Set it to `true` to require the extra
         * step.
         */
        confirm: z.boolean().default(false),
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
export function isEditCarrier(source) {
  if (!source || typeof source !== 'object') return false
  // Current shape. `editedBy` is what identifies a carrier now; the prompt carrier
  // deliberately keeps `kind: 'user'` (see buildCarrier) so the platform still reads
  // it as the human prompt, and the silent reply carrier keeps a producer-owned kind.
  if (source.editedBy === PLUGIN_ID) return true
  // Historical shapes, kept so ledgers and editability stay correct over logs
  // written by earlier releases: the producer-owned kind without `editedBy`, and
  // the session-format v3 `{ kind: 'plugin', plugin }`.
  if (source.kind === `plugin:${PLUGIN_ID}`) return true
  return source.kind === 'plugin' && source.plugin === PLUGIN_ID
}

export function isHumanPrompt(event) {
  if (!event || event.type !== 'user/message') return false
  const data = event.data
  if (!data || !data.source) return false
  // The platform's own test, and the one every consumer applies (`turn-outline`,
  // the Trajectory view, `ui-chat`, the inbox steering filter, `lastPromptAt`): a
  // human prompt is a `user/message` whose source kind is `'user'`. A message this
  // plugin rewrote stands in a human's place and keeps that kind, so it stays
  // editable (edit it again). Matching a plugin-owned kind instead is what made
  // the rewrite invisible to the turn outline - the round lost its prompt.
  if (data.source.kind === 'user') return true
  // Carriers written before that fix carry a producer-owned kind. Same message -
  // a `user/message` this plugin rewrote - so it must stay editable, or upgrading
  // would silently make every earlier edit un-editable.
  return isEditCarrier(data.source)
}

/**
 * Whether an event is a reply the model produced.
 *
 * Editing one of these is a different operation from editing a prompt: the
 * official append contract refuses to let an `assistant/message` carry
 * `sourceEventSeqs` ("assistant/message embeds its source stream"), so a reply
 * can never be the replacement carrier of a rollback. The rollback is therefore
 * followed by appending the corrected text as a new assistant message, and the
 * model goes on seeing it as its own answer.
 *
 * @param event - raw session event.
 * @returns true for an assistant reply.
 */
export function isAssistantReply(event) {
  return Boolean(event) && event.type === 'assistant/message'
}

/**
 * Whether one content block carries the editable text.
 *
 * This is the module's ONLY block-shape test, and it is deliberately about the
 * field the editor owns rather than about a block class. Every other block - a
 * picture, a file, and whatever type a later platform adds - is carried through
 * an edit untouched unless the user removed it, so no code below ever has to
 * learn a new name.
 *
 * @param block - one content block.
 * @returns true when the block holds text the editor prefills.
 */
export function isTextBlock(block) {
  return Boolean(block) && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string'
}

/**
 * The content blocks of a message payload, in message order.
 *
 * `user/message` carries its message fields on `data`; the other three surface
 * types nest them under `data.message`, so both shapes read the same way now
 * that the model's replies are editable too.
 *
 * @param event - raw session event.
 * @returns the block array, or an empty one when the message carries none.
 */
export function readMessageBlocks(event) {
  const data = (event && event.data) || {}
  const message = data.message && typeof data.message === 'object' ? data.message : data
  return Array.isArray(message.content) ? message.content : []
}

/**
 * Read the plain text of a message payload, plus how many non-text parts it
 * carries. The count is what tells a reader that a text-only carrier would drop
 * something, and it stays exactly what it always was.
 * @param event - raw session event.
 * @returns `{ text, attachments }`.
 */
export function readMessageText(event) {
  let text = ''
  let attachments = 0
  for (const block of readMessageBlocks(event)) {
    if (!block || typeof block !== 'object') continue
    if (isTextBlock(block)) text += (text === '' ? '' : '\n') + block.text
    else attachments += 1
  }
  return { text, attachments }
}

/**
 * The non-text blocks of a message, described for the editor's chips.
 *
 * Read by FIELD PRESENCE, never by type. A block that carries a durable
 * `attachment` reference is described from that reference (name, media type,
 * byte length, pixel size) whatever the platform calls the block; a block
 * without one is described by its own type name alone, which is what a chip can
 * honestly show. This list is for DRAWING and for offering a delete - it never
 * decides what an edit writes, and a block the user keeps is copied verbatim
 * whether or not this function could describe it.
 *
 * @param blocks - the message content, in message order.
 * @param preview - whether the deployment can hand these bytes back for a thumbnail.
 * @returns one entry per non-text block, in message order.
 */
export function blockSummaries(blocks, preview = false) {
  const out = []
  for (let index = 0; index < blocks.length; index += 1) {
    const block = blocks[index]
    if (!block || typeof block !== 'object' || isTextBlock(block)) continue
    const raw = block.attachment
    const attachment = raw && typeof raw === 'object' ? raw : null
    const summary = {
      index,
      type: typeof block.type === 'string' && block.type !== '' ? block.type : 'block',
      preview: false,
    }
    if (attachment !== null) {
      if (typeof attachment.name === 'string' && attachment.name !== '') summary.name = attachment.name
      if (typeof attachment.mediaType === 'string' && attachment.mediaType !== '') summary.mediaType = attachment.mediaType
      if (typeof attachment.bytes === 'number') summary.bytes = attachment.bytes
      if (typeof attachment.width === 'number') summary.width = attachment.width
      if (typeof attachment.height === 'number') summary.height = attachment.height
      summary.preview = preview && typeof attachment.attachmentId === 'string' && attachment.attachmentId !== ''
    }
    out.push(summary)
  }
  return out
}

/**
 * Whether two JSON values are the same value.
 *
 * Used to answer "did this edit change anything at all": the rebuilt block list
 * is compared against the original one, field by field. Key ORDER is not part
 * of a JSON value - a session reader is free to hand the same object back with
 * its keys in another order - so this walks the keys instead of comparing
 * stringified text.
 *
 * @param a - first JSON value.
 * @param b - second JSON value.
 * @returns true when the two are indistinguishable JSON.
 */
export function sameJson(a, b) {
  if (a === b) return true
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false
    for (let index = 0; index < a.length; index += 1) {
      if (!sameJson(a[index], b[index])) return false
    }
    return true
  }
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return false
  const keys = Object.keys(a)
  if (keys.length !== Object.keys(b).length) return false
  for (const key of keys) {
    if (!Object.prototype.hasOwnProperty.call(b, key)) return false
    if (!sameJson(a[key], b[key])) return false
  }
  return true
}

/**
 * Normalise one submitted block list.
 *
 * The wire vocabulary is exactly two entries:
 *
 *   `{ keep: <index> }` - the original block at that index, untouched;
 *   `{ add: { data, mediaType?, name? } }` - bytes the user just picked.
 *
 * Text is never listed: the revised text rides in its own field and the host
 * puts it back where the original's first text block was. A `keep` that names
 * a text block is therefore not an error - it is the text, and the text is
 * already accounted for.
 *
 * @param raw - the submitted `parts` array.
 * @param blockCount - how many blocks the original message carries.
 * @returns `[{ keep } | { add }]` in submitted order.
 * @throws {HttpError} 400 `invalid` for anything this vocabulary does not name.
 */
export function normalizeParts(raw, blockCount) {
  if (!Array.isArray(raw)) throw new HttpError(400, 'invalid', 'parts must be an array')
  if (raw.length > MAX_PARTS) throw new HttpError(400, 'invalid', `a message cannot carry more than ${MAX_PARTS} blocks`)
  const parts = []
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new HttpError(400, 'invalid', 'every part must be an object')
    }
    if (entry.keep !== undefined) {
      const index = entry.keep
      if (!Number.isInteger(index) || index < 0 || index >= blockCount) {
        throw new HttpError(400, 'invalid', 'a kept block index is out of range')
      }
      if (parts.some((part) => part.keep === index)) throw new HttpError(400, 'invalid', 'a block was kept twice')
      parts.push({ keep: index })
      continue
    }
    const upload = entry.add
    if (upload && typeof upload === 'object' && typeof upload.data === 'string') {
      parts.push({
        add: {
          data: upload.data,
          ...(typeof upload.mediaType === 'string' && upload.mediaType !== '' ? { mediaType: upload.mediaType } : {}),
          ...(typeof upload.name === 'string' && upload.name !== '' ? { name: upload.name } : {}),
        },
      })
      continue
    }
    throw new HttpError(400, 'invalid', 'every part is either a kept block or an upload')
  }
  return parts
}

/**
 * The ordered slots a submitted block list describes, plus where the text goes.
 *
 * Layout is the original message's, never a re-invention: the revised text is
 * placed where the original's FIRST text block stood (the editor holds every
 * text block at once, so the others merge into it), and the kept blocks keep
 * their relative order around it. A message with no text block at all - a
 * picture-only prompt - gets its text appended, which is the only position that
 * does not move something the user did not touch.
 *
 * @param originalBlocks - the message content before the edit.
 * @param parts - normalised parts (see {@link normalizeParts}).
 * @returns `{ slots, textAt, added }`; `textAt` indexes `slots`.
 */
export function planBlockLayout(originalBlocks, parts) {
  const slots = []
  let added = 0
  for (const part of parts) {
    if (part.keep !== undefined) {
      // The text blocks are the editor's own content, carried by `text`.
      if (isTextBlock(originalBlocks[part.keep])) continue
      slots.push({ kind: 'original', index: part.keep })
      continue
    }
    slots.push({ kind: 'add', upload: part.add })
    added += 1
  }
  let firstText = -1
  for (let index = 0; index < originalBlocks.length; index += 1) {
    if (isTextBlock(originalBlocks[index])) {
      firstText = index
      break
    }
  }
  let textAt = slots.length
  if (firstText >= 0) {
    // The text stands before the first kept block that came after it in the
    // original message. When no kept block did - everything after it was
    // removed, or it was the last block of all - it keeps its own place at the
    // head of what is left, ahead of the blocks that used to stand before it.
    let anchored = false
    for (let index = 0; index < slots.length; index += 1) {
      const slot = slots[index]
      if (slot.kind === 'original' && slot.index > firstText) {
        textAt = index
        anchored = true
        break
      }
    }
    if (!anchored) {
      let before = 0
      for (const slot of slots) {
        if (slot.kind === 'original' && slot.index < firstText) before += 1
      }
      textAt = before
    }
  }
  return { slots, textAt, added }
}

/**
 * Build the carrier content from a layout.
 *
 * A kept block is copied out of the original VERBATIM - a structured clone of
 * the very object the message carries, so an attachment reference, a name, a
 * dimension and every field a later platform adds cross the edit untouched and
 * byte-identical. Nothing here inspects what the block is.
 *
 * @param originalBlocks - the message content before the edit.
 * @param layout - the layout from {@link planBlockLayout}.
 * @param admitted - blocks for the layout's `add` slots, in slot order.
 * @param text - the revised text.
 * @returns the block array the carrier is written with.
 */
export function assembleBlocks(originalBlocks, layout, admitted, text) {
  const content = []
  let next = 0
  for (let index = 0; index <= layout.slots.length; index += 1) {
    if (index === layout.textAt) content.push({ type: 'text', text })
    const slot = layout.slots[index]
    if (slot === undefined) continue
    if (slot.kind === 'original') content.push(copyBlock(originalBlocks[slot.index]))
    else content.push(admitted[next++])
  }
  return content
}

/**
 * A verbatim copy of one block.
 *
 * `structuredClone` is what makes "untouched" literally true rather than
 * nearly true: the carrier is serialized into the session log, so an identical
 * copy and the same reference produce identical bytes - the clone only removes
 * the chance that a later writer mutates the original through it.
 *
 * @param block - one content block.
 * @returns an independent copy of the same JSON value.
 */
function copyBlock(block) {
  try {
    return structuredClone(block)
  } catch {
    // Not clonable (an exotic in-memory block): the block itself is still the
    // verbatim value, which is what this function promises.
    return block
  }
}

/**
 * Rebuild this plugin's rollback ledger from the log alone.
 *
 * Every rollback is one replacement event whose message source carries this
 * plugin's marker (`{ editedBy: 'dsh-edit-turn' }`; see {@link isEditCarrier}).
 * A replacement landed by any other producer - compaction, for instance - is
 * ignored.
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
    if (!isEditCarrier(source)) continue
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

/** The turn number the format expects next: the last one opened, plus one. */
export function nextTurnOf(events) {
  let last = 0
  for (const event of events) {
    const turn = event.data && event.data.turn
    if (typeof turn === 'number' && turn > last) last = turn
  }
  return last + 1
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
 * @param request - `{ seq?, messageId?, turn? }` (`turn` addresses a prompt only).
 * @returns `{ targetSeq, messageId, startSeq, endSeq, shadowed, mode, turn, step, provider, model, original, attachments }`.
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
  // Two editable kinds. A prompt is rewritten in place and the conversation
  // continues; a reply is replaced and everything built on it goes with it.
  const mode = isHumanPrompt(target) ? 'prompt' : isAssistantReply(target) ? 'reply' : null
  if (mode === null) {
    throw new EditPlanError('not-editable', 'only your own messages and the model replies can be edited')
  }
  const startIdx = nodeIndex.get(target.seq)
  // Two different windows, because the two edits mean different things.
  //
  // A revised PROMPT is replaced in place: only the message itself leaves the
  // surface, so the reply under it and everything after stay exactly as they
  // were - edit the wording, keep the conversation. A revised REPLY cannot do
  // that (an answer invalidates whatever was built on it), so its window runs to
  // the tail and the turn is closed again behind the correction.
  const shadowed = mode === 'prompt' ? [target.seq] : surfaceNodes.slice(startIdx)
  if (shadowed.length === 0 || shadowed[0] !== target.seq) {
    throw new EditPlanError('not-editable', 'the target does not open a rollback window')
  }
  const { text, attachments } = readMessageText(target)
  // The blocks themselves travel with the plan: the carrier is rebuilt from
  // them, so no caller has to re-read the message to know what it carries.
  const blocks = readMessageBlocks(target)
  const turn = turnOf.get(target.seq)
  const data = target.data && typeof target.data === 'object' ? target.data : {}
  const message = data.message && typeof data.message === 'object' ? data.message : data
  const source = message.source && typeof message.source === 'object' ? message.source : null
  return {
    targetSeq: target.seq,
    messageId: messageIdOf(target),
    startSeq: shadowed[0],
    endSeq: shadowed[shadowed.length - 1],
    shadowed,
    mode,
    turn: typeof turn === 'number' ? turn : null,
    // The appended correction is keyed by turn:step in the client's reducer, so a
    // missing step would make two corrections collide on "undefined:undefined".
    step: typeof data.step === 'number' ? data.step : 1,
    provider: source && typeof source.provider === 'string' ? source.provider : null,
    model: source && typeof source.model === 'string' ? source.model : null,
    original: text,
    attachments,
    blocks,
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
 * @param options - `{ preview }`: whether the deployment can hand attachment
 *   bytes back, which decides if a chip may offer a thumbnail.
 * @returns one entry per editable prompt, in conversation order.
 */
export function editableTurns(events, surfaceNodes, options = {}) {
  const eventBySeq = new Map(events.map((event) => [event.seq, event]))
  const turnOf = turnIndex(events)
  const head = surfaceNodes[0]
  const out = []
  // Surface order, not log order: a prompt rewritten in place travels as a
  // replace-carrier, which is APPENDED at the end of the log while standing at
  // the surface position of the wording it replaced. Walking `events` would
  // report the revision as the newest message in the conversation.
  for (const seq of surfaceNodes) {
    const event = eventBySeq.get(seq)
    if (!event || !isHumanPrompt(event)) continue
    if (seq === head) continue
    const { text, attachments } = readMessageText(event)
    const turn = turnOf.get(seq)
    out.push({
      seq,
      turn: typeof turn === 'number' ? turn : null,
      messageId: messageIdOf(event) ?? null,
      text,
      attachments,
      // What the editor draws beside the text: one chip per non-text block,
      // described by field presence only (see blockSummaries).
      blocks: blockSummaries(readMessageBlocks(event), options.preview === true),
    })
  }
  return out
}

/**
 * Every model reply that can currently be rewritten.
 *
 * Replies with no text at all are skipped: a step that only produced tool calls
 * has nothing to put in a text editor. A reply that carries tool calls *and*
 * text is offered, because replacing it drops those calls along with it - the
 * client warns about that, and the calls cannot survive a rewrite anyway.
 *
 * @param events - complete contiguous raw event log.
 * @param surfaceNodes - current surface seqs in model order.
 * @returns one entry per editable reply, in conversation order.
 */
export function editableReplies(events, surfaceNodes) {
  const nodeIndex = new Map(surfaceNodes.map((seq, index) => [seq, index]))
  const turnOf = turnIndex(events)
  const head = surfaceNodes[0]
  const out = []
  for (const event of events) {
    if (!isAssistantReply(event)) continue
    if (!nodeIndex.has(event.seq)) continue
    if (event.seq === head) continue
    const { text, attachments } = readMessageText(event)
    if (text.trim() === '') continue
    const turn = turnOf.get(event.seq)
    out.push({
      seq: event.seq,
      turn: typeof turn === 'number' ? turn : null,
      messageId: messageIdOf(event) ?? null,
      text,
      // For a reply these are the non-text blocks: tool calls and reasoning.
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
/**
 * The live agent whose loop owns this session's turn counter, when one exists.
 * @param ctx - plugin context.
 * @param sessionId - session to resolve.
 * @returns the agent, or undefined (cold session, or no controller mounted).
 */
async function resolveLoopAgent(ctx, sessionId) {
  const controller = ctx.get('sessionController')
  if (!controller || typeof controller.resolveAgent !== 'function') return undefined
  try {
    const result = await controller.resolveAgent(sessionId)
    return result && result.agent ? result.agent : undefined
  } catch {
    return undefined
  }
}

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

/**
 * Make the live agent loop agree with a turn this plugin opened in the log.
 *
 * The loop keeps its own counter in an idle-phase field (`phase.lastTurn`): it
 * is seeded when the loop is constructed from the projection and advanced only
 * by turns the loop itself opens. A reply edit has to open a turn - the read
 * path admits an `assistant/message` only inside an open turn and step - so
 * afterwards that field still names the turn this plugin consumed, and the
 * loop's next run would open the same number. That collides: both turn/start
 * events claim one number and the log fails its next load
 * (`turn/start does not open the expected turn`), which is the corruption this
 * plugin already shipped once and repaired.
 *
 * The shape guard is deliberate and the failure is soft: if the loop is not
 * idle, or its shape is not what this expects, nothing is touched and the
 * caller records why. The sibling plugin dsh-rerun-turn solves the same
 * problem the same way (`syncLoopTurn`); there is no official seam for it.
 *
 * @param agent - the live loop agent, when one exists.
 * @param maxTurn - the highest turn now in the log.
 * @returns `'synced' | 'already-current' | 'unavailable'`.
 */
export function syncLoopTurn(agent, maxTurn) {
  try {
    const phase = agent && agent.phase
    if (!phase || typeof phase !== 'object' || phase.kind !== 'idle' || typeof phase.lastTurn !== 'number') {
      return 'unavailable'
    }
    if (maxTurn > phase.lastTurn) {
      phase.lastTurn = maxTurn
      return 'synced'
    }
    return 'already-current'
  } catch {
    return 'unavailable'
  }
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

// --- attachment admission ----------------------------------------------------
//
// The platform's durable store is the only path by which bytes become a
// reference a session may cite (@deepseek-ai/dsh-attachment's `AttachmentStore`;
// the local backend is @deepseek-ai/dsh-attachment-local). It is resolved at
// REQUEST time, never assumed: a deployment that mounts none must keep working
// exactly as this plugin did before blocks travelled at all - text only, with
// the editor saying so - and one that mounts a store later starts working with
// no restart.

/**
 * The durable attachment store this deployment mounts, when it has one.
 *
 * Candidate names are probed the way the platform's own consumers reach it
 * (`ctx.get('attachments')`, e.g. dsh-acp). An object is only accepted when it
 * can actually admit something: a service that merely shares the name must not
 * make the editor promise to keep a block the host cannot store.
 *
 * @param ctx - plugin context.
 * @returns the store, or null when the deployment mounts none.
 */
export function resolveAttachmentStore(ctx) {
  if (!ctx || typeof ctx.get !== 'function') return null
  for (const name of ATTACHMENT_SERVICES) {
    let store
    try {
      store = ctx.get(name)
    } catch {
      store = null
    }
    if (!store || typeof store !== 'object') continue
    if (typeof store.saveImage === 'function' || typeof store.saveFile === 'function') return store
  }
  return null
}

/**
 * Whether this deployment can hand attachment bytes back for a chip thumbnail.
 * @param store - the resolved store, or null.
 * @returns true when a read path exists.
 */
export function canPreviewAttachments(store) {
  return Boolean(store) && (typeof store.readImage === 'function' || typeof store.fileHostPath === 'function')
}

/**
 * Decode one upload exactly the way the platform's wire admission does.
 *
 * Canonical base64 only (the platform's `admission.js` test): a payload whose
 * re-encoding differs is refused rather than silently decoded into different
 * bytes than the browser meant to send.
 *
 * @param data - base64 text.
 * @returns the decoded bytes.
 * @throws {HttpError} 400 `invalid` for anything but bounded canonical base64.
 */
function decodeUpload(data) {
  if (typeof data !== 'string' || data === '') throw new HttpError(400, 'invalid', 'an upload carried no data')
  if (data.length > MAX_UPLOAD_BYTES * 2) throw new HttpError(400, 'invalid', 'an upload is too large')
  const decoded = Buffer.from(data, 'base64')
  if (decoded.toString('base64') !== data) throw new HttpError(400, 'invalid', 'an upload is not canonical base64')
  if (decoded.byteLength > MAX_UPLOAD_BYTES) throw new HttpError(400, 'invalid', 'an upload is too large')
  return new Uint8Array(decoded)
}

/**
 * Admit one uploaded payload and hand back the block that cites it.
 *
 * The STORE decides the shape, not this plugin: bytes it accepts as an image
 * become the platform's image block, anything else is stored verbatim as a file
 * block. That is the platform's own vocabulary (`AttachmentStore.saveImage` /
 * `saveFile`, and `admitPromptContent` builds the same two shapes), and it is
 * the only place a block type is named in the whole edit path - a block the
 * user did not touch never passes through here at all.
 *
 * @param store - the resolved attachment store.
 * @param upload - `{ data, mediaType?, name? }`.
 * @returns the content block citing the durable reference.
 * @throws {HttpError} 400 `attachment-refused` when the store refuses it.
 */
export async function admitUpload(store, upload) {
  const data = decodeUpload(upload.data)
  const name = typeof upload.name === 'string' && upload.name !== '' ? upload.name : undefined
  const mediaType = typeof upload.mediaType === 'string' && upload.mediaType !== '' ? upload.mediaType : undefined
  // The store's own advertised media types decide whether it can take this as
  // an image; without that list, the declared type family is the only signal.
  const imageTypes = store.imageLimits && Array.isArray(store.imageLimits.mediaTypes) ? store.imageLimits.mediaTypes : null
  const asImage = mediaType !== undefined && typeof store.saveImage === 'function' &&
    (imageTypes === null ? mediaType.startsWith('image/') : imageTypes.includes(mediaType))
  try {
    if (asImage) {
      const ref = await store.saveImage(name === undefined ? { data, mediaType } : { data, mediaType, name })
      return { type: 'image', attachment: ref }
    }
    if (typeof store.saveFile !== 'function') {
      throw new HttpError(400, 'attachment-refused', 'this deployment can only store images')
    }
    const ref = await store.saveFile(name === undefined ? { data } : { data, name })
    return { type: 'file', attachment: ref }
  } catch (error) {
    if (error instanceof HttpError) throw error
    // The store's own refusal (too many images, wrong bytes, an unwritable
    // root) is reported as-is and NOTHING is written: admission runs before the
    // first append, so a refused upload can never leave a half-built carrier.
    const detail = String((error && error.message) || error)
    throw new HttpError(400, 'attachment-refused', detail)
  }
}

/**
 * The bytes of one block's attachment, for a chip's thumbnail.
 *
 * A display-only read, deliberately kept out of the edit path. It answers from
 * whatever read seam the mounted store offers - an image reader, or the host
 * path of a verbatim file - and gives up quietly when neither exists, because a
 * chip without a picture is still a usable chip. The block is located by the
 * seq of the message and its index inside that message's content, and the only
 * authorization is that the session's own log really does cite it: the same bar
 * the platform's attachment RPC applies before handing bytes over.
 *
 * @param ctx - plugin context.
 * @param sessionId - the session whose log owns the block.
 * @param seq - seq of the message event.
 * @param index - the block's index in that message's content.
 * @returns `{ data, mediaType }`, or null when there is nothing to serve.
 */
export async function attachmentBytes(ctx, sessionId, seq, index) {
  const events = await readEvents(ctx, sessionId)
  if (!events) return null
  const event = events.find((item) => item && item.seq === seq)
  if (!event) return null
  const block = readMessageBlocks(event)[index]
  if (!block || typeof block !== 'object') return null
  const ref = block.attachment
  if (!ref || typeof ref !== 'object' || typeof ref.attachmentId !== 'string' || ref.attachmentId === '') return null
  if (typeof ref.bytes === 'number' && ref.bytes > MAX_PREVIEW_BYTES) return null
  const store = resolveAttachmentStore(ctx)
  if (store === null) return null
  if (typeof store.readImage === 'function') {
    try {
      const stored = await store.readImage(ref)
      if (stored && stored.data) {
        const mediaType = stored.ref && typeof stored.ref.mediaType === 'string' ? stored.ref.mediaType : ref.mediaType
        return { data: Buffer.from(stored.data), mediaType: typeof mediaType === 'string' ? mediaType : undefined }
      }
    } catch {
      // Not an image reference; a stored file is read below.
    }
  }
  if (typeof store.fileHostPath === 'function') {
    try {
      const path = store.fileHostPath(ref)
      if (typeof path === 'string' && path !== '') return { data: await readFile(path), mediaType: undefined }
    } catch {
      // The reference resolves to nothing this deployment can serve.
    }
  }
  return null
}

// --- operations --------------------------------------------------------------

async function stateOf(ctx, sessionId, config) {
  const events = await readEvents(ctx, sessionId)
  if (!events) {
    noteRequest({ kind: 'state', sessionId, ok: false, code: 'session-not-found' })
    throw new HttpError(404, 'session-not-found', 'no session log for this id')
  }
  const folded = foldSurface(events)
  const ledger = rollbackLedger(events)
  const live = findLiveSession(ctx, sessionId)
  // Probed per request: the editor offers what THIS deployment can do right
  // now, so a store that is unmounted (or not yet mounted) cannot leave the
  // editor promising to keep blocks the host would have to drop.
  const store = resolveAttachmentStore(ctx)
  const turns = editableTurns(events, folded.nodes, { preview: canPreviewAttachments(store) })
  const replies = editableReplies(events, folded.nodes)
  noteRequest({
    kind: 'state',
    sessionId,
    ok: true,
    events: events.length,
    turns: turns.length,
    replies: replies.length,
    hidden: ledger.hidden.length,
    live: Boolean(live),
  })
  return {
    hidden: ledger.hidden,
    edits: ledger.edits.length,
    // The window record behind every hidden entry, with the same field names the
    // apply response uses (`replacementSeq`, `shadowed`, plus the window bounds).
    // Published so a sibling plugin can follow a rewritten message to its live
    // node without re-deriving the ledger from the log itself.
    revisions: ledger.edits,
    surface: folded.nodes,
    turns,
    replies,
    live: Boolean(live),
    busy: isBusy(events),
    lastSeq: events.length > 0 ? events[events.length - 1].seq : -1,
    // What this deployment can do with a block list. `attachments` is the
    // admission path (a chip the editor may keep) and `preview` is the read
    // path (a chip that may draw its own thumbnail); both are answered from a
    // live service probe, so the editor never promises what the host cannot do.
    capabilities: { attachments: store !== null, preview: canPreviewAttachments(store) },
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
 * @param content - the block list the revised prompt carries. Omitted, the
 *   carrier falls back to the marker text alone, which is what every caller
 *   that predates block-preserving edits (and the silent developer carrier)
 *   still asks for.
 * @returns `{ type, data }` for `session.append`.
 */
export function buildCarrier(plan, lastTurn, config, content) {
  const silent = config.carrier !== 'user/message'
  if (silent) {
    // The silent carrier is an empty message that projects to no model message.
    // It has to be a `developer/message`: the format admits only system-prompt
    // sources on `system/message`, so an empty plugin-owned system node (what
    // this used to append) made every session that contained one unreadable -
    // `SessionFormatError` on load, after a perfectly accepted append. An empty
    // developer message is legal, dormant, and a replacement never gets a row
    // of its own (rows are built for append events only), so it is invisible in
    // the transcript too.
    return {
      type: 'developer/message',
      data: {
        turn: typeof lastTurn === 'number' ? lastTurn : 0,
        step: 1,
        message: {
          id: randomUUID(),
          role: 'developer',
          content: [],
          source: { kind: `plugin:${PLUGIN_ID}`, editedBy: PLUGIN_ID },
        },
      },
    }
  }
  return {
    type: 'user/message',
    data: {
      id: randomUUID(),
      role: 'user',
      content: Array.isArray(content) && content.length > 0 ? content : [{ type: 'text', text: config.markerText }],
      // `kind: 'user'`, NOT a plugin-owned kind. This carrier stands in a human's
      // place - it IS the wording the user is asking with now - and the platform
      // owns that judgement: a human prompt is exactly a `user/message` whose
      // `source.kind` is `'user'`. Writing anything else here made the turn's
      // prompt unrecognisable to every consumer that tests it -
      // `dsh-session-turn-outline` (the turn rail and the Trajectory view),
      // `dsh-client-ui-trajectory`, `dsh-client-ui-chat`, the inbox steering
      // filter, and `lastPromptAt` on the session list - so an edited turn
      // showed no prompt at all and `turnOutline` reported `prompt: ""`. The
      // format's producer-owned kind (`plugin:<id>`) is for messages a plugin
      // authors in its own voice; a prompt it merely rewrote is not one.
      // `editedBy` below carries the provenance that `kind` used to.
      source: { kind: 'user', editedBy: PLUGIN_ID },
    },
  }
}

/**
 * The new assistant message that carries an edited reply.
 *
 * A reply cannot be swapped in place - the validator refuses `sourceEventSeqs`
 * on an `assistant/message` - so the correction is appended as a fresh reply.
 * `turn`/`step` are always set because the client keys a reply node by
 * `turn:step`; leaving them out would make two corrections collide.
 *
 * `source.kind` stays `model` so the entry renders and projects exactly like an
 * ordinary reply, while `editedBy` records honestly that the text was written by
 * the plugin and not produced by the model.
 *
 * @param plan - the planned window, for the original's provider/model.
 * @param text - the replacement text.
 * @param turn - the turn the correction lands in (the freshly opened one).
 * @param step - the step the correction lands in.
 * @returns `{ type, data }` for `session.append`, to be marked `surfaceOp: 'append'`.
 */
export function buildCorrection(plan, text, turn, step) {
  const source = { kind: 'model', editedBy: PLUGIN_ID }
  if (typeof plan.provider === 'string' && plan.provider !== '') source.provider = plan.provider
  if (typeof plan.model === 'string' && plan.model !== '') source.model = plan.model
  return {
    type: 'assistant/message',
    data: {
      turn: typeof turn === 'number' ? turn : 0,
      step: typeof step === 'number' ? step : 1,
      message: {
        id: randomUUID(),
        role: 'assistant',
        content: [{ type: 'text', text }],
        source,
      },
      stream: [],
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

  // The submitted block list, when the browser half sent one: which of the
  // message's blocks the user kept, in order, plus anything they just picked.
  // A caller that sends `text` only is a client from before blocks travelled -
  // a supported caller, not a broken one: it gets exactly the text-only carrier
  // this plugin has always written, and the answer says what that cost.
  let parts = plan.mode === 'prompt' && Array.isArray(body.parts) ? normalizeParts(body.parts, plan.blocks.length) : null
  let layout = parts === null ? null : planBlockLayout(plan.blocks, parts)
  // What this deployment can admit, probed NOW rather than remembered: with no
  // store mounted, nothing can be uploaded and no block may be promised, so the
  // edit degrades to the text-only carrier - the exact behaviour every release
  // before this one had - and the answer reports the blocks it had to leave
  // behind instead of writing a reference nothing can resolve.
  const store = plan.mode === 'prompt' ? resolveAttachmentStore(ctx) : null
  if (layout !== null && store === null) {
    parts = null
    layout = null
  }

  // Nothing to write when the revision changes nothing.
  //
  // The editor opens prefilled with exactly this text - it comes from
  // `readMessageText`, the same parse behind `/state`'s `turns[].text` and
  // `replies[].text` - so "open the editor and save without typing" arrives here
  // as an exact string match. It must not write: every write is a replacement
  // event (and, for a reply, a synthetic turn plus a fresh answer), so an
  // unchanged save used to add a revision with no revision behind it and a whole
  // turn to the rail while the conversation had not moved at all.
  //
  // Since blocks travel, the same question is asked of the whole message: the
  // carrier is rebuilt from the submitted list and compared against the original
  // block for block (see sameJson), so a save that keeps every block where it was
  // writes nothing either. A caller that sends text only keeps the original,
  // narrower test - its carrier IS text-only by construction, and comparing that
  // against a message with a picture in it would turn "I changed nothing" into a
  // write that drops the picture.
  //
  // Compared verbatim, deliberately, which is the same caliber the editor was
  // filled with: a trailing space is a real difference and keeps the old
  // behaviour, and nothing here trims (the only trim in this function is the
  // emptiness check above, which is about validity, not equality).
  //
  // The answer is a FLAG, not a refusal: the editor's "re-run" button saves
  // first and re-runs regardless, and its whole point is that the user wants the
  // turn regenerated even when the wording is what it already was. So the caller
  // decides what happens next, and this returns before anything is appended.
  const keepsEveryBlock = parts !== null && layout !== null && layout.added === 0 &&
    sameJson(assembleBlocks(plan.blocks, layout, [], text), plan.blocks)
  if (text === plan.original && (parts === null || keepsEveryBlock)) {
    return {
      kind: plan.mode,
      applied: false,
      unchanged: true,
      // Nothing left the surface, so nothing is shadowed: the caller must not
      // hide a row on account of this answer.
      shadowed: [],
      original: plan.original,
      // Nothing was written, so nothing was left behind either - and the
      // message's blocks are the ones it already had.
      dropped: false,
      blocks: blockSummaries(plan.blocks, canPreviewAttachments(store)),
    }
  }

  // Admission happens here, BEFORE the first append and outside the try blocks
  // below: a refused upload must not be able to leave a rollback (or a synthetic
  // turn) behind in the log. The blocks come back in slot order, which is the
  // order the layout put them in.
  const admitted = []
  if (layout !== null) {
    for (const slot of layout.slots) {
      if (slot.kind === 'add') admitted.push(await admitUpload(store, slot.upload))
    }
  }
  const content = layout === null ? [{ type: 'text', text }] : assembleBlocks(plan.blocks, layout, admitted, text)
  // Whether this save left non-text blocks behind, told to the caller instead of
  // being discovered later: true for a reply (its tool calls and reasoning
  // cannot survive a replacement) and true for a message rewritten without its
  // blocks. False whenever the carrier really did carry them.
  const dropped = layout === null && plan.blocks.some((block) => !isTextBlock(block))

  // A revised prompt has to (a) replace the old wording in the model context and
  // (b) NOT be answered. The platform answers any user message it finds on the
  // surface, so the revision cannot be *appended* - appending one made the loop
  // answer it, and the next save added another copy (three "你好" bubbles). It
  // travels as the rollback's replacement instead: a replace-type carrier, which
  // removes the old prompt and stands in its place, in one event.
  // A reply edit needs somewhere to land: `assistant/message` (and any message
  // with a step coordinate) is only readable inside an OPEN turn and step, and
  // opening one in the log is what advances the runtime's own turn counter too
  // (it projects `lastTurn` from every turn/start it observes). A prompt edit
  // does not: `user/message` carries the revision and needs no turn.
  const editTurn = plan.mode === 'reply' ? nextTurnOf(events) : lastTurnOf(events)
  const carrier = buildCarrier(plan, editTurn, plan.mode === 'prompt' ? { ...config, carrier: 'user/message', markerText: text } : config, content)
  if (plan.mode === 'reply') {
    try {
      session.append('turn/start', { turn: editTurn })
      session.append('step/start', { turn: editTurn, step: 1 })
    } catch (error) {
      return {
        kind: 'reply',
        applied: false,
        applyError: `could not open a turn for the correction: ${String((error && error.message) || error)}`,
        shadowed: plan.shadowed,
        dropped,
      }
    }
  }
  let replacement
  try {
    // A replacement carrier has to be a surface event with non-empty
    // `sourceEventSeqs` coverage of the whole shadowed window. An assistant
    // message forbids `sourceEventSeqs` outright, so the carrier is either an
    // empty `developer/message` (default: dormant, invisible to the model, and
    // never given a row of its own because rows are built for appends) or a
    // short `user/message` marker.
    replacement = session.append(carrier.type, carrier.data, {
      surfaceOp: { op: 'replace', startSeq: plan.startSeq, endSeq: plan.endSeq },
      sourceEventSeqs: plan.shadowed,
    })
  } catch (error) {
    throw new HttpError(409, 'stale', `the surface refused the rollback: ${String((error && error.message) || error)}`)
  }
  const flush = await flushSession(ctx, session)

  // Step two depends on what was edited.
  //
  // Rewriting a reply cannot swap the text in place - an `assistant/message` may
  // never carry `sourceEventSeqs`, so it can never be a replacement carrier
  // (checked against the real validator, not assumed). The correction is
  // appended instead, in the same shape the agent loop records a reply, so the
  // model goes on seeing the edited text as its own answer and the conversation
  // continues from there. Nothing is re-run: the answer was fixed, the model was
  // not asked again.
  if (plan.mode === 'reply') {
    const correction = buildCorrection(plan, text, editTurn, 1)
    let appended
    try {
      appended = session.append(correction.type, correction.data, { surfaceOp: 'append' })
      // Close the step and the turn behind the corrected reply: the host anchors
      // a turn's tail (duration, action strip) at its last `turn/end`, and the
      // format only reads a step message inside an open turn and step.
      session.append('step/end', { turn: editTurn, step: 1 })
      session.append('turn/end', { turn: editTurn, reason: { kind: 'completed' } })
    } catch (error) {
      return {
        kind: 'reply',
        replacementSeq: replacement.seq,
        applied: false,
        applyError: `the corrected reply was refused: ${String((error && error.message) || error)}`,
        shadowed: plan.shadowed,
        dropped,
        ...flush,
      }
    }
    const corrected = await flushSession(ctx, session)
    // The synthetic turn this edit opened is invisible to the live loop's own
    // counter; without the sync its next run reuses that number and the log
    // fails its next load. Only a reply edit opens a turn - a prompt edit does
    // not, and needs nothing.
    const loopAgent = await resolveLoopAgent(ctx, sessionId)
    const loopTurn = syncLoopTurn(loopAgent, editTurn)
    // `loopTurn` is the diagnostic the request ring records; the field is DELIBERATELY
  // not called `code` - the static checks read `code:` as host error codes and
  // must not start demanding a user-visible message for an internal sync state.
  const syncNote = loopTurn
  if (syncNote === 'unavailable') {
    noteRequest({ kind: 'reply', sessionId, ok: true, loopTurn: syncNote, turn: editTurn })
  }
    return {
      kind: 'reply',
      replacementSeq: replacement.seq,
      appendedSeq: appended.seq,
      applied: true,
      loopTurn,
      shadowed: plan.shadowed,
      dropped,
      ...corrected,
    }
  }

  // The rollback above already did the whole job: the carrier that replaced the
  // window *is* the revised prompt, so the model reads it as the user's wording
  // from here on. Saving therefore costs no model call, always: regenerating
  // the turn is a different operation with a different owner - the sibling
  // plugin dsh-rerun-turn shadows the turn and regenerates it from the prompt
  // the surface now shows, then replays what followed. Nothing here prompts.
  return {
    kind: 'prompt',
    replacementSeq: replacement.seq,
    applied: true,
    shadowed: plan.shadowed,
    dropped,
    // What the carrier now carries, described exactly the way /state describes
    // it. The browser half adopts this for the row it re-draws before its own
    // refresh lands - without it a second save could not know which blocks are
    // still there and would rewrite the message text-only.
    blocks: blockSummaries(content, canPreviewAttachments(store)),
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
        const replies = editableReplies(events, nodes)
        const limit = typeof args.limit === 'number' && args.limit > 0 ? Math.floor(args.limit) : 20
        const shown = turns.slice(-limit)
        const shownReplies = replies.slice(-limit)
        const lines = [
          `session ${sessionId}: ${turns.length} editable turn(s), ${replies.length} editable reply/replies, ${isBusy(events) ? 'BUSY' : 'idle'}`,
        ]
        for (const turn of shown) {
          const preview = turn.text.length > 160 ? `${turn.text.slice(0, 160)}...` : turn.text
          lines.push(`- turn ${turn.turn} (seq ${turn.seq}, ${turn.attachments} attachment(s)): ${preview}`)
        }
        if (turns.length > shown.length) lines.push(`(${turns.length - shown.length} earlier turn(s) omitted)`)
        for (const reply of shownReplies) {
          const preview = reply.text.length > 160 ? `${reply.text.slice(0, 160)}...` : reply.text
          lines.push(`- reply (seq ${reply.seq}, ${reply.attachments} non-text part(s)): ${preview}`)
        }
        if (replies.length > shownReplies.length) lines.push(`(${replies.length - shownReplies.length} earlier reply/replies omitted)`)
        lines.push('editing a turn replaces its wording in place (no model call); editing a reply replaces its text and discards what follows. Re-running a turn is dsh-rerun-turn\'s button.')
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

// The body limit is the upload limit: a revised message with blocks arrives as
// base64 inside this JSON, so /apply asks for a larger ceiling than the tiny
// default. The read is refused rather than truncated, and the socket keeps
// draining so the refusal can still be answered.
function readBody(req, limit = 1e6) {
  return new Promise((resolve, reject) => {
    let data = ''
    let refused = false
    req.on('data', (chunk) => {
      if (refused) return
      data += chunk
      if (data.length > limit) {
        refused = true
        data = ''
        reject(new HttpError(413, 'invalid', 'the request body is too large'))
      }
    })
    req.on('end', () => {
      if (!refused) resolve(data)
    })
    req.on('error', (error) => {
      if (!refused) reject(error)
    })
    req.on('aborted', () => {
      if (!refused) reject(new Error('aborted'))
    })
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
    confirm: config && typeof config.confirm === 'boolean' ? config.confirm : false,
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

    // The bytes behind one block, for the editor's chips. Read-only, loopback
    // and same-origin like everything else here, and answered only for a block
    // the session's own log cites.
    fiber.effect(() =>
      webServer.register({
        kind: 'exact',
        path: `${ROUTE_PREFIX}/attachment`,
        handler: async (req, res) => {
          if (!guard(req, res)) return
          if (req.method !== 'GET') {
            sendJson(res, 405, { ok: false, code: 'method', error: 'GET only' })
            return
          }
          try {
            const url = new URL(req.url, 'http://localhost')
            const sessionId = requireSessionId((url.searchParams.get('sessionId') || '').trim())
            const seq = Number(url.searchParams.get('seq'))
            const index = Number(url.searchParams.get('index'))
            if (!Number.isInteger(seq) || seq < 0 || !Number.isInteger(index) || index < 0) {
              throw new HttpError(400, 'invalid', 'seq and index must be whole numbers')
            }
            const found = await attachmentBytes(ctx, sessionId, seq, index)
            if (found === null) {
              // Deliberately without a code: the editor translates codes into
              // sentences, and "this chip has no picture" is not one the user
              // needs to read - the chip simply draws its label.
              sendJson(res, 404, { ok: false, error: 'no attachment bytes for this block' })
              return
            }
            res.writeHead(200, {
              'content-type': typeof found.mediaType === 'string' && found.mediaType !== '' ? found.mediaType : 'application/octet-stream',
              'content-length': found.data.byteLength,
              // The stored object is immutable and content-addressed.
              'cache-control': 'private, max-age=600',
            })
            res.end(found.data)
          } catch (error) {
            failure(res, error)
          }
        },
      }),
    )

    // Read-only diagnostics. The browser half's own state cannot be observed
    // from here, so the next best thing is an honest record of what its requests
    // asked for and what they got back.
    fiber.effect(() =>
      webServer.register({
        kind: 'exact',
        path: `${ROUTE_PREFIX}/debug`,
        handler: (req, res) => {
          if (!guard(req, res)) return
          if (req.method !== 'GET') {
            sendJson(res, 405, { ok: false, code: 'method', error: 'GET only' })
            return
          }
          sendJson(res, 200, { ok: true, version: PLUGIN_VERSION, requests: recentRequests() })
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
          let raw
          try {
            // A block list travels as base64 inside this body, so the ceiling is
            // the upload ceiling (see MAX_BODY_BYTES) - and an oversized body is
            // reported as such instead of being read as far as it goes.
            raw = await readBody(req, MAX_BODY_BYTES)
          } catch (error) {
            const status = error instanceof HttpError ? error.status : 400
            const detail = error instanceof HttpError ? error.message : 'malformed JSON body'
            sendJson(res, status, { ok: false, code: 'invalid', error: detail })
            return
          }
          let body = {}
          try {
            if (raw) body = JSON.parse(raw)
          } catch {
            sendJson(res, 400, { ok: false, code: 'invalid', error: 'malformed JSON body' })
            return
          }
          try {
            const sessionId = requireSessionId(typeof body.sessionId === 'string' ? body.sessionId.trim() : '')
            const result = await applyEdit(ctx, sessionId, body, resolved)
            // Recorded so the next "the button does nothing" can be answered
            // from here: an apply that never appears was never sent - the click
            // was lost in the browser half, not refused by this one.
            noteRequest({
              kind: 'apply',
              sessionId,
              ok: true,
              edit: result.kind,
              seq: typeof body.seq === 'number' ? body.seq : null,
              replacement: typeof result.replacementSeq === 'number' ? result.replacementSeq : null,
              // A save the host did not write because the text was already the
              // live text. Worth distinguishing from a landed edit here: the log
              // shows nothing for it, so this ring is the only place that records
              // "the user pressed save and nothing needed saving".
              unchanged: result.unchanged === true,
              // Whether non-text blocks were left behind by this save (see
              // applyEdit). The log cannot show this: the carrier is one event
              // either way.
              dropped: result.dropped === true,
            })
            sendJson(res, 200, { ok: true, ...result })
          } catch (error) {
            noteRequest({
              kind: 'apply',
              sessionId: typeof body.sessionId === 'string' ? body.sessionId.trim() : null,
              ok: false,
              code: error && error.code ? String(error.code) : 'internal',
            })
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
