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
      for (let i = nodes.length - 1; i >= 0; i -= 1) {
        const seq = nodes[i]
        if (seq >= start && seq <= end) {
          nodes.splice(i, 1)
          dropped.add(seq)
        }
      }
      // 契约要求 replace 把它覆盖的节点列全；列出但不在这段里的，同样算摘掉。
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
  return { visible: nodes, dropped }
}

/** 一条事件属于哪一步（turn:step），用于把工具调用与它的消息绑在一起。 */
function stepKey(event) {
  const data = event.data ?? {}
  const turn = Number(data.turn)
  const step = Number(data.step)
  if (!Number.isFinite(turn) || !Number.isFinite(step)) return null
  return `${turn}:${step}`
}

/** 消息类事件：会进入模型上下文的那几种。 */
const MESSAGE_TYPES = new Set([
  'user/message',
  'assistant/message',
  'system/message',
  'developer/message',
  'tool/result',
])

/** 保留但不算消息的结构事件：没有它们，折叠器不知道轮次从哪到哪。 */
const STRUCTURE_TYPES = new Set(['turn/start', 'turn/end'])

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
function classify(event, visibleSet, visibleSteps) {
  const type = String(event.type ?? '')
  if (STRUCTURE_TYPES.has(type)) return { keep: true, why: 'turn 边界' }
  if (type === 'tool/call' || type === 'tool/result') {
    // 工具调用和它的结果必须同进同出：留下调用却丢掉结果，模型会看到一个
    // 永远等不到返回的工具调用，provider 直接报错。它们挂在同一个 (turn, step)
    // 的 assistant 消息下，所以跟着那条消息走。
    const step = stepKey(event)
    if (step === null) return { keep: true, why: '工具事件（无法定位所属步）' }
    return visibleSteps.has(step)
      ? { keep: true, why: '可见步的工具事件' }
      : { keep: false, why: '所属步已被遮蔽' }
  }
  if (MESSAGE_TYPES.has(type)) {
    return visibleSet.has(event.seq)
      ? { keep: true, why: '可见消息' }
      : { keep: false, why: '被 replace 遮蔽' }
  }
  if (type.startsWith('compaction/')) {
    return { keep: false, why: '宿主压缩书签（折进账本）' }
  }
  if (type.startsWith(OPS_PREFIX)) {
    // 补丁/重跑/删除的记录：内容会被折进消息、或转成账本条目。
    return { keep: false, why: '操作记录（折进消息或账本）' }
  }
  if (type === 'step/start' || type === 'step/end') return { keep: false, why: '步进元数据' }
  if (type.startsWith('job/')) return { keep: false, why: '任务簿记' }
  if (type === 'agent/inbox/spliced') return { keep: false, why: '拼接痕迹' }
  if (type === 'session/end-seed') return { keep: false, why: '种子收尾' }
  if (type === 'feedback/message-delete' || type === 'feedback/message-put' || type === 'feedback/record') {
    return { keep: false, why: '反馈记录' }
  }
  // 其余一律留着：agent-preset/selected、approval/*、command/*、未知类型……
  return { keep: true, why: '保留（不在可丢清单里）' }
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
  const visibleSet = new Set(visible)
  // 可见的 (turn, step)：工具调用/结果据此决定去留。
  const visibleSteps = new Set()
  for (const event of events) {
    if (!visibleSet.has(event.seq)) continue
    if (event.type !== 'assistant/message') continue
    const step = stepKey(event)
    if (step !== null) visibleSteps.add(step)
  }

  let keepRaw = 0
  let keepCount = 0
  const droppedByType = new Map()
  const keptByType = new Map()
  for (const event of events) {
    const verdict = classify(event, visibleSet, visibleSteps)
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
      const report = estimate(resolveLog(positional[0]))
      if (asJson) console.log(JSON.stringify(report, null, 2))
      else printReport(report)
    }
  } catch (error) {
    console.error(`失败：${error instanceof Error ? error.message : String(error)}`)
    process.exit(1)
  }
}
