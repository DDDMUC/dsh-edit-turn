import { test } from 'node:test'
import assert from 'node:assert/strict'
import { foldSurface, rewrite, derivedHistory, snapToTurnStart, renumberLifecycle, assertHostLoadable, planUnloadableDrops, seededHeaderFor, titleSurvivesCut, dropUnsatisfiableTitles } from '../tools/compact-session.mjs'

/**
 * 造一份最小日志：一条用户消息、一条助手回复、再一条用户消息。
 *
 * @returns {object[]} 事件数组（不含头部）。
 */
function baseLog() {
  return [
    { type: 'turn/start', seq: 1, data: { turn: 1 } },
    { type: 'user/message', seq: 2, surfaceOp: 'append', data: { message: { role: 'user', content: [{ type: 'text', text: 'hi' }] } } },
    { type: 'assistant/message', seq: 3, surfaceOp: 'append', data: { message: { role: 'assistant', content: [{ type: 'text', text: 'hello' }] } } },
    { type: 'turn/end', seq: 4, data: { turn: 1 } },
    { type: 'turn/start', seq: 5, data: { turn: 2 } },
    { type: 'user/message', seq: 6, surfaceOp: 'append', data: { message: { role: 'user', content: [{ type: 'text', text: 'again' }] } } },
    { type: 'assistant/message', seq: 7, surfaceOp: 'append', data: { message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }] } } },
    { type: 'turn/end', seq: 8, data: { turn: 2 } },
  ]
}

test('折叠：被 replace 覆盖的节点从表面消失', () => {
  const events = baseLog()
  // 一条替换：覆盖第 2、3 条（第 1 轮），用一条摘要代替。
  events.push({
    type: 'user/message',
    seq: 9,
    surfaceOp: { op: 'replace', startSeq: 2, endSeq: 3 },
    sourceEventSeqs: [2, 3],
    data: { message: { role: 'user', content: [{ type: 'text', text: 'summary' }] } },
  })
  const { visible, dropped } = foldSurface(events)
  assert.deepEqual(visible, [6, 7, 9], '第 1 轮的两条被摘要取代')
  assert.equal(dropped.has(2), true)
  assert.equal(dropped.has(3), true)
})

test('replace 遮蔽不了它之后写下的事件', () => {
  const events = baseLog()
  // 区间端点越界：覆盖 2..7，但这条事件自己排在 6 之后、7 之前。
  events.splice(6, 0, {
    type: 'user/message',
    seq: 65,
    surfaceOp: { op: 'replace', startSeq: 2, endSeq: 7 },
    sourceEventSeqs: [2, 3],
    data: { message: { role: 'user', content: [{ type: 'text', text: 'summary' }] } },
  })
  const { visible } = foldSurface(events)
  assert.ok(visible.includes(7), '排在替换之后的消息仍然可见')
  assert.equal(visible.includes(3), false, '排在它之前的仍然被覆盖')
})

test('重写：派生历史逐条不变、seq 连续、没有悬空引用', () => {
  const events = baseLog()
  // 区间里要有"中间"事件才会净减少：两端必须留作锚（宿主校验引用存在），
  // 中间那些才是真正被删掉的。
  events.splice(3, 0, {
    type: 'assistant/message',
    seq: 35,
    surfaceOp: 'append',
    data: { message: { role: 'assistant', content: [{ type: 'text', text: 'middle one' }] } },
  })
  events.splice(4, 0, {
    type: 'assistant/message',
    seq: 36,
    surfaceOp: 'append',
    data: { message: { role: 'assistant', content: [{ type: 'text', text: 'middle two' }] } },
  })
  events.push({
    type: 'user/message',
    seq: 9,
    surfaceOp: { op: 'replace', startSeq: 2, endSeq: 36 },
    sourceEventSeqs: [2, 3, 35, 36],
    data: { message: { role: 'user', content: [{ type: 'text', text: 'summary' }] } },
  })
  const before = derivedHistory(events)
  const result = rewrite(events)
  assert.deepEqual(derivedHistory(result.events), before, '模型读到的历史一字不变')
  assert.ok(result.events.length < events.length, '确实变短了')

  // seq 从 0 开始：宿主按数组下标核对（events[i].seq === i）。
  const seqs = new Set(result.events.map((e) => e.seq))
  for (let i = 0; i < result.events.length; i += 1) assert.ok(seqs.has(i), `seq ${i} 存在`)
  for (const event of result.events) {
    for (const ref of Array.isArray(event.sourceEventSeqs) ? event.sourceEventSeqs : []) {
      assert.ok(seqs.has(ref), `引用的 seq ${ref} 存在`)
    }
    if (event.surfaceOp !== null && typeof event.surfaceOp === 'object') {
      assert.ok(seqs.has(event.surfaceOp.startSeq), '区间起点存在')
      assert.ok(seqs.has(event.surfaceOp.endSeq), '区间终点存在')
    }
  }
})

test('一条 replace 自己被更晚的 replace 覆盖时，不给它留孤儿锚', () => {
  const events = baseLog()
  // 第一次替换：覆盖 2..3。
  events.push({
    type: 'user/message',
    seq: 9,
    surfaceOp: { op: 'replace', startSeq: 2, endSeq: 3 },
    sourceEventSeqs: [2, 3],
    data: { message: { role: 'user', content: [{ type: 'text', text: 'first summary' }] } },
  })
  // 第二次替换：把第一次的替换和它前面的一切都覆盖掉。
  events.push({
    type: 'user/message',
    seq: 10,
    surfaceOp: { op: 'replace', startSeq: 2, endSeq: 9 },
    sourceEventSeqs: [2, 3, 9],
    data: { message: { role: 'user', content: [{ type: 'text', text: 'second summary' }] } },
  })
  const before = derivedHistory(events)
  const result = rewrite(events)
  assert.deepEqual(derivedHistory(result.events), before)
  // 第一条替换已被覆盖，它引用的 2/3 不该因为"留锚"而复活成可见节点。
  const visibleTexts = derivedHistory(result.events).join('|')
  assert.equal(visibleTexts.includes('first summary'), false, '被覆盖的摘要没有复活')
})

test('区间里一条都不剩时，替换降级为普通追加，消息不会凭空消失', () => {
  const events = [
    { type: 'turn/start', seq: 1, data: { turn: 1 } },
    // 区间指向不存在的事件：没有任何可覆盖的东西。
    { type: 'user/message', seq: 2, surfaceOp: { op: 'replace', startSeq: 900, endSeq: 950 }, data: { message: { role: 'user', content: [{ type: 'text', text: 'lonely' }] } } },
    { type: 'turn/end', seq: 3, data: { turn: 1 } },
  ]
  const result = rewrite(events)
  const texts = derivedHistory(result.events).join('|')
  assert.ok(texts.includes('lonely'), '消息仍然在派生历史里')
})

// ——— 宿主加载契约：压缩结果必须能从磁盘重新加载 ———
//
// 这一组对应 2026-10-29 那次事故：压缩把日志从"检查点"处切开，保留区从半轮开始，
// 标题的 messageSeqs 指向被裁掉的用户消息，宿主报
//   title messageSeqs must name an earlier event
// 整份历史再也打不开。下面的用例把每条约束钉住。

test('切点退到轮首：从检查点切会把一轮劈成两半', () => {
  const events = [
    { type: 'turn/start', seq: 0, data: { turn: 1 } },
    { type: 'step/start', seq: 1, data: { turn: 1, step: 1 } },
    { type: 'request/header', seq: 2, data: { header: { config: { provider: 'p', model: 'm' } } } },
    { type: 'step/end', seq: 3, data: { turn: 1, step: 1 } },
    { type: 'turn/end', seq: 4, data: { turn: 1 } },
    { type: 'turn/start', seq: 5, data: { turn: 2 } },
    { type: 'step/start', seq: 6, data: { turn: 2, step: 1 } },
  ]
  assert.equal(snapToTurnStart(events, 2), 0, '检查点落在第 1 轮里，切点退到第 1 轮的 turn/start')
  assert.equal(snapToTurnStart(events, 5), 5, '正好落在轮首时不动')
  assert.equal(snapToTurnStart(events, 6), 5, '落在轮中间时退到轮首')
})

test('轮次与步骤重编号：保留区的第一轮必须从 1 起', () => {
  const events = [
    { type: 'turn/start', seq: 0, data: { turn: 11 } },
    { type: 'step/start', seq: 1, data: { turn: 11, step: 58 } },
    { type: 'assistant/message', seq: 2, data: { turn: 11, step: 58, message: { role: 'assistant', content: [] } } },
    { type: 'step/end', seq: 3, data: { turn: 11, step: 58 } },
    { type: 'turn/end', seq: 4, data: { turn: 11 } },
    { type: 'turn/start', seq: 5, data: { turn: 12 } },
    { type: 'step/start', seq: 6, data: { turn: 12, step: 1 } },
  ]
  const out = renumberLifecycle(events)
  assert.deepEqual(
    out.map((e) => [e.data.turn, e.data.step]),
    [[1, undefined], [1, 1], [1, 1], [1, 1], [1, undefined], [2, undefined], [2, 1]],
  )
  assert.deepEqual(out.map((e) => e.seq), [0, 1, 2, 3, 4, 5, 6], 'seq 不动')
})

test('自检拦住"从半轮开始"的日志', () => {
  const events = [
    { type: 'request/header', seq: 0, data: { header: { config: { provider: 'p', model: 'm' } } } },
  ]
  assert.throws(() => assertHostLoadable(null, events), /不在开启的轮次里/)
})

test('自检拦住悬空的标题引用', () => {
  const events = [
    { type: 'session/title', seq: 0, data: { title: 'x', messageSeqs: [3], source: { kind: 'fallback' } } },
  ]
  assert.throws(() => assertHostLoadable(null, events), /不早于自身/)
})

test('自检拦住 shadowedRange 与表面切片不一致的压缩记录', () => {
  const events = [
    { type: 'turn/start', seq: 0, data: { turn: 1 } },
    { type: 'step/start', seq: 1, data: { turn: 1, step: 1 } },
    { type: 'user/message', seq: 2, surfaceOp: 'append', data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'a' }] } },
    {
      type: 'compaction/prune',
      seq: 3,
      data: { shadowedRange: { start: 2, end: 2 }, shadowedSeqs: [99] },
    },
  ]
  assert.throws(() => assertHostLoadable(null, events), /shadowedSeqs 与表面切片不一致/)
})

test('自检拦住没有摘要的 compaction/end', () => {
  const events = [
    { type: 'turn/start', seq: 0, data: { turn: 1 } },
    { type: 'compaction/start', seq: 1, data: { compactionId: 'c1', turn: 1 } },
    { type: 'compaction/end', seq: 2, data: { compactionId: 'c1', turn: 1 } },
  ]
  assert.throws(() => assertHostLoadable(null, events), /没有对应的摘要/)
})

test('降级后 turn/step 对不上当前轮的 replace 副本会被剔掉', () => {
  const events = [
    { type: 'turn/start', seq: 0, data: { turn: 1 } },
    { type: 'step/start', seq: 1, data: { turn: 1, step: 1 } },
    // 旧轮工具输出的剪短副本：replace 的端点已经不在表面上了
    { type: 'tool/result', seq: 2, surfaceOp: { op: 'replace', startSeq: 900, endSeq: 900 }, data: { turn: 7, step: 3, message: { role: 'tool', content: [] } } },
  ]
  const drops = planUnloadableDrops(events)
  assert.equal(drops.has(2), true, '会被剔掉')
  assert.equal(drops.has(1), false, '正常事件不受影响')
})

test('seeded 标记被裁掉时头部要改口', () => {
  const header = { isSeeded: true, parentSession: 'session-x' }
  assert.deepEqual(seededHeaderFor(header, []), { isSeeded: false, parentSession: 'session-x' })
  const kept = [{ type: 'session/end-seed', seq: 0, data: { inherited: true } }]
  assert.equal(seededHeaderFor(header, kept), header, '标记还在就不动头部')
})

test('标题：引用撑不住就不留，用户标题永远留得住', () => {
  const fallback = { type: 'session/title', seq: 9, data: { title: 't', messageSeqs: [3], source: { kind: 'fallback' } } }
  const user = { type: 'session/title', seq: 9, data: { title: 't', messageSeqs: [], source: { kind: 'user' } } }
  assert.equal(titleSurvivesCut(fallback), false)
  assert.equal(titleSurvivesCut(user), true)
  const events = [fallback, user]
  assert.deepEqual(dropUnsatisfiableTitles(events), [user])
})
