# dsh-edit-turn 可行性与方案（一页纸）

> 结论：**可行**。DSH 0.1.6-alpha.2 提供了官方的「回退 + 重跑」两段 seam，均不需要猴补丁、
> 不需要改写会话日志、不需要重启宿主。原任务书里「回退 = 截断事件流」的设想**不应采用**——
> 官方机制是 append-only 的 **surface-replace**，比截断文件更安全且已被官方 compaction 与
> `dsh-delete-turn` 在生产中使用。

证据基线：本机 DSH 0.1.6-alpha.2，源码在
`/Users/337mu/.npm/_npx/750cc96126099c02/node_modules/@deepseek-ai/`。

---

## 1. 回退：官方 surface-replace 契约（不是截断）

`dsh-session` README §Append and derive 原文：

> Surface events (`system/message`, `user/message`, `assistant/message`, `tool/result`) require
> `surfaceOp` in both typed events and append input. A replacement uses exactly
> `{ op: 'replace', startSeq, endSeq }`, with inclusive `SessionSeq` endpoints in **current surface
> order**. […] A `replace` surface operation **removes the shadowed entries from future inputs
> without deleting their raw log records**.

因此回退 = 追加**一条替换事件**，把「目标用户消息 → 日志末尾」这段 surface 窗口从**模型上下文**里
遮蔽掉；磁盘上的原始字节一个都不动（"Committed events are never rewritten"）。

**为什么不能截断 JSONL**（任务书原设想）：

- `dsh-session-persistence-jsonl` **没有公开的截断/重写 API**；全文只有 `truncateTornTail`
  用于崩溃后的残帧修复（`lib/index.js:227`），正常路径下"committed events are never rewritten"。
- 运行中的 host 把会话保存在**内存 append-only 日志 + projection cache**（`dsh-session-projection-cache`）里，
  改磁盘不会让活着的 session 重新读取；它会继续按旧 seq 追加，导致日志与缓存脱节。
- 落盘是多帧 zstd（一帧一个 append batch），`sourceEventSeqs` 还使用 `[start,end]` 压缩表示，
  手工截断极易产出校验不过的帧。
- 截断无法解决"悬空 tool/result"——surface-replace 天然不会：我们**总是遮蔽到一个轮边界之后的最后一个
  surface 节点**，assistant 消息（内含 tool_use）与它的 tool/result 一起走。

已验证的同类实现：`dsh-delete-turn` v0.1.1（本机
`~/Documents/Default Project/dsh-delete-turn`）在同一 DSH 版本上用同一个契约落地；
官方 `dsh-command-compact` 的 compaction checkpoint 也是同形状的 `user/message` 替换事件。

## 2. 重跑：`ctx.sessionController.prompt()`

`dsh-api-session-controller` 的 Host 服务（`declare module` 合并进 Context）：

```ts
prompt(request: SessionPromptRequest, signal: AbortSignal): Promise<{accepted: true}>
```

```ts
SessionPromptRequest = {
  requestId,                       // 客户端铸造的身份，回显为 user source 的 rpcId
  sessionId,
  mode: 'queue' | 'steer',
  content: PromptContentPart[],    // {type:'text',text} | {type:'image',...} | {type:'file',receiptId}
  clientTimeZone?,
}
```

这是**唯一的 prompt 准入路径**，并且它会自己 resume 冷会话。编辑后调它一次即完成"用新内容重跑这一轮"。

它是 `ctx.sessionController` 上的公开方法，插件通过 `ctx.get('sessionController')` 取用即可，
**不需要** import 任何 SDK。

## 3. 载体事件不会在转录里显示成气泡（关键可行性证据）

替换事件本身也是 surface 节点，需要非空内容（"user message must have content"），
那么这段文本会不会在前端渲染成一条用户气泡？

不会。`dsh-client-ui-chat/lib/client.js` 的会话节点定义：

```js
const messageDefinition = {
  kind: 'input-message', target: 'chat',
  match: (event) => event.type === 'user/message'
    && isAppendSurfaceEvent(event)          // ← 只认 append 型
    && !isCompactionCheckpoint(event) ? {...} : null,
}
```

`isAppendSurfaceEvent` 对 `surfaceOp.op === 'replace'` 为 false，所以**替换载体不匹配任何转录行定义**，
不产生气泡（这也正是 `dsh-delete-turn` 的 `[deleted]` 载体不显示的原因）。
代价：载体文本仍会进入**模型上下文**（每个 user/message 都会投影成模型消息），所以载体文本要短、要诚实。

## 4. UI 注入点

slot 体系（`dsh-client-ui-slots`）提供三个可用位置：

| slot | 类型 | 用途 |
|---|---|---|
| `conversation.chat.assistant-actions` | list | 助手回复操作条（拿到持久 messageId） |
| `conversation.chat.turnTail` | list | 轮尾追加内容 |
| `conversation.input.overlay` | list（每会话） | 每会话控制器：弹窗 / 就地编辑器 / DOM 增强宿主 |

**用户消息行没有官方操作 slot**（`dsh-delete-turn` 因此才做 DOM 增强）。所以编辑入口沿用同一套
已被验证的做法：官方标准 hook `useChat`（ChatSnapshot，按 `data-chat-flow-key` 索引）+ 官方
`data-chat-flow-*` 锚点，不碰 React fiber、不依赖 CSS module 哈希。

## 5. 方案（MVP）

```
用户点「编辑」
  → 就地 textarea（预填原文，host 的 /state 已带上每个可编辑轮的首条人类提示文本）
  → 确认
  → POST /api/dsh-edit-turn/apply { sessionId, seq | turn, text }
       host:
         1. 读事件流（sessionQuery.readSession，回退 live snapshot）
         2. foldSurface() → 当前 surface 节点顺序
         3. 定位目标用户消息（必须是 source.kind==='user' 的人写提示，且不是 surface 节点 0）
         4. isBusy() 检查（未闭合的 turn / 进行中的 compaction → 409）
         5. 计算遮蔽窗口 = surface[目标索引 .. 末尾]（连续、含端点、到轮尾）
         6. session.append('user/message', {content:[{type:'text',text: 短标记}],
              source:{kind:'plugin',plugin:'dsh-edit-turn'}},
              { surfaceOp:{op:'replace',startSeq,endSeq}, sourceEventSeqs: 窗口 })
         7. sessions.flush(session)（durability checkpoint）
         8. sessionController.prompt({requestId, sessionId, mode:'queue', content:[{type:'text',text:新文本}]})
         9. 返回 { replacementSeq, promptAccepted, shadowed }
  → client：/state 重新拉取 → 被遮蔽的行 DOM 隐藏 → 新提示与新回复由正常 follow 流追加
```

**轮边界保证**：遮蔽窗口右端固定为日志最后一个 surface 节点，左端固定为目标的用户消息节点，
所以永远整轮整块地丢，不存在悬空 tool/result。

**已明确不做（MVP 之外）**：删除某一轮、分支保留原文（`sessionController.fork({sessionId, atSeq})`
是它的官方基础）、快捷键、重新生成。

## 6. 需要沙箱实测的未确认项

1. **空 `system/message` 载体**：`dsh-session` 说"empty system nodes project to no message"，若能用作
   替换载体，标记文本就完全不进模型上下文。但 `dsh-delete-turn` 的注释记录该形状被格式校验拒绝
   （"pins system/message to an open step"）。→ 沙箱第一步就试，成功则升级为载体策略，失败则保留标记载体。
2. 前端隐藏效果与 `applyDom` 的行匹配是否覆盖用户行（沿用 delete-turn 的锚点，预期可行）。
3. `prompt` 在"刚被替换过、且当前无进行中 turn"的会话上是否会正常开新 turn（预期可行）。

## 7. 硬性红线遵守

- 全程只在**沙箱实例**（独立 `DSH_HOME` + 独立端口）验证；端口先 `lsof` 确认空闲，避开 3080/3099。
- 绝不 kill / restart 用户主 DSH（127.0.0.1:3080）。
- 验证尽量不发消息（省额度）；能用事件流断言的地方不发模型请求。
- 未经用户明确同意不 publish、不建公开仓库。
