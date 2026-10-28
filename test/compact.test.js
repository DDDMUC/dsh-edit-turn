import { test } from 'node:test'
import assert from 'node:assert/strict'
import { foldSurface, rewrite, derivedHistory } from '../tools/compact-session.mjs'

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

  const seqs = new Set(result.events.map((e) => e.seq))
  for (let i = 1; i <= result.events.length; i += 1) assert.ok(seqs.has(i), `seq ${i} 存在`)
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
