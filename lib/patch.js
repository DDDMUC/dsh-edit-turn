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
export const PATCH_VERSION = 1

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
  if (!block || typeof block !== 'object') return null
  if (block.type === 'text' && typeof block.text === 'string') return 'text'
  if ((block.type === 'reasoning' || block.type === 'thinking') && typeof block.text === 'string') return 'reasoning'
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
    const kind = kindOfBlock(block)
    if (kind === null) continue
    out.push({ index, kind, text: block.text })
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
  if (data.version !== PATCH_VERSION) {
    throw new Error(`${PATCH_TYPE}: unsupported version ${String(data.version)}`)
  }
  if (!Array.isArray(data.targets) || data.targets.length === 0) {
    throw new Error(`${PATCH_TYPE}: targets must be a nonempty array`)
  }
  for (const target of data.targets) {
    if (target === null || typeof target !== 'object' || Array.isArray(target)) {
      throw new Error(`${PATCH_TYPE}: each target must be an object`)
    }
    if (!isIndex(target.seq)) throw new Error(`${PATCH_TYPE}: target seq must be a non-negative safe integer`)
    if (!isIndex(target.blockIndex)) throw new Error(`${PATCH_TYPE}: target blockIndex must be a non-negative safe integer`)
    if (!(target.kind in KIND_TO_TYPES)) throw new Error(`${PATCH_TYPE}: target kind must be text or reasoning`)
    if (typeof target.text !== 'string') throw new Error(`${PATCH_TYPE}: target text must be a string`)
  }
  return data
}

/**
 * Build a validated patch payload.
 * @param targets - `[{ seq, blockIndex, kind, text }]`.
 * @returns the payload for `appendPluginRecord`.
 */
export function buildPatchData(targets) {
  const data = {
    version: PATCH_VERSION,
    targets: targets.map((target) => ({
      seq: target.seq,
      blockIndex: target.blockIndex,
      kind: target.kind,
      text: target.text,
    })),
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
export function applyTargetsToMessage(message, targets) {
  const content = Array.isArray(message.content) ? message.content.slice() : []
  for (const target of targets) {
    const block = content[target.blockIndex]
    const kind = kindOfBlock(block)
    if (kind === null || kind !== target.kind) continue
    const patched = { ...block, text: target.text }
    if (kind === 'reasoning') {
      // The signature signs the original text; keep it and some providers
      // reject the whole request. The recorded block keeps its signature; the
      // projected copy drops it, exactly like the disk path does.
      delete patched.signature
      delete patched.thinkingSignature
    }
    content[target.blockIndex] = patched
  }
  return { ...message, content }
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
      let byBlock = out.get(target.seq)
      if (byBlock === undefined) {
        byBlock = new Map()
        out.set(target.seq, byBlock)
      }
      byBlock.set(target.blockIndex, { kind: target.kind, text: target.text })
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
  for (const [seq, byBlock] of patches) {
    for (const [blockIndex, patch] of byBlock) {
      out.push({ seq, blockIndex, kind: patch.kind, text: patch.text })
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
  const byBlock = patches.get(seq)
  return editableBlocks(message).map((block) => {
    const patch = byBlock && byBlock.get(block.index)
    const applied = patch !== undefined && patch.kind === block.kind ? patch.text : block.text
    return {
      index: block.index,
      kind: block.kind,
      text: applied,
      original: block.text,
      patched: applied !== block.text,
    }
  })
}
