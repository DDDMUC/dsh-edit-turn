# dsh-edit-turn

**DeepSeek Harness 的「编辑某一轮」插件 —— 点用户消息旁的编辑按钮，就地改写，确认后把会话回退到这条消息之前，用新内容重新跑这一轮。** 回退走官方 surface-replace 契约（追加一条替换事件，被丢弃的内容从模型上下文里消失），重跑走官方 `sessionController.prompt()`。会话日志是 append-only 的，**原始字节一个都不改写**。

[中文](#中文) · [English](#english)

---

## 中文

### 为什么需要它

DSH 的会话日志是 append-only 的事件流：说错的提示词、问偏的问题，会一直留在模型上下文里污染后续每一轮。官方只有整段摘要式的「压缩」（`/compact`），没有「改一下我刚才那句话然后重来」这条路——而这恰恰是 ChatGPT / Claude 里最常用的动作。

这个插件把它补上：

- 悬停任意一条**你自己发过的消息**，右侧出现编辑按钮；
- 点击后在该消息下方就地展开编辑器，预填原文；
- 确认后：会话回退到这条消息之前，**这条消息之后的全部内容（含当轮助手回复、思考、工具调用与结果）从模型上下文中移除**；
- 然后立刻用改写后的内容**重新跑这一轮**，新回复照常流式出现。

### 特性

- **官方 seam，不改日志** —— 回退 = 追加一条带 `surfaceOp: { op: 'replace', startSeq, endSeq }` 的替换事件。原始事件全部留在会话文件里，只是不再进入 `deriveMessages()`。与官方 `/compact` 用的是同一套契约。
- **默认零上下文污染** —— 替换事件的载体是一个**空的 `system/message`**。官方格式文档里空的后置 system 节点是「dormant，不投影成任何消息」，所以回退后模型看到的上下文，和「对话真的停在那一点」完全一致，不会多出任何标记文本。
- **轮边界安全** —— 遮蔽窗口右端固定为日志最后一个 surface 节点，左端固定为目标消息节点，因此助手消息（内含 tool_use）与它产生的 tool/result 永远一起走，**不可能留下悬空的调用/结果对**。
- **重跑走官方准入路径** —— `ctx.sessionController.prompt()` 是唯一的口径：它会自己 resume 冷会话，并恰好开一个新轮次。
- **一次点击即执行** —— 保存后不再有二次确认。编辑器本身已经是用户主动打开的动作，面板里也写明了保存会丢弃哪些内容；想恢复两步确认可在 profile 里一行开启（`confirm: true`）。
- **中英双语 UI**，跟随 DSH 当前语言。
- **皮肤友好** —— 编辑器面板自带不透明表面（`--dshet-panel`）而不是借用主题的表面色变量。皮肤的本意就是让表面半透明、把插画透出来，而它只会给**自己的**元素补可读背景，插件类名不在其中；借用皮肤变量的面板会变成全透明，文字直接压在插画上。暗色分支走官方属性 `body[data-ds-dark-theme]`（与 `dsh-client-ui-theme` 及多个官方 UI 包一致），并用 `backdrop-filter` 与皮肤融合。
- **可配置载体**：万一某个 DSH 版本对空 system 节点处理不同，一行配置即可切回短标记载体。
- **宿主路由只限本机回环**，并校验 `Host` 与 `Origin`。

### 安装

```sh
dsh plugin --profile web add dsh-edit-turn
```

从本地目录安装（开发用）：

```sh
dsh plugin --profile web add /path/to/dsh-edit-turn
```

安装后重启该 profile 对应的 DSH 进程即可生效。

### 使用

1. 把鼠标移到你想改的那条**用户消息**上，点右侧的编辑图标（铅笔）。
2. 消息下方展开编辑器，原文已预填。改完点「保存并重跑」——**一次点击即执行**：这条消息之后的一切从模型上下文中移除，并立刻重新跑这一轮。
3. 编辑器与该轮之后的转录行一起消失，新提示词与新回复出现在下方。

编辑器里如果提示「这条消息包含图片或文件附件」，说明改写只保留文字，附件会被丢弃。

### 配置

写在 profile 里即可覆盖默认值：

```yaml
- id: dsh-edit-turn
  config:
    carrier: 'system/message'   # 默认：空 system 节点，模型不可见
    markerText: '...'           # 仅当 carrier 为 user/message 时使用的标记文本
    confirm: true               # 默认 true：确认后才执行回退
```

| 字段 | 默认 | 含义 |
|---|---|---|
| `carrier` | `system/message` | 替换事件的载体类型。`system/message` = 空节点，不投影成模型消息；`user/message` = 短标记文本，会作为一条用户消息进入上下文（等价插件在生产中用的是这种形状，作为兜底）。 |
| `markerText` | 一段说明文字 | `carrier: user/message` 时的载体文本。 |
| `confirm` | `false` | 客户端保存后是否先要求一次确认。默认**关闭**（一次点击即执行：编辑器本身已是用户主动打开的动作，面板里也写明了保存的后果）；设为 `true` 可恢复两步确认。 |

### 工作原理

一次编辑是两步官方操作：

**第一步：回退。** 读事件流（`sessionQuery.readSession`，回退到活动会话的 `snapshotEvents()`），用官方折叠规则算出当前 surface 顺序，定位目标消息的节点，然后遮蔽窗口 = `surface[目标下标 .. 末尾]`。追加一条：

```js
session.append('system/message', { turn, step, message: { role: 'system', content: [] } }, {
  surfaceOp: { op: 'replace', startSeq, endSeq },
  sourceEventSeqs: shadowed,      // 完整覆盖：官方校验要求列出全部被遮蔽的节点
})
```

落盘后等一次持久化检查点（`sessions.flush`），保证重启也能看到。

**第二步：重跑。**

```js
await ctx.sessionController.prompt({ requestId, sessionId, mode: 'queue', content: [{ type: 'text', text: 新内容 }] })
```

**为什么不做文件截断？** 因为那不是官方能力。`dsh-session-persistence-jsonl` 只暴露残帧崩溃修复用的 `truncateTornTail`，正常路径下「Committed events are never rewritten」；运行中的宿主把会话放在内存 append-only 日志 + 投影缓存里，改磁盘不会让它重新读取。截断还会破坏 `sourceEventSeqs` 的 `[start,end]` 压缩表示与多帧 zstd 结构。surface-replace 是官方为这件事准备的机制。

**插件接口**

| 类型 | 名称 | 说明 |
|---|---|---|
| 路由 | `GET /dsh-edit-turn/state?sessionId=` | 可编辑轮次、已遮蔽行账本、surface、忙碌状态 |
| 路由 | `POST /dsh-edit-turn/apply` | `{ sessionId, seq \| messageId \| turn, text }` → 执行回退 + 重跑 |
| 工具 | `edit_turn_targets` | 只读：列出该会话当前可编辑的轮次与原文（供 agent 自查） |
| 前端 | `conversation.input.overlay` | 每会话控制器：编辑入口、就地编辑器、被遮蔽行的隐藏账本 |

### 验证状态

本插件在 DSH `0.1.6-alpha.2` 上完成以下验证（全部**零模型调用**）：

| 验证 | 命令 | 结果 |
|---|---|---|
| 官方 append 契约（真实校验器，进程内） | `npm run verify:contract` | 46 项通过：替换事件被接受、派生历史真的收缩、日志 append-only、工具结果与调用同进同退、空 system 载体不产生模型消息、**连续两次回退都被接受** |
| 纯逻辑 + 宿主集成 + 客户端 DOM 行为（真 HTTP、真校验器、桩服务、DOM 桩） | `npm test` | 63 项通过 |
| 客户端半部静态检查（注册、i18n 完整性、样式、**皮肤可读性**、版本三处同步、线协议） | `npm run verify:client` | 全部通过 |
| 实机前端产物校验（运行中的 DSH 是否在下发当前代码） | `npm run verify:live -- --token-file ~/path/to/dsh.log` | 全部通过 |
| 真实 profile 安装 / 补丁合成 / 启动 / 工具契约 / 路由守卫 | `npm run verify:profile` | 全部通过 |

`verify:live` 针对**正在运行的实例**：用 DSH 启动时打印的 token 换取鉴权 cookie，读启动页里的客户端模块组，把含本插件的那一组下载下来，断言插件自己的标记确实在其中。它证明的是「浏览器刷新后会拿到当前代码」，而不是「源码看起来没问题」——前端改动后这是唯一能确认已生效的自动手段。

`verify:profile` 会另起独立端口 + 独立 `DSH_HOME` 的沙箱实例，**只按 pid 结束自己启动的进程**，绝不触碰你正在用的 DSH。也可以手动指定：

```sh
DSH_BIN=/path/to/dsh/lib/bin.js PORT=4123 DSH_HOME=/tmp/dsh-edit-turn-home bash tools/verify-dsh-plugin.sh
```

**尚未验证的一环（诚实说明）**：与**真实 DSH 界面**的耦合——真实 DOM 结构、真实 CSS 布局、以及 React 调和器在重渲染行时是否会移除注入的节点——只能由真实浏览器验证（本机 React 与 Playwright 均不可用）。但纯点击路径本身已被自动覆盖：`test/client.dom.test.js` 用一个可读的 DOM 实现把真实的 `OverlayEntry` 跑起来，断言「点动作 → 编辑器出现并预填 → 点保存 → 进入确认步骤 → 点确认 → 发出正确请求 → 编辑器关闭」以及各失败分支的文案。这个测试是有意义的：把重绘标记改回旧写法时，其中 6 项会失败。

**开发前置**：`npm test` 与两个 `verify:*` 需要 `@deepseek-ai/dsh-session` 与 `@deepseek-ai/dsh-tools` 可解析。本插件自身不依赖它们（宿主半部只 import `schemastery` 与 `dsh-tools`），测试需要一个装了 DSH 的 `node_modules`：

```sh
ln -s /path/to/dsh-install/node_modules ./node_modules
```

### 已知限制

- **只支持人类输入的消息**。注入的上下文行、助手消息、系统提示词都不提供编辑入口。
- **编辑会丢弃该消息之后的全部轮次**（MVP 语义，和 ChatGPT 的编辑一致）。想保留原文形成分支，需要走 `sessionController.fork({ sessionId, atSeq })`，尚未实现。
- **只改写文本**。消息里含图片/文件附件时，改写后只保留文字（编辑器会提示）。
- **会话必须当前在 DSH 中打开**，否则返回 `409 session-not-active`。
- **进行中拒绝编辑**：未闭合的轮次或正在压缩时返回 `409 busy`。
- **回退是持久的，隐藏不是**。回退写进日志后，模型上下文永久改变；转录里那些行的隐藏是本插件客户端半部做的。卸载插件后，旧行会重新显示出来（而模型上下文里的回退仍然生效）——因为替换事件是官方事件，不会随插件消失。
- 回退后**系统提示词保持不变**（窗口永不包含 surface 节点 0，该节点也永不可编辑）。

### 姊妹插件

- [dsh-delete-turn](https://github.com/DDDMUC/dsh-delete-turn) —— 单条消息/单步/单条回复的删除，同一套 surface-replace 契约。
- [dsh-free-search](https://github.com/DDDMUC/dsh-free-search) —— 免 key 多引擎网络搜索。
- [dsh-delete-session](https://github.com/DDDMUC/dsh-delete-session) —— 侧边栏会话删除。

### 兼容性

- `dsh.engines.dsh`: `>=0.1.6-alpha.2`（本插件依赖该版本的消息行定义与 surface 语义，并已在此版本实测）。
- 客户端依赖：`dsh-client-locale`、`dsh-client-ui-chat`、`dsh-client-ui-conversation`、`dsh-client-ui-primitives`。
- 宿主依赖：`dsh-settings`、`dsh-tools`（peer）；`@deepseek-ai/schemastery`（直接依赖）。

### License

MIT

---

## English

### Why

A DSH session log is an append-only event stream, so a mistyped prompt or a
badly framed question keeps polluting the model context for every later turn.
The only official remedy is `/compact`, which summarises the whole conversation
at once. There is no "rewrite that message and try again" - the single most used
action in ChatGPT and Claude.

This plugin adds it:

- hover any message **you** sent and an edit action appears on the row;
- clicking it opens an in-place editor below that message, pre-filled with the original text;
- confirming rolls the conversation back to just before that message: **everything after it (that turn's reply, reasoning, tool calls and their results) leaves the model context**;
- the revised text then **re-runs the turn immediately**, and the new reply streams in as usual.

### Features

- **Official seam, log untouched.** A rollback appends one replacement event carrying `surfaceOp: { op: 'replace', startSeq, endSeq }`. Every original event stays in the session file; it simply stops entering `deriveMessages()`. This is the same contract `/compact` uses.
- **Zero context pollution by default.** The replacement carrier is an **empty `system/message`**. The official format documents empty later system nodes as dormant, projecting to no message, so the context after an edit is exactly what it would be had the conversation really stopped there - no marker text is added.
- **Turn-boundary safe.** The shadow window always ends at the last surface node and always opens at the addressed message, so an assistant message (which carries its own tool_use blocks) and the tool/result it produced are shadowed together. A dangling call/result pair is impossible.
- **Official re-run.** `ctx.sessionController.prompt()` is the only prompt admission path; it resumes a cold Session itself and opens exactly one new turn.
- **One click applies** - no second confirmation. The editor is already an explicit action the user opened, and the panel states what saving discards; a profile can restore the two-step flow with `confirm: true`.
- **Bilingual UI** that follows the current DSH locale.
- **Skin-friendly** - the editor paints its own opaque surface (`--dshet-panel`) instead of borrowing the theme's surface colours. A skin exists to make surfaces translucent so its artwork shows through, and it only compensates for *its own* elements; a plugin's class names are not on that list, so a panel that borrows those variables can end up fully transparent with text sitting straight on the art. The dark branch uses the official `body[data-ds-dark-theme]` hook (the same one `dsh-client-ui-theme` and several official UI packages use) and blends in with `backdrop-filter`.
- **Configurable carrier**: if some DSH release treats empty system nodes differently, one config line restores the marker-text carrier.
- **Loopback-only host routes** with `Host` and `Origin` validation.

### Install

```sh
dsh plugin --profile web add dsh-edit-turn
```

From a local checkout (development):

```sh
dsh plugin --profile web add /path/to/dsh-edit-turn
```

Restart the DSH process that serves that profile to pick it up.

### Usage

1. Hover the **user message** you want to change and click the pencil action.
2. An editor opens below it with the original text pre-filled. Click "Save and re-run" - **one click applies**: everything after this message leaves the model context and the turn runs again immediately.
3. The editor disappears together with the discarded rows; the new prompt and its reply appear below.

If the editor warns that the message carries attachments, the rewrite keeps the
text only and drops them.

### Configuration

```yaml
- id: dsh-edit-turn
  config:
    carrier: 'system/message'   # default: an empty system node, invisible to the model
    markerText: '...'           # used only when carrier is user/message
    confirm: true               # default: require a confirmation step
```

| Field | Default | Meaning |
|---|---|---|
| `carrier` | `system/message` | Event type carrying the replacement. `system/message` is an empty dormant node that projects to no model message. `user/message` is a short marker that does enter the context; an equivalent plugin runs that shape in production, so it is the fallback. |
| `markerText` | an explanatory line | Carrier text when `carrier: user/message`. |
| `confirm` | `false` | Whether the client asks for a second confirmation before applying. Off by default - one click applies, because the editor is already an explicit action the user opened and the panel states what saving discards. Set it to `true` to restore the two-step flow. |

### How it works

One edit is two official operations.

**Step one, the rollback.** Read the event stream (`sessionQuery.readSession`,
falling back to the live session's `snapshotEvents()`), fold the official
surface order, locate the target message node, and take the window
`surface[index .. end]`. Then append:

```js
session.append('system/message', { turn, step, message: { role: 'system', content: [] } }, {
  surfaceOp: { op: 'replace', startSeq, endSeq },
  sourceEventSeqs: shadowed,      // complete coverage: the validator requires every shadowed node
})
```

The append then waits for the official durability checkpoint (`sessions.flush`)
so a reload or a DSH restart still sees the rollback.

**Step two, the re-run.**

```js
await ctx.sessionController.prompt({ requestId, sessionId, mode: 'queue', content: [{ type: 'text', text }] })
```

**Why not truncate the log?** Because that is not an official capability.
`dsh-session-persistence-jsonl` exposes only `truncateTornTail`, for crash
recovery; on the normal path "committed events are never rewritten". A running
host holds the session in an in-memory append-only log plus a projection cache,
so changing bytes on disk would not make it re-read them. Truncation would also
break the `[start, end]` run-compressed `sourceEventSeqs` representation and the
multi-frame zstd layout. Surface-replace is the mechanism the format provides
for exactly this.

**Plugin surface**

| Kind | Name | Purpose |
|---|---|---|
| Route | `GET /dsh-edit-turn/state?sessionId=` | Editable turns, the hidden-row ledger, the surface, busy state |
| Route | `POST /dsh-edit-turn/apply` | `{ sessionId, seq \| messageId \| turn, text }` → rollback + re-run |
| Tool | `edit_turn_targets` | Read-only: list the session's editable turns and their text |
| Client | `conversation.input.overlay` | Per-session controller: edit entry, in-place editor, hidden-row ledger |

### Verification status

Verified against DSH `0.1.6-alpha.2`, entirely **without model calls**:

| Check | Command | Result |
|---|---|---|
| Official append contract against the real validator, in process | `npm run verify:contract` | 46 checks pass: the replacement is accepted, the derived history really shrinks, the log stays append-only, a tool result leaves with its call, the empty system carrier adds no model message, **two consecutive rollbacks are both accepted** |
| Pure logic, host integration and browser-half DOM behaviour (real HTTP, real validator, stubbed services, DOM stub) | `npm test` | 63 tests pass |
| Browser-half static checks (registration, i18n completeness, styles, skin legibility, three-way version sync, wire contract) | `npm run verify:client` | all pass |
| Live client artifact (is the running DSH serving the current code?) | `npm run verify:live -- --token-file ~/path/to/dsh.log` | all pass |
| Real profile: install, patch composition, boot, tool contract, route guards | `npm run verify:profile` | all pass |

`verify:live` targets an instance that is **already running**: it exchanges the
token DSH printed on boot for an auth cookie, reads the client module groups out
of the boot page, downloads the group containing this plugin, and asserts the
plugin's own markers are inside it. That proves "a browser reload gets the
current code", which is stronger than "the source looks right" - and after a
front-end edit it is the only automatic way to confirm the change took effect.

`verify:profile` boots a sandbox instance on its own port with its own
`DSH_HOME`, and terminates only the process it started, **by pid**. It never
touches the DSH you are using:

```sh
DSH_BIN=/path/to/dsh/lib/bin.js PORT=4123 DSH_HOME=/tmp/dsh-edit-turn-home bash tools/verify-dsh-plugin.sh
```

**The one link that is NOT verified, stated plainly:** the coupling to the **real
DSH interface** - the real DOM structure, real CSS layout, and whether React's
reconciler drops an injected node when it re-renders a row - needs a real browser
(React and Playwright are both unavailable on this machine). The click path
itself is now covered: `test/client.dom.test.js` runs the real `OverlayEntry`
against a readable DOM implementation and asserts "click the action -> the editor
appears pre-filled -> click save -> the confirmation step appears -> click
confirm -> the right request is posted -> the editor closes", plus every failure
branch's message. That test is meaningful: reverting the re-render marker to its
old form makes 6 of its cases fail.

**Development prerequisite:** `npm test` and both `verify:*` commands need
`@deepseek-ai/dsh-session` and `@deepseek-ai/dsh-tools` to resolve. The plugin
itself does not depend on them (the host half imports only `schemastery` and
`dsh-tools`), so tests need a `node_modules` from a DSH installation:

```sh
ln -s /path/to/dsh-install/node_modules ./node_modules
```

### Known limitations

- **Human messages only.** Injected context rows, assistant messages and the system prompt offer no edit entry.
- **An edit discards every later turn** (the MVP semantic, matching ChatGPT's edit). Keeping the original as a branch needs `sessionController.fork({ sessionId, atSeq })`, which is not implemented.
- **Text only.** A message carrying image or file attachments keeps its text and drops them (the editor warns first).
- **The session must be open in DSH**, otherwise the route answers `409 session-not-active`.
- **Running work is refused**: an unclosed turn or an in-flight compaction answers `409 busy`.
- **The rollback is durable; the hiding is not.** Once written, the rollback permanently changes the model context. Hiding those rows in the transcript is this plugin's browser half. Uninstall the plugin and the old rows reappear - while the rollback in the model context still stands, because the replacement is an official event that outlives the plugin.
- **The system prompt is never touched**: the window can never include surface node 0, and that node is never editable.

### Sister plugins

- [dsh-delete-turn](https://github.com/DDDMUC/dsh-delete-turn) - delete a message, a step or a reply, on the same surface-replace contract.
- [dsh-free-search](https://github.com/DDDMUC/dsh-free-search) - multi-engine web search without API keys.
- [dsh-delete-session](https://github.com/DDDMUC/dsh-delete-session) - delete sessions from the sidebar.

### Compatibility

- `dsh.engines.dsh`: `>=0.1.6-alpha.2` (this plugin relies on that release's message-row definitions and surface semantics, and was verified on it).
- Client dependencies: `dsh-client-locale`, `dsh-client-ui-chat`, `dsh-client-ui-conversation`, `dsh-client-ui-primitives`.
- Host dependencies: `dsh-settings`, `dsh-tools` (peers); `@deepseek-ai/schemastery` (direct).

### License

MIT
