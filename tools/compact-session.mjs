#!/usr/bin/env node
/**
 * 会话日志压缩：只读试算（--dry-run）。
 *
 * 目的：把一份会话日志里"历史残影"算清楚——被 replace 遮蔽的旧消息、我们的
 * 补丁记录、重放留下的重复——然后给出"如果按可见轮重写，会剩下多少"。
 *
 * 这个工具**只读**。它不改任何文件，不写账本，不碰 session.lock。
 *
 * 用法：
 *
 *   node tools/compact-session.mjs <会话目录或日志文件> [--json]
 *   node tools/compact-session.mjs --all [--json]      # 扫所有会话，只估算
 *
 * 退出码：0 正常；1 参数或读取错误；2 日志无法解析。
 *
 * 判定规则（与插件的计划一致）：
 *   候选：op 条数 ≥ 3
 *   值得压：可折叠事件 ≥ 500，或（可折叠 ≥ 100 且 占比 ≥ 20%）
 */

import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import os from 'node:os'
import { pathToFileURL } from 'node:url'
import { execFileSync } from 'node:child_process'

const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

/** 判定阈值，集中放这里便于以后搬进插件配置。 */
export const RULES = {
  minOps: 3,
  minDroppable: 500,
  minDroppableWithRatio: 100,
  minRatio: 0.2,
}

/**
 * 解压一份多帧 zstd 的会话日志，返回 JSON 事件数组。
 *
 * 日志是按帧追加的：每帧一帧 zstd。这里按魔数切帧，逐帧解压后拼起来。
 *
 * @param {string} file - 日志文件路径。
 * @returns {{ events: object[], rawBytes: number, compressedBytes: number, header: object|null }}
 */
export function readLog(file) {
  const buf = fs.readFileSync(file)
  const starts = []
  for (let i = 0; i + 4 <= buf.length; i += 1) {
    if (buf[i] === 0x28 && buf[i + 1] === 0xb5 && buf[i + 2] === 0x2f && buf[i + 3] === 0xfd) starts.push(i)
  }
  let text = ''
  for (let k = 0; k < starts.length; k += 1) {
    const end = k + 1 < starts.length ? starts[k + 1] : buf.length
    try {
      text += zlib.zstdDecompressSync(buf.subarray(starts[k], end)).toString('utf8')
    } catch {
      // 一帧坏了不该毁掉整个文件：跳过它，后面的帧照读。
    }
  }
  const events = []
  let rawBytes = 0
  let header = null
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue
    rawBytes += Buffer.byteLength(line, 'utf8') + 1
    let event
    try {
      event = JSON.parse(line)
    } catch {
      continue
    }
    if (header === null && event.type === 'session') header = event
    else events.push(event)
  }
  return { events, rawBytes, compressedBytes: buf.length, header }
}

/**
 * 折叠表面：按 surfaceOp 算出"现在真正可见的是哪些事件"。
 *
 * 规则来自日志本身：
 * - `surfaceOp: "append"` 把一个节点加到表面
 * - `surfaceOp: { op: "replace", startSeq, endSeq }` 先把这段节点摘掉，再把本条加上
 *
 * @param {object[]} events - 除头部以外的事件，按 seq 递增。
 * @returns {{ visible: number[], dropped: Set<number> }}
 */
export function foldSurface(events) {
  /** @type {number[]} */
  const nodes = []
  const dropped = new Set()
  /** 被 replace 覆盖过的区间；落在这里面的事件都不再出现在界面上。 */
  const ranges = []
  for (const event of events) {
    const op = event.surfaceOp
    if (op === undefined || op === null) continue
    if (op === 'append') {
      nodes.push(event.seq)
      continue
    }
    if (typeof op === 'object' && op.op === 'replace') {
      const start = Number(op.startSeq)
      const end = Number(op.endSeq)
      // 记下发起替换的那条事件的 seq：replace 只能遮蔽**它之前**的事件，
      // 区间端点越界时不能把后面的事件也算成被覆盖。
      ranges.push([start, end, event.seq])
      for (let i = nodes.length - 1; i >= 0; i -= 1) {
        const seq = nodes[i]
        // 只移除**排在它之前**的节点：replace 遮蔽不了还没写下的东西（宿主也要求
        // startSeq/endSeq 必须引用更早的事件）。
        if (seq >= start && seq <= end && seq < event.seq) {
          nodes.splice(i, 1)
          dropped.add(seq)
        }
      }
      // 契约要求 replace 把它覆盖的节点列全；列出的同样算摘掉。
      for (const seq of Array.isArray(event.sourceEventSeqs) ? event.sourceEventSeqs : []) {
        const at = nodes.indexOf(seq)
        if (at >= 0) {
          nodes.splice(at, 1)
          dropped.add(seq)
        }
      }
      nodes.push(event.seq)
    }
  }
  // 覆盖范围内的**所有**事件都不可见，不只是表面节点：step/start、job/* 这类
  // 没有 surfaceOp 的事件，只要落在被替换的区间里，就已经随那段历史一起从界面上
  // 消失了——界面在那个位置画的是一条「压缩标记」行（chat bundle 里的
  // CompactionItem），而不是原来的消息和过程面板。
  const covered = new Set(dropped)
  for (const event of events) {
    for (const [start, end, at] of ranges) {
      if (event.seq >= start && event.seq <= end && event.seq < at) {
        covered.add(event.seq)
        break
      }
    }
  }
  return { visible: nodes, dropped: covered }
}

/** 账本要记的操作类型（来自四个组件写的记录）。 */
const OPS_PREFIX = 'plugin:dsh-'

/**
 * 判定一条事件在压缩后还有没有用。
 *
 * 保守原则：只在能说清"它为什么没用"时才丢。说不清的（未知类型）留着，
 * 体积是小问题，丢掉宿主还要读的东西才是大问题。
 *
 * @param {object} event - 一条日志事件。
 * @param {Set<number>} visibleSet - 折叠后可见的 seq 集合。
 * @returns {{ keep: boolean, why: string }}
 */
function classify(event, covered) {
  // 唯一可靠的判据：这条事件有没有被某次 replace 覆盖掉。
  //
  // 按类型猜是错的：step/start、job/* 看着像"元数据"，其实是界面上过程面板
  // （已完成分析 / 思考 / 工具调用列表）的数据源；它们只有在被 replace 覆盖时
  // 才该消失——而那一刻，界面在那个位置画的已经是「压缩标记」行。
  if (covered.has(event.seq)) return { keep: false, why: '被 replace 覆盖（界面上已不在）' }
  const type = String(event.type ?? '')
  if (type.startsWith(OPS_PREFIX)) {
    // 我们自己的补丁/重跑/删除记录：内容会折进消息、或转成账本条目。
    return { keep: false, why: '操作记录（折进消息或账本）' }
  }
  return { keep: true, why: '界面仍会渲染' }
}

/**
 * 从日志里读出我们的操作（账本条目），用于判定"这个会话被改过几次"。
 *
 * @param {object[]} events - 日志事件。
 * @returns {object[]} 按时间排序的操作描述。
 */
export function opsOf(events) {
  const ops = []
  for (const event of events) {
    const type = String(event.type ?? '')
    // 宿主的压缩也算一条操作：它同样把旧消息变成了残影。
    if (type.startsWith('compaction/')) {
      ops.push({ op: 'compaction', seq: event.seq, time: event.time, kind: type })
      continue
    }
    if (!type.startsWith(OPS_PREFIX)) continue
    const slash = type.lastIndexOf('/')
    const kind = type.slice(slash + 1)
    const data = event.data ?? {}
    if (kind === 'patch') {
      const targets = Array.isArray(data.targets) ? data.targets : []
      for (const target of targets) {
        ops.push({
          op: target.insert ? 'insert' : 'edit',
          seq: event.seq,
          time: event.time,
          session: event.session,
          target: target.seq,
          block: target.blockIndex,
          kindOfBlock: target.kind,
          chars: typeof target.text === 'string' ? target.text.length : 0,
          insertId: target.insert?.id ?? null,
          removed: target.removed === true,
        })
      }
      continue
    }
    ops.push({ op: kind, seq: event.seq, time: event.time, data })
  }
  return ops
}

/**
 * 试算一个会话。
 *
 * @param {string} file - 日志文件路径。
 * @returns {object} 报告对象。
 */
export function estimate(file) {
  const { events, rawBytes, compressedBytes, header } = readLog(file)
  if (events.length === 0) throw new Error('日志里没有事件')
  const { visible, dropped } = foldSurface(events)
  const covered = dropped

  let keepRaw = 0
  let keepCount = 0
  const droppedByType = new Map()
  const keptByType = new Map()
  for (const event of events) {
    const verdict = classify(event, covered)
    const line = Buffer.byteLength(JSON.stringify(event), 'utf8') + 1
    const bucket = verdict.keep ? keptByType : droppedByType
    bucket.set(event.type, (bucket.get(event.type) ?? 0) + 1)
    if (verdict.keep) {
      keepRaw += line
      keepCount += 1
    }
  }

  const pluginOps = opsOf(events)
  // 改写历史的证据不只我们的插件：宿主的 replace（含 compaction/prune）同样
  // 会让旧消息变成残影。判定"这个会话被改过几次"要把它们算在一起。
  let replaceOps = 0
  for (const event of events) {
    if (event.surfaceOp && typeof event.surfaceOp === 'object' && event.surfaceOp.op === 'replace') replaceOps += 1
  }
  const ops = pluginOps.concat(Array.from({ length: replaceOps }, (_, i) => ({ op: 'replace', seq: -1 - i })))
  const total = events.length
  const droppable = total - keepCount
  const ratio = total === 0 ? 0 : droppable / total
  // 压缩后的大小按"保留的原始 JSONL 比例"折算到 zstd 大小：两者的压缩率接近，
  // 这个估算偏保守（真实重写还能去掉重复的字符串）。
  const estimatedCompressed = compressedBytes === 0 ? 0 : Math.round((keepRaw / Math.max(rawBytes, 1)) * compressedBytes)

  const candidate = ops.length >= RULES.minOps
  const worth =
    droppable >= RULES.minDroppable ||
    (droppable >= RULES.minDroppableWithRatio && ratio >= RULES.minRatio)

  return {
    file,
    sessionId: header?.id ?? path.basename(path.dirname(file)),
    header: header ?? null,
    events: total,
    rawBytes,
    compressedBytes,
    visibleNodes: visible.length,
    shadowedNodes: dropped.size,
    keptEvents: keepCount,
    droppedEvents: droppable,
    dropRatio: ratio,
    estimatedCompressed,
    savedCompressed: compressedBytes - estimatedCompressed,
    ops: ops.length,
    opKinds: ops.reduce((acc, op) => {
      acc[op.op] = (acc[op.op] ?? 0) + 1
      return acc
    }, {}),
    droppedByType: Object.fromEntries([...droppedByType.entries()].sort((a, b) => b[1] - a[1])),
    keptByType: Object.fromEntries([...keptByType.entries()].sort((a, b) => b[1] - a[1])),
    verdict: { candidate, worth, compact: candidate && worth },
  }
}

/** 把字节数写成人看的单位。 */
function human(bytes) {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`
  return `${(bytes / 1048576).toFixed(1)} MB`
}

/** 打印一份报告。 */
function printReport(report) {
  const r = report
  console.log(`会话 ${r.sessionId}`)
  console.log(`  日志      ${r.file}`)
  console.log(`  压缩前    ${r.events} 事件 / ${human(r.compressedBytes)}（${human(r.rawBytes)} 未压缩）`)
  console.log(`  表面      ${r.visibleNodes} 个可见节点，${r.shadowedNodes} 个被遮蔽`)
  console.log(`  重写后    ${r.keptEvents} 事件 / 预计 ${human(r.estimatedCompressed)}（省 ${human(Math.max(0, r.savedCompressed))}）`)
  console.log(`  可折叠    ${r.droppedEvents} 条（${(r.dropRatio * 100).toFixed(1)}%）`)
  console.log(`  操作      ${r.ops} 条 ${JSON.stringify(r.opKinds)} ${r.ops > 0 ? '（账本来源）' : ''}`)
  const dropped = Object.entries(r.droppedByType)
  if (dropped.length > 0) {
    console.log('  折叠明细')
    for (const [type, count] of dropped.slice(0, 12)) console.log(`      ${String(count).padStart(6)}  ${type}`)
    if (dropped.length > 12) console.log(`      … 还有 ${dropped.length - 12} 种`)
  }
  const kept = Object.entries(r.keptByType)
  if (kept.length > 0) {
    console.log('  保留明细')
    for (const [type, count] of kept.slice(0, 10)) console.log(`      ${String(count).padStart(6)}  ${type}`)
  }
  const v = r.verdict
  console.log(`  判定      候选=${v.candidate ? '是' : '否'}（操作 ${r.ops} / 门槛 ${RULES.minOps}）` +
    `，值得压=${v.worth ? '是' : '否'}（可折叠 ${r.droppedEvents}，${(r.dropRatio * 100).toFixed(0)}%）`)
  console.log(`  结论      ${v.compact ? '会压缩 ✔' : '跳过 ✘'}`)
  console.log('')
}

/** 找到 dsh 的会话根目录。 */
function sessionsRoot() {
  return path.join(os.homedir(), '.dsh', 'sessions')
}

/** 列出所有会话日志文件。 */
function allLogs() {
  const root = sessionsRoot()
  const files = []
  let projects = []
  try {
    projects = fs.readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory())
  } catch {
    return files
  }
  for (const project of projects) {
    const dir = path.join(root, project.name)
    let entries = []
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory())
    } catch {
      continue
    }
    for (const entry of entries) {
      const file = path.join(dir, entry.name, 'session.v4.jsonl.zstd')
      if (fs.existsSync(file)) files.push(file)
    }
  }
  return files
}

/** 把用户给的参数解析成一个日志文件路径。 */
function resolveLog(arg) {
  if (arg === undefined) throw new Error('缺少会话 id 或日志路径')
  if (arg.endsWith('.zstd')) return arg
  if (arg.endsWith('.jsonl')) return arg
  const dir = fs.existsSync(arg) ? arg : null
  if (dir !== null) {
    const file = path.join(dir, 'session.v4.jsonl.zstd')
    if (fs.existsSync(file)) return file
  }
  for (const file of allLogs()) {
    if (file.includes(arg)) return file
  }
  throw new Error(`找不到会话：${arg}`)
}

// 路径里有空格时手工拼 file:// 会不相等，用 pathToFileURL 对齐编码。
/**
 * 无论被谁覆盖都保留的事件：这些是界面渲染「压缩标记」和会话元信息要用的，
 * 体量可以忽略（这个会话里 64 条），丢了会让界面少一行标记或丢标题。
 */
const KEEP_ALWAYS = ['compaction/', 'session/']

/**
 * 生成压缩后的日志事件流。
 *
 * 关键约束：宿主校验"被引用的 seq 必须先存在"，所以不能一边删掉被 replace
 * 覆盖的原文、一边留着那条 replace。做法是**每个被覆盖的区间留一个锚事件**
 * （区间里最小的那条），把 replace 的范围重指到它；区间里其余的事件全部删除。
 * 结果：契约仍然成立，派生历史（模型看到的）逐条不变，而体积塌掉。
 *
 * @param {object[]} events - 原日志事件（不含头部）。
 * @returns {{ events: object[], dropped: number, anchors: number, mapping: Map<number, number> }}
 */
export function rewrite(events) {
  const { dropped } = foldSurface(events)

  // 第一遍：先算出"不靠锚也活下来"的事件。
  const keep = new Set()
  for (const event of events) {
    const type = String(event.type ?? '')
    const always = KEEP_ALWAYS.some((prefix) => type.startsWith(prefix))
    if (!dropped.has(event.seq) || always) keep.add(event.seq)
  }

  // 第二遍：把活下来的 replace 的区间端点对齐到真正的表面节点（并把端点纳入保留）。
  alignReplaceRanges(events, keep)

  const kept = []
  let droppedCount = 0
  for (const event of events) {
    if (keep.has(event.seq)) kept.push(event)
    else droppedCount += 1
  }
  const result = renumber(kept)
  return { events: result.events, dropped: droppedCount, anchors: 0, mapping: result.mapping, refsFixed: result.refsFixed }
}

/**
 * 派生历史：把日志折叠成"模型最终会读到的消息序列"，用内容做签名。
 *
 * 校验压缩是否安全，就看新旧两份日志算出来的这个序列是否逐条相同。
 *
 * @param {object[]} events - 事件（不含头部）。
 * @returns {string[]} 每条消息的签名。
 */
export function derivedHistory(events) {
  const { visible } = foldSurface(events)
  const bySeq = new Map(events.map((e) => [e.seq, e]))
  const signatures = []
  for (const seq of visible) {
    const event = bySeq.get(seq)
    if (event === undefined) continue
    const payload = event.data?.message ?? event.data ?? null
    signatures.push(`${event.type}:${JSON.stringify(payload)}`)
  }
  return signatures
}

/**
 * 把一份事件流写成日志字节（多帧 zstd，一行一事件）。
 *
 * @param {object|null} header - 头部记录。
 * @param {object[]} events - 事件。
 * @returns {Buffer} 文件内容。
 */
export function encodeLog(header, events) {
  const lines = []
  if (header !== null) lines.push(JSON.stringify(header))
  for (const event of events) lines.push(JSON.stringify(event))
  const frames = []
  // 头部单独一帧，其余每 256 条一帧：和官方一样是多帧结构。
  const chunks = [lines.slice(0, 1), ...chunk(lines.slice(1), 256)]
  for (const chunkLines of chunks) {
    if (chunkLines.length === 0) continue
    frames.push(zlib.zstdCompressSync(Buffer.from(chunkLines.join('\n') + '\n', 'utf8')))
  }
  return Buffer.concat(frames)
}

/** 把数组切成固定大小的块。 */
function chunk(items, size) {
  const out = []
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size))
  return out
}

/**
 * 试写一份压缩后的日志到临时路径，并校验它和原日志"派生历史逐条相同"。
 *
 * 只写临时文件，**绝不碰原日志**。
 *
 * @param {string} file - 原日志。
 * @param {string} target - 写到哪里。
 */
function emitReport(file, target) {
  const original = readLog(file)
  const before = derivedHistory(original.events)
  const result = rewrite(original.events)
  const after = derivedHistory(result.events)

  // 结构不变量：seq 连续；引用的 seq 都存在。
  const seqs = new Set(result.events.map((e) => e.seq))
  let contiguous = true
  for (let i = 0; i < result.events.length; i += 1) {
    if (!seqs.has(i)) { contiguous = false; break }
  }
  const missing = []
  for (const event of result.events) {
    const cited = [
      ...(Array.isArray(event.sourceEventSeqs) ? event.sourceEventSeqs : []),
      ...(event.surfaceOp && typeof event.surfaceOp === 'object' && event.surfaceOp.op === 'replace'
        ? [event.surfaceOp.startSeq, event.surfaceOp.endSeq] : []),
    ]
    for (const seq of cited) if (!seqs.has(Number(seq))) missing.push({ at: event.seq, cites: seq })
  }

  const identical = before.length === after.length && before.every((sig, i) => sig === after[i])
  const bytes = encodeLog(original.header, result.events)
  fs.writeFileSync(target, bytes)

  console.log(`原日志    ${file}`)
  console.log(`压缩前    ${original.events.length} 事件 / ${human(original.compressedBytes)}`)
  console.log(`压缩后    ${result.events.length} 事件 / ${human(bytes.length)}（省 ${human(Math.max(0, original.compressedBytes - bytes.length))}）`)
  console.log(`删除      ${result.dropped} 条；保留锚事件 ${result.anchors} 个（每段 replace 一个）`)
  console.log(`结构      seq 连续=${contiguous ? '是' : '否'}，悬空引用=${missing.length === 0 ? '无' : missing.length + ' 处'}`)
  console.log(`派生历史  原 ${before.length} 条 → 新 ${after.length} 条；逐条相同=${identical ? '是 ✔' : '否 ✘'}`)
  if (!identical) {
    for (let i = 0; i < Math.max(before.length, after.length); i += 1) {
      if (before[i] !== after[i]) {
        console.log(`  首个差异在第 ${i} 条：`)
        console.log(`    原: ${String(before[i]).slice(0, 160)}`)
        console.log(`    新: ${String(after[i]).slice(0, 160)}`)
        break
      }
    }
  }
  console.log(`试写文件  ${target}`)
}

/** 试写的默认路径：临时目录，绝不覆盖原日志。 */
function outPath(file, args) {
  const at = args.indexOf('--out')
  if (at >= 0 && args[at + 1] !== undefined) return args[at + 1]
  return path.join(os.tmpdir(), `compact-${path.basename(path.dirname(file))}.jsonl.zstd`)
}

/**
 * 列出一次会话里所有 replace（官方的压缩 + 我们插件的改写），逐条给出"在哪、
 * 覆盖了什么、替代物是什么"，供人到界面上核对。
 *
 * @param {string} file - 日志文件。
 * @returns {{ sessionId: string, title: string, rows: object[] }}
 */
export function listReplaces(file) {
  const { events, header } = readLog(file)
  const turns = []
  let cur = null
  for (const event of events) {
    if (event.type === 'turn/start') cur = { turn: Number(event.data?.turn), start: event.seq, end: event.seq }
    else if (event.type === 'turn/end' && cur !== null) { cur.end = event.seq; turns.push(cur); cur = null }
  }
  const turnOf = (seq) => {
    const hit = turns.find((t) => seq >= t.start && seq <= t.end)
    return hit === undefined ? null : hit.turn
  }
  let title = ''
  for (const event of events) {
    if (event.type === 'session/title' && typeof event.data?.title === 'string') title = event.data.title
  }
  const rows = []
  for (const event of events) {
    const op = event.surfaceOp
    if (op === undefined || op === null || typeof op !== 'object' || op.op !== 'replace') continue
    const start = Number(op.startSeq)
    const end = Number(op.endSeq)
    const covered = events.filter((e) => e.seq >= start && e.seq <= end && e.seq < event.seq)
    const byType = {}
    for (const e of covered) byType[e.type] = (byType[e.type] ?? 0) + 1
    const coveredTurns = covered.map((e) => turnOf(e.seq)).filter((t) => t !== null)
    const turnFrom = coveredTurns.length === 0 ? null : Math.min(...coveredTurns)
    const turnTo = coveredTurns.length === 0 ? null : Math.max(...coveredTurns)
    const content = event.data?.message?.content ?? event.data?.content ?? null
    const texts = Array.isArray(content) ? content.filter((b) => typeof b?.text === 'string').map((b) => b.text) : []
    rows.push({
      seq: event.seq,
      type: event.type,
      atTurn: turnOf(event.seq),
      covers: covered.length,
      turnFrom,
      turnTo,
      byType,
      summaryHead: texts.join(' ').replace(/\s+/g, ' ').slice(0, 120),
      textChars: texts.join('').length,
      single: covered.length <= 1,
    })
  }
  return { sessionId: header?.id ?? '', title, rows }
}

/** 窗口的定义来自 dsh-session-pages：压缩 checkpoint 切窗。 */
export const CHECKPOINT_KIND = 'compact-checkpoint'

/**
 * 这条事件是不是一个窗口开头的 checkpoint。
 *
 * @param {object} event - 日志事件。
 * @returns {boolean} 是 checkpoint 时为 true。
 */
export function isCheckpoint(event) {
  if (event === null || typeof event !== 'object') return false
  if (event.type !== 'user/message') return false
  const source = event.data === null || event.data === undefined ? undefined : event.data.source
  return source !== null && source !== undefined && source.kind === CHECKPOINT_KIND
}

/** 对话区的行只来自 append 原文（宿主的原话：替换副本只给模型）。 */
export function transcriptRows(events) {
  const types = new Set(['system/message', 'developer/message', 'user/message', 'assistant/message', 'tool/result'])
  return events.filter((e) => types.has(e.type) && e.surfaceOp === 'append').length
}

/** 按 checkpoint 切窗，返回每一窗的起止 seq。 */
export function windowsOf(events) {
  const sorted = [...events].sort((a, b) => a.seq - b.seq)
  const marks = sorted.filter(isCheckpoint).map((e) => e.seq)
  const windows = []
  const first = sorted.length > 0 ? sorted[0].seq : 0
  windows.push({ index: 1, startSeq: first, endSeq: marks.length > 0 ? marks[0] - 1 : null, checkpointSeq: null })
  marks.forEach((seq, i) => {
    windows.push({
      index: i + 2,
      startSeq: seq,
      endSeq: i + 1 < marks.length ? marks[i + 1] - 1 : null,
      checkpointSeq: seq,
    })
  })
  return windows
}

/**
 * 只保留最后 keep 个窗口，其余整段裁掉。
 *
 * 这是**销毁性**操作：被裁窗口的原文是对话区的源材料，删掉之后人也看不到了。
 * 保留的"框"（系统提示词、工具声明、预设、权限）是会话级设置，裁掉模型就没了，
 * 所以无论落在哪一窗都留下。
 *
 * @param {object[]} events - 原事件（不含头部）。
 * @param {number} keep - 保留最后几窗。
 * @returns {{ events: object[], cutSeq: number|null, windows: number, kept: number, dropped: number, frame: object[] }}
 */
export function keepLastWindows(events, keep) {
  const windows = windowsOf(events)
  if (windows.length <= keep) {
    return { events, cutSeq: null, windows: windows.length, kept: events.length, dropped: 0, frame: [] }
  }
  const firstKept = windows.length - keep + 1
  const cutSeq = windows[firstKept - 1].startSeq

  // 会话级的"框"：这些事件决定模型看到什么系统提示词、有哪些工具、什么预设。
  // 它们只出现在会话开头，裁掉就等于把设置也裁了。
  // 系统提示词要取"原日志里真正可见的那一条"。
  //
  // 会话中途系统提示词可能被重写过（宿主允许用 system/message 精确替换 node 0），
  // 于是日志里会躺着多条 system/message：早期那条已被遮蔽，真正生效的是后来的。
  // 按"第一条"取会把被遮蔽的那条复活，模型上下文里就出现两份系统提示词。
  const originalVisible = foldSurface(events).visible
  const visibleSet = new Set(originalVisible)
  // 必须挑**非空**的那条：日志里还有成对的空 `developer/message` 标记，
  // 它们不产生任何模型消息；挑错了模型就丢了系统提示词。
  const effectiveSystem = originalVisible
    .map((seq) => events.find((e) => e.seq === seq))
    .find(
      (e) =>
        e !== undefined &&
        (e.type === 'system/message' || e.type === 'developer/message') &&
        textLengthOf(e) > 0,
    )
  const frame = []
  if (effectiveSystem !== undefined) frame.push(effectiveSystem)
  const frameSeen = new Set(frame.map((e) => e.seq))
  const keepLastOf = (type) => {
    const hit = events.filter((e) => e.type === type && e.seq < cutSeq).pop()
    if (hit !== undefined) frame.push(hit)
  }
  void visibleSet
  for (const type of ['request/header', 'agent-preset/selected', 'permission/preset', 'sandbox/mode', 'approval/policy', 'session/title']) {
    keepLastOf(type)
  }

  const keepSeq = new Set(frame.map((e) => e.seq))
  const bySeq = new Map(events.map((e) => [e.seq, e]))
  // developer/message 用 `headerSeq` 精确指向它那一次请求的 request/header；
  // 宿主的校验要求那条 header 必须还在、且排在它之前。裁掉就等于把这条消息废掉。
  // 这里迭代到不动点：被留下的 header 不会再引用别的东西，所以最多两轮。
  for (let round = 0; round < 4; round += 1) {
    let added = false
    for (const event of events) {
      const referenced = event.data?.headerSeq
      if (event.seq < cutSeq && !keepSeq.has(event.seq)) continue
      if (!Number.isSafeInteger(referenced)) continue
      if (keepSeq.has(referenced)) continue
      const header = bySeq.get(referenced)
      if (header === undefined) continue
      keepSeq.add(referenced)
      added = true
    }
    if (!added) break
  }
  const out = []
  let dropped = 0
  for (const event of events) {
    if (event.seq >= cutSeq || keepSeq.has(event.seq)) {
      out.push(event)
      continue
    }
    dropped += 1
  }
  // 活下来的 replace 的区间端点必须落在保留集里的表面节点上。
  const { anchors } = alignReplaceRanges(events, keepSeq)
  const finalOut = []
  let finalDropped = 0
  for (const event of events) {
    if (event.seq >= cutSeq || keepSeq.has(event.seq)) finalOut.push(event)
    else finalDropped += 1
  }
  void out
  void dropped
  const extra = [...keepSeq]
    .filter((seq) => !frame.some((e) => e.seq === seq))
    .map((seq) => bySeq.get(seq))
    .filter((e) => e !== undefined)
  return {
    events: finalOut,
    cutSeq,
    windows: windows.length,
    kept: finalOut.length,
    dropped: finalDropped,
    frame: [...frame, ...extra],
    anchors: anchors.size,
  }
}

/**
 * 把 `sourceEventSeqs` 规范化成宿主契约要的形状。
 *
 * 契约（`assertSourceEventReferences`）：非空数组、每一项都是非负安全整数、不重复。
 * 实测本机的日志里有 3 条由 dsh-rerun-turn 写下的记录把第一个元素写成了数组
 * （`[[11119,11121],11125,…]`），宿主的严格校验器会直接拒绝 —— 界面能打开是因为
 * 加载路径容错，但这样的数据在 fork / relocate / 严格 adopt 时会被拒。
 *
 * @param {unknown} raw - 原始的 sourceEventSeqs。
 * @returns {number[]|null} 规范化后的数组；空则返回 null（字段应删除）。
 */
export function normalizeRefs(raw) {
  if (!Array.isArray(raw)) return null
  const flat = []
  for (const item of raw) {
    if (Array.isArray(item)) {
      for (const inner of item) flat.push(inner)
    } else {
      flat.push(item)
    }
  }
  const seen = new Set()
  const out = []
  for (const value of flat) {
    const seq = Number(value)
    if (!Number.isSafeInteger(seq) || seq < 0) continue
    if (seen.has(seq)) continue
    seen.add(seq)
    out.push(seq)
  }
  return out.length === 0 ? null : out
}

/**
 * 重编 seq 并把所有引用搬过去；引用落空的 replace 降级为普通追加。
 *
 * @param {object[]} events - 已经选好的事件（按原顺序）。
 * @returns {{ events: object[], mapping: Map<number, number>, refsFixed: number }}
 */
/** 会进入表面的消息类型（宿主 SURFACE_EVENT_TYPES）。 */
const SURFACE_TYPES = new Set([
  'system/message',
  'developer/message',
  'user/message',
  'assistant/message',
  'tool/result',
])

/**
 * 一条事件承载的文本长度（零宽字符不算内容）。
 *
 * @param {object} event - 日志事件。
 * @returns {number} 去掉零宽字符后的字符数。
 */
export function textLengthOf(event) {
  const blocks = Array.isArray(event?.data?.content)
    ? event.data.content
    : Array.isArray(event?.data?.message?.content) ? event.data.message.content : []
  let text = ''
  for (const block of blocks) if (typeof block?.text === 'string') text += block.text
  return text.replace(/[\u200b\u200c\u200d\ufeff]/g, '').trim().length
}

/** 这条事件是不是一个表面节点（宿主的 `state.nodes` 成员）。 */
export function isSurfaceNode(event) {
  if (event === null || typeof event !== 'object') return false
  if (!SURFACE_TYPES.has(event.type)) return false
  return event.surfaceOp !== undefined && event.surfaceOp !== null
}

/**
 * 把每个"活下来的" replace 的区间端点对齐到真正的表面节点，并把这些端点纳入保留集。
 *
 * 宿主的 `replacementRange` 用 `state.nodes.indexOf(startSeq)` 定位端点，端点必须
 * 是表面节点，否则直接抛错；被遮蔽集合则是**表面序列的切片**，不是"seq 落在区间内"。
 * 所以区间两端要选范围内第一个/最后一个表面节点，而不是范围内最小/最大的 seq
 * （后者可能是 step/start 这种非表面事件）。
 *
 * @param {object[]} events - 原事件（按 seq 升序）。
 * @param {Set<number>} keep - 已决定保留的 seq 集合（会被就地补充）。
 * @returns {{ degraded: Set<number>, anchors: Set<number> }}
 */
export function alignReplaceRanges(events, keep) {
  const degraded = new Set()
  const anchors = new Set()
  const drop = new Set()
  const isReplace = (e) => e.surfaceOp !== undefined && e.surfaceOp !== null && typeof e.surfaceOp === 'object'
  for (let round = 0; round < 6; round += 1) {
    let added = false
    for (const event of events) {
      if (!keep.has(event.seq) || !isReplace(event)) continue
      const start = Number(event.surfaceOp.startSeq)
      const end = Number(event.surfaceOp.endSeq)
      const candidates = events.filter(
        (e) => e.seq >= start && e.seq <= end && e.seq < event.seq && isSurfaceNode(e) && keep.has(e.seq),
      )
      if (candidates.length === 0) {
        // 区间里一个表面节点都不剩：这条 replace 引用不到任何东西，降级为普通追加，
        // 否则它会因为端点不在表面而被宿主拒绝。
        //
        // 如果它的内容本来就是空的（静默替换载体是 1 个零宽字符），降级只会往模型
        // 上下文里塞一条空消息，那就干脆删掉。
        // 非空的：留在保留集里，`renumber` 会因为端点不在表面而把它降级成
        // 普通追加 —— 内容必须留下，悄悄删掉摘要会让模型少一段记忆。
        if (textLengthOf(event) === 0) drop.add(event.seq)
        continue
      }
      const min = candidates.reduce((a, b) => (a.seq < b.seq ? a : b))
      const max = candidates.reduce((a, b) => (a.seq > b.seq ? a : b))
      event.surfaceOp = { op: 'replace', startSeq: min.seq, endSeq: max.seq }
      for (const anchor of [min, max]) {
        if (!keep.has(anchor.seq)) {
          keep.add(anchor.seq)
          anchors.add(anchor.seq)
          added = true
        }
      }
    }
    if (!added) break
  }
  for (const seq of drop) keep.delete(seq)
  return { degraded, anchors, drop }
}

/** 会进入表面的消息类型（宿主 SURFACE_EVENT_TYPES）。 */
export function renumber(events) {
  // seq 从 0 开始：宿主按数组下标核对（`planSurfaceEvent` 要求 events[i].seq === i），
  // 而日志里第一条事件的 seq 就是 0。
  const mapping = new Map()
  events.forEach((event, index) => mapping.set(event.seq, index))
  const remap = (seq) => (mapping.has(seq) ? mapping.get(seq) : null)
  const out = events.map((event) => {
    const next = { ...event, seq: mapping.get(event.seq) }
    // developer/message 的 `headerSeq` 是按 seq 指向 request/header 的引用，也要搬。
    if (Number.isSafeInteger(event.data?.headerSeq)) {
      const moved = remap(event.data.headerSeq)
      next.data = { ...event.data }
      if (moved === null) delete next.data.headerSeq
      else next.data.headerSeq = moved
    }
    if (event.surfaceOp !== undefined && event.surfaceOp !== null && typeof event.surfaceOp === 'object') {
      const startSeq = remap(Number(event.surfaceOp.startSeq))
      const endSeq = remap(Number(event.surfaceOp.endSeq))
      if (startSeq !== null && endSeq !== null) next.surfaceOp = { ...event.surfaceOp, startSeq, endSeq }
      else next.surfaceOp = 'append'
    }
    return next
  })

  // 模拟宿主的折叠，逐条算出这条 replace 应该引用什么。
  //
  // 宿主的算法（`replacementRange`）：用 `state.nodes.indexOf(startSeq)` 定位端点，
  // 被遮蔽集合是**表面序列的切片** `nodes.slice(startIdx, endIdx + 1)` —— 不是"seq
  // 落在区间内"。照搬原引用会把非法数据带进新日志（实测：本机有 3 条 rerun 记录把
  // 范围写成嵌套数组、还漏了区间内的节点）。重算之后，输出的日志反而比原来更合规。
  const nodes = []
  let refsFixed = 0
  for (const event of out) {
    const op = event.surfaceOp
    if (op === undefined || op === null) {
      // 非表面事件：引用只要求扁平、不重复、都排在它之前。
      if (event.sourceEventSeqs !== undefined) {
        const flat = normalizeRefs(event.sourceEventSeqs)
        const moved = flat === null ? [] : flat.filter((seq) => seq < event.seq)
        if (moved.length === 0) delete event.sourceEventSeqs
        else event.sourceEventSeqs = moved
        if (flat === null || flat.length !== moved.length) refsFixed += 1
      }
      continue
    }
    if (op === 'append') {
      if (event.sourceEventSeqs !== undefined) {
        const flat = normalizeRefs(event.sourceEventSeqs)
        const moved = flat === null ? [] : flat.filter((seq) => seq < event.seq)
        if (moved.length === 0) delete event.sourceEventSeqs
        else event.sourceEventSeqs = moved
        if (flat === null || flat.length !== moved.length) refsFixed += 1
      }
      nodes.push(event.seq)
      continue
    }
    const startIdx = nodes.indexOf(op.startSeq)
    const endIdx = nodes.indexOf(op.endSeq)
    if (startIdx === -1 || endIdx === -1 || startIdx > endIdx) {
      // 端点不在表面上：这条 replace 引用不到任何东西，降级为普通追加，
      // 否则宿主会直接抛 "start seq not found in surface"。
      event.surfaceOp = 'append'
      delete event.sourceEventSeqs
      nodes.push(event.seq)
      refsFixed += 1
      continue
    }
    const shadowed = nodes.slice(startIdx, endIdx + 1)
    const before = Array.isArray(event.sourceEventSeqs) ? event.sourceEventSeqs : []
    if (before.length !== shadowed.length || before.some((value, i) => value !== shadowed[i])) refsFixed += 1
    event.sourceEventSeqs = [...shadowed]
    nodes.splice(startIdx, endIdx - startIdx + 1, event.seq)
  }
  return { events: out, mapping, refsFixed }
}

/**
 * 只保留最后 keep 个窗口，试写到临时文件，并报告删了什么。
 *
 * @param {string} file - 原日志。
 * @param {number} keep - 保留最后几窗。
 * @param {string} target - 写到哪里（只写临时文件）。
 */
function trimReport(file, keep, target) {
  const original = readLog(file)
  const before = {
    events: original.events.length,
    bytes: original.compressedBytes,
    windows: windowsOf(original.events).length,
    transcript: transcriptRows(original.events),
  }
  const trimmed = keepLastWindows(original.events, keep)
  if (trimmed.cutSeq === null) {
    console.log(`只有 ${trimmed.windows} 个窗口，不需要裁。`)
    return
  }
  const renamed = renumber(trimmed.events)
  const bytes = encodeLog(original.header, renamed.events)
  fs.writeFileSync(target, bytes)

  const seqs = new Set(renamed.events.map((e) => e.seq))
  let contiguous = true
  for (let i = 0; i < renamed.events.length; i += 1) if (!seqs.has(i)) { contiguous = false; break }
  let dangling = 0
  for (const event of renamed.events) {
    const refs = [...(Array.isArray(event.sourceEventSeqs) ? event.sourceEventSeqs : [])]
    if (event.surfaceOp !== null && typeof event.surfaceOp === 'object') refs.push(event.surfaceOp.startSeq, event.surfaceOp.endSeq)
    for (const ref of refs) if (ref !== undefined && !seqs.has(Number(ref))) dangling += 1
  }
  const firstKeptWindow = before.windows - keep + 1
  const first = renamed.events.find((e) => isCheckpoint(e))
  const checkpointText = (event) => {
    const blocks = Array.isArray(event?.data?.content)
      ? event.data.content
      : Array.isArray(event?.data?.message?.content) ? event.data.message.content : []
    return blocks.map((b) => (typeof b?.text === 'string' ? b.text : '')).join(' ')
  }

  // 模型视图：宿主按 surface 折叠，而压缩是累积的（后一个 checkpoint 覆盖前一个），
  // 所以模型通常只看得见最后一个摘要 + 它之后的尾部。裁掉更早的窗口对它毫无影响，
  // 这个对照就是证据。
  const visibleBefore = foldSurface(original.events).visible.length
  const visibleAfter = foldSurface(renamed.events).visible.length

  console.log(`原日志    ${file}`)
  console.log(`窗口      ${before.windows} 个 → 保留最后 ${keep} 个（裁掉第 1–${firstKeptWindow - 1} 窗）`)
  console.log(`事件      ${before.events} → ${renamed.events.length}（删除 ${trimmed.dropped} 条）`)
  console.log(`大小      ${human(before.bytes)} → ${human(bytes.length)}（省 ${human(Math.max(0, before.bytes - bytes.length))}）`)
  console.log(`对话区    可见行 ${before.transcript} → ${transcriptRows(renamed.events)}  ← 人也将看不到被裁的窗口`)
  console.log(`模型视图  可见节点 ${visibleBefore} → ${visibleAfter}${visibleBefore === visibleAfter ? '（完全不变）' : ''}`)
  if (first !== undefined) {
    console.log(`          从原第 ${firstKeptWindow} 窗的摘要起："${checkpointText(first).replace(/\s+/g, ' ').slice(0, 90)}…"`)
  }
  console.log(`结构      seq 连续=${contiguous ? '是' : '否'}，悬空引用=${dangling === 0 ? '无' : dangling + ' 处'}，重算引用 ${renamed.refsFixed} 条`)
  console.log(`保留的框  ${trimmed.frame.map((e) => e.type).join(', ') || '(无)'}`)
  console.log(`试写文件  ${target}`)
}

/**
 * 会话是否正被某个进程持有（`session.lock` 被打开）。
 *
 * 宿主在内存里打开会话时会持有这把锁；这时候改文件会被它后续的写入覆盖，
 * 所以必须拒绝。
 *
 * @param {string} logFile - 日志文件路径。
 * @returns {boolean} 被持有时为 true。
 */
function isSessionLocked(logFile) {
  const lock = path.join(path.dirname(logFile), 'session.lock')
  if (!fs.existsSync(lock)) return false
  try {
    const out = execFileSync('lsof', ['--', lock], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
    // lsof 无持有时只打印表头，或什么都不打印。
    const lines = out.trim().split('\n').filter((line) => line.trim() !== '' && !line.startsWith('COMMAND'))
    return lines.length > 0
  } catch {
    // lsof 找不到、或没有持有者时会以非零退出。
    return false
  }
}

/**
 * 真正落盘：备份原文件（改名保留）、写新文件（临时名 → rename）。
 *
 * 任何一步失败都不会留下半成品：新文件先写到同目录的临时名，成功后才 rename
 * 覆盖原名；备份就是把原文件改名，内容一字未动。
 *
 * @param {string} logFile - 原日志。
 * @param {number} keep - 保留最后几窗。
 * @returns {object} 结果摘要。
 */
export function applyTrim(logFile, keep) {
  if (isSessionLocked(logFile)) {
    throw new Error('会话正被宿主持有（session.lock 被打开），拒绝改动；请先关掉该会话或重启宿主')
  }
  const original = readLog(logFile)
  const trimmed = keepLastWindows(original.events, keep)
  if (trimmed.cutSeq === null) throw new Error(`只有 ${trimmed.windows} 个窗口，不需要裁`)
  const renamed = renumber(trimmed.events)

  const seqs = new Set(renamed.events.map((e) => e.seq))
  for (let i = 0; i < renamed.events.length; i += 1) {
    if (!seqs.has(i)) throw new Error(`内部错误：seq ${i} 缺失`)
  }
  for (const event of renamed.events) {
    const refs = [...(Array.isArray(event.sourceEventSeqs) ? event.sourceEventSeqs : [])]
    if (event.surfaceOp !== null && typeof event.surfaceOp === 'object') refs.push(event.surfaceOp.startSeq, event.surfaceOp.endSeq)
    for (const ref of refs) {
      if (ref !== undefined && !seqs.has(Number(ref))) throw new Error(`内部错误：seq ${event.seq} 引用不存在的 ${ref}`)
    }
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const backup = `${logFile}.precompact-${stamp}`
  const staging = `${logFile}.staging-${stamp}`
  fs.writeFileSync(staging, encodeLog(original.header, renamed.events))
  fs.renameSync(logFile, backup)
  fs.renameSync(staging, logFile)
  return {
    backup,
    before: { events: original.events.length, bytes: original.compressedBytes, windows: trimmed.windows },
    after: { events: renamed.events.length, bytes: fs.statSync(logFile).size },
    dropped: trimmed.dropped,
    refsFixed: renamed.refsFixed,
    transcript: { before: transcriptRows(original.events), after: transcriptRows(renamed.events) },
    model: { before: foldSurface(original.events).visible.length, after: foldSurface(renamed.events).visible.length },
  }
}

const isMain = process.argv[1] !== undefined && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
if (isMain) {
  const args = process.argv.slice(2)
  const asJson = args.includes('--json')
  const positional = args.filter((a) => !a.startsWith('--'))
  try {
    if (args.includes('--all')) {
      const reports = []
      for (const file of allLogs()) {
        try {
          reports.push(estimate(file))
        } catch {
          // 坏文件跳过：一次全量扫不该被一个烂日志打断。
        }
      }
      reports.sort((a, b) => b.savedCompressed - a.savedCompressed)
      if (asJson) {
        console.log(JSON.stringify(reports, null, 2))
      } else {
        console.log(`共 ${reports.length} 个会话\n`)
        for (const report of reports) printReport(report)
        const compactable = reports.filter((r) => r.verdict.compact)
        const saved = compactable.reduce((sum, r) => sum + Math.max(0, r.savedCompressed), 0)
        console.log(`合计：${compactable.length} 个值得压缩，预计省 ${human(saved)}`)
      }
    } else {
      const file = resolveLog(positional[0])
      if (args.includes('--replaces')) {
        const { sessionId, title, rows } = listReplaces(file)
        console.log(`会话 ${sessionId}`)
        if (title !== '') console.log(`标题 ${title}`)
        console.log(`replace 共 ${rows.length} 条：大范围（摘要）${rows.filter((r) => !r.single).length}，单点（修剪）${rows.filter((r) => r.single).length}\n`)
        for (const r of rows) {
          if (r.single) continue
          console.log(`· seq ${r.seq} ${r.type}（发起于第 ${r.atTurn ?? '?'} 轮）`)
          console.log(`  覆盖      第 ${r.turnFrom ?? '?'} 轮到第 ${r.turnTo ?? '?'} 轮，共 ${r.covers} 条事件`)
          console.log(`             ${Object.entries(r.byType).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([k, v]) => k + '×' + v).join(' ')}`)
          console.log(`  替代物    ${r.type}，${r.textChars} 字符：${r.summaryHead}`)
          console.log('')
        }
        const prunes = rows.filter((r) => r.single)
        if (prunes.length > 0) {
          console.log(`单点修剪 ${prunes.length} 条（各覆盖 1 条旧工具输出，换成剪短版），例如：`)
          for (const r of prunes.slice(0, 3)) {
            console.log(`· seq ${r.seq}（第 ${r.atTurn ?? '?'} 轮）覆盖 seq ${r.coverSeq ?? '?'} → ${r.textChars} 字符`)
          }
        }
      } else if (args.includes('--apply')) {
        const at = args.indexOf('--keep-windows')
        const keep = at >= 0 ? Number(args[at + 1] ?? '3') : 3
        const result = applyTrim(resolveLog(positional[0]), keep)
        console.log(`已裁剪    ${resolveLog(positional[0])}`)
        console.log(`窗口      ${result.before.windows} 个 → 保留最后 ${keep} 个`)
        console.log(`事件      ${result.before.events} → ${result.after.events}（删除 ${result.dropped} 条）`)
        console.log(`大小      ${human(result.before.bytes)} → ${human(result.after.bytes)}`)
        console.log(`对话区    可见行 ${result.transcript.before} → ${result.transcript.after}`)
        console.log(`模型视图  可见节点 ${result.model.before} → ${result.model.after}${result.model.before === result.model.after ? '（完全不变）' : ''}`)
        console.log(`重算引用  ${result.refsFixed} 条`)
        console.log(`备份      ${result.backup}`)
      } else if (args.includes('--keep-windows')) {
        const at = args.indexOf('--keep-windows')
        const keep = Number(args[at + 1] ?? '3')
        trimReport(file, keep, outPath(file, args))
      } else if (args.includes('--emit')) {
        emitReport(file, outPath(file, args))
      } else {
        const report = estimate(file)
        if (asJson) console.log(JSON.stringify(report, null, 2))
        else printReport(report)
      }
    }
  } catch (error) {
    console.error(`失败：${error instanceof Error ? error.message : String(error)}`)
    process.exit(1)
  }
}
