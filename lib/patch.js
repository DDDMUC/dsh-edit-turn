// In-place reply edits through a plugin-owned session record and a message
// projection.
//
// The host refuses to let an `assistant/message` be a surface-replacement
// carrier (it may never carry `sourceEventSeqs`), so a corrected reply cannot be
// put back at its own position with a surface event. The official seam for that
// case is a message projection: append a log-only plugin record, then register a
// pure projection for its type that rewrites the model-visible message at the
// target seq. Nothing leaves the surface, so there is nothing to replay and the
// log grows by one small record per edit.
//
// `appendPluginRecord` writes the record with the `ignorable` envelope the
// persistence gate requires (DSH >= 0.2.1-rc.2). The projection is registered
// through `ctx.sessions.registerMessageProjection` and is fiber-owned: unloading
// the plugin removes it, and the record is then skipped, so the original text
// comes back. That is the deliberate trade against the surface path: prompt
// edits are official events that outlive the plugin, patch edits are an overlay
// that needs its owner.

/** The plugin record type. The grammar requires the `plugin:` namespace. */
export const PATCH_TYPE = 'plugin:dsh-edit-turn/patch'

/** Patch payload version. */
export const PATCH_VERSION = 2

/**
 * Every record version this build can still READ.
 *
 * v1 is what every session written before inserted blocks exists; its targets
 * are plain block rewrites. Reading it is what keeps the edits already made in
 * those sessions effective - a build that only understood v2 would silently
 * drop every one of them from the model's context.
 */
const READABLE_VERSIONS = new Set([1, 2])

/** Block kinds this plugin can edit, mapped to the recorded block types. */
const KIND_TO_TYPES = {
  text: ['text'],
  reasoning: ['reasoning', 'thinking'],
}

/**
 * The editable kind of one content block.
 * @param block - one message content block.
 * @returns 'text' | 'reasoning' | null.
 */
export function kindOfBlock(block) {
  return blockField(block) === null ? null : blockField(block).kind
}

/**
 * The editable text of one block, plus which field carries it.
 *
 * A platform is free to name the reasoning payload `text`, `reasoning` or
 * `thinking`; the editor reads all three and writes back to the field it read,
 * so a shape this build has not seen before is still editable.
 *
 * @param block - one content block.
 * @returns `{ kind, field, text }`, or null when the block carries no text.
 */
export function blockField(block) {
  if (!block || typeof block !== 'object') return null
  if (block.type === 'text' && typeof block.text === 'string') return { kind: 'text', field: 'text', text: block.text }
  if (block.type === 'reasoning' || block.type === 'thinking') {
    for (const field of ['text', 'reasoning', 'thinking']) {
      if (typeof block[field] === 'string') return { kind: 'reasoning', field, text: block[field] }
    }
  }
  return null
}

/**
 * Every block of a message an editor may target, in message order.
 * @param message - a message payload with a `content` array.
 * @returns `[{ index, kind, text }]`.
 */
export function editableBlocks(message) {
  const content = message && Array.isArray(message.content) ? message.content : []
  const out = []
  for (let index = 0; index < content.length; index += 1) {
    const block = content[index]
    const found = blockField(block)
    if (found === null) continue
    out.push({ index, kind: found.kind, text: found.text })
  }
  return out
}

/** A non-negative safe integer, matching the host's seq/blockIndex checks. */
function isIndex(value) {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && !Object.is(value, -0)
}

/**
 * Validate one patch payload (shape and target grammar).
 * @param data - the record payload.
 * @returns the same payload when valid.
 * @throws when malformed.
 */
export function validatePatchData(data) {
  if (data === null || typeof data !== 'object' || Array.isArray(data)) {
    throw new Error(`${PATCH_TYPE}: data must be an object`)
  }
  if (!READABLE_VERSIONS.has(data.version)) {
    throw new Error(`${PATCH_TYPE}: unsupported version ${String(data.version)}`)
  }
  if (!Array.isArray(data.targets) || data.targets.length === 0) {
    throw new Error(`${PATCH_TYPE}: targets must be a nonempty array`)
  }
  const targets = []
  for (const target of data.targets) {
    if (target === null || typeof target !== 'object' || Array.isArray(target)) {
      throw new Error(`${PATCH_TYPE}: each target must be an object`)
    }
    if (!isIndex(target.seq)) throw new Error(`${PATCH_TYPE}: target seq must be a non-negative safe integer`)
    if (target.insert === undefined) {
      // A rewrite of a block the message already carries.
      if (!isIndex(target.blockIndex)) throw new Error(`${PATCH_TYPE}: target blockIndex must be a non-negative safe integer`)
      if (!(target.kind in KIND_TO_TYPES)) throw new Error(`${PATCH_TYPE}: target kind must be text or reasoning`)
      if (typeof target.text !== 'string') throw new Error(`${PATCH_TYPE}: target text must be a string`)
      targets.push({ seq: target.seq, blockIndex: target.blockIndex, kind: target.kind, text: target.text })
      continue
    }
    // An inserted block, identified by a stable id rather than a position:
    // inserting shifts every later index, so a position is not an identity and
    // a second edit through one would land on a different block.
    const insert = target.insert
    if (insert === null || typeof insert !== 'object' || Array.isArray(insert)) {
      throw new Error(`${PATCH_TYPE}: insert must be an object`)
    }
    if (typeof insert.id !== 'string' || insert.id === '') throw new Error(`${PATCH_TYPE}: insert id must be a non-empty string`)
    if (!isIndex(insert.position)) throw new Error(`${PATCH_TYPE}: insert position must be a non-negative safe integer`)
    if (!(target.kind in KIND_TO_TYPES)) throw new Error(`${PATCH_TYPE}: target kind must be text or reasoning`)
    if (typeof target.text !== 'string') throw new Error(`${PATCH_TYPE}: target text must be a string`)
    targets.push({
      seq: target.seq,
      kind: target.kind,
      text: target.text,
      insert: { id: insert.id, position: insert.position },
      removed: target.removed === true,
    })
  }
  return { version: data.version, targets }
}

/**
 * Build a validated patch payload.
 * @param targets - `[{ seq, blockIndex, kind, text }]`.
 * @returns the payload for `appendPluginRecord`.
 */
export function buildPatchData(targets) {
  const data = {
    // Always v2, even when no block is inserted: one shape on disk is easier to
    // reason about than two, and this build reads v1 anyway.
    version: PATCH_VERSION,
    targets: targets.map((target) =>
      target.insert === undefined
        ? { seq: target.seq, blockIndex: target.blockIndex, kind: target.kind, text: target.text }
        : {
            seq: target.seq,
            kind: target.kind,
            text: target.text,
            insert: { id: target.insert.id, position: target.insert.position },
            ...(target.removed === true ? { removed: true } : {}),
          },
    ),
  }
  validatePatchData(data)
  return data
}

/**
 * Apply the targets that belong to one seq to one message.
 *
 * Targets are grouped by the caller: a record may carry several blocks of the
 * same message, and they all have to land in one projected message. A target
 * whose block is gone (or changed kind) is skipped; the rest still apply.
 *
 * @param message - the base message payload.
 * @param targets - validated targets, all for this message.
 * @returns a patched message copy.
 */
/** The display index an inserted block gets; recorded content indices are far below. */
export const INSERT_INDEX_BASE = 1000000

/** One content block shaped for an inserted kind. */
function insertedBlockOf(target) {
  return target.kind === 'reasoning' ? { type: 'reasoning', text: target.text } : { type: 'text', text: target.text }
}

export function applyTargetsToMessage(message, targets) {
  const content = Array.isArray(message.content) ? message.content.slice() : []
  // Inserts are placed against the RECORDED indices, so they are collected
  // first and interleaved afterwards: splicing them in as they arrive would move
  // the very positions the remaining targets were resolved against.
  const placed = []
  for (const target of targets) {
    if (target.insert === undefined) continue
    if (target.removed === true) continue
    placed.push({
      position: Math.min(target.insert.position, content.length),
      kind: target.kind,
      text: target.text,
    })
  }
  for (const target of targets) {
    if (target.insert !== undefined) continue
    const block = content[target.blockIndex]
    const found = blockField(block)
    if (found === null || found.kind !== target.kind) continue
    const patched = { ...block, [found.field]: target.text }
    if (found.kind === 'reasoning') {
      // The signature signs the original text; keep it and some providers
      // reject the whole request. The recorded block keeps its signature; the
      // projected copy drops it, exactly like the disk path does.
      delete patched.signature
      delete patched.thinkingSignature
    }
    content[target.blockIndex] = patched
  }
  if (placed.length === 0) return { ...message, content }
  // Ascending position, and equal positions keep the record's own order.
  placed.sort((a, b) => a.position - b.position)
  const out = []
  let next = 0
  for (let index = 0; index <= content.length; index += 1) {
    while (next < placed.length && placed[next].position === index) {
      out.push(insertedBlockOf(placed[next]))
      next += 1
    }
    if (index < content.length) out.push(content[index])
  }
  while (next < placed.length) {
    out.push(insertedBlockOf(placed[next]))
    next += 1
  }
  return { ...message, content: out }
}

/**
 * The message projection for this plugin's record type.
 *
 * Pure and never throws: a projection error fails the whole session fold, which
 * would make the session unreadable. A malformed record or a target that is no
 * longer on the surface is simply skipped.
 *
 * Several records compose: the base for one target is the message the previous
 * projections already produced (`context.messages`), falling back to the
 * recorded message, so editing block A and later block B keeps both edits.
 *
 * @returns `{ type, project(event, context) }` for the host registry.
 */
export function patchProjection() {
  return {
    type: PATCH_TYPE,
    project(event, context) {
      const out = new Map()
      let data
      try {
        data = validatePatchData(event && event.data)
      } catch {
        return out
      }
      const nodes = new Set(Array.isArray(context && context.nodes) ? context.nodes : [])
      const events = Array.isArray(context && context.events) ? context.events : []
      const baseSeq = typeof (context && context.baseSeq) === 'number' ? context.baseSeq : 0
      const messages = context && context.messages
      const groups = new Map()
      for (const target of data.targets) {
        // A retired target is not in the model context any more: editing it
        // would be a no-op for the conversation.
        if (!nodes.has(target.seq)) continue
        const group = groups.get(target.seq)
        if (group === undefined) groups.set(target.seq, [target])
        else group.push(target)
      }
      for (const [seq, targets] of groups) {
        const source = events[seq - baseSeq]
        if (!source || source.type !== 'assistant/message') continue
        const previous = messages && typeof messages.get === 'function' ? messages.get(seq) : undefined
        const base = previous && typeof previous === 'object' ? previous : source.data && source.data.message
        if (!base || !Array.isArray(base.content)) continue
        try {
          out.set(seq, applyTargetsToMessage(base, targets))
        } catch {
          // Keep the rest of the record; a broken target must not take the
          // session's whole fold down.
        }
      }
      return out
    },
  }
}

/**
 * Read every landed patch from the log, latest per (seq, blockIndex).
 * @param events - complete contiguous event log.
 * @returns `Map<seq, Map<blockIndex, { kind, text }>>`.
 */
export function patchesOf(events) {
  const out = new Map()
  for (const event of events) {
    if (!event || event.type !== PATCH_TYPE) continue
    let data
    try {
      data = validatePatchData(event.data)
    } catch {
      continue
    }
    for (const target of data.targets) {
      let entry = out.get(target.seq)
      if (entry === undefined) {
        entry = { replacements: new Map(), inserts: new Map() }
        out.set(target.seq, entry)
      }
      if (target.insert === undefined) {
        entry.replacements.set(target.blockIndex, { kind: target.kind, text: target.text })
        continue
      }
      const previous = entry.inserts.get(target.insert.id)
      entry.inserts.set(target.insert.id, {
        id: target.insert.id,
        position: target.insert.position,
        kind: target.kind,
        text: target.text,
        removed: target.removed === true,
        // The order a block was first inserted in, kept across later edits and
        // across removal/restore: two blocks at the same position stay in the
        // order the user created them.
        order: previous === undefined ? entry.inserts.size : previous.order,
      })
    }
  }
  return out
}

/**
 * The latest patch per block as a flat list for the browser half.
 * @param patches - `patchesOf(events)`.
 * @returns `[{ seq, blockIndex, kind, text }]`.
 */
export function patchList(patches) {
  const out = []
  for (const [seq, entry] of patches) {
    for (const [blockIndex, patch] of entry.replacements) {
      out.push({ seq, blockIndex, kind: patch.kind, text: patch.text })
    }
    for (const item of entry.inserts.values()) {
      out.push({
        seq,
        blockIndex: INSERT_INDEX_BASE + item.order,
        insertId: item.id,
        kind: item.kind,
        text: item.text,
        removed: item.removed === true,
      })
    }
  }
  return out.sort((a, b) => a.seq - b.seq || a.blockIndex - b.blockIndex)
}

/**
 * One message's blocks with the landed patch text applied.
 * @param message - the recorded message payload.
 * @param seq - the event seq that carries the message.
 * @param patches - `patchesOf(events)`.
 * @returns `[{ index, kind, text, original, patched }]`.
 */
export function projectedBlocks(message, seq, patches) {
  const entry = patches !== null && patches !== undefined && typeof patches.get === 'function' ? patches.get(seq) : undefined
  const replacements = entry === undefined ? new Map() : entry.replacements
  const content = message !== null && message !== undefined && Array.isArray(message.content) ? message.content : []
  const byPosition = new Map()
  if (entry !== undefined) {
    for (const item of entry.inserts.values()) {
      if (item.removed === true) continue
      const position = Math.min(item.position, content.length)
      const list = byPosition.get(position)
      if (list === undefined) byPosition.set(position, [item])
      else list.push(item)
    }
  }
  const out = []
  for (let index = 0; index <= content.length; index += 1) {
    // Inserts sit where the user put them, before the block at that position.
    for (const item of byPosition.get(index) ?? []) {
      out.push({
        index: INSERT_INDEX_BASE + item.order,
        insertId: item.id,
        kind: item.kind,
        text: item.text,
        original: '',
        patched: true,
      })
    }
    if (index === content.length) break
    const found = blockField(content[index])
    if (found === null) continue
    const patch = replacements.get(index)
    const applied = patch !== undefined && patch.kind === found.kind ? patch.text : found.text
    out.push({
      index,
      kind: found.kind,
      text: applied,
      original: found.text,
      patched: applied !== found.text,
    })
  }
  return out
}
