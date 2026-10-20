# dsh-edit-turn 可行性与方案（一页纸）

> 结论：**可行**。DSH 0.1.6-alpha.2 提供了官方的「回退 + 重跑」两段 seam，均不需要猴补丁、
> 不需要改写会话日志、不需要重启宿主。原任务书里「回退 = 截断事件流」的设想**不应采用**——
> 官方机制是 append-only 的 **surface-replace**，比截断文件更安全且已被官方 compaction 与
> `dsh-delete-turn` 在生产中使用。

证据基线：DSH 0.1.6-alpha.2，源码在
`<DSH 安装目录>/node_modules/@deepseek-ai/`。

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

已验证的同类实现：`dsh-delete-turn` v0.1.1（同一工作区里的兄弟插件）在同一 DSH 版本上用同一个契约落地；
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
  → 点「保存并重跑」（一次点击即执行；二次确认是可选项 confirm，默认关闭）
  → POST /dsh-edit-turn/apply { sessionId, seq | turn, text }
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

## 8. 0.3.0：回复块的就地补丁（plugin record + message projection）

0.2.x 的回复编辑受一个格式事实限制：`assistant/message` 不能携带 `sourceEventSeqs`，因此
不能做 surface replacement；只能"回退到末尾 + 追加修正回答 + 逐事件重放后续轮次"。这保住了
后续对话，但改一条中间回答仍然会让日志多出整段副本、换掉所有轮次号与 messageId，且工具调用
和思维链留不住。

0.3.0 改用宿主在 0.2.1-rc.2 已经提供的另一条**公开 seam**：

- `appendPluginRecord(session, 'plugin:dsh-edit-turn/patch', data)`（`@deepseek-ai/dsh-session`
  导出）：只往日志追加一条 `ignorable: true` 的插件记录，不碰 surface；
- `ctx.sessions.registerMessageProjection({ type, project })`：注册一个**纯函数**投影，折叠会话时
  把目标 seq 的模型可见消息改写。投影按事件类型注册，同一类型只能一个；它只应注册到**自己的**
  事件类型上，绝不能注册到 `assistant/message`（那会让 assistant 事件走 `project` 分支，破坏
  surface/遮蔽关系）；
- 投影必须**绝不抛错**：一次抛错会让整个会话折叠失败（会话打不开）。畸形记录、不在 surface 上的
  目标、类型已经不符的块，一律跳过；
- 同一 seq 的多条记录按日志顺序叠加：以 `context.messages.get(seq)`（已投影消息）为 base，没有则
  用记录的原始 message；一条记录里多个 target 先按 seq 分组、一次性应用；
- 改 `reasoning` / `thinking` 时删除 `signature` / `thinkingSignature`：签名签的是旧文本，留着会被
  provider 拒绝；
- 记录写入后等一次 `sessions.flush`；宿主重启/重新打开会话时，投影仍在注册表里，所以补丁还在；
- **投影的生命周期跟着宿主进程**：热重载时复用已注册的定义（按 type 查找），不重复注册；卸载插件并重启
  宿主后投影不存在，记录被跳过，模型与 UI 都回到原文。只卸载不重启时模型仍按投影读取。这是与
  surface 路径的明确取舍，已写进 README；需要永久改写时仍走提示词编辑。

验证：

- 纯函数单测（`test/patch.test.js`）：载荷校验、块选择、单条记录多 target、跨记录叠加、retired
  target、签名删除、畸形记录不抛错；
- 宿主集成（`test/host.test.js`）：一次保存只多一条记录（无 turn、无 correction、无 replay）、
  `/state` 的 mode/patches/blocks、思维链保存与二次叠加、unchanged 不写；
- 真实校验器（`tools/verify-surface-contract.mjs`）：记录是 `ignorable` 且无 surfaceOp、surface
  不变、无投影时原文回来、有投影时目标块改写且后续轮次/tool 结果不动、第二条记录叠加；
- 沙箱 profile（`tools/verify-dsh-plugin.sh`）：真实启动后 `/debug` 报 `mode: patch` 且
  `pluginRecords: true`——证明投影确实在真实宿主里注册成功，而不是静默降级。

**未验证/已知限制**：

- 客户端正文覆盖采用宿主 `[data-slot="conversation.chat.node"]` + markdown 容器形状匹配（不写死
  CSS module 哈希），匹配不到容器时不覆盖（模型上下文仍然正确）；思维链折叠时只显示注记，不强行
  展开面板；
- 投影注册随宿主进程存活：卸载插件后需重启宿主，记录才会被跳过、原文回来；只卸载不重启时模型仍按投影读取；
- 宿主没有该 API 时自动退回重放；`replyMode: patch` 会直接拒绝而不是悄悄降级。
