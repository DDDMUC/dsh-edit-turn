// Repair sessions that dsh-edit-turn 0.2.0-0.2.3 corrupted.
//
// The reply-edit path used to write a carrier the append path accepted and
// every reader refused (an empty plugin-owned `system/message`, plus a
// correction sitting outside an open turn and step). A session that contains
// one no longer loads: DSH answers `session-not-found` for it and the history
// screen shows `SessionFormatError: system/message does not match an open turn
// and step`.
//
// The tool scans a sessions directory, validates every log through the same
// loader DSH uses, and for a corrupt one: keeps a byte-for-byte backup next to
// it and truncates the log at the first event the loader refuses. Everything
// before that point survives; the dropped tail is in the backup. In practice
// the refused events are exactly this plugin's reply-edit groups, so real
// conversation is what gets kept.
//
// The storage layout has two rules a re-written file must respect, or the
// session will not even be listed (the symptom is `session not found` even
// though every event validates):
//   - the header line lives in a zstd frame of its own, and
//   - sequence numbers stay contiguous from the first event's seq.
//
//   node tools/repair-session.mjs ~/.dsh/sessions/<project-dir> --dry-run
//   node tools/repair-session.mjs ~/.dsh/sessions/<project-dir>
import { readFileSync, writeFileSync, readdirSync } from 'node:fs'
import { zstdCompressSync, zstdDecompressSync } from 'node:zlib'
import { Session } from '@deepseek-ai/dsh-session'
import { currentSessionMessageProjections } from '@deepseek-ai/dsh-session-format-catalog/message-projections'

const dir = process.argv[2]
const dryRun = process.argv.includes('--dry-run')
const HEADER_TYPE = 'session'
const ZSTD_MAGIC = [0x28, 0xb5, 0x2f, 0xfd]

/** Decode the concatenated zstd frames of a session log into frames of lines. */
function decode(path) {
  const raw = readFileSync(path)
  const offsets = []
  for (let i = 0; i + 4 <= raw.length; i += 1) {
    if (ZSTD_MAGIC.every((byte, index) => raw[i + index] === byte)) offsets.push(i)
  }
  const frames = []
  for (let i = 0; i < offsets.length; i += 1) {
    const end = i + 1 < offsets.length ? offsets[i + 1] : raw.length
    try {
      frames.push(zstdDecompressSync(raw.subarray(offsets[i], end)).toString('utf8').trim().split('\n').filter(Boolean))
    } catch {
      /* a torn trailing frame is dropped, the way the writer treats one */
    }
  }
  return frames
}

/** The writer's layout: the header alone in frame zero, events eight to a frame. */
function writeLog(path, header, events) {
  const frames = [zstdCompressSync(Buffer.from(`${header}\n`))]
  for (let i = 0; i < events.length; i += 8) {
    frames.push(zstdCompressSync(Buffer.from(`${events.slice(i, i + 8).join('\n')}\n`)))
  }
  writeFileSync(path, Buffer.concat(frames))
}

/** One stored line as the in-memory seed the loader expects. */
function toSeed(line) {
  const event = JSON.parse(line)
  const seed = { type: event.type, seq: event.seq, time: event.time, data: event.data }
  if (event.surfaceOp !== undefined) seed.surfaceOp = event.surfaceOp
  if (event.sourceEventSeqs !== undefined) {
    // Storage packs consecutive runs as [start, end] pairs; the in-memory seed
    // carries every seq, so expand before validating.
    seed.sourceEventSeqs = event.sourceEventSeqs.flatMap((value) =>
      Array.isArray(value)
        ? Array.from({ length: value[1] - value[0] + 1 }, (_, offset) => value[0] + offset)
        : [value],
    )
  }
  return seed
}

function failureOf(seed) {
  // A forked session's stored events start at the inherited count, not at 0;
  // that is the one place the loader takes it from storage metadata rather than
  // the log itself. Passing the first seq keeps the contiguity check honest.
  const inherited = seed.length > 0 ? seed[0].seq : 0
  try {
    Session.create('session-00000000-0000-4000-8000-repair', seed, undefined, inherited, currentSessionMessageProjections)
    return null
  } catch (error) {
    return String((error && error.message) || error)
  }
}

for (const name of readdirSync(dir)) {
  if (name.startsWith('.')) continue
  const path = `${dir}/${name}/session.v4.jsonl.zstd`
  let frames
  try {
    frames = decode(path)
  } catch {
    continue
  }
  const lines = frames.flat()
  if (lines.length === 0) continue
  const header = lines[0]
  if (JSON.parse(header).type !== HEADER_TYPE) continue
  let events = lines.slice(1)
  const seed = () => events.map(toSeed)

  // A healthy log can still be invisible to the listing when its header shares
  // a frame with events (older versions of this tool wrote it that way).
  const headerAlone = frames.length > 0 && frames[0].length === 1
  if (failureOf(seed()) === null) {
    if (headerAlone) continue
    console.log(`\n${name}: valid but mis-framed; re-framing`)
    if (dryRun) {
      console.log(`  dry run: would re-frame ${events.length} events`)
      continue
    }
    const backup = `${path}.reframe-${new Date().toISOString().replace(/[:.]/g, '-')}.bak`
    writeFileSync(backup, readFileSync(path))
    writeLog(path, header, events)
    console.log(`  re-framed: ${events.length} events, backup ${backup.split('/').pop()}`)
    continue
  }
  console.log(`\n${name}: corrupt, repairing`)

  const dropped = []
  for (let guard = 0; guard < 50; guard += 1) {
    const failure = failureOf(seed())
    if (failure === null) break
    let index = (/at index (\d+)/).exec(failure)?.[1]
    index = index === undefined ? undefined : Number(index)
    if (index === undefined || index < 0 || index >= events.length) {
      // No usable index in the message: find the first failing prefix.
      let low = 0
      let high = events.length - 1
      while (low < high) {
        const mid = Math.floor((low + high) / 2)
        if (failureOf(events.slice(0, mid + 1).map(toSeed)) === null) low = mid + 1
        else high = mid
      }
      index = low
      console.log('  (prefix probe) offending event index', index, JSON.parse(events[index]).type)
    } else {
      console.log('  drop index', index, JSON.parse(events[index]).type, '-', failure.slice(0, 90))
    }
    // The log must stay contiguous from the first seq, so an event cannot be
    // removed on its own: everything from the first offending event on is
    // truncated, and the original file is kept as a backup.
    dropped.push(...events.slice(index))
    events = events.slice(0, index)
  }
  const finalFailure = failureOf(seed())
  if (finalFailure !== null) {
    console.log('  STILL CORRUPT after dropping', dropped.length, ':', finalFailure)
    continue
  }
  if (dryRun) {
    console.log(`  dry run: would drop ${dropped.length} event(s) and keep ${events.length}`)
    continue
  }
  const backup = `${path}.corrupt-${new Date().toISOString().replace(/[:.]/g, '-')}.bak`
  writeFileSync(backup, readFileSync(path))
  writeLog(path, header, events)
  console.log(`  repaired: dropped ${dropped.length} event(s), kept ${events.length}, backup ${backup.split('/').pop()}`)
  console.log('  dropped types:', dropped.map((line) => JSON.parse(line).type).join(', '))
}
console.log('\ndone')
