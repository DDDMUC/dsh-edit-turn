import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'
import { stageTrim, commitTrim, applyTrim, encodeLog, readLog } from '../tools/compact-session.mjs'

/**
 * 造一份**多窗口**的最小日志：6 个真窗口（5 个检查点），于是"保留最后 3 窗"会真的切掉前两窗。
 *
 * 注意"窗口"只数**带检查点**的那些：开头那个是会话的设置窗（系统提示词、权限、预设），
 * 不算对话窗——这正是先前把 `b6188055`（只有 3 个真窗口）误裁的原因。
 *
 * 检查点就是一条 `user/message`，`data.source.kind === 'compact-checkpoint'`——窗口划分
 * 只看这个标记（见 dsh-session-pages 的 `isCheckpoint`）。
 *
 * @returns {object[]} 事件数组。
 */
function windowedLog() {
  const events = []
  let seq = 0
  const push = (type, data, extra = {}) => {
    events.push({ type, seq, data, ...extra })
    seq += 1
    return events[events.length - 1]
  }

  push('permission/preset', { preset: 'workspace-write' })
  push('system/message', { turn: 1, step: 1, message: { id: 'sys', role: 'system', content: [{ type: 'text', text: 'system prompt' }] } }, { surfaceOp: 'append' })

  for (let turn = 1; turn <= 6; turn += 1) {
    if (turn > 1) {
      // 检查点：覆盖上一窗的两条消息。
      const from = events.find((e) => e.data?.message?.id === `u${turn - 1}`).seq
      const to = events.find((e) => e.data?.message?.id === `a${turn - 1}`).seq
      push(
        'user/message',
        {
          id: `cp${turn}`,
          role: 'user',
          content: [{ type: 'text', text: `summary of window ${turn - 1}` }],
          source: { kind: 'compact-checkpoint', compactionId: `compaction-${turn}` },
        },
        { surfaceOp: { op: 'replace', startSeq: from, endSeq: to }, sourceEventSeqs: [from, to] },
      )
      push('compaction/start', { compactionId: `compaction-${turn}`, turn })
      push('compaction/end', { compactionId: `compaction-${turn}`, turn })
    }
    push('turn/start', { turn })
    push('step/start', { turn, step: 1 })
    push('user/message', { turn, step: 1, message: { id: `u${turn}`, role: 'user', content: [{ type: 'text', text: `question ${turn}` }] } }, { surfaceOp: 'append' })
    push('assistant/message', { turn, step: 1, message: { id: `a${turn}`, role: 'assistant', content: [{ type: 'text', text: `answer ${turn}` }] } }, { surfaceOp: 'append' })
    push('step/end', { turn, step: 1 })
    push('turn/end', { turn })
  }
  return events
}

/**
 * 把日志写进临时目录（`stageTrim` 会在同目录找 `session.lock`）。
 *
 * @param {object[]} events - 事件数组。
 * @returns {{ dir: string, file: string }} 路径。
 */
function writeLog(events) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-trim-test-'))
  const file = path.join(dir, 'session.v4.jsonl.zstd')
  const header = { type: 'session', version: 4, id: 'session-00000000-0000-4000-8000-000000000000', createdAt: 1, isSeeded: false, delegationDepth: 0 }
  fs.writeFileSync(file, encodeLog(header, events))
  return { dir, file }
}

test('暂存：只写暂存文件，原文件一个字节都不动', () => {
  const { file } = writeLog(windowedLog())
  const before = fs.readFileSync(file)
  const staged = stageTrim(file, 3)
  assert.equal(fs.readFileSync(file).equals(before), true, '原文件未被改动')
  assert.equal(fs.existsSync(staged.staging), true, '暂存文件已写出')
  assert.equal(fs.existsSync(staged.backup), false, '还没有备份（备份是提交那一步才产生）')
  assert.ok(staged.summary.before.events > staged.summary.after.events, '事件数确实减少了')
})

test('提交：原文件改名成备份，暂存文件上位', () => {
  const { file } = writeLog(windowedLog())
  const staged = stageTrim(file, 3)
  const summary = commitTrim(staged, file)
  assert.equal(summary.backup, staged.backup)
  assert.equal(fs.existsSync(staged.staging), false, '暂存文件已经改名')
  assert.equal(fs.existsSync(staged.backup), true, '备份在')
  const trimmed = readLog(file)
  assert.equal(trimmed.events.length, summary.after.events)
  const backup = readLog(staged.backup)
  assert.equal(backup.events.length, summary.before.events)
})

test('落盘：跳过校验时照常写入（--no-verify）', async () => {
  const { file } = writeLog(windowedLog())
  const before = readLog(file).events.length
  const summary = await applyTrim(file, 3, { verify: false })
  assert.ok(summary.after.events < before)
  assert.equal(readLog(file).events.length, summary.after.events)
})

test('落盘：校验器跑不起来时拒绝写入，且不留暂存文件', async () => {
  const { dir, file } = writeLog(windowedLog())
  const before = fs.readFileSync(file)
  const fakeAsar = path.join(dir, 'not-an-asar')
  fs.writeFileSync(fakeAsar, 'this is not an asar')
  const saved = process.env.DSH_ASAR
  process.env.DSH_ASAR = fakeAsar
  try {
    await assert.rejects(
      () => applyTrim(file, 3),
      /校验器跑不起来|未写入/,
      '必须抛错而不是静默写入',
    )
  } finally {
    if (saved === undefined) delete process.env.DSH_ASAR
    else process.env.DSH_ASAR = saved
  }
  assert.equal(fs.readFileSync(file).equals(before), true, '原文件未被改动')
  const leftovers = fs.readdirSync(dir).filter((name) => name.includes('staging'))
  assert.deepEqual(leftovers, [], '没有留下暂存文件')
})

test('压缩编码：写出的日志能被自己读回来（含 zstd 帧）', () => {
  const events = windowedLog()
  const header = { type: 'session', version: 4, id: 'session-00000000-0000-4000-8000-000000000000', createdAt: 1, isSeeded: false, delegationDepth: 0 }
  const bytes = encodeLog(header, events)
  assert.ok(bytes.length > 0)
  assert.equal(bytes.subarray(0, 4).readUInt32LE(0), 0xfd2fb528, 'zstd 魔数')
  const { dir, file } = writeLog(events)
  const back = readLog(file)
  assert.equal(back.events.length, events.length)
  assert.equal(back.events[back.events.length - 1].type, 'turn/end')
  void dir
  void zlib
})
