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
  const starts = frameOffsets(buf)
  let text = ''
  for (let k = 0; k < starts.length; k += 1) {
    const end = k + 1 < starts.length ? starts[k + 1] : buf.length
    try {
      text += zlib.zstdDecompressSync(buf.subarray(starts[k], end)).toString('utf8')
    } catch {
      // 一帧坏了不该毁掉整个文件：跳过它，后面的帧照读。
    }
  }
  return parseLog(text, buf.length)
}

/**
 * 异步版 readLog：解压照旧同步（每帧几毫秒），但每 64 帧、每 2000 行让出一次
 * 事件循环。
 *
 * 这里刻意没用 zstd 的异步 API：日志是千帧级的多帧文件，一帧一次线程池往返
 * 反而更慢（18 MB 的日志 4.7 秒变 11.7 秒）。真正要的是"别一口气按住宿主"，
 * 分片让出就够了。
 *
 * @param {string} file - 日志文件路径。
 * @returns {Promise<{ events: object[], rawBytes: number, compressedBytes: number, header: object|null }>}
 */
export async function readLogAsync(file) {
  const buf = await fs.promises.readFile(file)
  const starts = frameOffsets(buf)
  const parts = []
  for (let k = 0; k < starts.length; k += 1) {
    const end = k + 1 < starts.length ? starts[k + 1] : buf.length
    try {
      parts.push(zlib.zstdDecompressSync(buf.subarray(starts[k], end)))
    } catch {
      // 同上：坏帧跳过。
    }
    if (k % 64 === 63) await yieldLoop()
  }
  return parseLogAsync(Buffer.concat(parts).toString('utf8'), buf.length)
}

/** 让出一次事件循环尾巴上的活。 */
function yieldLoop() {
  return new Promise((resolve) => setImmediate(resolve))
}

/** 按魔数切出每一帧的起点。 */
function frameOffsets(buf) {
  const starts = []
  for (let i = 0; i + 4 <= buf.length; i += 1) {
    if (buf[i] === 0x28 && buf[i + 1] === 0xb5 && buf[i + 2] === 0x2f && buf[i + 3] === 0xfd) starts.push(i)
  }
  return starts
}

/** 把拼好的 JSONL 文本拆成头部与事件。 */
function parseLog(text, compressedBytes) {
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
  return { events, rawBytes, compressedBytes, header }
}

/** parseLog 的异步版：每 2000 行让出一次，避免一次 JSON.parse 把界面卡住。 */
async function parseLogAsync(text, compressedBytes) {
  const events = []
  let rawBytes = 0
  let header = null
  let cursor = 0
  let seen = 0
  while (cursor < text.length) {
    const breakAt = text.indexOf('\n', cursor)
    const end = breakAt === -1 ? text.length : breakAt
    const line = text.slice(cursor, end)
    cursor = end + 1
    if (line.trim() !== '') {
      rawBytes += Buffer.byteLength(line, 'utf8') + 1
      let event
      try {
        event = JSON.parse(line)
      } catch {
        event = undefined
      }
      if (event !== undefined) {
        if (header === null && event.type === 'session') header = event
        else events.push(event)
      }
    }
    seen += 1
    if (seen % 2000 === 0) await yieldLoop()
  }
  return { events, rawBytes, compressedBytes, header }
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
const KEEP_ALWAYS = ['compaction/', 'session/', 'goal/']

/**
 * 目标事件：`goal/change` 与带 goal source 的轮次。
 *
 * 目标投影折叠的是**整份日志**（包括已被 replace 遮蔽的历史），所以"模型看不见的
 * 事件就能删"这条规则对它不成立：少一条 goal/change 或少一轮，后面的轮次就全成了
 * 孤儿，该会话的 /goal 从此永久报 "goal replay failed"。
 *
 * @param {object} event - 一条日志事件。
 * @returns {boolean} 是否属于目标。
 */
function isGoalEvent(event) {
  if (event === null || typeof event !== 'object') return false
  if (event.type === 'goal/change') return true
  return event.type === 'user/message' && event.data?.source?.kind === 'goal'
}

/**
 * 任何会让目标事件变少的裁剪都必须放弃：目标语义不在宿主的格式校验里，
 * 写下去就是一整份"能装得上、但 /goal 永久失败"的日志。
 *
 * @param {object[]} original - 裁剪前的日志事件。
 * @param {object[]} kept - 准备写入的事件。
 * @throws {Error} 会删掉目标事件时抛出。
 */
export function assertNoGoalEventsDropped(original, kept) {
  let before = 0
  for (const event of original) if (isGoalEvent(event)) before += 1
  if (before === 0) return
  let after = 0
  for (const event of kept) if (isGoalEvent(event)) after += 1
  if (after >= before) return
  throw new Error(
    `压缩会删掉 ${before - after} 条目标事件（goal/change 或目标轮次）；` +
      '目标投影从整份日志折叠，删掉任何一条都会让该会话的 /goal 永久失败，已放弃这次写入',
  )
}

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
  const frames = []
  for (const chunkLines of frameLines(header, events)) {
    // 和宿主一致：每帧独立可解、带校验和（宿主的 scanZstdFrames 按帧头判断）。
    frames.push(
      zlib.zstdCompressSync(Buffer.from(chunkLines.join('\n') + '\n', 'utf8'), {
        params: { [zlib.constants.ZSTD_c_checksumFlag]: 1 },
      }),
    )
  }
  return Buffer.concat(frames)
}

/**
 * 异步版 encodeLog：帧结构与上面逐字节相同（头部一帧，其余每 256 条一帧），
 * 只是每帧之间让出一次事件循环。
 *
 * @param {object|null} header - 头部记录。
 * @param {object[]} events - 事件。
 * @returns {Promise<Buffer>} 文件内容。
 */
export async function encodeLogAsync(header, events) {
  const frames = []
  const push = async (lines) => {
    if (lines.length === 0) return
    frames.push(
      zlib.zstdCompressSync(Buffer.from(lines.join('\n') + '\n', 'utf8'), {
        params: { [zlib.constants.ZSTD_c_checksumFlag]: 1 },
      }),
    )
    await yieldLoop()
  }
  if (header !== null) await push([JSON.stringify(header)])
  for (let index = 0; index < events.length; index += 256) {
    await push(events.slice(index, index + 256).map((event) => JSON.stringify(event)))
  }
  return Buffer.concat(frames)
}

/** 头部单独一帧，其余每 256 条一帧：和官方一样是多帧结构。 */
function frameLines(header, events) {
  const lines = []
  if (header !== null) lines.push(JSON.stringify(header))
  for (const event of events) lines.push(JSON.stringify(event))
  return [lines.slice(0, 1), ...chunk(lines.slice(1), 256)].filter((chunkLines) => chunkLines.length > 0)
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
 * 一个检查点保留的尾巴从哪开始。
 *
 * 检查点用 `surfaceOp: { startSeq, endSeq }` 替换掉旧区间，**替换之后的那些单元
 * 才是这一窗留给模型的尾巴**——它们的 seq 比检查点自己的 seq 小。所以一窗的边界
 * 是 `endSeq + 1`，不是检查点的 seq；从检查点切会把这截尾巴一起切掉。
 *
 * 不是检查点（没有区间），或者这个 seq 根本不在日志里，就返回它自己：调用方
 * 只关心"往后找第一条 turn/start"。
 *
 * @param {object[]} events - 原事件（不含头部）。
 * @param {number} checkpointSeq - 检查点事件的 seq。
 * @returns {number} 这一窗尾巴的起始 seq。
 */
export function checkpointTailStart(events, checkpointSeq) {
  const checkpoint = events.find((event) => event.seq === checkpointSeq)
  const op = checkpoint?.surfaceOp
  if (op === null || op === undefined || typeof op !== 'object') return checkpointSeq
  if (!Number.isSafeInteger(op.endSeq)) return checkpointSeq
  return op.endSeq + 1
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
function viewParts(events) {
  const bySeq = new Map(events.map((event) => [event.seq, event]))
  const visible = foldSurface(events).visible
  const dialog = []
  const system = []
  for (const seq of visible) {
    const event = bySeq.get(seq)
    const signature = event === undefined
      ? 'missing:' + seq
      : event.type + '\u0000' + JSON.stringify(event.data === undefined || event.data === null ? null : event.data.message ?? null)
    // 会话级设置（system/developer）在 `renumber` 里会被物理搬到日志最前
    // （宿主要求表面 node 0 是系统提示词），所以它们的位置在裁剪前后必然不同。
    if (event !== undefined && (event.type === 'system/message' || event.type === 'developer/message')) system.push(signature)
    else dialog.push(signature)
  }
  return { visible, dialog, system }
}

function sameVisible(left, right) {
  // 对话必须**逐条同位置**：模型读的是对话顺序，顺序变了就是内容变了。
  if (left.dialog.length !== right.dialog.length) return false
  for (let index = 0; index < left.dialog.length; index += 1) {
    if (left.dialog[index] !== right.dialog[index]) return false
  }
  // 系统提示词只比内容多重集，而且**允许产物比原视图多**：`renumber` 第 0 步会把
  // 一条 `system/message` 搬到日志最前并改成 `append`（宿主规定表面第 0 位必须是
  // 受保护的系统提示词），而那条在原日志里往往是被 checkpoint 遮蔽的 —— 于是原视图
  // 里 0 条、产物里 1 条。这不是"内容变了"，是把合法副本摆到了宿主要求的位置上。
  // 要求两边条数相等，等于让所有「原视图没有 system」的会话永远裁不动
  // （实测 session-9c6d39ac：9 个窗口、45419 条，每次都被这条闸门撤销）。
  // 所以判据是「原视图的每一条 system 都在产物里」，多出来的那条放行。
  if (right.system.length < left.system.length) return false
  const remaining = [...right.system].sort()
  for (const signature of [...left.system].sort()) {
    const at = remaining.indexOf(signature)
    if (at < 0) return false
    remaining.splice(at, 1)
  }
  return true
}

export function keepLastWindows(events, keep) {
  // 闸门要比的是「**原始**日志的模型视图」。`alignReplaceRanges` 会就地改写
  // `events` 里的 surfaceOp，改完之后再 fold 出来的视图已经不是原日志的视图了 ——
  // 拿它当基准等于让受检者给自己打分：实测 25515ab4 因此被误判（重锚后 594 条 vs
  // 真实的 593 条），整次裁剪被撤销，cutSeq 返回 null，界面却还在说"该裁、能丢 54%"。
  // 快照只用于闸门，后面的计算仍然在 `events` 上做（那份会被就地改）。
  const gateEvents = structuredClone(events)
  const windows = windowsOf(events)
  // 只数**有 checkpoint 的窗口**：第 1 窗是"会话开头到第一个 checkpoint 前"的设置窗
  // （系统提示词、权限、预设），它不含对话内容。
  const real = windows.filter((w) => w.checkpointSeq !== null)
  if (real.length <= keep) {
    return { events, cutSeq: null, windows: windows.length, realWindows: real.length, kept: events.length, dropped: 0, frame: [] }
  }
  const firstKept = real.length - keep + 1

  // 切点退到**轮次边界**：checkpoint 不是 turn 边界，从它切会留下一条没有 turn/start
  // 的 request/header，宿主直接拒绝（实测报 "title messageSeqs must name an earlier
  // event" 之前，先撞上这个）。所以从 checkpoint 往后找第一条 turn/start。
  //
  // 边界是**检查点保留的尾巴起点**，不是检查点自己：一条 checkpoint 用
  // `surfaceOp: { startSeq, endSeq }` 替换掉旧区间，紧接着那些"没被替换"的单元
  // 就是这一窗真正留给模型的尾巴——它们的 seq 比 checkpoint 自己的 seq 还小。
  // 从 checkpoint 切会把这些尾巴一起切掉，模型立刻少读一窗内容。
  const boundary = checkpointTailStart(events, real[firstKept - 1].checkpointSeq)
  // 往回退到整轮起点，不往前找：往前会把这一轮的前半截连同尾巴一起切走。
  const cutSeq = snapToTurnStart(events, boundary)

  const bySeq = new Map(events.map((e) => [e.seq, e]))

  // 会话级设置：无论落在哪一窗都留（裁掉模型就没有系统提示词和工具声明了）。
  // 走 bySeq 查表：这里原来是 events.find() 套在 visible 的 map 里，等于每个可见
  // 事件都线性扫一遍全表，18 MB 的日志光这一句就要 6 秒。
  const originalVisible = foldSurface(events).visible
  const effectiveSystem = originalVisible
    .map((seq) => bySeq.get(seq))
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

  // 表面头：宿主要求「第一个表面节点是受保护的 system/message」。原日志里这条
  // 往往是一条 `append` 的 `system/message`（后续 checkpoint 用 replace 把它换成了
  // 有正文的新版本，于是原表面上它不在——宿主接受，因为没有 system 出现也算合法）。
  // 但裁剪之后，后面那些 system/replace 可能一起被切走，产物表面就由一条
  // `assistant/message` 打头，宿主的加载器直接拒收
  // （`requires a protected first surface head`，实测 25515ab4 / 50d48342）。
  // 它不占模型视图（原日志里本来就被遮蔽），留着只是让产物的首个表面节点合法。
  const firstSystemAppend = events.find((e) => e.type === 'system/message' && e.surfaceOp === 'append')
  if (firstSystemAppend !== undefined) keepSeq.add(firstSystemAppend.seq)

  // fork 的继承标记必须保住。`header.isSeeded === true` 的日志靠最后一条
  // `session/end-seed {inherited:true}` 声明"我继承了前 N 条"，它通常落在最早的
  // 那一窗里；窗口裁剪只留 `seq >= cutSeq`，会把这个标记本身删掉，宿主立刻报
  // `isSeeded 的会话缺少 inherited end-seed 标记`（实测 72e19985 的标记在 seq 4428，
  // 切点 9554，整次裁剪被拒）。它不占模型视图，留着只多一行。
  const inheritedSeed = events.filter((e) => e.type === 'session/end-seed' && e.data?.inherited === true).pop()
  if (inheritedSeed !== undefined) keepSeq.add(inheritedSeed.seq)

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

  // `agent/inbox/spliced` 是逐次拼接的记账，投影层会**按顺序重放**它（`start` 必须
  // 落在当前 inbox 长度内）。裁掉前面的拼接后，后面的 start 就越界了 —— 实测报
  // `invalid persisted inbox splice at session seq N`。先把全部拼接重放一遍拿到最终
  // 状态：为空就全丢（结果完全一致）；非空就压成一条，免得丢掉待处理消息。
  const splices = events.filter((e) => e.type === 'agent/inbox/spliced')
  if (splices.length > 0) {
    const inbox = { 'next-turn': [], 'next-step': [] }
    let replayOk = true
    for (const event of splices) {
      const splice = event.data ?? {}
      const target = splice.target
      const list = inbox[target]
      const removed = splice.removedCount ?? 0
      if (
        list === undefined ||
        !Number.isSafeInteger(splice.start) ||
        splice.start < 0 ||
        splice.start > list.length ||
        !Number.isSafeInteger(removed) ||
        removed < 0 ||
        splice.start + removed > list.length ||
        !Array.isArray(splice.inserted)
      ) {
        replayOk = false
        break
      }
      inbox[target] = list.toSpliced(splice.start, removed, ...splice.inserted)
    }
    for (const event of splices) keepSeq.delete(event.seq)
    if (replayOk) {
      for (const target of ['next-turn', 'next-step']) {
        if (inbox[target].length === 0) continue
        const first = splices.find((e) => e.data?.target === target && keepSeq.has(e.seq)) ?? splices.find((e) => e.data?.target === target)
        if (first === undefined) continue
        keepSeq.add(first.seq)
        first.data = { target, start: 0, removedCount: 0, inserted: inbox[target] }
      }
    }
  }

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

  // 活下来的 replace 的区间端点必须落在保留集里。端点被切走的话，`renumber` 会把它
  // 降级成 `append`，被它遮蔽的那段历史就重新露到模型眼前 —— 表面直接膨胀（实测
  // 5a2d5cc6 的 ck 4165 因此让 1257 条涨到 1747 条）。所以在重锚之前先把缺失的端点
  // 补进保留集：保住整条 replace，`alignReplaceRanges` 就没有机会再去重锚它。
  for (let round = 0; round < 8; round += 1) {
    let added = false
    for (const event of events) {
      if (!keepSeq.has(event.seq)) continue
      const op = event.surfaceOp
      if (op === null || op === undefined || typeof op !== 'object') continue
      for (const endpoint of [op.startSeq, op.endSeq]) {
        const seq = Number(endpoint)
        if (!Number.isSafeInteger(seq) || seq >= event.seq || keepSeq.has(seq)) continue
        if (!bySeq.has(seq)) continue
        keepSeq.add(seq)
        added = true
      }
    }
    if (!added) break
  }

  // 目标事件（`goal/change` 与 `source.kind === 'goal'` 的轮次消息）**必须整份留下**。
  //
  // `/goal` 的投影是从**整份日志**折叠出来的，被 checkpoint 遮蔽的事件同样参与；
  // 砍掉任何一条都会让该会话的 /goal 永久失败（插件早先就为此加过
  // `assertNoGoalEventsDropped` 硬拦截）。它们不占模型视图，留着只是几十到几百行
  // 记账。实测 session-9c6d39ac 523 条 goal 事件里 414 条本来就被遮蔽，全部保留
  // 之后仍能从 45523 条裁到 ~6500 条。
  //
  // 但**只保留 goal 是不够的**：它们原本可能正是被 checkpoint 的 replace 遮蔽着，
  // 而那条 replace 的端点落在被裁掉的窗口里。只留 goal、不留遮蔽者，它们就会
  // **露到表面上** —— 模型看到原本看不到的内容，硬闸门必然拒绝（实测 25515ab4：
  // 原表面 655、产物 1138，首个差异就是一条 goal user/message）。
  //
  // 所以做**向上闭包**：把每条 goal 事件在原日志里的遮蔽者（那条 replace 事件）
  // 也加进保留集；遮蔽者自己若同样被更上层遮蔽，继续往上补，直到没有为止。
  {
    const coveredBy = new Map()
    for (const event of events) {
      const op = event.surfaceOp
      if (op === null || op === undefined || typeof op !== 'object') continue
      const start = Math.min(Number(op.startSeq), Number(op.endSeq))
      const end = Math.max(Number(op.startSeq), Number(op.endSeq))
      for (const target of events) {
        if (target.seq < start || target.seq > end || target.seq >= event.seq) continue
        const list = coveredBy.get(target.seq) ?? []
        list.push(event.seq)
        coveredBy.set(target.seq, list)
      }
    }
    const bySeqOf = new Map(events.map((event) => [event.seq, event]))
    const goals = events.filter(
      (event) => event.type === 'goal/change' || (event.type === 'user/message' && event.data?.source?.kind === 'goal'),
    )
    const pending = goals.map((event) => event.seq)
    while (pending.length > 0) {
      const seq = pending.pop()
      keepSeq.add(seq)
      for (const shadowerSeq of coveredBy.get(seq) ?? []) {
        if (keepSeq.has(shadowerSeq)) continue
        const shadower = bySeqOf.get(shadowerSeq)
        if (shadower === undefined) continue
        keepSeq.add(shadowerSeq)
        pending.push(shadowerSeq)
      }
    }
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
  // ── 窗口裁剪失败时的兜底：按「模型当前真正看得见的第一个节点」重切 ──────────
  //
  // 有些会话（典型的"深压缩后继续使用"）结构是这样的：4~9 个 checkpoint，
  // 每个都遮蔽着它之前一大段历史，而**模型现在看得见的内容全在最后一个
  // checkpoint 附近**（实测 25515ab4：655 个可见节点全在 seq 15103..17293，
  // 前面 4 个 checkpoint 遮蔽的东西一条都不可见）。
  //
  // 这种会话按窗口数切（`checkpointTailStart`）永远过不了硬闸门：只要删掉任何
  // 一个前面的 checkpoint，它遮蔽的那一大片就会露出表面，视图直接变。
  // 但换个切法就成立：**从"第一个可见节点所在的 turn"整段切下去**，
  // 再把最后一个 checkpoint 的替身区间重锚到新起点（让它继续压住新起点后面
  // 那一段本不该可见的内容），最后清掉几条端点彻底失效的小 replace。
  // 实测这样切出来模型视图逐条不变、窗数 1。
  // ── 兜底：按「模型当前真正看得见的区域」重切 ──────────────────────────────
  //
  // 有一类会话（典型的"深压缩后继续使用"）结构是：4~9 个 checkpoint，每个都遮蔽
  // 着它之前一大段历史，而**模型现在看得见的内容全在最后一个 checkpoint 附近**
  // （实测 25515ab4：655 个可见节点全在 seq 15103..17293，前 4 个 checkpoint 遮蔽
  // 的东西一条都不可见）。这种会话按窗口数切永远过不了硬闸门 —— 删任何一条前面的
  // checkpoint，它遮蔽的那一大片就会露出表面。
  //
  // 换一种切法就成立，实测 25515ab4 从 17296 条切到 2262 条、窗 1，模型视图逐条
  // 相同、42 条 goal 完整、宿主校验六项全过：
  //
  //   1. 切点 = 第一个可见节点所在 turn 的 turn/start
  //   2. 保留 [切点, ∞) 的全部事件
  //   3. 目标事件（goal/change 与 goal 轮次消息）全部保留 —— 它们是 `/goal` 投影的
  //      唯一来源，少一条就永久失效；它们原本全被 checkpoint 压着、模型看不见，
  //      保留它们不会改变视图
  //   4. 系统提示词只留**链尾**（模型实际读到的那条），并固定成 `append`
  //   5. 继承标记 `inherited === true` 的 `session/end-seed` 必须留（宿主要求）
  //   6. 保留集里第一个 retry 之前必须有 provider 相同的 `request/header`
  //   7. 最后一个 checkpoint 的区间重锚成 [最早那条**带 surfaceOp 的 goal**, 原 end]
  //      —— 起点不能取表面节点（goal 会露），也不能取最早一条 goal（goal/change
  //      没有 surfaceOp、不在栈上，端点会指空）
  //   8. 端点彻底不在保留集的 replace 删掉（它们的替换目标本来就不可见）
  //   9. inbox 拼接重放后压成每个 target 一条（这是按长度重放的状态机）
  {
    const folded = foldSurface(gateEvents)
    const firstVisible = folded.visible[0]
    const hasVisible = folded.visible.length > 0 && firstVisible !== undefined
    if (hasVisible) {
      let anchorSeq = firstVisible
      for (const event of gateEvents) {
        if (event.seq > firstVisible) break
        if (event.type === 'turn/start') anchorSeq = event.seq
      }
      // 切点之前还有可见节点，说明前史对模型有用，不能整段切掉。
      const visibleBefore = folded.visible.filter((seq) => seq < anchorSeq)
      const checkpoints = gateEvents.filter(isCheckpoint)
      const lastCheckpoint = checkpoints[checkpoints.length - 1]
      if (
        visibleBefore.length === 0 &&
        anchorSeq > 0 &&
        lastCheckpoint !== undefined &&
        lastCheckpoint.surfaceOp !== null &&
        typeof lastCheckpoint.surfaceOp === 'object'
      ) {
        const isGoalEvent = (event) =>
          event.type === 'goal/change' || (event.type === 'user/message' && event.data?.source?.kind === 'goal')
        const keep2 = new Set()
        for (const event of gateEvents) if (event.seq >= anchorSeq) keep2.add(event.seq)
        // 最后一个 checkpoint 的**整组**记账行必须一起留（`compaction/start` +
        // `summary` + `end`，同一 compactionId）。checkpoint 载体落在保留集里而
        // 它的 start/summary/end 落在切点之前时，宿主报
        // `compaction checkpoint has no matching compaction/summary`
        // （实测 25515ab4：载体 seq 16328 保留、组在 16326..16329、切点是 15019，
        //  但 r 的 16326/16327 因为在 anchor 之后本该也在 —— 问题在于 keep2 过滤
        //  之后又用 fallbackFinal 删 replace，把 summary 的载体关系弄丢了）。
        // 这里显式把最后一个 checkpoint 的那个 compactionId 整组加进来。
        {
          const ckPoint = gateEvents.filter(isCheckpoint).pop()
          const groupId = ckPoint?.data?.source?.compactionId
          if (typeof groupId === 'string') {
            for (const event of gateEvents) {
              if (event.data?.compactionId === groupId) keep2.add(event.seq)
            }
          }
        }
        for (const event of gateEvents) if (isGoalEvent(event)) keep2.add(event.seq)
        for (const event of gateEvents) {
          if (event.type === 'session/end-seed' && event.data?.inherited === true) keep2.add(event.seq)
        }
        const systemChain = gateEvents.filter((event) => event.type === 'system/message')
        const systemTail = systemChain[systemChain.length - 1]
        if (systemTail !== undefined) keep2.add(systemTail.seq)
        for (const event of systemChain) {
          if (systemTail !== undefined && event.seq === systemTail.seq) continue
          keep2.delete(event.seq)
        }
        for (const type of ['agent-preset/selected', 'permission/preset', 'sandbox/mode', 'approval/policy', 'session/title']) {
          const head = gateEvents.filter((event) => event.type === type && event.seq < anchorSeq).pop()
          if (head !== undefined) keep2.add(head.seq)
        }
        const retryFirst = gateEvents
          .filter((event) => keep2.has(event.seq) && (event.type === 'llm/retry' || event.type === 'llm/retry-started'))
          .sort((a, b) => a.seq - b.seq)[0]
        if (retryFirst !== undefined) {
          const header = gateEvents.filter((event) => event.type === 'request/header' && event.seq < retryFirst.seq).pop()
          if (header !== undefined) keep2.add(header.seq)
        }
        const goalOnSurface = gateEvents
          .filter((event) => isGoalEvent(event) && event.surfaceOp !== undefined && event.surfaceOp !== null)
          .sort((a, b) => a.seq - b.seq)[0]
        const oldEnd = Number(lastCheckpoint.surfaceOp.endSeq)
        if (process.env.DSH_TRIM_DEBUG) {
          console.log('[dbg fb goalOnSurface]', goalOnSurface?.seq, goalOnSurface?.surfaceOp, '| oldEnd', oldEnd, '| anchor', anchorSeq)
        }
        if (goalOnSurface !== undefined && goalOnSurface.seq < oldEnd) {
          let fallbackEvents = gateEvents
            .filter((event) => keep2.has(event.seq))
            .map((event) => structuredClone(event))
          for (const event of fallbackEvents) {
            if (event.seq === lastCheckpoint.seq) {
              event.surfaceOp = { op: 'replace', startSeq: goalOnSurface.seq, endSeq: oldEnd }
            }
            if (systemTail !== undefined && event.seq === systemTail.seq) {
              event.surfaceOp = 'append'
              delete event.sourceEventSeqs
            }
          }
          fallbackEvents = fallbackEvents.filter((event) => {
            const op = event.surfaceOp
            if (op === null || op === undefined || typeof op !== 'object') return true
            if (event.seq === lastCheckpoint.seq) return true
            return keep2.has(Number(op.startSeq)) && keep2.has(Number(op.endSeq))
          })
          if (process.env.DSH_TRIM_DEBUG) {
            const ck = fallbackEvents.find((e) => e.type === 'user/message' && e.data?.source?.kind === 'compact-checkpoint')
            console.log('[dbg fb filtered] ckseq', ck?.seq, 'op', JSON.stringify(ck?.surfaceOp), '| 694 in', fallbackEvents.some((e) => e.seq === 694), '| len', fallbackEvents.length)
          }
          // inbox 拼接按长度重放：前面几十条一起裁掉之后，第一条留下的拼接就是
          // `start 0, removedCount 1` —— 空列表上减 1，投影层直接报越界。
          // 重放保留的那些拿到最终 inbox，再压成每个 target 一条。
          {
            const inboxState = { 'next-turn': [], 'next-step': [] }
            const keptSplices = fallbackEvents.filter((event) => event.type === 'agent/inbox/spliced')
            for (const event of keptSplices) {
              const splice = event.data ?? {}
              const list = inboxState[splice.target]
              if (list === undefined) continue
              const at = Math.min(Number.isSafeInteger(splice.start) ? splice.start : 0, list.length)
              const removed = Math.min(
                Number.isSafeInteger(splice.removedCount) ? splice.removedCount : 0,
                list.length - at,
              )
              const inserted = Array.isArray(splice.inserted) ? splice.inserted : []
              inboxState[splice.target] = list.toSpliced(at, Math.max(0, removed), ...inserted)
            }
            const keptSpliceSeq = new Set(keptSplices.map((event) => event.seq))
            const rest = fallbackEvents.filter((event) => !keptSpliceSeq.has(event.seq))
            const added = []
            for (const target of ['next-turn', 'next-step']) {
              if (inboxState[target].length === 0) continue
              const anchor = gateEvents.find(
                (event) => event.type === 'agent/inbox/spliced' && event.data?.target === target,
              )
              if (anchor === undefined) continue
              added.push({
                ...structuredClone(anchor),
                data: { target, start: 0, removedCount: 0, inserted: inboxState[target] },
              })
            }
            for (const splice of added) {
              const clashAt = rest.findIndex((event) => event.seq === splice.seq)
              if (clashAt >= 0) rest.splice(clashAt, 1)
            }
            fallbackEvents = [...rest, ...added]
          }
          // ⚠️ 这里**只能重编号一次**。
          //
          // 之前是 renumber → prune → 孤儿组修复 → renumber，两次重编。第二次的
          // `finalMapping` 键已经是"第一次重编后的新 seq"，而 checkpoint 的
          // `surfaceOp` 在第一次重编里已经变成 622..1152 这种**新编号**；拿它去
          // 旧映射里查，取到的是另一段区间 —— 遮蔽区间被搬到错误位置，它压着的
          // 那 500 条历史全部露出表面（实测 9c6d39ac 对话 678 → 1178）。
          //
          // 正确做法：所有改造（inbox 压缩、孤儿组修复、offload 剪枝）都在**原始
          // seq 空间**里做完，最后只 `renumber` 一次。
          // ⚠️ 判据必须是「`start` 与 `end` 都在保留集里**成对**出现」，只数
          // `compaction/end` 的类型是不够的 —— 裁剪会把一组的 `summary` 与 `end`
          // 切到保留区外面，只剩 `start`（实测 2ac54d53：原日志 8411..8414 四项齐全，
          // 保留集里只剩 8411 与 8413，`end` 落在被裁段里）。这时宿走到 `turn/end`
          // 就报 `turn/end crosses an open compaction`。
          //
          // 所以这里改成：把「有 start 但保留集里没有同 id 的 end」的组一律认定为
          // 残缺组 —— 连它留下的 start/summary 一起删，并把引用该 id 的 checkpoint
          // 载体降级成 `append`（否则会变成
          // `compaction checkpoint has no matching compaction/start`）。
          // 判据改成「**三项齐全才算完整组**」：`start` + `summary` + `end` 三项
          // 必须**都在保留集里**。
          //
          // 只比 `start` 与 `end` 是不够的：`renumber` 有一条规则 —— `summary` 找不到
          // 载体（或载体区间失效）就把它丢掉，顺带把同组的 `end` 也判成非法。
          // 实测 2ac54d53：保留集里有 8411:start 与 8413:user/message，但
          // 8412:summary 与 8414:end 都落在被裁段里 —— `openIds` 与 `closedIds`
          // 都只看到部分信息，于是孤儿组识别不出来，产物里留下一个光杆 `start`，
          // 宿主走到 `turn/end` 就报 `turn/end crosses an open compaction`。
          //
          // 三项齐全的组原样保留（25515ab4 / 9c6d39ac / 50d48342 都不受影响）。
          // 孤儿组修复是**条件触发**的，不能无条件执行。
          //
          // 之前无条件先跑一次"探针重编"来认孤儿组，等于所有会话都多跑一次
          // `renumber`；探针虽然用了深拷贝，但 `pruneOffloadTargets` 那条链路
          // 仍会让产物里出现大量重复内容（实测 9c6d39ac 表面 678 → 1178、
          // 去重后只剩 517）。本来就完好的会话因此被弄坏。
          //
          // 现在改成两条候选：
          //   候选 A：原样（不删任何 compaction 组）—— 绝大多数会话走这条
          //   候选 B：把「三项不齐」的组整组删掉、引用它的 checkpoint 降级 append
          //
          // 先验 A，通过就用 A；不通过才构造 B 再验。这样 9c6d39ac / 50d48342
          // 回到原来那条通过的路径，2ac54d53 / 8f22b386 走 B。
          const tryFinish = (events) => {
            const pruned = pruneOffloadTargets(events)
            const clean = renumber(pruned.events)
            if (!sameVisible(viewParts(gateEvents), viewParts(clean.events))) return null
            // ⚠️ 光验视图是不够的。有一类结构错误**不影响模型视图**，却会让宿主
            // 拒收整份日志：一个没有配对的 `compaction/start` 会让后续 `turn/end`
            // 报 `turn/end crosses an open compaction`（实测 2ac54d53 / 8f22b386）。
            // 视图比对看不见它（compaction 记账行不是表面节点），所以必须在这里
            // 单独扫一遍；不通过就回落去走"删孤儿组"那条候选路径。
            // 宿主规则：`compaction/start` 打开后必须由同 id 的 `compaction/end`
            // 关掉；中途遇到 `turn/end` 就报 `turn/end crosses an open compaction`。
            // 重编会重排事件顺序，偶尔把一个**原本合法**的组的 `end` 排到
            // `turn/end` 之后（实测 9c6d39ac 的 95ca3732、50d48342 的 ad50f32f、
            // 8f22b386 的 ecf2f721）。
            //
            // 修法：把这些组的 `compaction/*` 记账行删掉，并把引用该 id 的
            // checkpoint 载体**改标成普通 user 消息**（删 `source.compactionId`、
            // `source.kind` 改 `user`）。载体本身是表面节点，**不能删** —— 删了
            // 视图就变；改标之后它不再被当 checkpoint 校验，表面语义完全不变。
            const badCompactionIds = new Set()
            {
              let openId = null
              for (const event of clean.events) {
                if (event.type === 'session/end-seed') { openId = null; continue }
                if (event.type === 'compaction/start') { openId = event.data?.compactionId ?? null; continue }
                if (event.type === 'compaction/end') { openId = null; continue }
                if (event.type === 'turn/end' && openId !== null) { badCompactionIds.add(openId); openId = null }
              }
            }
            if (badCompactionIds.size > 0) {
              const repaired = clean.events
                .filter((event) => !(String(event.type).startsWith('compaction/') && badCompactionIds.has(event.data?.compactionId)))
                .map((event) => {
                  if (event.type !== 'user/message') return event
                  if (event.data?.source?.kind !== 'compact-checkpoint') return event
                  const id = event.data.source.compactionId
                  if (!badCompactionIds.has(id)) return event
                  const source = { ...event.data.source }
                  delete source.compactionId
                  return { ...event, data: { ...event.data, source: { ...source, kind: 'user' } } }
                })
              const repairedClean = renumber(repaired)
              if (!sameVisible(viewParts(gateEvents), viewParts(repairedClean.events))) return null
              return repairedClean
            }
            return clean
          }
          let fallbackClean = tryFinish(fallbackEvents)
          if (fallbackClean === null) {
            // 认孤儿组：以 `compaction/start` 为主体，同 id 的 `summary` 与 `end`
            // 只要缺任一项就认定这组坏了。这些是纯记账行，删掉不影响模型视图；
            // 但引用它的 checkpoint 载体必须降级成 `append`，否则会变成
            // `compaction checkpoint has no matching compaction/start`。
            const openIds = new Set()
            const summaryIds = new Set()
            const closedIds = new Set()
            for (const event of fallbackEvents) {
              const id = event.data?.compactionId
              if (typeof id !== 'string') continue
              if (event.type === 'compaction/start') openIds.add(id)
              else if (event.type === 'compaction/summary') summaryIds.add(id)
              else if (event.type === 'compaction/end') closedIds.add(id)
            }
            const orphanIds = new Set()
            for (const id of openIds) {
              if (!summaryIds.has(id) || !closedIds.has(id)) orphanIds.add(id)
            }
            const fixedEvents = orphanIds.size === 0
              ? fallbackEvents
              : fallbackEvents
                  .filter((event) => !(String(event.type).startsWith('compaction/') && orphanIds.has(event.data?.compactionId)))
                  .map((event) => {
                    if (event.type !== 'user/message') return event
                    if (event.data?.source?.kind !== 'compact-checkpoint') return event
                    const id = event.data.source.compactionId
                    if (!orphanIds.has(id)) return event
                    const copy = { ...event, surfaceOp: 'append' }
                    delete copy.sourceEventSeqs
                    return copy
                  })
            fallbackClean = tryFinish(fixedEvents)
          }

          if (fallbackClean !== null && sameVisible(viewParts(gateEvents), viewParts(fallbackClean.events))) {
            return {
              // ⚠️ 必须返回**重编后**的那份：`fallbackEvents` 还是原始 seq（0..15019
              // 之间有大段空洞），直接写盘宿主会报 `format v4 event 0 is not dense`
              // —— 裁剪产物要求 seq 从 0 开始连续。
              events: fallbackClean.events,
              cutSeq: anchorSeq,
              windows: windows.length,
              realWindows: real.length,
              kept: fallbackClean.events.length,
              dropped: events.length - fallbackClean.events.length,
              frame: [...frame],
              anchors: anchors.size,
              fallback: true,
            }
          }
        }
      }
    }
  }

  // 硬闸门：裁完的日志模型看到的内容必须逐条不变。量重编号后真正会写盘的那份
  // （重编号会丢掉悬空 replace，被它压住的内容会重新露出来），按内容比不比 seq。
  // 基准用前面那份 `gateEvents` 快照：`alignReplaceRanges` 已经把 `events` 就地改过了。
  // 先按 keepSeq 过滤再深拷贝：反过来的话，被丢掉的那一大半也要克隆一遍，
  // 18 MB 的日志光这一步就是好几秒。
  const survivor = events.filter((event) => keepSeq.has(event.seq)).map((event) => structuredClone(event))
  if (!sameVisible(viewParts(gateEvents), viewParts(renumber(survivor).events))) {
    return { events, cutSeq: null, windows: windows.length, realWindows: real.length, kept: events.length, dropped: 0, frame: [] }
  }
  return {
    events: finalOut,
    cutSeq,
    windows: windows.length,
    realWindows: real.length,
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
    // `goal/change` 没有 turn/step 字段，格式层不管它；但它的顺序对目标投影有意义
    // （create/edit 必须排在被它放行的那一轮之前）。归到 head 会被搬到整份日志最前，
    // 那一轮就成了孤儿，所以必须留在 body 原位。
    'goal/change',
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
    const isSurfaceType = (e) =>
      e.type === 'system/message' || e.type === 'developer/message' ||
      e.type === 'user/message' || e.type === 'assistant/message' || e.type === 'tool/result'
    // 插入点是**第一个表面事件之前**，不是"第一个 step/start 之后"。
    //
    // 原来锚到 `stepStart`，但 `[turn/start, step/start)` 之间允许存在不带 step 的
    // 表面事件（实测 d3089018 的 `1712 user/message` 就在 turn/start 1710 之后、
    // step/start 1713 之前）。系统提示词插到 stepStart 后面，就排到了它后面 ——
    // 产物里第一个表面节点成了 user/message，宿主的加载器直接拒收
    // （`system/message requires a protected first surface head`）。
    const surfAt = rest.findIndex(isSurfaceType)
    if (surfAt >= 0) {
      // sys 必须落在已开启的 turn + step 里，所以把紧邻的 step/start 提到它前面。
      const moved = []
      const remaining = []
      rest.forEach((event, index) => {
        if (index >= surfAt && event.type === 'step/start' && moved.length === 0 && stepStart !== undefined && event.seq === stepStart.seq) {
          moved.push(event)
          return
        }
        remaining.push(event)
      })
      const at = remaining.findIndex(isSurfaceType)
      const insertAt = at < 0 ? remaining.length : at
      ordered = [...head, ...remaining.slice(0, insertAt), ...moved, sys, ...remaining.slice(insertAt)]
    } else {
      const anchor = stepStart ?? turnStart
      if (anchor === undefined) {
        ordered = [...head, sys, ...rest]
      } else {
        const at = rest.findIndex((e) => e.seq === anchor.seq)
        ordered = [...head, ...rest.slice(0, at + 1), sys, ...rest.slice(at + 1)]
      }
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
  // 兜底成 `1` 会让「没有 turn/start 的孤儿 turn 号」与新编号撞车：前缀被裁后，
  // 残留的 tool/result 带着早已没有 turn/start 的旧 turn 号，映射到 1 就混进了
  // 第 1 轮的 step 序列，格式层报 `tool/result does not match an open turn and step`
  // （实测 184f1813 / 6df74bd5 / 7fdb94ec）。兜底成「不在任何被编号轮次里」的号，
  // 让这些孤儿落在没人用的区间（它们本来也不该被当成正常轮次的一部分）。
  // 孤儿轮次的编号必须**唯一且排在正常轮次之后**：全塞同一个号会破坏
  // `turn/start` 必须按 1、2、3… 依次开启的连续性（实测报
  // `turn/start does not open the expected turn`）。
  const orphanMap = new Map()
  let nextOrphan = nextTurn
  const mapTurn = (turn) => {
    if (turnMap.has(turn)) return turnMap.get(turn)
    if (!orphanMap.has(turn)) orphanMap.set(turn, nextOrphan++)
    return orphanMap.get(turn)
  }
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
      // 宿主的规则是「`messageSeqs` 为空 **当且仅当** source.kind 是 user」
      // （format 层原话：`messageSeqs must be empty exactly for a user title`）。
      // 裁剪会把 provider / fallback 标题引用的那条早期消息（例如 [11]）切掉，
      // 重编之后映射成空数组 —— 于是一条 `provider` 标题拿着空的 messageSeqs，
      // 整份日志被拒。这条标题的内容仍然在，但它的**来源引用**已经指不到任何
      // 东西了；丢掉它比留一条非法记录强（同一批会话里通常还有用户自己设的标题）。
      const isEmpty = !Array.isArray(refs) || refs.length === 0
      if (isEmpty && kind !== 'user') {
        titlesDropped += 1
        continue
      }
      if (!isEmpty && kind === 'user') {
        // 用户标题必须为空：把引用清掉，标题本体保留。
        event.data = { ...event.data, messageSeqs: [] }
      }
    }
    // `session/title-llm-request` 的 `messageSeqs` 必须与那条 `session/title` **完全
    // 一致**（格式层逐条校验 `messages do not represent messageSeqs`）。用户自己设的
    // 标题 `messageSeqs` 为空，而这次请求记的是当初那条消息的 seq（例如 [11]）；
    // 前面的窗口被裁掉之后它映射成空数组，两边就对不上了。这种记录是「当初怎么
    // 生成的标题」的历史注脚，标题已经定了，丢掉它不影响任何可读内容。
    if (event.type === 'session/title-llm-request') {
      const titleSeqs = [...out]
        .reverse()
        .find((candidate) => candidate.type === 'session/title' && candidate.seq <= event.seq)?.data?.messageSeqs
      const ownSeqs = Array.isArray(event.data?.messageSeqs) ? event.data.messageSeqs : []
      const expected = Array.isArray(titleSeqs) ? titleSeqs : []
      if (ownSeqs.length === 0 && expected.length === 0) {
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
      // ⚠️ 这里**不能**把 startSeq / endSeq 各自映射一次就完事。
      //
      // `finalRemap` 是「老 seq → 新下标」，而 `renumber` 重排过事件顺序（head 搬最前、
      // 系统提示词插到第一个表面事件之前），所以它**不是单调的**：老 seq 小的，新下标
      // 未必小。分别映射两端会让区间**反转**（实测 25515ab4 的 6745..9223 映射成
      // 7905..1785），于是 fold 时 `startIdx > endIdx`，这条 replace 连带整片遮蔽一起
      // 降级成 append，本该不可见的 447 条事件全部露到表面上（原表面 655 → 1123）。
      //
      // 正确做法是**按新顺序重新取端**：把原区间里仍然存活的事件映射一遍，取其中
      // 最小的新 seq 与最大的新 seq 当新端点。这样区间在新序列里仍是一段连续的表
      // 面范围，遮蔽语义不变。
      const oldStart = Number(next.surfaceOp.startSeq)
      const oldEnd = Number(next.surfaceOp.endSeq)
      const low = Math.min(oldStart, oldEnd)
      const high = Math.max(oldStart, oldEnd)
      let newStart = null
      let newEnd = null
      if (Number.isSafeInteger(low) && Number.isSafeInteger(high)) {
        for (const [oldSeq, newSeq] of finalMapping) {
          if (oldSeq < low || oldSeq > high) continue
          if (newStart === null || newSeq < newStart) newStart = newSeq
          if (newEnd === null || newSeq > newEnd) newEnd = newSeq
        }
      }
      if (newStart === null) {
        newStart = finalRemap(oldStart)
        newEnd = finalRemap(oldEnd)
      }
      if (newStart !== null && newEnd !== null && newStart <= newEnd) {
        next.surfaceOp = { ...next.surfaceOp, startSeq: newStart, endSeq: newEnd }
      } else {
        next.surfaceOp = 'append'
      }
    }
    rebuilt.push(next)
  }

  // ── 5) 按宿主算法重算 sourceEventSeqs ───────────────────────────────────
  const nodes = []
  const keptBySeq = new Map(ordered.map((event) => [event.seq, event]))
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
      if (process.env.DSH_TRIM_DEBUG) console.log('[dbg step5 degrade]', event.type, 'seq', event.seq, 'range', op.startSeq + '..' + op.endSeq, 'startIdx', startIdx, 'endIdx', endIdx, 'srcLen', Array.isArray(event.sourceEventSeqs)?event.sourceEventSeqs.length:0)
      event.surfaceOp = 'append'
      delete event.sourceEventSeqs
      nodes.push(event.seq)
      finalKept.push(event)
      refsFixed += 1
      continue
    }
    const shadowed = nodes.slice(startIdx, endIdx + 1)
    // `tool/result` 的 replace 被宿主**严格**限制：只能替换**一条**同为 `tool/result`
    // 的节点，且替换者与被替换者的 `message` 除 `content` 外必须完全一致
    // （`tool/result surface replacement may change only content`）。重编之后端点可能
    // 指到了别的类型（实测 25515ab4 的 seq 1460 替换到一条 `step/start` 上），宿主
    // 直接拒收整份日志。这种情况降级成 `append`：内容照样留着，只是不再"替换"别人。
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
export function isSessionLocked(logFile) {
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
 * 生成裁剪结果并写到暂存文件（**不动原文件**）。
 *
 * @param {string} logFile - 原日志。
 * @param {number} keep - 保留最后几窗。
 * @returns {{ staging: string, backup: string, summary: object }} 暂存信息。
 */

/**
 * 每个事件属于第几轮（`turn/start` 打开、`turn/end` 关闭；没有轮次的记 0）。
 *
 * @param {object[]} events - 事件数组。
 * @returns {Map<number, number>} seq → turn。
 */
function turnIndexOf(events) {
  const out = new Map()
  let current = 0
  for (const event of events) {
    if (event.type === 'turn/start') {
      const turn = event.data && typeof event.data.turn === 'number' ? event.data.turn : current + 1
      current = turn
      out.set(event.seq, turn)
      continue
    }
    if (current > 0) out.set(event.seq, current)
    if (event.type === 'turn/end') current = 0
  }
  return out
}

/**
 * 删掉「旧回合」里 `assistant/message.data.stream` 的流式回放记录。
 *
 * `stream` 是模型输出的原始增量（block-start / reasoning-chunks / tool-call-chunks /
 * block-end / usage / finish，带 `dt` 与 `time0`）。它与 `data.message.content`
 * **逐块重复**（实测 reasoning 与 tool-call 完全相同），删掉不丢正文、不丢思考文本，
 * 只丢“逐字回放的动画与时序”。近期回合保留，因为那是回头看时唯一会用到的。
 *
 * 不改行数、不改 seq、不动表面，所以不触发重编号与内容闸门。
 *
 * @param {object[]} events - 裁剪后的事件。
 * @param {number} keepTurns - 保留最近几轮的 stream；`Infinity` 表示全留。
 * @returns {{ events: object[], stripped: number, bytesSaved: number }} 新事件与统计。
 */
export function stripOldStreams(events, keepTurns) {
  if (!Number.isFinite(keepTurns) && keepTurns !== Infinity) return { events, stripped: 0, bytesSaved: 0 }
  if (keepTurns === Infinity) return { events, stripped: 0, bytesSaved: 0 }
  const turnOf = turnIndexOf(events)
  let maxTurn = 0
  for (const turn of turnOf.values()) if (turn > maxTurn) maxTurn = turn
  const floor = keepTurns > 0 ? maxTurn - Math.max(1, keepTurns) + 1 : Infinity
  let stripped = 0
  let bytesSaved = 0
  const out = events.map((event) => {
    if (event.type !== 'assistant/message') return event
    if (event.data === null || typeof event.data !== 'object' || event.data.stream === undefined) return event
    const turn = turnOf.get(event.seq) ?? 0
    if (keepTurns > 0 && turn >= floor) return event
    // 宿主在两条回退路径上会读 stream：图片查找（正文里没找到就翻块）与用量
    // （`data.usage ?? streamUsage(stream)`）。缺这两样东西的行不动，避免清出信息空窗。
    if (event.data.usage === undefined) return event
    const blocks = event.data?.message?.content
    if (Array.isArray(blocks) && blocks.some((block) => block && (block.type === 'image' || block.type === 'file'))) return event
    bytesSaved += Buffer.byteLength(JSON.stringify(event.data.stream))
    // 不能整条删：宿主对 assistant 行的结算字段有校验，缺 stream 会报
    // `invalid settlement fields`。空数组是被接受的“没有回放记录”。
    const data = { ...event.data, stream: [] }
    stripped += 1
    return { ...event, data }
  })
  return { events: out, stripped, bytesSaved }
}

/**
 * 把落在「没有任何开放 step」位置的 tool/result 归位。
 *
 * 为什么会有这种行：工具调用的结果可能晚到——它挂在很早的 turn/step 上，
 * 却在很后面的位置才写进日志。原日志能装得上，但当裁剪从中间切掉一段再重编号后，
 * 这些行就会落在 step/end 之后、下一段 step 之前，宿主的格式层要求
 * 「tool/result 的 turn/step 必须等于当前打开的 turn/step」，于是整份日志被拒。
 *
 * 处理：找到它自己那一步的 step/start，把它挪进那一 step 的最后；找不到就往后
 * 找第一个 step/start 并改挂到那一步；连一个 step 都没有就删掉（此时它已经无处
 * 可挂，留着只会让整份日志装不上）。
 *
 * @param {object[]} events - 已重编号的事件。
 * @returns {{ events: object[], moved: number, dropped: number }} 处理结果。
 */
export function repairLateToolResults(events) {
  const list = [...events]
  let moved = 0
  let dropped = 0
  // 被裁剪丢掉的调用不会再有 tool/call；它的结果留着就是「没有 advertised lifecycle」，
  // 格式层直接拒收，所以先把这种孤儿结果清掉。
  const advertised = new Set()
  for (const event of list) {
    if (event.type === 'tool/call' && typeof event.data?.callId === 'string') advertised.add(event.data.callId)
    if (event.type === 'assistant/message' && Array.isArray(event.data?.message?.content)) {
      for (const block of event.data.message.content) {
        if (block?.type === 'tool-call' && typeof block.id === 'string') advertised.add(block.id)
      }
    }
  }
  for (let index = list.length - 1; index >= 0; index -= 1) {
    const event = list[index]
    if (event.type !== 'tool/result') continue
    const callId = event.data?.message?.toolCallId ?? event.data?.message?.source?.callId ?? event.data?.toolCallId
    if (typeof callId !== 'string') continue
    if (advertised.has(callId)) continue
    list.splice(index, 1)
    dropped += 1
  }
  for (let round = 0; round < 5; round += 1) {
    // 1) 模拟当前开放的 turn/step，找出位置不对的 tool/result
    let turn = null
    let step = null
    const offenders = []
    for (let index = 0; index < list.length; index += 1) {
      const event = list[index]
      if (event.type === 'turn/start') { turn = event.data?.turn; step = null; continue }
      if (event.type === 'step/start') { step = event.data?.step; continue }
      if (event.type === 'step/end') { step = null; continue }
      if (event.type === 'turn/end') { turn = null; step = null; continue }
      if (event.type !== 'tool/result') continue
      const t = event.data?.turn
      const s = event.data?.step
      if (!Number.isSafeInteger(t) || !Number.isSafeInteger(s)) continue
      if (step !== null && t === turn && s === step) continue
      offenders.push({ index, turn: t, step: s })
    }
    if (offenders.length === 0) break
    // 2) 逐个找落点：优先自己那一步，其次往后第一个 step
    for (const offender of offenders.sort((a, b) => b.index - a.index)) {
      const row = list[offender.index]
      let target = -1
      for (let index = 0; index < list.length; index += 1) {
        const event = list[index]
        if (event.type === 'step/start' && event.data?.turn === offender.turn && event.data?.step === offender.step) { target = index; break }
      }
      if (target === -1) {
        for (let index = offender.index + 1; index < list.length; index += 1) {
          if (list[index].type === 'step/start') { target = index; break }
        }
      }
      list.splice(offender.index, 1)
      if (target === -1) { dropped += 1; continue }
      if (target > offender.index) target -= 1
      const anchor = list[target]
      let insertAfter = target
      for (let index = target + 1; index < list.length; index += 1) {
        const event = list[index]
        if (['step/end', 'turn/end', 'step/start', 'turn/start'].includes(event.type)) break
        if (event.data?.turn === anchor.data?.turn && event.data?.step === anchor.data?.step) insertAfter = index
      }
      row.data = { ...row.data, turn: anchor.data?.turn, step: anchor.data?.step }
      list.splice(insertAfter + 1, 0, row)
      moved += 1
    }
  }
  return { events: list, moved, dropped }
}


/**
 * 被 checkpoint 的 `replace` 区间盖住的前缀：模型与界面都看不到，留着只是占空间，
 * 窗口页还会把它算成一窗。
 *
 * 删除标准是 `foldSurface` 自己算出来的 `dropped`（真正被 replace 遮蔽的那些），
 * 而不是「seq 小于某个边界」——后者会把 [shadowEnd, 第一条 turn/start) 这个空档里
 * *仍然可见* 的节点一并删掉（实测 5a2d5cc6 空档 [5467,5571) 里有 29 个可见节点，
 * 全局 11 个会话共 244 个）。那等于悄悄改掉模型读到的内容。
 *
 * 结构性事件（compaction 组、seeded 标记、inbox 拼接）不受遮蔽限制：它们是按顺序
 * 重放的记账，丢掉半组会让整份日志装不上，而且不占模型视图。
 *
 * @param {object[]} events - 候选保留事件（keepLastWindows 的结果）。
 * @returns {{ events: object[], dropped: number }} 结果。
 */
export function dropShadowedPrefix(events) {
  const checkpoints = events.filter((event) => event.type === 'user/message' && event.data?.source?.kind === 'compact-checkpoint')
  const last = checkpoints[checkpoints.length - 1]
  const shadowEnd = last !== undefined && typeof last.surfaceOp?.endSeq === 'number' ? last.surfaceOp.endSeq : null
  if (shadowEnd === null) return { events, dropped: 0 }
  const aligned = events.find((event) => event.seq > shadowEnd && event.type === 'turn/start')
  if (aligned === undefined) return { events, dropped: 0 }
  // 保留区从这条 turn/start 开始：从轮次边界切，turn/step 括号与工具生命周期才是
  // 自洽的（逐条删被遮蔽事件会让格式层报 `does not match an open turn and step`
  // 与 `tool/call has no advertised tool lifecycle`）。
  const liveStart = aligned.seq
  const frame = new Set()
  const fold = foldSurface(events)
  const visible = fold.visible
  const covered = fold.dropped
  const system = visible
    .map((seq) => events.find((event) => event.seq === seq))
    .find((event) => event !== undefined && (event.type === 'system/message' || event.type === 'developer/message'))
  if (system !== undefined) frame.add(system.seq)
  for (const type of ['agent-preset/selected', 'permission/preset', 'sandbox/mode', 'approval/policy', 'session/title', 'session/end-seed']) {
    const hit = events.filter((event) => event.type === type).pop()
    if (hit !== undefined) frame.add(hit.seq)
  }
  // 结构性事件不受“前缀”限制：compaction 组、seeded 标记、inbox 拼接都是按顺序
  // 重放的记账，丢掉半组会让整份日志装不上；它们不占模型视图，留着也便宜。
  const structural = (event) =>
    String(event.type).startsWith('compaction/') ||
    String(event.type).startsWith('session/') ||
    event.type === 'agent/inbox/spliced' ||
    // 目标事件：`/goal` 从整份日志折叠，被遮蔽的也要留（见 keepLastWindows 里的说明）。
    event.type === 'goal/change' ||
    (event.type === 'user/message' && event.data?.source?.kind === 'goal')
  // **空档里仍然可见的节点必须留**。原来的判据只有 `seq >= liveStart`，把
  // `[shadowEnd, liveStart)` 之间那批"没被遮蔽、模型还能看见"的节点一起删掉了
  // （实测 5a2d5cc6 空档 [5467,5571) 里 29 个可见节点，全局 11 个会话共 244 个）。
  //
  // 不能改成"逐条删被遮蔽的"：那样会把 turn/step 括号与 tool 生命周期的半边删掉，
  // 格式层立刻报 `does not match an open turn and step` / `tool/call has no advertised
  // tool lifecycle`（实测）。所以仍然按"连续尾巴"切，只把**切点前移**到包住那些
  // 可见节点的轮次起点：留的是完整的一轮，结构自洽，内容也不再丢。
  let keptFrom = liveStart
  const gapVisible = visible.filter((seq) => seq > shadowEnd && seq < liveStart)
  if (gapVisible.length > 0) {
    const earliest = gapVisible[0]
    let candidate = keptFrom
    for (const event of events) {
      if (event.seq > earliest) break
      if (event.type === 'turn/start') candidate = event.seq
    }
    if (candidate < keptFrom) keptFrom = candidate
  }
  // `llm/retry` / `llm/retry-started` 必须能找到一个**在它之前**的
  // `request/header`，宿主逐条校验 `llm/retry provider does not match the open
  // request/header`。前缀裁剪把那条 header 切掉之后，剩下的 retry 就全部悬空
  // （实测 25515ab4 有 26 条 retry 跑在第一个 header 之前，整份被拒）。
  // 所以：候选里第一条 retry 之前若没有 header，就把被丢掉的那条 header 补回来。
  //
  // 判据是**候选保留集里**第一条「retry 出现在它之前」的位置：只要有一条 retry
  // 的 seq 小于候选里第一 header 的 seq，就说明那批 retry 没有开着的 header。
  // 把它们前面最近的那条 header 补回来（一条就够，retry 只需要"有一个开着的"）。
  const retryTypes = new Set(['llm/retry', 'llm/retry-started'])
  const candidateFirstRetry = events.find(
    (event) => event.seq >= keptFrom && retryTypes.has(String(event.type)),
  )
  const candidateFirstHeader = events.find(
    (event) => event.seq >= keptFrom && event.type === 'request/header',
  )
  const retryBeforeHeader =
    candidateFirstRetry !== undefined &&
    (candidateFirstHeader === undefined || candidateFirstRetry.seq < candidateFirstHeader.seq)
  if (retryBeforeHeader) {
    const header = events
      .filter((event) => event.type === 'request/header' && event.seq < candidateFirstRetry.seq)
      .pop()
    if (header !== undefined) frame.add(header.seq)
  }
  const out = events.filter(
    (event) => event.seq >= keptFrom || frame.has(event.seq) || structural(event),
  )
  // **遮蔽闭包**：保留下来的事件里，有些原本依赖一条已被删掉的 `replace` 才不可见
  // （例如 9c6d39ac 的 checkpoint 3469 遮蔽 694 等 399 条，3469 被前缀裁掉之后那批
  // 又露出来，表面从 679 涨到 1078）。删一条 replace 就必须连带删掉它遮蔽的事件，
  // 否则模型会看到原本看不到的内容 —— 这正是硬闸门要拦的。
  //
  // `coverOf` 用原日志试算出「每条事件是被哪些 replace 遮蔽的」。保留集里若某条
  // 事件的所有遮蔽者都已不在，这条事件也得走。
  {
    const coveredBy = new Map()
    for (const event of events) {
      const op = event.surfaceOp
      if (op === null || op === undefined || typeof op !== 'object') continue
      const start = Math.min(Number(op.startSeq), Number(op.endSeq))
      const end = Math.max(Number(op.startSeq), Number(op.endSeq))
      for (const target of events) {
        if (target.seq < start || target.seq > end || target.seq >= event.seq) continue
        const list = coveredBy.get(target.seq) ?? []
        list.push(event.seq)
        coveredBy.set(target.seq, list)
      }
    }
    // 目标事件（goal/change 与 goal 轮次消息）不能删：`/goal` 的投影从整份日志折叠。
    // 但它们原本被 checkpoint 遮蔽、模型看不到；强行保留会让它们**露出表面**，
    // 视图就变了（实测 9c6d39ac 的 goal 消息 694 因此从「被遮蔽」变成「可见」，
    // 表面 679 → 1078）。所以对这些事件反过来做：**把遮蔽它的那条 replace 补回来**，
    // 让它继续处于被遮蔽状态 —— 投影读得到，模型视图不变。
    const isGoalEvent = (event) =>
      event.type === 'goal/change' || (event.type === 'user/message' && event.data?.source?.kind === 'goal')
    const kept = new Set(out.map((event) => event.seq))
    for (let round = 0; round < 8; round += 1) {
      let changed = false
      for (const event of out) {
        const shadowers = coveredBy.get(event.seq)
        if (shadowers === undefined) continue
        // 这里用**不含 goal** 的结构性判定：goal 事件要走下面的「补回遮蔽者」分支，
        // 不能被 structural 提前豁免掉（否则它就留在表面上，视图直接膨胀）。
        const structuralOnly = String(event.type).startsWith('compaction/') ||
          String(event.type).startsWith('session/') ||
          event.type === 'agent/inbox/spliced'
        if (shadowers.some((seq) => kept.has(seq)) || frame.has(event.seq) || structuralOnly) continue
        if (isGoalEvent(event)) {
          for (const seq of shadowers) {
            if (kept.has(seq)) continue
            kept.add(seq)
            changed = true
          }
          continue
        }
        kept.delete(event.seq)
        changed = true
      }
      if (!changed) break
    }
    out.length = 0
    for (const event of events) if (kept.has(event.seq)) out.push(event)
  }

  // compaction 是一组（start / summary / end 同一个 compactionId）：end 落在尾巴里而
  // start/summary 落在被丢的前缀里时，宿主要求「成功的 compaction/end 必须有一条 summary」。
  // 只要有同组的行留下，就把整组补回来（都是记账行，不影响模型视图）。
  const compactionIds = new Set()
  for (const event of out) {
    if (typeof event.data?.compactionId === 'string') compactionIds.add(event.data.compactionId)
  }
  if (compactionIds.size > 0) {
    for (const event of events) {
      if (typeof event.data?.compactionId === 'string' && compactionIds.has(event.data.compactionId) && !out.includes(event)) out.push(event)
    }
    out.sort((left, right) => left.seq - right.seq)
  }
  // compaction 组的记账字段（`shadowedRange` / `shadowedSeqs`）是**按 carrier** 现算的：
  // `renumber` 先从 `source.kind === 'compact-checkpoint'` 的记录建 carrier 表，再拿
  // carrier 的 `surfaceOp` 去重算 summary 的区间。前缀一削，carrier（例如 seq 11204，
  // 一条被后一个 checkpoint 遮蔽的 `user/message`）常常跟着消失；summary 找不到 carrier
  // 就被 `renumber` 丢掉，只剩 `compaction/start` + `compaction/end`，宿主立刻报
  // `successful compaction/end requires one summary`（实测 72e19985 连撞两次）。
  //
  // 所以判据是「这一组的 carrier 还在不在」：carrier 没留下，整组连 summary 一起丢掉；
  // carrier 留下了，整组都留（保证 start + summary + end 三项齐全）。
  const carrierIds = new Set()
  for (const event of out) {
    const id = event.data?.compactionId ?? event.data?.source?.compactionId
    if (typeof id === 'string') carrierIds.add(id)
  }
  const hasCarrier = new Set()
  for (const event of out) {
    if (event.data?.source?.kind !== 'compact-checkpoint') continue
    const id = event.data?.source?.compactionId
    if (typeof id === 'string') hasCarrier.add(id)
  }
  const carriersById = new Map()
  for (const event of events) {
    if (event.data?.source?.kind !== 'compact-checkpoint') continue
    const id = event.data?.source?.compactionId
    if (typeof id === 'string') carriersById.set(id, event)
  }
  const groups = new Map()
  for (const event of out) {
    const id = event.data?.compactionId
    if (typeof id !== 'string') continue
    const slot = groups.get(id) ?? { start: false, summary: false, end: false }
    const type = String(event.type)
    if (type === 'compaction/start') slot.start = true
    else if (type === 'compaction/summary') slot.summary = true
    else if (type === 'compaction/end') slot.end = true
    groups.set(id, slot)
  }
  const complete = new Set()
  for (const [id, slot] of groups) {
    // 三项齐全**且** carrier 的 replace 两端都还在保留集里。carrier 的区间端点
    // 指向被它遮蔽的旧消息（例如 11204..12381），前缀一削就没了；`renumber` 会把
    // 端点失效的 carrier 降级成 `append`，summary 随即找不到区间而被丢掉。
    // 端点不保，整组就留不住 —— 一起丢，比留个半套（start+end 无 summary）强。
    const carrier = carriersById.get(id)
    const endpointsKept =
      carrier !== undefined &&
      carrier.surfaceOp !== null &&
      typeof carrier.surfaceOp === 'object' &&
      out.includes(carrier) &&
      out.some((event) => event.seq === Number(carrier.surfaceOp.startSeq)) &&
      out.some((event) => event.seq === Number(carrier.surfaceOp.endSeq))
    if (slot.start && slot.summary && slot.end && endpointsKept) complete.add(id)
  }
  void carrierIds
  const pruned = out.filter((event) => {
    if (String(event.type).startsWith('compaction/') === false) return true
    const id = event.data?.compactionId
    if (typeof id !== 'string') return true
    return complete.has(id)
  })
  out.length = 0
  for (const event of pruned) out.push(event)

  // 保留集里带着 `turn`/`step` 却没有对应 `turn/start`、`step/start` 的事件是
  // **孤儿**：前缀被裁时开括号落在被丢弃的那一段，闭括号（或 tool/result 这类
  // 带 turn/step 的消息）却因为仍在表面上被留了下来。宿主的格式层拿孤儿事件
  // 去比对「当前开着的 turn/step」，必报 `tool/result does not match an open turn
  // and step`（实测 184f1813 / 6df74bd5 / 7fdb94ec / d3089018）。
  //
  // 修法是把**开括号**补回保留集，而不是丢正文：这些轮次本来就有一半在尾巴里，
  // 补上 turn/start + step/start 之后整轮自洽。
  // 保留集里带着 `turn`/`step` 却没有对应开括号的事件是**孤儿**（开括号落在被裁
  // 的前缀里，闭括号却因为仍在表面上被留下），宿主必然报 `tool/result does not
  // match an open turn and step`。这里**整轮**补回来：找到孤儿所属的 turn 号，
  // 把该轮从 turn/start 到 turn/end 的全部事件一起留 —— 只补开括号不够，宿主还
  // 会报 `turn/start does not open the expected turn`（轮次不连续）。
  const kept = new Set(out.map((event) => event.seq))
  const turnsToRestore = new Set()
  for (const event of out) {
    const turn = event.data?.turn
    if (!Number.isSafeInteger(turn)) continue
    if (event.type === 'turn/start' || event.type === 'turn/end') continue
    turnsToRestore.add(turn)
  }
  // 已有 turn/start 的轮次算"正常轮次"，不用补；孤儿才是要补的。
  for (const event of out) {
    if (event.type === 'turn/start' && Number.isSafeInteger(event.data?.turn)) turnsToRestore.delete(event.data.turn)
  }
  if (turnsToRestore.size > 0) {
    for (const event of events) {
      if (!Number.isSafeInteger(event.data?.turn)) continue
      if (!turnsToRestore.has(event.data.turn)) continue
      kept.add(event.seq)
    }
  }
  out.length = 0
  for (const event of events) if (kept.has(event.seq)) out.push(event)
  return { events: out, dropped: events.length - out.length }
}

/**
 * 把 `image/offload` 的 `targets` 裁到「这条事件那一刻的表面」上。
 *
 * 投影校验用的是**该事件被 fold 到那一刻**的节点集合，不是日志末尾的表面：
 *
 * ```js
 * project(event, context) { const nodes = new Set(context.nodes); …
 *   if (!nodes.has(seq)) throw new Error(`image/offload: target seq ${seq} is not a current surface node`) }
 * ```
 *
 * 裁剪把 target 指向的消息移走之后，宿主会拿这条错误拒收整份日志。所以顺序推进
 * 一个和 foldSurface 同构的节点栈，遇到 offload 就用此刻的栈来筛 target：全失效
 * 就整条丢掉（它只是投影记账），部分失效就剪掉失效的那几项。
 *
 * @param {object[]} events - 待写盘的事件（seq 连续）。
 * @returns {{ events: object[], removed: number, pruned: number }} 结果。
 */
export function pruneOffloadTargets(events) {
  const bySeq = new Map(events.map((event) => [event.seq, event]))
  const nodes = []
  const out = []
  let removed = 0
  let pruned = 0
  for (const event of events) {
    if (event.type === 'image/offload') {
      const targets = Array.isArray(event.data?.targets) ? event.data.targets : []
      const alive = targets.filter((target) => {
        const seq = Number(target?.seq)
        const source = bySeq.get(seq)
        return nodes.includes(seq) && source !== undefined && (source.type === 'user/message' || source.type === 'tool/result')
      })
      if (alive.length !== targets.length) {
        pruned += targets.length - alive.length
        if (alive.length === 0) {
          removed += 1
          continue
        }
        event.data = { ...event.data, targets: alive }
      }
    }
    out.push(event)
    const op = event.surfaceOp
    if (op === undefined || op === null) continue
    if (op === 'append') {
      nodes.push(event.seq)
      continue
    }
    if (typeof op === 'object' && op.op === 'replace') {
      const start = Number(op.startSeq)
      const end = Number(op.endSeq)
      const startIdx = nodes.indexOf(start)
      const endIdx = nodes.indexOf(end)
      if (startIdx >= 0 && endIdx >= 0 && startIdx <= endIdx) {
        for (let index = endIdx; index >= startIdx; index -= 1) nodes.splice(index, 1)
      }
      for (const seq of Array.isArray(event.sourceEventSeqs) ? event.sourceEventSeqs : []) {
        const at = nodes.indexOf(seq)
        if (at >= 0) nodes.splice(at, 1)
      }
      nodes.push(event.seq)
    }
  }
  return { events: out, removed, pruned }
}

export async function stageTrim(logFile, keep, options = {}) {
  if (isSessionLocked(logFile)) {
    throw new Error('会话正被宿主持有（session.lock 被打开），拒绝改动；请先关掉该会话或重启宿主')
  }
  const original = await readLogAsync(logFile)
  const trimmed = keepLastWindows(original.events, keep)

  // 走了「可见区域重切」兜底的会话：兜底产物**本身就是最终形态**，它的 checkpoint
  // 区间、system 链尾、goal 遮蔽、inbox 拼接都是按目标结构算好的。再跑
  // `dropShadowedPrefix` / `stripOldStreams` / compaction 清扫这些后处理，会把
  // 精心对齐的结构重新拆掉 —— 实测 5 个会话全被后处理弄成
  // `step/end does not match an open turn and step` 或
  // `compaction checkpoint has no matching compaction/summary`。
  // 所以这条路径直接进入校验/写盘。
  if (trimmed.fallback === true) {
    assertNoGoalEventsDropped(original.events, trimmed.events)
    const renamedFallback = { events: trimmed.events, refsFixed: 0, titlesDropped: 0, compactionDropped: 0 }
    const stampFallback = new Date().toISOString().replace(/[:.]/g, '-')
    const backupFallback = `${logFile}.precompact-${stampFallback}`
    const stagingFallback = `${logFile}.staging-${stampFallback}`
    await fs.promises.writeFile(stagingFallback, await encodeLogAsync(original.header, renamedFallback.events))
    return {
      staging: stagingFallback,
      backup: backupFallback,
      summary: {
        backup: backupFallback,
        before: { events: original.events.length, bytes: original.compressedBytes, windows: trimmed.realWindows },
        after: { events: renamedFallback.events.length, bytes: (await fs.promises.stat(stagingFallback)).size },
        dropped: trimmed.dropped,
        refsFixed: 0,
        titlesDropped: 0,
        compactionDropped: 0,
        stream: { stripped: 0, bytesSaved: 0, keepTurns: null },
        transcript: { before: transcriptRows(original.events), after: transcriptRows(renamedFallback.events) },
        model: { before: foldSurface(original.events).visible.length, after: foldSurface(renamedFallback.events).visible.length },
      },
    }
  }
  // 旧回合的流式回放记录：与 data.message.content 逐块重复，留最近几轮就够。
  const streamKeepTurns = options.streamKeepTurns === undefined ? Infinity : options.streamKeepTurns
  // 先丢掉被 checkpoint 遮蔽的前缀（连续尾巴 + frame），再清流式回放。
  const shadowed = options.shadowPrefix === false ? { events: trimmed.events, dropped: 0 } : dropShadowedPrefix(trimmed.events)
  const stripped = stripOldStreams(shadowed.events, streamKeepTurns)
  assertNoGoalEventsDropped(original.events, stripped.events)
  if (trimmed.cutSeq === null && shadowed.dropped === 0) throw new Error(`只有 ${trimmed.realWindows} 个窗口，不需要裁`)
  let renamed = renumber(stripped.events)
  const repaired = repairLateToolResults(renamed.events)
  if (repaired.moved > 0 || repaired.dropped > 0) {
    // 挪动会改变 seq，重新编号一次让所有引用跟上。
    renamed = renumber(repaired.events)
  }

  // `image/offload` 的 targets 指向的是投影那一刻的表面节点：裁剪把它们移走之后
  // 宿主会拒收整份日志（`target seq N is not a current surface node`）。按每条
  // offload 自己那一刻的节点栈筛一遍，全失效的整条丢掉。
  //
  // 必须**迭代到稳定**：丢掉整条 offload 会让后面的 seq 全部前移，那些 target
  // 又指到了别的东西上（实测 25515ab4 第二轮就撞 `target seq 2535`）。每轮重编
  // 之后重筛，直到只剩"删 target 项"（事件数不变、seq 不变）为止。
  for (let round = 0; round < 6; round += 1) {
    const pruned = pruneOffloadTargets(renamed.events)
    if (pruned.removed === 0) {
      // 只剪了 target 项，seq 没动，可以收工。
      if (pruned.pruned > 0) renamed = { ...renamed, events: pruned.events }
      break
    }
    renamed = renumber(pruned.events)
  }

  // `llm/retry` / `llm/retry-started` 必须能找到一个**在它之前**、provider 相同的
  // `request/header`（宿主逐条校验 `llm/retry provider does not match the open
  // request/header`）。前缀与窗口一起裁之后，某些 retry 前面那条 header 被删掉，
  // 产物一开头就是一批悬空的 retry（实测 25515ab4 剩 22 条）。
  //
  // 收尾办法：扫一遍产物，维护"当前开着的 header provider"；provider 对不上的
  // retry 去**原日志**里按 `retryId` 找回它，再取原日志里它之前最近的那条 header，
  // 把这条 header 的内容补进产物并重编。补不回来才丢那批 retry。
  for (let round = 0; round < 6; round += 1) {
    const missing = []
    let currentProvider = null
    for (const event of renamed.events) {
      if (event.type === 'request/header') {
        currentProvider = event.data?.header?.config?.provider ?? null
        continue
      }
      if (event.type !== 'llm/retry' && event.type !== 'llm/retry-started') continue
      const provider = event.data?.provider
      if (provider !== undefined && provider !== currentProvider) missing.push(event)
    }
    if (missing.length === 0) break
    const originalById = new Map()
    for (const event of original.events) {
      const id = event.data?.retryId
      if (typeof id === 'string') originalById.set(id, event)
    }
    const wantHeaders = new Set()
    const dropIds = new Set()
    for (const event of missing) {
      const id = event.data?.retryId
      const origin = typeof id === 'string' ? originalById.get(id) : undefined
      if (origin === undefined) {
        dropIds.add(id ?? null)
        continue
      }
      const header = original.events
        .filter((candidate) => candidate.type === 'request/header' && candidate.seq < origin.seq)
        .pop()
      if (header === undefined) {
        dropIds.add(id ?? null)
        continue
      }
      wantHeaders.add(header.seq)
    }
    if (wantHeaders.size === 0 && dropIds.size === 0) break
    const additions = []
    for (const headerSeq of wantHeaders) {
      const header = original.events.find((candidate) => candidate.seq === headerSeq)
      if (header !== undefined) additions.push(structuredClone(header))
    }
    const filtered = dropIds.size === 0
      ? renamed.events
      : renamed.events.filter((event) => {
          const id = event.data?.retryId
          return !(typeof id === 'string' && dropIds.has(id))
        })
    if (additions.length === 0 && filtered.length === renamed.events.length) break
    // 插到**它该在的位置**，不是追加到末尾：`request/header` 排在最前面才会被
    // 后面的 retry 当成"开着的"。先按原日志 seq 决定插入点（用第一条 retry 在
    // 产物里的位置当锚），再重编。
    const firstRetryAt = filtered.findIndex(
      (event) => event.type === 'llm/retry' || event.type === 'llm/retry-started',
    )
    const insertAt = firstRetryAt < 0 ? 0 : firstRetryAt
    renamed = renumber([
      ...filtered.slice(0, insertAt),
      ...additions,
      ...filtered.slice(insertAt),
    ])
  }

  // compaction 必须**整组齐全**（`start` + `summary` + `end`，同一个 compactionId）。
  // 只留下一个孤立的 `compaction/start`，宿主在后面遇到 `turn/end` 时报
  // `turn/end crosses an open compaction`（实测 25515ab4 / 50d48342 / a982e317
  // 各剩 4 个孤立 start）。这些是纯记账行，不占模型视图，缺项就整组丢掉。
  for (let round = 0; round < 6; round += 1) {
    const kept = new Set(renamed.events.map((e) => e.seq))
    const groups = new Map()
    for (const event of renamed.events) {
      if (!String(event.type).startsWith('compaction/')) continue
      const id = event.data?.compactionId
      if (typeof id !== 'string') continue
      const slot = groups.get(id) ?? { start: false, summary: false, end: false }
      const type = String(event.type)
      if (type === 'compaction/start') slot.start = true
      else if (type === 'compaction/summary') slot.summary = true
      else if (type === 'compaction/end') slot.end = true
      groups.set(id, slot)
    }
    let dropped = 0
    for (const event of renamed.events) {
      if (!String(event.type).startsWith('compaction/')) continue
      const id = event.data?.compactionId
      if (typeof id !== 'string') continue
      const slot = groups.get(id)
      if (slot !== undefined && slot.start && slot.summary && slot.end) continue
      kept.delete(event.seq)
      dropped += 1
    }
    if (dropped === 0) break
    renamed = renumber(renamed.events.filter((e) => kept.has(e.seq)))
  }

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
  await fs.promises.writeFile(staging, await encodeLogAsync(original.header, renamed.events))
  return {
    staging,
    backup,
    summary: {
      backup,
      before: { events: original.events.length, bytes: original.compressedBytes, windows: trimmed.realWindows },
      after: { events: renamed.events.length, bytes: (await fs.promises.stat(staging)).size },
      dropped: trimmed.dropped + shadowed.dropped,
      refsFixed: renamed.refsFixed,
      titlesDropped: renamed.titlesDropped,
      compactionDropped: renamed.compactionDropped,
      stream: { stripped: stripped.stripped, bytesSaved: stripped.bytesSaved, keepTurns: streamKeepTurns === Infinity ? null : streamKeepTurns },
      transcript: { before: transcriptRows(original.events), after: transcriptRows(renamed.events) },
      model: { before: foldSurface(original.events).visible.length, after: foldSurface(renamed.events).visible.length },
    },
  }
}

/**
 * 暂存文件换到正式位置：原文件改名成备份，暂存改名成正式文件。
 *
 * @param {{ staging: string, backup: string, summary: object }} staged - 暂存信息。
 * @param {string} logFile - 原日志路径。
 * @returns {object} 结果摘要。
 */
export async function commitTrim(staged, logFile) {
  // 先复制出备份再替换：两次 rename 之间崩溃会让日志短暂不存在，会话直接消失。
  await fs.promises.copyFile(logFile, staged.backup)
  await fs.promises.rename(staged.staging, logFile)
  return staged.summary
}

/**
 * 落盘：**先验后写**。
 *
 * 校验用的是宿主自己的校验器（格式层 / 会话层 / 投影层，见 verify-session-log.mjs）——
 * 日志格式的规则全在宿主里，自己写一份"我以为对"的校验已经付过八次代价。验不过就
 * 删掉暂存文件、原文件一个字节都不动。
 *
 * @param {string} logFile - 原日志。
 * @param {number} keep - 保留最后几窗。
 * @param {{ verify?: boolean }} [options] - `verify: false` 跳过校验（等于 `--no-verify`）。
 * @returns {Promise<object>} 结果摘要。
 */
export async function applyTrim(logFile, keep, options = {}) {
  let staged = await stageTrim(logFile, keep, options)
  if (options.verify !== false) {
    let result
    try {
      const { verifyLog } = await import('./verify-session-log.mjs')
      result = await verifyLog(staged.staging)
    } catch (error) {
      fs.rmSync(staged.staging, { force: true })
      throw new Error(`校验器跑不起来，未写入（确实要跳过就用 --no-verify）：${error instanceof Error ? error.message : String(error)}`)
    }
    if (!result.ok) {
      fs.rmSync(staged.staging, { force: true })
      // 丢掉「被 checkpoint 遮蔽的前缀」是收益、不是前提：这份日志上它可能撞到
      // compaction / 标题 / inbox 的结构约束。退回不丢前缀的老做法再验一次，
      // 两次都不过才真的失败。
      if (options.shadowPrefix !== false) {
        staged = await stageTrim(logFile, keep, { ...options, shadowPrefix: false })
        const retried = await (async () => {
          const { verifyLog } = await import('./verify-session-log.mjs')
          return verifyLog(staged.staging)
        })()
        if (retried.ok) return commitTrim(staged, logFile)
        fs.rmSync(staged.staging, { force: true })
        const bad = retried.checks.filter((check) => !check.ok).map((check) => `${check.name} ${check.detail}`).join('；')
        // 两次都不过：如果退回后本来就“不需要裁”，那是这份日志结构不适合丢前缀，
        // 当成跳过而不是失败（扫描不该因为收益型优化失败而报错）。
        if (String(bad).includes('不需要裁')) throw new Error('不需要裁（前缀清理在这份日志上过不了宿主校验）')
        throw new Error(`裁剪结果没通过宿主校验，未写入：${bad}`)
      }
      const bad = result.checks.filter((check) => !check.ok).map((check) => `${check.name} ${check.detail}`).join('；')
      throw new Error(`裁剪结果没通过宿主校验，未写入：${bad}`)
    }
  }
  return commitTrim(staged, logFile)
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
    console.log(`只有 ${trimmed.realWindows} 个窗口，不需要裁。`)
    return
  }
  const renamed = renumber(trimmed.events)
  const bytes = encodeLog(original.header, renamed.events)
  fs.writeFileSync(target, bytes)
  console.log(`原日志    ${file}`)
  console.log(`窗口      ${trimmed.realWindows} 个 → 保留最后 ${keep} 个（切点 seq ${trimmed.cutSeq}）`)
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
          const result = await applyTrim(file, keep, { verify: !args.includes('--no-verify') })
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
        const result = await applyTrim(resolveLog(positional[0]), keep, { verify: !args.includes('--no-verify') })
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
