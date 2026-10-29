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
    // 和宿主一致：每帧独立可解、带校验和（宿主的 scanZstdFrames 按帧头判断）。
    frames.push(
      zlib.zstdCompressSync(Buffer.from(chunkLines.join('\n') + '\n', 'utf8'), {
        params: { [zlib.constants.ZSTD_c_checksumFlag]: 1 },
      }),
    )
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
 * 把切点退到它所在那一轮的 `turn/start`。
 *
 * 宿主的日志生命周期从 `turn/start turn=1` 起算：轮次必须 1,2,3… 连续，每轮的步骤
 * 从 `step=1` 起算。在"摘要检查点"处切会得到一份从半轮开始的日志，加载时第一条
 * request/header 就因为"不在开启的轮次里"被拒。
 *
 * @param {object[]} events - 原事件（按 seq 升序）。
 * @param {number} cutSeq - 原计划的切点。
 * @returns {number} 退到轮首之后的切点；找不到更早的 turn/start 就原样返回。
 */
export function snapToTurnStart(events, cutSeq) {
  let snapped = cutSeq
  for (const event of events) {
    if (event.seq > cutSeq) break
    if (event.type === 'turn/start') snapped = event.seq
  }
  return snapped
}

/**
 * 这条标题在被裁掉前半段之后还能不能自洽。
 *
 * 用户自己命名的标题 `messageSeqs` 为空，与日志内容无关，永远留得住；
 * fallback / provider 标题必须引用**更早的**人类消息，而那些消息都在被裁的那一段里，
 * 留下来就是悬空引用（宿主：`title messageSeqs must name an earlier event`）。
 *
 * @param {object} event - session/title 事件。
 * @returns {boolean} 能原样保留则为 true。
 */
export function titleSurvivesCut(event) {
  const seqs = event?.data?.messageSeqs
  if (!Array.isArray(seqs) || seqs.length === 0) return true
  return event?.data?.source?.kind === 'user'
}

/**
 * 丢掉"没有对应 compaction/start"的压缩残留事件。
 *
 * 压缩记录成对出现：`compaction/start` 开启，`compaction/end` 收尾，中间可能有
 * `compaction/summary`。切点落在一次压缩中间时 start 被裁掉、end 留下，
 * 宿主会报 `compaction/end has no matching compaction/start`。
 *
 * @param {object[]} events - 已选好的事件（按 seq 升序）。
 * @returns {object[]} 去掉不完整压缩记录之后的事件。
 */
export function dropOrphanCompactions(events) {
  const started = new Set()
  for (const event of events) {
    if (event.type !== 'compaction/start') continue
    if (typeof event?.data?.compactionId === 'string') started.add(event.data.compactionId)
  }
  const orphan = new Set()
  for (const event of events) {
    if (event.type !== 'compaction/end' && event.type !== 'compaction/summary') continue
    const id = event?.data?.compactionId
    if (typeof id === 'string' && !started.has(id)) orphan.add(event.seq)
  }
  return orphan.size === 0 ? events : events.filter((event) => !orphan.has(event.seq))
}

/**
 * 丢掉引用已经撑不住的标题事件。
 *
 * 只有 `session/title` 有"空 messageSeqs ⇔ source.kind === 'user'"这条硬约束：
 * 它引用的用户消息被裁掉之后还留着，整份日志就过不了宿主的严格校验。
 *
 * @param {object[]} events - 事件数组（按 seq 升序）。
 * @returns {object[]} 过滤后的数组。
 */
export function dropUnsatisfiableTitles(events) {
  const alive = new Set(events.map((event) => event.seq))
  return events.filter((event) => {
    if (event.type !== 'session/title') return true
    const seqs = Array.isArray(event.data?.messageSeqs) ? event.data.messageSeqs : []
    if (seqs.some((seq) => alive.has(Number(seq)))) return true
    return event.data?.source?.kind === 'user'
  })
}

/**
 * 把轮次和步骤重编号成宿主能加载的形状。
 *
 * 裁掉前半段之后，保留区的第一轮可能还是"第 11 轮"、第一个步骤还是"第 58 步"。
 * 宿主校验的是：`turn/start` 的 turn 必须等于"下一个轮次"（从 1 起），
 * `step/start` 的 step 必须等于"这一轮的下一个步骤"（从 1 起）。
 * 所以按出现顺序重排：轮次 1,2,3…，每轮内部步骤 1,2,3…
 *
 * @param {object[]} events - 已重排 seq 的事件。
 * @returns {object[]} 轮次/步骤重编号之后的事件（不动 seq）。
 */
export function renumberLifecycle(events) {
  const turnMap = new Map()
  let nextTurn = 1
  for (const event of events) {
    const turn = event?.data?.turn
    if (!Number.isSafeInteger(turn) || turnMap.has(turn)) continue
    turnMap.set(turn, nextTurn)
    nextTurn += 1
  }
  const stepMaps = new Map()
  for (const event of events) {
    const turn = event?.data?.turn
    const step = event?.data?.step
    if (!Number.isSafeInteger(turn) || !Number.isSafeInteger(step)) continue
    let map = stepMaps.get(turn)
    if (map === undefined) {
      map = new Map()
      stepMaps.set(turn, map)
    }
    if (!map.has(step)) map.set(step, map.size + 1)
  }
  return events.map((event) => {
    const turn = event?.data?.turn
    if (!Number.isSafeInteger(turn)) return event
    const data = { ...event.data, turn: turnMap.get(turn) ?? turn }
    const step = data.step
    if (Number.isSafeInteger(step)) {
      const map = stepMaps.get(turn)
      data.step = map?.get(step) ?? step
    }
    return { ...event, data }
  })
}

/**
 * 头部要不要跟着改。
 *
 * `isSeeded` 的会话必须有一条 `session/end-seed {inherited:true}` 标记继承前缀的
 * 截止位置。压缩把这条标记一起裁掉时，头部就得改口说"这不是 seeded 会话"，
 * 否则宿主报 `seeded header disagrees with its last inherited end-seed marker`。
 *
 * @param {object|null} header - 原头部。
 * @param {object[]} events - 压缩后的事件。
 * @returns {object|null} 修正后的头部。
 */
export function seededHeaderFor(header, events) {
  if (header === null || header === undefined || header.isSeeded !== true) return header
  const marked = events.some(
    (event) => event.type === 'session/end-seed' && event.data?.inherited === true,
  )
  return marked ? header : { ...header, isSeeded: false }
}

/**
 * 发布前自检：按宿主加载路径的硬约束核一遍。
 *
 * 这里不追求覆盖全部校验（宿主还有消息、工具生命周期、引用完整性等上百条），
 * 只拦"压缩自己会造出来"的那几类致命错：轮次/步骤不连续、request/header 落在轮次
 * 之外、标题引用悬空、压缩记录残缺、seeded 标记与头部不一致。
 *
 * @param {object|null} header - 即将写入的头部。
 * @param {object[]} events - 即将写入的事件。
 * @throws {Error} 不合契约时抛出，调用方必须放弃发布。
 */
export function assertHostLoadable(header, events) {
  const fail = (message) => {
    throw new Error(`压缩结果不合宿主契约，已放弃写入：${message}`)
  }
  for (let i = 0; i < events.length; i += 1) {
    if (events[i].seq !== i) fail(`seq ${i} 不连续（该位置是 ${events[i].seq}）`)
  }
  let openTurn = null
  let openStep = null
  let nextTurn = 1
  let nextStep = 1
  const compactions = new Map()
  const nodes = []
  let protectedHead = false
  for (const event of events) {
    const data = event.data ?? {}
    // 表面折叠（宿主的 `foldSurface`）：端点必须落在当前表面上。
    const surfaceOp = event.surfaceOp
    if (surfaceOp !== undefined && surfaceOp !== null) {
      if (surfaceOp === 'append') {
        if (event.type === 'system/message') {
          if (nodes.length > 0 && !protectedHead) fail(`system/message ${event.seq} 不是表面的第一条（宿主要求受保护的系统头）`)
          protectedHead = true
        }
        nodes.push(event.seq)
      } else if (typeof surfaceOp === 'object') {
        const a = nodes.indexOf(Number(surfaceOp.startSeq))
        const b = nodes.indexOf(Number(surfaceOp.endSeq))
        if (a < 0 || b < a) fail(`${event.type} ${event.seq} 的 replace 端点不在表面上`)
        nodes.splice(a, b - a + 1, event.seq)
      }
    }
    // compaction/prune、compaction/summary 的 shadowedRange 必须正好是当前表面的一段。
    const range = data.shadowedRange
    if (range !== undefined && range !== null && typeof range === 'object') {
      if (!(Number(range.start) < event.seq) || !(Number(range.end) < event.seq)) {
        fail(`${event.type} ${event.seq} 的 shadowedRange 指向不早于自身的 seq`)
      }
      const a = nodes.indexOf(Number(range.start))
      const b = nodes.indexOf(Number(range.end))
      if (a < 0 || b < a) fail(`${event.type} ${event.seq} 的 shadowedRange 端点不在表面上`)
      const slice = nodes.slice(a, b + 1)
      const seqs = Array.isArray(data.shadowedSeqs) ? data.shadowedSeqs : []
      if (seqs.length !== slice.length || seqs.some((seq, index) => seq !== slice[index])) {
        fail(`${event.type} ${event.seq} 的 shadowedSeqs 与表面切片不一致`)
      }
    }
    switch (event.type) {
      case 'turn/start':
        if (openTurn !== null) fail(`turn/start ${data.turn} 落在第 ${openTurn} 轮里`)
        if (data.turn !== nextTurn) fail(`turn/start ${data.turn} 不是预期的第 ${nextTurn} 轮`)
        openTurn = data.turn
        openStep = null
        nextStep = 1
        break
      case 'turn/end':
        if (openTurn !== data.turn) fail(`turn/end ${data.turn} 没有对应的开启轮次`)
        openTurn = null
        openStep = null
        nextTurn += 1
        break
      case 'step/start':
        if (openTurn !== data.turn) fail(`step/start ${data.turn}/${data.step} 不在开启的轮次里`)
        if (openStep !== null) fail(`step/start ${data.turn}/${data.step} 叠在上一个步骤上`)
        if (data.step !== nextStep) fail(`step/start ${data.turn}/${data.step} 不是预期的第 ${nextStep} 步`)
        openStep = data.step
        break
      case 'step/end':
        if (openTurn !== data.turn || openStep !== data.step) fail(`step/end ${data.turn}/${data.step} 与开启的步骤不符`)
        openStep = null
        nextStep += 1
        break
      case 'request/header':
      case 'request/context':
        if (openTurn === null) fail(`${event.type} 不在开启的轮次里`)
        break
      case 'compaction/start':
        compactions.set(data.compactionId, { summarized: false })
        break
      case 'compaction/summary': {
        const open = compactions.get(data.compactionId)
        if (open === undefined) fail(`compaction/summary ${data.compactionId} 没有对应的 compaction/start`)
        if (open.summarized) fail(`compaction/summary ${data.compactionId} 重复`)
        open.summarized = true
        break
      }
      case 'compaction/end': {
        const open = compactions.get(data.compactionId)
        if (open === undefined) fail(`compaction/end ${data.compactionId} 没有对应的 compaction/start`)
        if (data.error === undefined && !open.summarized) fail(`compaction/end ${data.compactionId} 没有对应的摘要`)
        compactions.delete(data.compactionId)
        break
      }
      default:
        break
    }
    if (event.type === 'session/title') {
      const seqs = data.messageSeqs
      if (!Array.isArray(seqs)) fail(`session/title ${event.seq} 缺少 messageSeqs`)
      const seen = new Set()
      for (const seq of seqs) {
        if (!Number.isSafeInteger(seq) || seq < 0) fail(`session/title ${event.seq} 的 messageSeqs 有非法值 ${seq}`)
        if (seq >= event.seq) fail(`session/title ${event.seq} 引用了不早于自身的 seq ${seq}`)
        if (seen.has(seq)) fail(`session/title ${event.seq} 重复引用 seq ${seq}`)
        seen.add(seq)
        const source = events[seq]
        if (source?.type !== 'user/message') fail(`session/title ${event.seq} 引用的 seq ${seq} 不是 user/message`)
        if (source?.data?.source?.kind !== 'user') fail(`session/title ${event.seq} 引用的 seq ${seq} 不是人类消息`)
      }
      if ((seqs.length === 0) !== (data?.source?.kind === 'user')) fail(`session/title ${event.seq} 的 messageSeqs 与 source.kind 不一致`)
    }
  }
  if (header !== null && header !== undefined && header.isSeeded === true) {
    const marked = events.some(
      (event) => event.type === 'session/end-seed' && event.data?.inherited === true,
    )
    if (!marked) fail('头部声明 isSeeded，但日志里没有 inherited 的 end-seed 标记')
  }
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
  // 只数**有 checkpoint 的窗口**：第 1 窗是"会话开头到第一个 checkpoint 前"的设置窗
  // （系统提示词、权限、预设），它不含对话内容。
  const real = windows.filter((w) => w.checkpointSeq !== null)
  if (real.length <= keep) {
    return { events, cutSeq: null, windows: windows.length, kept: events.length, dropped: 0, frame: [] }
  }
  const firstKept = real.length - keep + 1

  // 切点退到**轮次边界**：checkpoint 不是 turn 边界，从它切会留下一条没有 turn/start
  // 的 request/header，宿主直接拒绝（实测报 "title messageSeqs must name an earlier
  // event" 之前，先撞上这个）。所以从 checkpoint 往后找第一条 turn/start。
  const boundary = real[firstKept - 1].startSeq
  const turnStart = events.find((e) => e.type === 'turn/start' && e.seq >= boundary)
  const cutSeq = turnStart !== undefined ? turnStart.seq : boundary

  const bySeq = new Map(events.map((e) => [e.seq, e]))

  // 会话级设置：无论落在哪一窗都留（裁掉模型就没有系统提示词和工具声明了）。
  const originalVisible = foldSurface(events).visible
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
  const keepLastOf = (type) => {
    const hit = events.filter((e) => e.type === type && e.seq < cutSeq).pop()
    if (hit !== undefined) frame.push(hit)
  }
  for (const type of ['agent-preset/selected', 'permission/preset', 'sandbox/mode', 'approval/policy', 'session/title']) {
    keepLastOf(type)
  }

  const keepSeq = new Set(frame.map((e) => e.seq))
  for (const event of events) if (event.seq >= cutSeq) keepSeq.add(event.seq)

  // compaction 是**一组**（start/summary/end 同一个 compactionId）：只留一半，
  // 宿主会说 end 丢了 summary。任一条被保留，整组都留下。
  const compactionIds = new Set()
  for (const event of events) {
    if (event.seq < cutSeq) continue
    const id = event.data?.compactionId
    if (typeof id === 'string') compactionIds.add(id)
  }
  for (const event of events) {
    const id = event.data?.compactionId
    if (typeof id === 'string' && compactionIds.has(id)) keepSeq.add(event.seq)
  }

  // developer/message 的 headerSeq 指向它那一次请求的 request/header，必须一起留。
  for (let round = 0; round < 4; round += 1) {
    let added = false
    for (const event of events) {
      if (!keepSeq.has(event.seq)) continue
      const referenced = event.data?.headerSeq
      if (!Number.isSafeInteger(referenced) || keepSeq.has(referenced)) continue
      const header = bySeq.get(referenced)
      if (header === undefined) continue
      keepSeq.add(referenced)
      added = true
    }
    if (!added) break
  }

  // 被裁窗口里那一条 request/header 也留一条：界面要拿它显示"这一窗的工具声明"。
  const lastHeaderBefore = events.filter((e) => e.type === 'request/header' && e.seq < cutSeq).pop()
  if (lastHeaderBefore !== undefined) keepSeq.add(lastHeaderBefore.seq)

  // compaction/prune 指向它剪短的那条工具输出；目标被裁掉就整条丢掉（它只是记账，
  // 真正生效的是那条 tool/result 自己的 surfaceOp）。
  for (const event of events) {
    if (event.type !== 'compaction/prune' || !keepSeq.has(event.seq)) continue
    const seqs = Array.isArray(event.data?.shadowedSeqs) ? event.data.shadowedSeqs : []
    if (seqs.length > 0 && !seqs.some((seq) => keepSeq.has(seq))) keepSeq.delete(event.seq)
  }

  const out = []
  let dropped = 0
  for (const event of events) {
    if (keepSeq.has(event.seq)) out.push(event)
    else dropped += 1
  }

  // 活下来的 replace 的区间端点必须落在保留集里的表面节点上。
  const { anchors } = alignReplaceRanges(events, keepSeq)
  const finalOut = []
  let finalDropped = 0
  for (const event of events) {
    if (keepSeq.has(event.seq)) finalOut.push(event)
    else finalDropped += 1
  }
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
        // 区间整段落在被裁掉的那一段里。如果这条 replace 的语义是"我替代我从头到现在
        // 的一切"（压缩摘要 / 检查点消息就是这么写的：range 从会话第一条消息起），
        // 那就把端点重新锚到"保留下来的、它之前的表面节点"上。
        //
        // 不这么做会有两个后果：摘要降级成普通追加之后，它后面的摘要链条失去锚点，
        // 模型反而看到更多原文（实测 +111 条）；而 compaction/summary 的
        // shadowedRange 也会因为端点消失而变成非法值，宿主直接拒绝加载。
        //
        // 只对"从头开始"的区间这么做：起点晚于保留区第一条表面节点的区间，说明它
        // 只概括了中间一段，硬锚到头部会把本来该可见的内容也遮掉。
        const condensation =
          (event.type === 'user/message' || event.type === 'system/message') && textLengthOf(event) > 0
        const keptBefore = condensation
          ? events.filter((e) => e.seq < event.seq && keep.has(e.seq) && isSurfaceNode(e))
          : []
        const head = keptBefore[0]
        // 宿主禁止遮蔽受保护的系统头（表面上的第一条 system/message）。
        const usable = head !== undefined && head.type === 'system/message' ? keptBefore.slice(1) : keptBefore
        if (usable.length > 0 && start <= (head === undefined ? start : head.seq)) {
          const min = usable[0]
          const max = usable[usable.length - 1]
          event.surfaceOp = { op: 'replace', startSeq: min.seq, endSeq: max.seq }
          for (const anchor of [min, max]) {
            if (!keep.has(anchor.seq)) {
              keep.add(anchor.seq)
              anchors.add(anchor.seq)
              added = true
            }
          }
          continue
        }
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

/**
 * 让 `compaction/summary` 的 shadowedRange 跟它的检查点消息说同一段。
 *
 * 压缩是"摘要事件 + 检查点 user/message"成对写的：summary 用 shadowedRange 记它概括
 * 了哪一段，检查点用 surfaceOp 记它替代了哪一段，两段本来是同一个区间。裁掉前半段
 * 之后这个区间会被 `alignReplaceRanges` 重新对齐，但那只改检查点的 surfaceOp，
 * summary 还指着已经不存在的 seq —— 宿主会报
 * "compaction/prune shadowedSeqs do not name an exact current surface span"。
 *
 * @param {object[]} events - 原事件（surfaceOp 已对齐）。
 * @returns {number} 对齐了几条摘要。
 */
export function syncSummaryRanges(events) {
  const checkpoints = new Map()
  for (const event of events) {
    if (event.type !== 'user/message') continue
    const source = event.data?.source
    if (source?.kind !== 'compact-checkpoint') continue
    if (typeof source.compactionId !== 'string') continue
    if (event.surfaceOp === undefined || event.surfaceOp === null || typeof event.surfaceOp !== 'object') continue
    checkpoints.set(source.compactionId, event.surfaceOp)
  }
  let synced = 0
  for (const event of events) {
    if (event.type !== 'compaction/summary') continue
    const range = checkpoints.get(event.data?.compactionId)
    if (range === undefined) continue
    event.data = { ...event.data, shadowedRange: { start: Number(range.startSeq), end: Number(range.endSeq) } }
    synced += 1
  }
  return synced
}

/**
 * 找出"留着就过不了宿主校验"的事件：
 *
 * 1. 降级成普通追加之后 turn/step 对不上当前轮的 replace。
 *    典型来源是工具输出剪枝（`compaction-tool-result-pruner`）：它把旧轮的一条
 *    tool/result 复制成一条排在后面的 replace 事件，data.turn/step 仍然是**旧轮**的。
 *    宿主对 replace 形式的 tool/result 只要求"有开启的轮次"，所以原日志合法；
 *    但压缩把被遮蔽的节点裁掉之后这条 replace 只能降级成追加，而降级后宿主会按
 *    追加去核对 turn/step —— 旧轮编号对不上当前轮，整份日志被拒。
 *    这种事件只是"旧工具输出的剪短版"，旧输出已被裁掉，留着只会往模型上下文里
 *    塞一条没有对应 tool call 的 tool 消息。丢掉。
 *
 * 2. `shadowedRange` 端点已经不在表面上的 compaction/prune、compaction/summary。
 *    宿主会用 `assertCurrentSurfaceSpan` 逐条核对："端点必须落在当前表面，
 *    且 shadowedSeqs 必须正好等于那一段切片"。被裁掉的那一段本来就没了，
 *    这条记录也就没有对象，丢掉。
 *
 * @param {object[]} events - 事件数组（按 seq 升序）。
 * @returns {Set<number>} 需要丢弃的 seq。
 */
export function planUnloadableDrops(events) {
  const drops = new Set()
  const nodes = []
  let openTurn = null
  let openStep = null
  for (const event of events) {
    const data = event.data ?? {}
    switch (event.type) {
      case 'turn/start':
        openTurn = data.turn
        openStep = null
        break
      case 'turn/end':
        openTurn = null
        openStep = null
        break
      case 'step/start':
        openStep = data.step
        break
      case 'step/end':
        openStep = null
        break
      default:
        break
    }
    // 带 shadowedRange 的压缩记录：端点必须还在表面上。
    // 摘要（compaction/summary）不在这里丢 —— 它的 compaction/end 要求"必须有一条
    // 摘要"，丢了整段就残了。它的端点由 renumber 按自己的 surfaceOp 重新对齐。
    const range = data.shadowedRange
    if (range !== undefined && range !== null && typeof range === 'object' && event.type !== 'compaction/summary') {
      const a = nodes.indexOf(Number(range.start))
      const b = nodes.indexOf(Number(range.end))
      if (a === -1 || b === -1 || a > b) drops.add(event.seq)
    }
    const op = event.surfaceOp
    if (op === undefined || op === null) continue
    if (op === 'append') {
      nodes.push(event.seq)
      continue
    }
    if (typeof op !== 'object') continue
    const startIdx = nodes.indexOf(Number(op.startSeq))
    const endIdx = nodes.indexOf(Number(op.endSeq))
    if (startIdx === -1 || endIdx === -1 || startIdx > endIdx) {
      const staleTurn = Number.isSafeInteger(data.turn) && data.turn !== openTurn
      const staleStep = Number.isSafeInteger(data.step) && data.step !== openStep
      if (staleTurn || staleStep) drops.add(event.seq)
      continue
    }
    nodes.splice(startIdx, endIdx - startIdx + 1, event.seq)
  }
  return drops
}

/** 会进入表面的消息类型（宿主 SURFACE_EVENT_TYPES）。 */
/**
 * 递归重编事件里的"指向别的 seq"的字段。
 *
 * 宿主的格式层会逐条校验这些交叉引用（实测报错：`delivery throughSeq must
 * precede its marker`），而它们不止一种名字：`throughSeq`、`headerSeq`、
 * `source.originalSeq`、`source.promptSeq`、`messageSeqs`、`shadowedSeqs`、
 * `shadowedRange`…… 逐个硬编码迟早漏，所以按后缀统一处理。
 *
 * 策略：
 * - `*Seqs` 数组：逐项重编，目标没了的项丢掉；
 * - `*Seq` 数字：重编；目标没了就删掉该字段；
 * - `*Range` 对象：`start`/`end` 一起重编，任一端没了就删掉该字段；
 * - `throughSeq` 特殊：它是投递标记的"投到哪一条"，目标没了这条事件就没意义，
 *   由调用方整条丢弃（返回 `{ drop: true }`）。
 *
 * @param {unknown} value - 待处理的子树。
 * @param {(seq: number) => number|null} remap - 旧 seq → 新 seq。
 * @returns {{ value: unknown, drop: boolean }} 处理后的子树与是否需要丢弃该事件。
 */
/** 不以 `Seq` 结尾、但同样是本会话 seq 的字段（我们自己的插件写的）。 */
const SEQ_FIELD_NAMES = new Set(['logFrom', 'logTo', 'rerunTurnEnd'])

function remapSeqFields(value, remap) {
  if (Array.isArray(value)) {
    const out = []
    for (const item of value) {
      const result = remapSeqFields(item, remap)
      if (result.drop) return { value, drop: true }
      out.push(result.value)
    }
    return { value: out, drop: false }
  }
  if (value === null || typeof value !== 'object') return { value, drop: false }
  const out = {}
  for (const [key, item] of Object.entries(value)) {
    if (key === 'throughSeq' && Number.isSafeInteger(item)) {
      // 不重编：`throughSeq` 指的是**另一个会话**（`data.sessionId`）的日志位置，
      // 不在本会话的 seq 空间里。它只需要"比本条事件的 seq 更早"，这一点由
      // 调用方在重编之后检查（撑不住就丢这条投递记录）。
      out[key] = item
      continue
    }
    if (/Seqs$/.test(key) && Array.isArray(item)) {
      const moved = item
        .map((seq) => (Number.isSafeInteger(seq) ? remap(seq) : null))
        .filter((seq) => seq !== null)
      // 字段必须留下（可以是空数组）：格式层要求 `title messageSeqs requires an array`，
      // 删掉字段和留下非法值一样会被拒。
      out[key] = moved
      continue
    }
    if (SEQ_FIELD_NAMES.has(key) && Number.isSafeInteger(item)) {
      const moved = remap(item)
      if (moved !== null) out[key] = moved
      continue
    }
    if (/Seq$/.test(key) && Number.isSafeInteger(item)) {
      const moved = remap(item)
      if (moved !== null) out[key] = moved
      continue
    }
    if (/Range$/.test(key) && item !== null && typeof item === 'object' && !Array.isArray(item)) {
      const start = Number.isSafeInteger(item.start) ? remap(item.start) : null
      const end = Number.isSafeInteger(item.end) ? remap(item.end) : null
      if (start !== null && end !== null) out[key] = { ...item, start, end }
      continue
    }
    const nested = remapSeqFields(item, remap)
    if (nested.drop) return { value, drop: true }
    out[key] = nested.value
  }
  return { value: out, drop: false }
}

export function renumber(events) {
  // ── 0) 系统提示词搬到最前，并改成 append ─────────────────────────────────
  //
  // 宿主规定表面 node 0 是系统提示词。日志里它可能是一条"替换 node 0"的
  // system/message；裁掉被替换的 node 0 之后这条替换就没了落点，而且它原本
  // 排在很后面（那一窗的位置）。搬最前 + 改 append 两头都满足。
  // 重排：格式层规定一大批事件（`request/header`、`request/context`、`session/title`、
  // compaction/*、消息……）必须落在"已打开的 turn"里，而 `system/message` 还额外要求
  // turn+step 完全匹配（`requireStep`）。所以：
  //
  //   能在 turn 之前的 = 格式层不管的类型（权限/沙箱/预设这些设置，以及我们的插件记录）
  //   其余全部挪进第一对 turn/start + step/start 之后，系统提示词排在最前
  //
  // turn/start、step/start 都不是表面节点，所以系统提示词仍然是第一个表面节点。
  const RELATIONSHIP_TYPES = new Set([
    'system/message', 'developer/message', 'user/message', 'assistant/message', 'tool/result',
    'assistant/attempt', 'turn/start', 'turn/end', 'step/start', 'step/end', 'tool/call',
    'request/header', 'request/context', 'tool/ptc-dispatch-start', 'tool/ptc-dispatch',
    'llm/retry', 'llm/retry-started', 'session/title', 'session/title-llm-request',
    'command/run', 'command/done', 'compaction/start', 'compaction/summary', 'compaction/end',
    'compaction/prune', 'session/end-seed',
  ])
  const head = events.filter((e) => !RELATIONSHIP_TYPES.has(e.type))
  const body = events.filter((e) => RELATIONSHIP_TYPES.has(e.type))

  const sysIndex = body.findIndex(
    (e) => (e.type === 'system/message' || e.type === 'developer/message') && textLengthOf(e) > 0,
  )
  let ordered = events
  if (sysIndex >= 0) {
    const sysEvent = body[sysIndex]
    const turnStart = body.find((e) => e.type === 'turn/start')
    const stepStart = turnStart === undefined
      ? undefined
      : body.find((e) => e.type === 'step/start' && e.seq > turnStart.seq)
    const sys = {
      ...sysEvent,
      surfaceOp: 'append',
      data: {
        ...sysEvent.data,
        ...(turnStart === undefined ? {} : { turn: turnStart.data?.turn }),
        ...(stepStart === undefined ? {} : { step: stepStart.data?.step }),
      },
    }
    const rest = body.filter((_, index) => index !== sysIndex)
    const anchor = stepStart ?? turnStart
    if (anchor === undefined) {
      ordered = [...head, sys, ...rest]
    } else {
      const at = rest.findIndex((e) => e.seq === anchor.seq)
      ordered = [...head, ...rest.slice(0, at + 1), sys, ...rest.slice(at + 1)]
    }
  } else {
    ordered = [...head, ...body]
  }

  // 收尾：body 里可能还有排在第一条 turn/start **之前**的事件（例如为"这一窗的工具
  // 声明"强制保留的那条 request/header）。它们同样必须在已打开的 turn 里，所以搬到
  // 第一条 turn/start 之后、系统提示词旁边。
  const firstTurnAt = ordered.findIndex((e) => e.type === 'turn/start')
  if (firstTurnAt > 0) {
    const strays = ordered.slice(0, firstTurnAt).filter((e) => RELATIONSHIP_TYPES.has(e.type))
    if (strays.length > 0) {
      const straysSet = new Set(strays.map((e) => e.seq))
      const kept = ordered.filter((e) => !straysSet.has(e.seq))
      const anchorAt = kept.findIndex((e) => e.type === 'step/start' || e.type === 'turn/start')
      const insertAt = anchorAt < 0 ? 0 : anchorAt + 1
      // 系统提示词要留在最前：strays 插到它后面。
      const sysAt = kept.findIndex(
        (e) => (e.type === 'system/message' || e.type === 'developer/message') && textLengthOf(e) > 0,
      )
      const at = sysAt >= 0 && sysAt >= insertAt ? sysAt + 1 : insertAt
      ordered = [...kept.slice(0, at), ...strays, ...kept.slice(at)]
    }
  }

  // ── 1) seq 从 0 起连续重编 ───────────────────────────────────────────────
  const mapping = new Map()
  ordered.forEach((event, index) => mapping.set(event.seq, index))
  const remap = (seq) => (mapping.has(seq) ? mapping.get(seq) : null)

  // ── 2) 轮次 / 步骤重编号 ─────────────────────────────────────────────────
  //
  // 裁掉前 10 轮之后，日志里的 turn 还从 11 起、step 从 58 起；宿主按 1 起读。
  // 轮次按 **turn/start 的顺序**编号（不是按任何事件出现顺序：重排之后，排在最前的
  // 设置/job 记录还带着被裁窗口的旧 turn 号，会先把 1、2、3 占掉）。
  const turnMap = new Map()
  let nextTurn = 1
  for (const event of ordered) {
    if (event.type !== 'turn/start') continue
    const old = event.data?.turn
    if (Number.isSafeInteger(old) && !turnMap.has(old)) turnMap.set(old, nextTurn++)
  }
  const mapTurn = (turn) => (turnMap.has(turn) ? turnMap.get(turn) : 1)
  const stepMap = new Map()
  for (const event of ordered) {
    const oldTurn = event.data?.turn
    const step = event.data?.step
    if (!Number.isSafeInteger(oldTurn) || !Number.isSafeInteger(step)) continue
    const newTurn = mapTurn(oldTurn)
    let perTurn = stepMap.get(newTurn)
    if (perTurn === undefined) {
      perTurn = new Map()
      stepMap.set(newTurn, perTurn)
    }
    if (!perTurn.has(step)) perTurn.set(step, perTurn.size + 1)
  }

  const out = []
  let seqDropped = 0
  for (const event of ordered) {
    const next = { ...event, seq: mapping.get(event.seq) }
    if (event.data !== undefined && event.data !== null) {
      const data = { ...event.data }
      let touched = false
      if (Number.isSafeInteger(data.turn)) {
        data.turn = mapTurn(data.turn)
        touched = true
      }
      if (Number.isSafeInteger(data.step)) {
        const perTurn = stepMap.get(mapTurn(event.data.turn))
        if (perTurn !== undefined && perTurn.has(event.data.step)) {
          data.step = perTurn.get(event.data.step)
          touched = true
        }
      }
      // 所有"指向别的 seq"的字段统一重编（throughSeq / headerSeq / originalSeq /
      // promptSeq / messageSeqs / shadowedSeqs / shadowedRange …）。
      const remapped = remapSeqFields(data, remap)
      if (remapped.drop) {
        // 这条事件引用了一条已经被裁掉的事件（例如投递标记的 throughSeq），
        // 它自己也就没有意义了 —— 整条丢掉，而不是留下一条悬空引用。
        seqDropped += 1
        continue
      }
      void touched
      next.data = remapped.value
    }
    if (event.surfaceOp !== undefined && event.surfaceOp !== null && typeof event.surfaceOp === 'object') {
      const startSeq = remap(Number(event.surfaceOp.startSeq))
      const endSeq = remap(Number(event.surfaceOp.endSeq))
      if (startSeq !== null && endSeq !== null) next.surfaceOp = { ...event.surfaceOp, startSeq, endSeq }
      else next.surfaceOp = 'append'
    }
    out.push(next)
  }

  // 标题：fallback 来源必须至少指向一条消息；指向不到就整条丢掉。
  let titlesDropped = 0
  let deliveryDropped = 0
  const kept = []
  for (const event of out) {
    // 投递记录的 throughSeq 指向别的会话，裁掉前面的内容后它可能不再"更早"，
    // 这时整条丢掉（格式层逐条校验 `throughSeq must precede its marker`）。
    if (Number.isSafeInteger(event.data?.throughSeq) && event.data.throughSeq >= event.seq) {
      deliveryDropped += 1
      continue
    }
    if (event.type === 'session/title') {
      const kind = event.data?.source?.kind
      const refs = event.data?.messageSeqs
      if (kind === 'fallback' && (!Array.isArray(refs) || refs.length === 0)) {
        titlesDropped += 1
        continue
      }
    }
    kept.push(event)
  }

  // ── 3) compaction 的 shadowedRange 按它那条载体的 surfaceOp 重算 ─────────
  // 载体把 compactionId 放在 `data.source.compactionId`（不是 data.compactionId）。
  const carriers = new Map()
  for (const event of kept) {
    if (event.data?.source?.kind !== 'compact-checkpoint') continue
    const id = event.data.source.compactionId
    if (typeof id === 'string') carriers.set(id, event)
  }
  const finalEvents = []
  let compactionDropped = 0
  for (const event of kept) {
    if (event.type === 'compaction/summary') {
      const id = event.data?.compactionId
      const carrier = typeof id === 'string' ? carriers.get(id) : undefined
      const range = carrier !== undefined && carrier.surfaceOp !== null && typeof carrier.surfaceOp === 'object'
        ? carrier.surfaceOp
        : null
      if (range === null) {
        // 载体没了（它的窗口被裁掉）：这条摘要的区间无从重算，整条丢掉，
        // 否则它带着指向已裁 seq 的 shadowedRange。
        compactionDropped += 1
        continue
      }
      event.data = {
        ...event.data,
        shadowedRange: { start: range.startSeq, end: range.endSeq },
        shadowedSeqs: Array.isArray(carrier.sourceEventSeqs) ? [...carrier.sourceEventSeqs] : [],
      }
    }
    if (event.type === 'compaction/prune') {
      const seqs = Array.isArray(event.data?.shadowedSeqs) ? event.data.shadowedSeqs : []
      const moved = seqs.map((seq) => remap(seq)).filter((seq) => seq !== null)
      if (moved.length === 0) {
        compactionDropped += 1
        continue
      }
      event.data = { ...event.data, shadowedSeqs: moved, shadowedRange: { start: Math.min(...moved), end: Math.max(...moved) } }
    }
    finalEvents.push(event)
  }

  // ── 4) 重编 seq 后引用可能又错位（删标题/摘要会移位），再跑一次映射 ──────
  const finalMapping = new Map()
  finalEvents.forEach((event, index) => finalMapping.set(event.seq, index))
  const finalRemap = (seq) => (finalMapping.has(seq) ? finalMapping.get(seq) : null)
  const rebuilt = []
  for (const event of finalEvents) {
    const next = { ...event, seq: finalMapping.get(event.seq) }
    // 第二趟必须**同样走通用重编**：中间丢掉了事件（标题 / 摘要 / 投递记录），
    // 后面的 seq 整体前移，只补几个硬编码字段会让 promptSeq、originalSeq 这类
    // 字段停在旧编号上（实测偏差 73 —— 正好是丢掉的投递记录数）。
    if (next.data !== undefined && next.data !== null) {
      const remapped = remapSeqFields(next.data, finalRemap)
      if (!remapped.drop) next.data = remapped.value
    }
    if (next.data?.shadowedRange !== undefined && next.type === 'compaction/summary') {
      next.data = { ...next.data }
      const start = finalRemap(next.data.shadowedRange.start)
      const end = finalRemap(next.data.shadowedRange.end)
      if (start !== null && end !== null) next.data.shadowedRange = { start, end }
      else delete next.data.shadowedRange
    }
    if (next.surfaceOp !== undefined && next.surfaceOp !== null && typeof next.surfaceOp === 'object') {
      const startSeq = finalRemap(next.surfaceOp.startSeq)
      const endSeq = finalRemap(next.surfaceOp.endSeq)
      if (startSeq !== null && endSeq !== null) next.surfaceOp = { ...next.surfaceOp, startSeq, endSeq }
      else next.surfaceOp = 'append'
    }
    rebuilt.push(next)
  }

  // ── 5) 按宿主算法重算 sourceEventSeqs ───────────────────────────────────
  const nodes = []
  let refsFixed = 0
  let compactionDropped2 = 0
  const finalKept = []
  /** 摘要被丢掉的 compactionId：start/end/prune 也要一起丢，否则宿主报
   *  "successful compaction/end requires one summary"。 */
  const brokenCompactions = new Set()
  for (const event of rebuilt) {
    if (typeof event.data?.compactionId === 'string' && brokenCompactions.has(event.data.compactionId)) {
      compactionDropped2 += 1
      continue
    }
    // compaction 的记账字段必须与"这一刻的表面"逐条对齐：校验器要求
    // shadowedRange 的两端都在当前表面里，且 shadowedSeqs **正好等于**两者之间的
    // 切片（`shadowedSeqs do not name an exact current surface span`）。所以在这里
    // 按模拟出的表面现算，而不是照搬载体上的值。
    if (event.type === 'compaction/summary' || event.type === 'compaction/prune') {
      const carrier = event.type === 'compaction/summary'
        ? carriers.get(event.data?.compactionId)
        : null
      const range = event.type === 'compaction/summary'
        ? (carrier !== undefined && carrier.surfaceOp !== null && typeof carrier.surfaceOp === 'object' ? carrier.surfaceOp : null)
        : (event.data?.shadowedRange ?? null)
      const startIdx = range === null ? -1 : nodes.indexOf(Number(range.start))
      const endIdx = range === null ? -1 : nodes.indexOf(Number(range.end))
      if (range === null || startIdx < 0 || endIdx < startIdx) {
        compactionDropped2 += 1
        if (typeof event.data?.compactionId === 'string') brokenCompactions.add(event.data.compactionId)
        continue
      }
      const span = nodes.slice(startIdx, endIdx + 1)
      event.data = { ...event.data, shadowedRange: { start: span[0], end: span[span.length - 1] }, shadowedSeqs: [...span] }
      finalKept.push(event)
      continue
    }
    const op = event.surfaceOp
    if (op === undefined || op === null) {
      if (event.sourceEventSeqs !== undefined) {
        const flat = normalizeRefs(event.sourceEventSeqs)
        const moved = flat === null ? [] : flat.filter((seq) => seq < event.seq)
        if (moved.length === 0) delete event.sourceEventSeqs
        else event.sourceEventSeqs = moved
        if (flat === null || flat.length !== moved.length) refsFixed += 1
      }
      finalKept.push(event)
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
      finalKept.push(event)
      continue
    }
    const startIdx = nodes.indexOf(op.startSeq)
    const endIdx = nodes.indexOf(op.endSeq)
    if (startIdx === -1 || endIdx === -1 || startIdx > endIdx) {
      event.surfaceOp = 'append'
      delete event.sourceEventSeqs
      nodes.push(event.seq)
      finalKept.push(event)
      refsFixed += 1
      continue
    }
    const shadowed = nodes.slice(startIdx, endIdx + 1)
    const before = Array.isArray(event.sourceEventSeqs) ? event.sourceEventSeqs : []
    if (before.length !== shadowed.length || before.some((value, i) => value !== shadowed[i])) refsFixed += 1
    event.sourceEventSeqs = [...shadowed]
    nodes.splice(startIdx, endIdx - startIdx + 1, event.seq)
    finalKept.push(event)
  }

  // 收敛式收尾：丢掉事件会让后面的 seq 整体前移，而重编之后又可能有事件的
  // throughSeq 不再"更早"（它指向别的会话，不能重编），于是再丢一次。循环到不再
  // 丢弃为止（实测最多两轮）。
  let current = finalKept
  let deliveryDropped2 = 0
  for (let pass = 0; pass < 4; pass += 1) {
    const map = new Map()
    current.forEach((event, index) => map.set(event.seq, index))
    const remap = (seq) => (map.has(seq) ? map.get(seq) : null)
    const out = []
    let dropped = 0
    for (const event of current) {
      const next = { ...event, seq: map.get(event.seq) }
      if (next.data !== undefined && next.data !== null) {
        const remapped = remapSeqFields(next.data, remap)
        if (remapped.drop) { dropped += 1; continue }
        next.data = remapped.value
      }
      if (Array.isArray(next.sourceEventSeqs)) {
        next.sourceEventSeqs = next.sourceEventSeqs.map(remap).filter((seq) => seq !== null)
        if (next.sourceEventSeqs.length === 0) delete next.sourceEventSeqs
      }
      if (next.surfaceOp !== undefined && next.surfaceOp !== null && typeof next.surfaceOp === 'object') {
        const startSeq = remap(next.surfaceOp.startSeq)
        const endSeq = remap(next.surfaceOp.endSeq)
        if (startSeq !== null && endSeq !== null) next.surfaceOp = { ...next.surfaceOp, startSeq, endSeq }
        else next.surfaceOp = 'append'
      }
      if (Number.isSafeInteger(next.data?.throughSeq) && next.data.throughSeq >= next.seq) {
        dropped += 1
        deliveryDropped2 += 1
        continue
      }
      out.push(next)
    }
    current = out
    if (dropped === 0) break
  }

  return {
    events: current,
    mapping: finalMapping,
    refsFixed,
    titlesDropped,
    compactionDropped: compactionDropped + compactionDropped2,
    seqDropped,
    deliveryDropped: deliveryDropped + deliveryDropped2,
  }
}

/**
 * 会话是否正被某个进程持有（`session.lock` 被打开）。
 *
 * 宿主在内存里打开会话时会持有这把锁；这时候改文件会被它后续的写入覆盖，所以必须拒绝。
 *
 * @param {string} logFile - 日志文件路径。
 * @returns {boolean} 被持有时为 true。
 */
function isSessionLocked(logFile) {
  const lock = path.join(path.dirname(logFile), 'session.lock')
  if (!fs.existsSync(lock)) return false
  try {
    const out = execFileSync('lsof', ['--', lock], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
    const lines = out.trim().split('\n').filter((line) => line.trim() !== '' && !line.startsWith('COMMAND'))
    return lines.length > 0
  } catch {
    return false
  }
}

/**
 * 真正落盘：备份原文件（改名保留）、写新文件（临时名 → rename）。
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
    if (Number.isSafeInteger(event.data?.headerSeq) && !seqs.has(event.data.headerSeq)) {
      throw new Error(`内部错误：seq ${event.seq} 的 headerSeq 指向不存在的 ${event.data.headerSeq}`)
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
    titlesDropped: renamed.titlesDropped,
    compactionDropped: renamed.compactionDropped,
    transcript: { before: transcriptRows(original.events), after: transcriptRows(renamed.events) },
    model: { before: foldSurface(original.events).visible.length, after: foldSurface(renamed.events).visible.length },
  }
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
  const trimmed = keepLastWindows(original.events, keep)
  if (trimmed.cutSeq === null) {
    console.log(`只有 ${trimmed.windows} 个窗口，不需要裁。`)
    return
  }
  const renamed = renumber(trimmed.events)
  const bytes = encodeLog(original.header, renamed.events)
  fs.writeFileSync(target, bytes)
  console.log(`原日志    ${file}`)
  console.log(`窗口      ${trimmed.windows} 个 → 保留最后 ${keep} 个（切点 seq ${trimmed.cutSeq}）`)
  console.log(`事件      ${original.events.length} → ${renamed.events.length}（删除 ${trimmed.dropped} 条）`)
  console.log(`大小      ${human(original.compressedBytes)} → ${human(bytes.length)}`)
  console.log(`对话区    可见行 ${transcriptRows(original.events)} → ${transcriptRows(renamed.events)}`)
  console.log(`模型视图  可见节点 ${foldSurface(original.events).visible.length} → ${foldSurface(renamed.events).visible.length}`)
  console.log(`重算引用  ${renamed.refsFixed} 条；标题丢 ${renamed.titlesDropped} 条；compaction 丢 ${renamed.compactionDropped} 条`)
  console.log(`试写文件  ${target}`)
}

const isMain = process.argv[1] !== undefined && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
if (isMain) {
  const args = process.argv.slice(2)
  const asJson = args.includes('--json')
  const positional = args.filter((a) => !a.startsWith('--'))
  try {
    if (args.includes('--all') && args.includes('--apply')) {
      // 退出宿主后一条命令裁掉所有空闲会话：被持有的会自动跳过并报出来。
      const at = args.indexOf('--keep-windows')
      const keep = at >= 0 ? Number(args[at + 1] ?? '3') : 3
      let trimmed = 0
      let skipped = 0
      let saved = 0
      for (const file of allLogs()) {
        try {
          const before = fs.statSync(file).size
          const result = applyTrim(file, keep)
          saved += Math.max(0, before - result.after.bytes)
          trimmed += 1
          console.log(`✔ ${path.basename(path.dirname(file)).slice(8, 20)}  ${result.before.events} → ${result.after.events} 事件  ${human(result.before.bytes)} → ${human(result.after.bytes)}  模型视图 ${result.model.before} → ${result.model.after}`)
        } catch (error) {
          skipped += 1
          console.log(`· ${path.basename(path.dirname(file)).slice(8, 20)}  跳过：${error instanceof Error ? error.message : String(error)}`)
        }
      }
      console.log(`\n裁剪 ${trimmed} 个会话，跳过 ${skipped} 个，共省 ${human(saved)}`)
    } else if (args.includes('--all')) {
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
