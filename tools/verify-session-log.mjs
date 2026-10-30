/**
 * 用**宿主自己的校验器**验一份会话日志，验不过就别落盘。
 *
 * 这是这次做会话裁剪时踩出来的教训：日志格式的规则全在宿主里，而且分三层。自己
 * 写一份"我以为对"的校验，结果是连续八次被宿主拒收（`title messageSeqs must name
 * an earlier event`、`delivery throughSeq must precede its marker`、`system/message
 * does not match an open turn and step`、`request/header is outside an open turn`、
 * `turn/start does not open the expected turn`、`compaction shadowedSeqs do not name
 * an exact current surface span`、`format v4 event N is not dense`、`successful
 * compaction/end requires one summary`）。所以这里直接把宿主的包从 app.asar 里取出来跑。
 *
 * 五重校验：
 *   ① 格式层   `dsh-session-format-v3-to-v4` 的 `restoreReleasedV4Artifact`
 *   ② 会话层   `dsh-session` 的 `adoptSessionEvent` + `foldSurface`
 *   ③ 交叉引用 所有指向本会话其它事件的字段（`*Seq` / `*Seqs` / `*Range`）都必须存在且更早
 *   ④ inbox    `agent/inbox/spliced` 按投影层的规则重放（`start` 必须落在当前长度内）
 *   ⑤ 结构     seq 从 0 连续、表面替换的两端都在表面里
 *
 * 用法：
 *   node tools/verify-session-log.mjs <日志文件>
 *   node tools/verify-session-log.mjs <日志文件> --json
 */

import fs from 'node:fs'
import { pathToFileURL } from 'node:url'
import { loadHostLibs } from './lib/host-libs.mjs'
import { readLog, normalizeRefs, isCheckpoint } from './compact-session.mjs'

/** 不以 `Seq` 结尾、但同样指向本会话 seq 的字段（本仓库插件自己写的）。 */
const EXTRA_SEQ_FIELDS = new Set(['logFrom', 'logTo', 'rerunTurnEnd'])

/**
 * 检查项 ⑤：seq 连续、表面替换的端点合法。
 *
 * @param {Array<object>} events - 事件数组。
 * @returns {string|null} 违规说明，通过返回 null。
 */
function checkStructure(events) {
  const seqs = new Set(events.map((event) => event.seq))
  for (let index = 0; index < events.length; index += 1) {
    if (events[index].seq !== index) return `第 ${index} 条事件的 seq 是 ${events[index].seq}，不连续`
  }
  for (const event of events) {
    const op = event.surfaceOp
    if (op === null || op === undefined || typeof op !== 'object') continue
    for (const key of ['startSeq', 'endSeq']) {
      const seq = op[key]
      if (!seqs.has(seq)) return `seq ${event.seq} 的 surfaceOp.${key} 指向不存在的 ${seq}`
      if (seq >= event.seq) return `seq ${event.seq} 的 surfaceOp.${key} = ${seq} 不比它更早`
    }
    if (op.startSeq > op.endSeq) return `seq ${event.seq} 的 surfaceOp 区间倒序（${op.startSeq}-${op.endSeq}）`
  }
  return null
}

/**
 * 检查项 ③：所有指向本会话其它事件的字段。
 *
 * @param {Array<object>} events - 事件数组。
 * @returns {string|null} 违规说明，通过返回 null。
 */
function checkReferences(events) {
  const seqs = new Set(events.map((event) => event.seq))
  const problems = []
  const walk = (value, trail, at) => {
    if (Array.isArray(value)) {
      value.forEach((item, index) => walk(item, `${trail}[${index}]`, at))
      return
    }
    if (value === null || typeof value !== 'object') {
      const leaf = String(trail).split('.').pop() ?? ''
      if (typeof value === 'number' && (/(Seq|Seqs|Range)$/.test(leaf) || EXTRA_SEQ_FIELDS.has(leaf))) {
        if (!seqs.has(value)) problems.push(`seq ${at}: ${trail} = ${value} 不存在`)
        else if (value >= at) problems.push(`seq ${at}: ${trail} = ${value} 不比它更早`)
      }
      return
    }
    for (const [key, item] of Object.entries(value)) walk(item, trail === '' ? key : `${trail}.${key}`, at)
  }
  for (const event of events) {
    if (Number.isSafeInteger(event.data?.throughSeq)) continue // throughSeq 指向别的会话，另有规则
    walk(event.data ?? {}, '', event.seq)
  }
  return problems.length === 0 ? null : problems.slice(0, 5).join('；')
}

/**
 * 检查项 ④：按投影层的规则重放 inbox 拼接。
 *
 * 规则照抄 `@deepseek-ai/dsh-agent-loop` 的 inbox 投影：`start` 与 `removedCount` 必须
 * 落在当前 inbox 长度内，且插入后两条 inbox 合起来不能有重复的消息 id。
 *
 * @param {Array<object>} events - 事件数组。
 * @returns {string|null} 违规说明，通过返回 null。
 */
function checkInbox(events) {
  const state = { 'next-turn': [], 'next-step': [] }
  for (const event of events) {
    if (event.type !== 'agent/inbox/spliced') continue
    const splice = event.data ?? {}
    const list = state[splice.target]
    const removed = splice.removedCount ?? 0
    if (list === undefined) return `seq ${event.seq}: 未知的 inbox target ${JSON.stringify(splice.target)}`
    if (!Number.isSafeInteger(splice.start) || splice.start < 0 || splice.start > list.length) {
      return `seq ${event.seq}: start ${splice.start} 越界（当前长度 ${list.length}）`
    }
    if (!Number.isSafeInteger(removed) || removed < 0 || splice.start + removed > list.length) {
      return `seq ${event.seq}: removedCount 越界`
    }
    if (!Array.isArray(splice.inserted)) return `seq ${event.seq}: inserted 不是数组`
    const next = list.toSpliced(splice.start, removed, ...splice.inserted)
    const ids = new Set()
    const all = splice.target === 'next-turn' ? [...next, ...state['next-step']] : [...state['next-turn'], ...next]
    for (const message of all) {
      if (ids.has(message.id)) return `seq ${event.seq}: 消息 ${message.id} 重复`
      ids.add(message.id)
    }
    state[splice.target] = next
  }
  return null
}

/**
 * 检查项 ①：格式层。
 *
 * @param {Array<object>} events - 事件数组。
 * @param {object} header - 头部记录（不含 `type`）。
 * @param {object} libs - 宿主库。
 * @returns {string|null} 违规说明，通过返回 null。
 */
function checkFormat(events, header, libs) {
  // fork（isSeeded）的日志里，继承前缀以最后一条 `session/end-seed {inherited:true}` 结尾，
  // 而格式层要求"头里记的继承数"正好等于那条标记的**下标**。
  const lastInherited = events.reduce((found, event, index) => {
    if (event.type === 'session/end-seed' && event.data?.inherited === true) return index
    return found
  }, undefined)
  const inheritedEventCount = lastInherited ?? 0
  if (header.isSeeded === true && lastInherited === undefined) return 'isSeeded 的会话缺少 inherited end-seed 标记'
  if (header.isSeeded !== true && lastInherited !== undefined) return '非 fork 的会话里出现了 inherited end-seed 标记'
  try {
    libs.formatV3ToV4.restoreReleasedV4Artifact({ header, events, inheritedEventCount }, libs.session.KNOWN_SESSION_EVENT_TYPES)
    return null
  } catch (error) {
    return `${error.constructor.name}: ${error.message}`
  }
}

/**
 * 检查项 ②：会话层（逐条准入 + 表面折叠）。
 *
 * @param {Array<object>} events - 事件数组。
 * @param {object} libs - 宿主库。
 * @returns {{ error: string|null, visible: number }} 结果与可见节点数。
 */
function checkSession(events, libs) {
  try {
    for (const event of events) libs.session.adoptSessionEvent(structuredClone(event))
  } catch (error) {
    return { error: `adoptSessionEvent: ${error.message}`, visible: 0 }
  }
  try {
    const fold = libs.session.foldSurface(events)
    return { error: null, visible: fold.nodes.length }
  } catch (error) {
    return { error: `foldSurface: ${error.message}`, visible: 0 }
  }
}

/**
 * 检查标题规则：`fallback` 来源的标题必须至少指向一条更早的消息；用户命名的标题允许为空。
 *
 * @param {Array<object>} events - 事件数组。
 * @returns {string|null} 违规说明，通过返回 null。
 */
function checkTitles(events) {
  for (const event of events) {
    if (event.type !== 'session/title') continue
    if (event.data?.source?.kind !== 'fallback') continue
    const seqs = normalizeRefs(event.data?.messageSeqs)
    if (seqs === null || seqs.length === 0) return `seq ${event.seq}: fallback 标题的 messageSeqs 为空`
    const bad = seqs.filter((seq) => seq >= event.seq)
    if (bad.length > 0) return `seq ${event.seq}: fallback 标题的 messageSeqs 指向 ${bad.join(',')}（必须更早）`
  }
  return null
}

/**
 * 验一份会话日志。
 *
 * @param {string} logFile - 日志文件路径。
 * @param {{ libs?: object }} [options] - 可传入已加载的宿主库以复用。
 * @returns {Promise<{ ok: boolean, checks: Array<{ name: string, ok: boolean, detail: string }>, events: number, visible: number }>} 结果。
 */
export async function verifyLog(logFile, options = {}) {
  const libs = options.libs ?? (await loadHostLibs())
  const log = readLog(logFile)
  const { type: _type, ...header } = log.header ?? {}
  const checks = []

  const formatError = checkFormat(log.events, header, libs)
  checks.push({ name: '格式层', ok: formatError === null, detail: formatError ?? '通过' })

  const sessionResult = checkSession(log.events, libs)
  checks.push({ name: '会话层', ok: sessionResult.error === null, detail: sessionResult.error ?? `可见节点 ${sessionResult.visible}` })

  const refError = checkReferences(log.events)
  checks.push({ name: '交叉引用', ok: refError === null, detail: refError ?? '所有引用都存在且更早' })

  const inboxError = checkInbox(log.events)
  checks.push({ name: 'inbox 投影', ok: inboxError === null, detail: inboxError ?? '拼接重放通过' })

  const structureError = checkStructure(log.events)
  checks.push({ name: '结构', ok: structureError === null, detail: structureError ?? `seq 0..${log.events.length - 1} 连续` })

  const titleError = checkTitles(log.events)
  checks.push({ name: '标题', ok: titleError === null, detail: titleError ?? '合法' })

  return {
    ok: checks.every((check) => check.ok),
    checks,
    events: log.events.length,
    visible: sessionResult.visible,
    checkpoints: log.events.filter((event) => isCheckpoint(event)).length,
  }
}

const isMain = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href

if (isMain) {
  const args = process.argv.slice(2)
  const json = args.includes('--json')
  const file = args.find((arg) => !arg.startsWith('--'))
  if (file === undefined) {
    console.error('用法: node tools/verify-session-log.mjs <日志文件> [--json]')
    process.exit(2)
  }
  if (!fs.existsSync(file)) {
    console.error(`✗ 文件不存在：${file}`)
    process.exit(2)
  }
  try {
    const result = await verifyLog(file)
    if (json) {
      console.log(JSON.stringify(result, null, 2))
    } else {
      console.log(`文件 ${file}`)
      console.log(`事件 ${result.events}；检查点 ${result.checkpoints}；可见节点 ${result.visible}`)
      for (const check of result.checks) {
        console.log(`  ${check.ok ? '✔' : '✘'} ${check.name}  ${check.detail}`)
      }
      console.log(result.ok ? '全部通过 ✔' : '存在不通过项 ✘')
    }
    process.exit(result.ok ? 0 : 1)
  } catch (error) {
    console.error(`✗ 校验器无法运行：${error.message}`)
    process.exit(2)
  }
}
