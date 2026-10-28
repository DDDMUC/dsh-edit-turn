#!/usr/bin/env node
/**
 * 用**宿主自己的校验器**验一份会话日志能不能加载。
 *
 * 为什么要这个：会话日志的格式校验散在 `@deepseek-ai/dsh-session-persistence-jsonl`
 * 里（上千行），抄一份必抄漏。这个脚本直接从 DeepSeek Harness 的 app.asar 里把那个
 * 校验 worker 抽出来跑，得到的结论和宿主加载时一字不差。
 *
 * 用法：
 *
 *   node tools/verify-log.mjs <会话目录 | 日志文件> [--app <Harness.app 路径>] [--quiet]
 *
 * 退出码：0 能加载；1 不能加载（打印宿主原话）；2 环境问题（找不到 app.asar 等）。
 *
 * 注意：只读。不写日志、不碰 session.lock。
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'
import { Worker } from 'node:worker_threads'
import { pathToFileURL } from 'node:url'

const DEFAULT_APP = '/Applications/DeepSeek Harness.app'
const ZSTD_MAGIC = 0xfd2fb528
const WORKER_REL = 'dsh/node_modules/@deepseek-ai/dsh-session-persistence-jsonl/lib/worker.cjs'

/**
 * 把 app.asar 里的某个文件抽到磁盘上（worker 需要真实路径才能被 Worker 加载）。
 *
 * asar 的结构：16 字节头（第 4..7 字节是 pickle 长度）+ JSON 目录 + 拼接的文件体。
 *
 * @param {string} asar - app.asar 路径。
 * @param {string} wanted - asar 内的相对路径。
 * @param {string} target - 抽到哪。
 * @returns {boolean} 抽到了为 true。
 */
function extractFromAsar(asar, wanted, target) {
  const fd = fs.openSync(asar, 'r')
  try {
    const head = Buffer.alloc(16)
    fs.readSync(fd, head, 0, 16, 0)
    const base = 8 + head.readUInt32LE(4)
    const jsonLength = head.readUInt32LE(12)
    const headerBuffer = Buffer.alloc(jsonLength)
    fs.readSync(fd, headerBuffer, 0, jsonLength, 16)
    const header = JSON.parse(headerBuffer.toString('utf8').replace(/\0+$/g, ''))
    let node = header
    for (const part of wanted.split('/')) {
      node = node?.files?.[part]
      if (node === undefined) return false
    }
    if (node.unpacked === true || node.offset === undefined || node.size === undefined) return false
    const bytes = Buffer.alloc(node.size)
    if (node.size > 0) fs.readSync(fd, bytes, 0, node.size, base + Number(node.offset))
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, bytes)
    return true
  } finally {
    fs.closeSync(fd)
  }
}

/** 日志里的事件条数（不含头部）。多帧 zstd 逐帧解压，按帧魔数切。 */
function countEvents(file) {
  const buf = fs.readFileSync(file)
  if (buf.length < 4 || buf.readUInt32LE(0) !== ZSTD_MAGIC) {
    return buf.toString('utf8').split('\n').filter((line) => line.trim() !== '').length - 1
  }
  const starts = []
  for (let i = 0; i + 4 <= buf.length; i += 1) {
    if (buf.readUInt32LE(i) === ZSTD_MAGIC) starts.push(i)
  }
  let text = ''
  for (let k = 0; k < starts.length; k += 1) {
    const end = k + 1 < starts.length ? starts[k + 1] : buf.length
    try {
      text += zlib.zstdDecompressSync(buf.subarray(starts[k], end)).toString('utf8')
    } catch {
      // 单帧坏了不影响计数：真正的结论交给宿主的校验器。
    }
  }
  return text.split('\n').filter((line) => line.trim() !== '').length - 1
}

/** 会话目录 → 当前日志文件；也可以直接给日志文件。 */
function resolveLog(target) {
  const stat = fs.statSync(target)
  if (stat.isDirectory()) {
    const candidates = fs
      .readdirSync(target)
      .filter((name) => /^session\.v\d+\.jsonl(\.zstd)?$/.test(name))
      .sort()
    const hit = candidates.find((name) => name.endsWith('.zstd')) ?? candidates[0]
    if (hit === undefined) throw new Error(`${target} 里没有 session.v*.jsonl*`)
    return path.join(target, hit)
  }
  return target
}

/** 会话 id：优先读头部，读不到就用目录名兜底。 */
function sessionId(logFile) {
  try {
    const buf = fs.readFileSync(logFile)
    const text =
      buf.length >= 4 && buf.readUInt32LE(0) === ZSTD_MAGIC
        ? zlib.zstdDecompressSync(buf.subarray(0, 1 << 20)).toString('utf8')
        : buf.toString('utf8')
    const first = JSON.parse(text.split('\n')[0])
    if (typeof first.id === 'string') return first.id
  } catch {
    // 落到目录名
  }
  const name = path.basename(path.dirname(logFile))
  const hit = name.match(/session-[0-9a-f-]{36}/)
  return hit === null ? name : hit[0]
}

/**
 * 跑宿主的校验 worker。
 *
 * @param {string} workerPath - 抽出来的 worker.cjs。
 * @param {string} logFile - 待验日志。
 * @param {string} id - 会话 id。
 * @param {number} count - 期望事件数（worker 用它核对条数）。
 * @param {'zstd'|'none'} compression - 按内容判断，别看扩展名（备份文件名会带后缀）。
 * @returns {Promise<string|null>} 通过返回 null，否则返回宿主的错误原话。
 */
function verify(workerPath, logFile, id, count, compression) {
  return new Promise((resolve) => {
    const worker = new Worker(workerPath, {
      workerData: { path: logFile, compression, expectedId: id, expectedEventCount: count },
    })
    let settled = false
    const done = (value) => {
      if (settled) return
      settled = true
      resolve(value)
      worker.terminate().catch(() => {})
    }
    worker.on('message', (message) => done(message.ok === true ? null : String(message.message ?? '未知错误')))
    worker.on('error', (error) => done(error instanceof Error ? error.message : String(error)))
    worker.on('exit', () => done('校验 worker 提前退出'))
  })
}

const isMain = process.argv[1] !== undefined && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
if (isMain) {
  const args = process.argv.slice(2)
  const quiet = args.includes('--quiet')
  const appAt = args.indexOf('--app')
  const app = appAt >= 0 ? args[appAt + 1] : DEFAULT_APP
  const positional = args.filter((value, index) => !value.startsWith('--') && (appAt < 0 || index !== appAt + 1))
  try {
    if (positional[0] === undefined) throw new Error('用法：node tools/verify-log.mjs <会话目录 | 日志文件>')
    const logFile = resolveLog(positional[0])
    const asar = path.join(app, 'Contents/Resources/app.asar')
    if (!fs.existsSync(asar)) throw new Error(`找不到 ${asar}（用 --app 指定 Harness.app）`)
    // worker 会 `require('../package.json')`，所以要把包目录的骨架一起抽出来。
    const pkgRoot = path.join(os.tmpdir(), 'dsh-verify-log', 'session-persistence-jsonl')
    const workerPath = path.join(pkgRoot, 'lib', 'worker.cjs')
    const pkgFile = path.join(pkgRoot, 'package.json')
    if (!extractFromAsar(asar, WORKER_REL, workerPath)) throw new Error('app.asar 里没有会话校验 worker')
    extractFromAsar(asar, WORKER_REL.replace(/\/lib\/worker\.cjs$/, '/package.json'), pkgFile)
    const count = countEvents(logFile)
    const head = fs.readFileSync(logFile).subarray(0, 4)
    const compression = head.length === 4 && head.readUInt32LE(0) === ZSTD_MAGIC ? 'zstd' : 'none'
    const failure = await verify(workerPath, logFile, sessionId(logFile), count, compression)
    if (failure === null) {
      if (!quiet) console.log(`✔ 能加载：${count} 条事件  ${logFile}`)
      process.exit(0)
    }
    console.error(`✘ 加载失败：${failure}`)
    console.error(`  ${logFile}`)
    process.exit(1)
  } catch (error) {
    console.error(`环境问题：${error instanceof Error ? error.message : String(error)}`)
    process.exit(2)
  }
}
