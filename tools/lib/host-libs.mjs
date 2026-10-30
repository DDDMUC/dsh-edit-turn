/**
 * 从 DSH 应用的 `app.asar` 里取出宿主的真实校验器，供本工具"先验后写"使用。
 *
 * 为什么不能自己写一份校验：日志格式的规则是宿主定的，而且分了层——格式层
 * （`dsh-session-format-v3-to-v4`）、会话层（`dsh-session`）、投影层
 * （`dsh-agent-loop` 的 inbox 拼接）。自己实现一份只会得到"我以为对"的结果，
 * 实测代价是连续八次被宿主拒收。所以直接把宿主的代码取出来跑。
 *
 * 取出来的包缓存在 `~/.cache/dsh-edit-turn/host-libs/<版本>/`，只在首次或版本变化时
 * 解包。缓存目录里放一个 `loader.mjs`，由它 `import` 那些包再转出去——裸包名是按
 * "引用它的文件所在目录"解析的，所以那个 loader 必须待在缓存目录里。
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

/** 需要取出的包（含它们的依赖，缺一个都会加载失败）。 */
export const HOST_PACKAGES = [
  '@deepseek-ai/dsh-session',
  '@deepseek-ai/dsh-session-format',
  '@deepseek-ai/dsh-session-format-v0-to-v1',
  '@deepseek-ai/dsh-session-format-v1-to-v2',
  '@deepseek-ai/dsh-session-format-v2-to-v3',
  '@deepseek-ai/dsh-session-format-v3-to-v4',
  '@deepseek-ai/dsh-session-format-catalog',
  '@deepseek-ai/dsh-util-values',
  '@deepseek-ai/dsh-brand',
  '@deepseek-ai/dsh-scope',
  '@deepseek-ai/dsh-llm',
  '@deepseek-ai/dsh-util-crypto',
  '@deepseek-ai/dsh-timeout',
  '@deepseek-ai/dsh-typert-protocol',
  '@deepseek-ai/dsh-compaction-image-offload',
  '@deepseek-ai/cordis',
  '@deepseek-ai/cosmokit',
  '@deepseek-ai/schemastery',
]

/** 默认的 asar 位置（可用 `DSH_ASAR` 覆盖）。 */
export const DEFAULT_ASAR = '/Applications/DeepSeek Harness.app/Contents/Resources/app.asar'

/**
 * 找到可用的 asar。
 *
 * @returns {string|null} 路径，找不到返回 null。
 */
export function findAsar() {
  const candidates = [process.env.DSH_ASAR, DEFAULT_ASAR].filter((value) => typeof value === 'string' && value !== '')
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate
  }
  return null
}

/**
 * 读出 asar 的文件表。
 *
 * 注意头部偏移：asar 的记录是 `[8 字节 pickle 头][JSON][对齐填充]`，而 JSON 里的
 * 文件偏移是相对**数据段起点**的，数据段起点 = `8 + headerSize`。这里曾经写成
 * `16 + headerSize`，于是每个文件都错位 8 字节，解出来的 JS 全部截断不可解析 ——
 * 那正是之前"没法用宿主自己的校验器"的原因。
 *
 * @param {string} asar - asar 路径。
 * @returns {{ buffer: Buffer, files: Map<string, { offset: number, size: number }> }} 文件表。
 */
export function readAsar(asar) {
  const buffer = fs.readFileSync(asar)
  const headerSize = buffer.readUInt32LE(4)
  const jsonSize = buffer.readUInt32LE(12)
  const header = JSON.parse(buffer.subarray(16, 16 + jsonSize).toString('utf8'))
  const base = 8 + headerSize
  const files = new Map()
  const walk = (node, prefix) => {
    for (const [name, meta] of Object.entries(node.files ?? {})) {
      const full = `${prefix}/${name}`
      if (meta.files !== undefined) walk(meta, full)
      else if (meta.offset !== undefined) files.set(full, { offset: Number(meta.offset), size: Number(meta.size) })
    }
  }
  walk(header, '')
  return { buffer, files, base }
}

/**
 * 确保宿主库已解包，返回可 `import` 的 loader 地址。
 *
 * @param {{ asar?: string, force?: boolean }} [options] - 选项。
 * @returns {Promise<{ url: string, cache: string, asar: string }>} loader 信息。
 */
export async function ensureHostLibs(options = {}) {
  const asar = options.asar ?? findAsar()
  if (asar === null) throw new Error(`找不到 app.asar（可用 DSH_ASAR 指定）`)
  const stamp = `${fs.statSync(asar).size}-${fs.statSync(asar).mtimeMs}`
  const cache = path.join(os.homedir(), '.cache', 'dsh-edit-turn', 'host-libs', stamp.replace(/[^0-9-]/g, '_'))
  const loader = path.join(cache, 'loader.mjs')
  const done = path.join(cache, '.done')
  if (fs.existsSync(done) && fs.existsSync(loader) && options.force !== true) {
    return { url: pathToFileURL(loader).href, cache, asar }
  }

  const { buffer, files, base } = readAsar(asar)
  const missing = []
  for (const pkg of HOST_PACKAGES) {
    const prefix = `/dsh/node_modules/${pkg}/`
    const entries = [...files.entries()].filter(([name]) => name.startsWith(prefix))
    if (entries.length === 0) {
      missing.push(pkg)
      continue
    }
    for (const [name, meta] of entries) {
      const relative = name.slice(prefix.length)
      if (relative === '' || relative.endsWith('/')) continue
      const target = path.join(cache, 'node_modules', pkg, relative)
      fs.mkdirSync(path.dirname(target), { recursive: true })
      fs.writeFileSync(target, buffer.subarray(base + meta.offset, base + meta.offset + meta.size))
    }
  }
  if (missing.length > 0) throw new Error(`asar 里缺少这些包：${missing.join(', ')}`)

  fs.writeFileSync(
    loader,
    [
      `export * as session from '@deepseek-ai/dsh-session'`,
      `export * as formatV3ToV4 from '@deepseek-ai/dsh-session-format-v3-to-v4'`,
      `export * as formatCatalog from '@deepseek-ai/dsh-session-format-catalog'`,
      '',
    ].join('\n'),
  )
  fs.writeFileSync(done, `${new Date().toISOString()}\n`)
  return { url: pathToFileURL(loader).href, cache, asar }
}

/**
 * 加载宿主库（首次会解包）。
 *
 * @param {{ asar?: string, force?: boolean }} [options] - 选项。
 * @returns {Promise<{ session: object, formatV3ToV4: object, formatCatalog: object, cache: string, asar: string }>} 宿主库。
 */
export async function loadHostLibs(options = {}) {
  const { url, cache, asar } = await ensureHostLibs(options)
  const libs = await import(url)
  return { ...libs, cache, asar }
}
