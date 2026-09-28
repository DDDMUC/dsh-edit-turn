# dsh-edit-turn

**DeepSeek Harness 的「编辑某一轮」插件 —— 点用户消息旁的编辑按钮，就地改写那一句。保存即生效：改后的内容成为模型后续读到的版本，这一条消息下面的对话原样不动。** 改写走官方 surface-replace 契约（一条替换事件同时完成"删旧 + 立新"，被替换的内容从模型上下文里消失），**默认不重跑模型**。会话日志是 append-only 的，**原始字节一个都不改写**。

[中文](#中文) · [English](#english)

---

## 中文

### 为什么需要它

DSH 的会话日志是 append-only 的事件流：说错的提示词、问偏的问题，会一直留在模型上下文里污染后续每一轮。官方只有整段摘要式的「压缩」（`/compact`），没有「改一下我刚才那句话然后重来」这条路——而这恰恰是 ChatGPT / Claude 里最常用的动作。

这个插件把它补上：

- 悬停任意一条**你自己发过的消息**，右侧出现编辑按钮；
- 点击后在该消息下方就地展开编辑器，预填原文；
- 保存后：**只有这一条消息被替换**——旧措辞从模型上下文里消失，改后的内容占住它的位置（因此后续每一轮读到的都是改后的版本）；
- **它下面的助手回复、以及之后的全部对话，原样保留**，不重跑、不清空；
- 想让它立刻按改后的内容重新回答，把 `rerun` 打开即可。

### 特性

- **官方 seam，不改日志** —— 回退 = 追加一条带 `surfaceOp: { op: 'replace', startSeq, endSeq }` 的替换事件。原始事件全部留在会话文件里，只是不再进入 `deriveMessages()`。与官方 `/compact` 用的是同一套契约。
- **改写内容就是载体本身** —— 提示词编辑落下的是一条 `user/message` 替换事件，内容就是你改后的那句话。它既让模型读到你改后的版本，也在转录里显示成你自己的气泡；平台不会把它当成新输入去回答（这一点踩过坑：**追加**一条 user 消息会触发平台自动回答，越改越多）。
- **窗口最小化** —— 提示词编辑只遮蔽目标那一格（`shadowed = [target.seq]`）；回复编辑才需要"到末尾"的窗口（回答变了，建立在它之上的一切都不再成立），因此助手消息（内含 tool_use）与它产生的 tool/result 永远一起走，**不可能留下悬空的调用/结果对**。
- **默认不重跑模型** —— 保存只写上下文，不产生任何模型调用。想"改完立刻重答"，配置 `rerun: true`：那会走官方准入路径 `ctx.sessionController.prompt()`（它会自己 resume 冷会话，并恰好开一个新轮次）。
- **模型回答也能编辑** —— 回答无法被"替换"：官方格式禁止 `assistant/message` 携带 `sourceEventSeqs`（已在真实校验器上验证）。做法是回退该回答及其后的内容，再**追加**一条带改写文本的助手消息——模型会把改写后的内容当成自己说过的话，对话可以继续。`source.editedBy` 会如实记录这段文字由插件写入。
- **改过的那条还能再改** —— 它仍然显示在原来的位置（由插件渲染成气泡），悬停就有编辑按钮。
- **一次点击即执行** —— 保存后不再有二次确认（`confirm: true` 可恢复两步确认，确认步里会写明这次保存会丢弃什么）。编辑器本身已经是用户主动打开的动作，保存的后果在 README 与确认步里说明，输入框本身保持干净。
- **中英双语 UI**，跟随 DSH 当前语言。
- **皮肤友好** —— 编辑器面板自带不透明表面（`--dshet-panel`）而不是借用主题的表面色变量。皮肤的本意就是让表面半透明、把插画透出来，而它只会给**自己的**元素补可读背景，插件类名不在其中；借用皮肤变量的面板会变成全透明，文字直接压在插画上。暗色分支走官方属性 `body[data-ds-dark-theme]`（与 `dsh-client-ui-theme` 及多个官方 UI 包一致），并用 `backdrop-filter` 与皮肤融合。
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
2. 消息下方展开编辑器，原文已预填。改完点「**保存**」——**一次点击即执行**：旧措辞从模型上下文里移除，改后的内容占住它的位置，**不叫模型**。（配置 `rerun: true` 时按钮为「保存并重跑」。）
3. 编辑器收起，那条消息就地变成你改后的内容；它下面的回复与之后的对话**原样不动**。

编辑器是**平台输入框那样的一个圆角盒子**：输入区在上、取消与主按钮在右下，聚焦时整圈描边高亮；**随文字长高**（空的时候不留空白），没有标题栏、没有常驻说明、没有拖拽手柄。键盘也和输入框一致：**Enter 保存、Shift+Enter 换行、Esc 取消**（确认步里 Esc 是退回上一步）。**输入法优先**：组合中的 Enter 与"候选选词的 Enter"（`isComposing` 或 `keyCode 229`，平台自己的输入框也是这两条一起挡）都不会被当成保存，组合期间也不重排输入框——此前少挡了 229 那半，拼音选词按回车会直接保存/关闭，看起来就是"打不了中文"。

编辑器里如果提示「这条消息包含图片或文件附件」，说明改写只保留文字，附件会被丢弃。

**编辑模型的回答**：悬停任意一条模型回复，同样会出现编辑入口。改完点「保存」——这条回答被替换为你写的内容，它之后的内容一并移除，模型从此把你写的内容当成自己说过的话，对话可以继续下去。

注意：回答里的**工具调用与思考过程**无法保留（替换后只留文字，编辑器会提示），因为工具调用的结果已经不再成立。

### 配置

写在 profile 里即可覆盖默认值：

```yaml
- id: dsh-edit-turn
  config:
    confirm: false              # 默认 false：一次点击即执行；置 true 才要求二次确认
    rerun: false                # 默认 false：保存只写上下文；置 true 则同时重跑该轮
```

| 字段 | 默认 | 含义 |
|---|---|---|
| `confirm` | `false` | 客户端保存后是否先要求一次确认。默认**关闭**（一次点击即执行：编辑器本身已是用户主动打开的动作；设为 `true` 时确认步里会写明这次保存会丢弃什么）； |
| `rerun` | `false` | 保存后是否立刻重跑该轮。默认**关闭**：改后的内容进上下文即可，等你下次发消息时模型才读到它。设为 `true` 则保存即重跑（走官方 `sessionController.prompt()`）。 |

### 工作原理

一次编辑就是**一条官方替换事件**。读事件流（`sessionQuery.readSession`，回退到活动会话的 `snapshotEvents()`），用官方折叠规则算出当前 surface 顺序，定位目标消息的节点，然后：

- 提示词编辑：窗口 = **仅那一格**（`[target.seq]`），载体就是改后的文本；
- 回复编辑：窗口 = `surface[目标下标 .. 末尾]`（回答变了，建立在它之上的一切都不再成立）；先在日志里**开一个新轮次**（`turn/start` + `step/start`），载体是空 `developer/message`（空内容不投影给模型），随后把改写文本作为一条助手消息追加进这个轮次，再 `step/end` + `turn/end` 收尾。

追加一条：

```js
// 回复编辑的形状；提示词编辑的载体就是改后的那条 user/message
session.append('developer/message', { turn, step, message: { role: 'developer', content: [] } }, {
  surfaceOp: { op: 'replace', startSeq, endSeq },
  sourceEventSeqs: shadowed,      // 完整覆盖：官方校验要求列出全部被遮蔽的节点
})
```

落盘后等一次持久化检查点（`sessions.flush`），保证重启也能看到。

**第二步（可选）：重跑。** 默认不做。`rerun: true` 时：

```js
await ctx.sessionController.prompt({ requestId, sessionId, mode: 'queue', content: [{ type: 'text', text: 新内容 }] })
```

**为什么不做文件截断？** 因为那不是官方能力。`dsh-session-persistence-jsonl` 只暴露残帧崩溃修复用的 `truncateTornTail`，正常路径下「Committed events are never rewritten」；运行中的宿主把会话放在内存 append-only 日志 + 投影缓存里，改磁盘不会让它重新读取。截断还会破坏 `sourceEventSeqs` 的 `[start,end]` 压缩表示与多帧 zstd 结构。surface-replace 是官方为这件事准备的机制。

**插件接口**

| 类型 | 名称 | 说明 |
|---|---|---|
| 路由 | `GET /dsh-edit-turn/state?sessionId=` | 可编辑轮次、已遮蔽行账本（`hidden` + `revisions`）、surface、忙碌状态 |
| 路由 | `POST /dsh-edit-turn/apply` | `{ sessionId, seq \| messageId \| turn, text }` → 写入改后内容（`rerun: true` 时另加重跑）；响应含 `applied` / `reran` / `shadowed` / `replacementSeq` |
| 工具 | `edit_turn_targets` | 只读：列出该会话当前可编辑的轮次与原文（供 agent 自查） |
| 前端 | `conversation.input.overlay` | 每会话控制器：编辑入口、就地编辑器、被遮蔽行的隐藏账本 |

### 跨插件契约（给兄弟插件）

转录只为 **append surface 事件**建行（ui-chat 的 user/assistant 定义都以 `isAppendSurfaceEvent` 为 match 条件），所以一次就地编辑之后，**那一行永远锚在原来的 seq / messageId 上**——行里没有任何字段告诉别的插件"我现在在 seq N"，而模型上下文里的活节点是替换事件。任何按 surface 校验的入口（例如兄弟插件 `dsh-delete-turn` 的删除按钮）只看原 seq 就已经死了，是否继续提供入口需要沿替换链找到活节点。为此外部消费者可以依赖：

1. **prompt 编辑保持单节点窗口**：`planRollback` 的 `mode === 'prompt'` 只遮蔽目标那一格（`shadowed = [target.seq]`），不会顺手回退到末尾；
2. **替换事件与目标同事件类型**：改 `user/message` 落下的就是 `user/message`（回复编辑不换类型就换不了位，见第 5 条）；
3. **`sourceEventSeqs` 永远列全窗口**：官方校验要求完整覆盖，缺一个节点事件会被拒；
4. **每个替换都带语义标记**：`source.kind === 'plugin:dsh-edit-turn'` 且 `source.editedBy === 'dsh-edit-turn'`——包括那个不含文本的空 `developer/message` 载体，兄弟插件按 `editedBy` 识别即可，不必靠推断窗口形状；
5. **回复编辑 = 多节点回退 + 追加新回复**，不是就地替换：旧回复行没有入口是**设计如此**（新行自带入口）。不要为了保住旧行的入口往 `assistant/message` 上加 `sourceEventSeqs`——官方校验会直接拒；
6. **映射已公开**：`GET /dsh-edit-turn/state` 的 `revisions[]` 给出 `{ replacementSeq, startSeq, endSeq, shadowed }`（字段名与 `POST /apply` 响应一致），`hidden[]` 每题一格列出 `{ seq, turn, replacement }`。跨插件不必再从事件流自行推导。

**`source.kind` 的行为（有意为之）**：prompt 编辑落地的那条 `user/message` 的 `source.kind` 是 `plugin:dsh-edit-turn`，**不是 `user`**。因此凡是以 `source.kind === 'user'` 识别"人类提问"的消费者（例如按人类提问划分回复删除窗口的逻辑），会把这条改写后的提问当作**普通内容**。这是刻意的：它是一段插件写入的文本，不是新的用户发话，平台也就不该再回答它；需要识别它的消费者请用上面的 `revisions`/`editedBy`，不要放宽 `source.kind === 'user'` 的判定。

### 验证状态

本插件在 DSH `0.1.6-alpha.2` 与 `0.1.7-rc.1` 上完成以下验证：

| 验证 | 命令 | 结果 |
|---|---|---|
| 运行中的实例是否真的挂载了本插件（只读路由守卫探针，无需 token） | `npm run probe:loaded [端口]` | 通过：`/state` 返 400、`/apply` 返 405 —— 这两个状态码只有本插件会返回 |
| 浏览器半部到底问了什么、拿回了什么（只读诊断，含失败记录） | `GET /dsh-edit-turn/debug` | 通过：真实浏览器里确认客户端确实拿到 replies；并复现了旧 v3 会话的 session-not-found |
| 官方 append **与读取**契约（真实校验器，进程内） | `npm run verify:contract` | 80 项通过（每段写入后都用加载器重读整份日志）：替换事件被接受、派生历史真的收缩、日志 append-only、工具结果与调用同进同退、空 developer 载体不产生模型消息、**连续两次回退都被接受**、**编辑模型回答的完整机制被接受**、**跨插件依赖的不变量（单节点窗口 / 同事件类型 / 全窗口 sourceEventSeqs / 每个替换都带 `editedBy` 标记 / 改写后的 `source.kind` 不是 `user` / 修正回复不带 `sourceEventSeqs`）** |
| 纯逻辑 + 宿主集成 + 客户端 DOM 行为（真 HTTP、真校验器、桩服务、DOM 桩） | `npm test` | 105 项通过 |
| 客户端半部静态检查（注册、i18n 完整性、样式、皮肤可读性、版本三处同步、线协议） | `npm run verify:client` | 全部通过 |
| 实机前端产物校验（运行中的 DSH 是否在下发当前代码） | `npm run verify:live -- --token-file ~/path/to/dsh.log` | 全部通过（含**宿主节点形状锚点**） |
| **真实浏览器渲染冒烟**（CDP 驱动已开着的标签页，只读） | `npm run verify:ui` | 全部通过：下发的字节就是刚改的字节、无槽位崩溃留下的空占位、回复铅笔在平台动作条里、被回滚的行保住动作条、**被回滚的用户行一定显示替代文本（消息不会凭空消失）**、**替代气泡一定排在时间/复制之上（顺序与正常消息一致）**、**改写后那颗铅笔一定在还活着的动作条末尾（已在原始会话、切走的会话、切回后三处现场确认）**、**回复铅笔一定排在动作条最左（复制之前，已现场确认）**、气泡上没有 `.dshet-floating` 压着文字、切走再切回入口仍在 |
| 真实 profile 安装 / 补丁合成 / 启动 / 工具契约 / 路由守卫 | `npm run verify:profile` | 全部通过 |
| **真实浏览器端到端**（agent-browser 驱动 Chrome 打开运行实例） | 手动 | 已完成：模型回答行出现「编辑这条回答」、点开编辑器预填真实回复原文、取消后网络层 0 个 apply 请求。截图见 `docs/reply-editor-in-browser.png` |

`verify:live` 针对**正在运行的实例**：用 DSH 启动时打印的 token 换取鉴权 cookie，读启动页里的客户端模块组，把含本插件的那一组下载下来，断言插件自己的标记确实在其中。它证明的是「浏览器刷新后会拿到当前代码」，而不是「源码看起来没问题」——前端改动后这是唯一能确认已生效的自动手段。

`verify:ui` 直接驱动一个**已经开着**的 Chrome 标签页（`--remote-debugging-port`，默认 9333）：先缓存击穿地重载，断言浏览器此刻拿到的字节就是刚改的字节，再读 DOM 与 console——每个 assistant 单元格都渲染出了东西（没有被 `abdicate` 留下的空占位）、回复铅笔落在平台自己的动作条里、被回滚的行丢掉消息但保住时间/复制/删除、**并且每一条被折叠的用户消息都立着本插件的替代气泡**（这条正是「保存后消息不见了」的现场判据：行可以折叠，但不能折叠到无处显示替代文本）、**而且这颗气泡排在时间/复制的上方**（顺序与平台画一条正常消息时一致，否则时间戳看起来像属于下一条）、**改写后那颗铅笔排在还活着的那条动作条的末尾、气泡里不再留笔**（把 message 文本那一层留给文字，铅笔跟着行本身走）、**回复铅笔排在动作条最左、压在平台自己画的复制按钮之前**（那一格是 `display:contents`，DOM 序只能排第二，靠 flex `order` 才能争到第一位，现场按布局算 x 而不是数节点）、气泡上没有 `.dshet-floating` 压着文字、切走再切回会话入口仍在。它**只读**：从不打开编辑器、从不点保存、从不发 `/apply`。（这两条铅笔落位的断言已在真机重载后跑通，三处视图——原始会话、切走的会话、切回后——都确认了。）

`verify:profile` 会另起独立端口 + 独立 `DSH_HOME` 的沙箱实例，**只按 pid 结束自己启动的进程**，绝不触碰你正在用的 DSH。也可以手动指定：

```sh
DSH_BIN=/path/to/dsh/lib/bin.js PORT=4123 DSH_HOME=/tmp/dsh-edit-turn-home bash tools/verify-dsh-plugin.sh
```

**尚未验证的一环（诚实说明）**：`verify:ui` 覆盖的是「渲染成什么样」（只读），**真正按下保存**会发 `/apply` 并回退会话——这一步刻意留给手动端到端（见上表最后一行与 `docs/reply-editor-in-browser.png`），冒烟脚本永远不碰。另外本机没有 React / Playwright，所以 `verify:ui` 走的是裸 CDP 而不是框架。但纯点击路径本身已被自动覆盖：`test/client.dom.test.js` 用一个可读的 DOM 实现把真实的 `OverlayEntry` 跑起来，断言「点动作 → 编辑器出现并预填 → 点保存 → 进入确认步骤 → 点确认 → 发出正确请求 → 编辑器关闭」以及各失败分支的文案。这个测试是有意义的：把重绘标记改回旧写法时，其中 6 项会失败。

**「按下保存之后那一屏」同样已被覆盖**，因为这里出过一次真事故：保存成功后旧消息行被折叠，而替身气泡从未建起，整条消息在界面上消失（截图见 `docs/`，服务端状态其实早已回退成功）。三个用例分别钉住它的一半成因——①保存响应一到，替代气泡必须立刻出现（把紧随其后的 `/state` 卡住不返回也得过，证明不靠刷新兜底）②保存必须重新向宿主要一次 `/state` ③有替换记录却还没有替换文本时，行不得折叠。把 `lib/client.js` 里对应的三处修复逐一还原，这三个用例各自**恰好失败一次**，恢复后当时 94 项全绿（现 105 项）。

**「气泡排在时间/复制上面」同样已被覆盖**：替代气泡原先插在被折叠行的**后面**，行里剩下的时间戳与复制按钮于是排到了改写文本的上方，看起来像属于下一条消息。现在气泡插进行内、动作条**之前**（`placeRevisionBubble`），同时 `collapseRowContent` 的豁免名单加上它自己——气泡一旦进到行里，清空行内容的那一步就必须放过它；而没有动作条可留的行会整行消失，此时气泡改插到行**前面**，否则会跟着行一起被藏起来。两个用例分别钉住这两种情形（94 → 95 项）：把定位那一处改回「插在行后」，恰好 4 个用例同时失败。`verify:ui` 加了现场断言「气泡必须在动作条之上」，静态检查加 2 条，`verify:live` 加 1 个下发标记。

**「两支铅笔该落在哪儿」同样已被覆盖**，这是按你给的规范改的：用户行那颗笔排在**动作条的最右边**（时间、复制、以及兄弟插件后插进来的按钮之后），回复行那颗笔排在**动作条的最左边**（复制按钮之前）。两处都不是"换个插入点"能办到的，各自卡在一个宿主限制上：折叠行原先把笔塞进替代气泡的字外留白里（要悬停改写文本才看得见，也够不着"复制"）；回复笔受宿主注册的 slot 约束，DOM 上必然排在平台自己画的复制按钮之后。现在的做法是：①`renderRevision` 把改写后的笔**交给那条活下来的动作条**（`injectRowAction(row, editTarget, …)`），同时把它从气泡里摘掉，只有行彻底没有条可留时才退回气泡字外留白；`applyDom` 在行可见时**只在没有替代气泡站位时**才拆掉行上的笔——否则会把上一行刚放进去的笔拆走。②回复笔靠新增的 `.dshet-reply-action` 加 flex `order:-1` 冲到最左，因为那一格宿主是 `display:contents`，DOM 序永远只能第二，只有顺序属性改得动；用户笔同理——兄弟插件（`dsh-delete-turn`）会在任意时刻把垃圾桶**追加**进同一条动作条，DOM 插入序保不住右端，所以 `.dshet-action-host` 带 `order:9`，无论谁后插都在它左边。颜色也一并对齐平台：`.dshet-action` 改用平台的 `--dsw-alias-label-tertiary`（悬停 `--dsw-alias-label-primary`，留一个等于默认主题取值的兜底），不再用自己的蓝灰墨色——此前它比旁边的复制/垃圾桶更蓝，看起来像另一个控件；实测两者计算色都是 `rgb(129, 133, 140)`。测试上：原"铅笔在字外留白"的用例改写为「铅笔并进那条活下来的条的末尾、气泡里不再留笔」，无条用例补上"留白里仍有笔"，回复 entry 用例补 class 断言；静态检查加 4 条钉住这一批写法（含「气泡按内容收窄」），另加 1 条钉住 `order:9`，`verify:live` 加 2 个下发标记；`verify:ui` 的「行末尾的笔」断言改成**按布局量右边缘**（DOM 序不算数）并已在真机重载后跑通——现场那个用户条是 `时间 → 复制 → 垃圾桶 → 笔`，笔在最右（原始会话/切走的会话/切回后三处确认）。三处新写法各做过反向复现：把「笔交给动作条」「`.dshet-reply-action` class」「`applyDom` 的站位守卫」逐一还原，各有一个用例失败（守卫那处失败在「笔并进条末尾」用例上——它恰好也钉住了"刚放好又被拆走"这条回归）。当前 `npm run check` **105 项** + 契约 + 静态全绿。

**开发前置**：`npm test` 与两个 `verify:*` 需要 `@deepseek-ai/dsh-session` 与 `@deepseek-ai/dsh-tools` 可解析。本插件自身不依赖它们（宿主半部只 import `schemastery` 与 `dsh-tools`），测试需要一个装了 DSH 的 `node_modules`：

```sh
ln -s /path/to/dsh-install/node_modules ./node_modules
```

### 已知限制

- 可以编辑**你自己输入的消息**与**模型的回答**；注入的上下文行与系统提示词没有编辑入口。
- 编辑一条回答会把它替换为**纯文本**：该回答里的工具调用与思考过程会被移除（编辑器会提示），因为它们的结果已不再成立。
- 编辑一条用户消息**只替换那一条**，**默认不重跑模型**（`rerun: true` 才会保存后立刻重跑）；编辑一条模型回答只替换内容，同样不问模型。
- **提示词编辑只动那一条**：它下面的回复与之后的对话**原样保留**。**回复编辑**才会移除该回答及其后的内容——回答变了，建立在它之上的一切都不再成立。想保留原文形成分支，需要走 `sessionController.fork({ sessionId, atSeq })`，尚未实现。
- **只改写文本**。消息里含图片/文件附件时，改写后只保留文字（编辑器会提示）。
- **会话必须当前在 DSH 中打开**，否则返回 `409 session-not-active`。
- **进行中拒绝编辑**：未闭合的轮次或正在压缩时返回 `409 busy`。
- **回退是持久的，隐藏不是**。回退写进日志后，模型上下文永久改变；转录里那些行的隐藏是本插件客户端半部做的。卸载插件后，旧行会重新显示出来（而模型上下文里的回退仍然生效）——因为替换事件是官方事件，不会随插件消失。
- 回退后**系统提示词保持不变**（窗口永不包含 surface 节点 0，该节点也永不可编辑）。
- **旧会话（v3 格式日志）在 DSH 0.1.7 下读不到**：DSH 的会话读取层对这类日志返回 `session-not-found`，本插件因此在其中完全不工作（表现为没有编辑入口）。新写的会话是 v4，正常。

### 排查：编辑入口整个不见了

先分清是"插件没加载"还是"加载了但没渲染"——两者的现场完全不同，别猜。

1. **插件加载了吗？** 在插件目录跑 `npm run probe:loaded [端口]`（默认 3080）。返回 `400`/`405` 说明宿主半部在跑；返回 `404` 说明插件根本没加载。
2. **没加载时看宿主启动输出**，找这一行：

   ```
   dsh-edit-turn (dsh-edit-turn): failed to import
   ```

   这行的原因几乎总是**依赖解析失败**，最常见的是：插件以 `link:` 方式安装（开发目录直接挂进 profile），而插件目录的 `node_modules` 是个指向某处 npx 缓存的软链——缓存被 `npx` 清理后软链变死链，静态 `import` 直接抛错，整个插件消失。修法是在插件目录里真实安装依赖：

   ```sh
   cd <插件目录> && rm -f node_modules && npm install --omit=dev --legacy-peer-deps
   ```

   注意区分两类依赖：宿主提供的 **peer**（`dsh-tools`、`dsh-settings`）由 DSH 加载器解析，可以不装；**普通 dependencies**（如 `schemastery`）必须能解析到，加载器不会替你找。
3. **加载了但没入口时**，用只读诊断路由看浏览器半部到底问了什么：

   ```sh
   curl "http://127.0.0.1:<端口>/dsh-edit-turn/debug"
   ```

   记录里有 `state` 且 `replies` 大于 0 → 数据到了客户端，问题在渲染；**一条记录都没有** → 客户端半部没跑起来（看浏览器控制台）。

4. **「历史加载失败 / 某个会话读不出来」**（`session-not-found`，控制台里出现 `SessionFormatError`）：这可能是 0.2.0–0.2.3 的回复编辑留下的坏日志。用仓库里的修复工具扫描并用官方加载器验证、备份后截断：

   ```sh
   node tools/repair-session.mjs ~/.dsh/sessions/<项目目录> --dry-run
   node tools/repair-session.mjs ~/.dsh/sessions/<项目目录>
   ```

   截断前的内容全部留在同目录的 `*.corrupt-*.bak` 里；修复后重启 DSH（或桌面版）即可重新打开该会话。

   **「点了保存没反应」先看这里**：记录里有没有 `apply`。没有 → 点击丢在浏览器半边（此前的成因是宿主在 mousedown/mouseup 之间重建了行，按钮已改为 pointerdown 激活）；有 `apply` 但 `ok:false` → 宿主拒绝了，`code` 就是原因（`busy`/`stale`/...）。

### 更新日志

**0.2.6** —— 修「改写过的提示词，再点它的笔没反应」。

- **修复：折叠改写行上的铅笔是死的**。改写后的提示词由一个替换事件承载，而平台**不为替换事件渲染行**——于是"哪一行覆盖被编辑的 seq"永远匹配不上，编辑器根本不渲染，点击无声无息（无报错）。现在"覆盖"也认**该行的替换指向**（`revisions.get(行seq) === 编辑seq`），并且编辑器自 0.2.3 起挂在独立浮层上，折叠行承载它没有任何问题。新增用例「改写过的提示词，点笔仍能打开编辑器（预填替代文本）」+ 1 条静态检查；真机复现：重载后点击折叠行上的笔，编辑器打开并预填「回复2」。

**0.2.5** —— 修「每保存一次，模型的回答往下掉一格」。

- **修复：被回滚的「轮次尾巴」没有隐藏，堆成了一列空条**。回复编辑会留下旧轮次的尾巴（用时/用量/动作条）——它不是消息行，属于它的消息已经被回滚，尾巴上没有任何可操作的东西。此前我们按"消息行"的规则给它保留了动作条（那条规则本是为了让被回滚的用户消息还能复制/删除），于是**每保存一次就多一条空条**，把对话一格格顶下去。现在按 `data-chat-flow-kind="turn-tail"` 识别：尾巴整条隐藏（并清理旧版本给它打过的 `data-dshet-keep-actions`），消息行照旧保留动作条。新增用例「被回滚的轮次尾巴整条消失，而不是叠一条空条」+ 2 条静态检查；`verify:ui` 的现场断言改为三条事实——轮次尾巴整条隐藏、没有动作条的行整条隐藏、有动作条的消息行必须保住动作条（真机 6 条孤儿尾巴全部按新规则消失）。
- 补一句 0.2.4 的发布说明：`verify:ui` 与 `verify:live` 在 0.2.4 上均已通过；本缺陷是发布后由使用现场发现的。

**0.2.4** —— 修一个**会把会话写坏**的致命缺陷（回复编辑的写入非法），并把「读取路径校验」补进契约测试。

- **修复（致命）：回复编辑会把整份会话写到读不出来**。旧写法把两样非法内容写进日志：①静默载体是一个空的 `system/message`，而格式**只允许 system-prompt 来源的 system 消息**；②修正消息带着**已经关闭的**原轮次 turn/step 追加。追加是宽松的（当场不报错），但**读取**会拒绝：DSH 从此对该会话返回 `session-not-found`，「历史加载失败：stored log is corrupt: SessionFormatError: system/message does not match an open turn and step」。现场表现就是那个会话里所有编辑入口消失、历史打不开。现在：回复编辑先在日志里**开一个新轮次**（`turn/start` + `step/start`），静默载体改为**空 `developer/message`**（空内容不投影给模型、替换不进转录、格式合法），修正消息与 `step/end`/`turn/end` 都在这个轮次内收尾；运行时从 `turn/start` 事件投影 `lastTurn`，所以它下一轮用 N+2，序号一致。
- **契约测试补上「读取路径」这一层**：以前只验 `append` 被接受，现在每一段写入之后都用与现代码同一套加载器（`Session.create` + 消息投影）**重新加载整个日志**，并模拟"回复编辑之后的下一个真实轮次"，任何非法的轮次/来源/形状都会在这里失败——这个校验如果早有，上面的事故就不会发生（契约 73 → 80 项）。
- **附带产出 `tools/repair-session.mjs`**：扫描一个 `sessions` 目录，用同一套加载器找出被写坏的日志，**先备份**再在第一个非法事件处截断（日志要求 seq 从 0 连续，坏事件无法单独摘除；实践中被截掉的正好都是本插件的坏"回复编辑"组，真实对话保留）。本机 4 个受影响会话都已按此法修复，原文件留在同目录 `*.corrupt-*.bak`。
- 其余为 0.2.2/0.2.3 累积的浏览器半部修复（见下），一并随本版发布到 npm。

**0.2.3** —— 修浏览器半部的一批界面缺陷，并让它们以后能被自动验证。

- **修复：保存改写后整条消息从界面上消失（最严重的一处）**。保存成功的乐观更新只记下了「哪些行被回退」，既没记「替代文本现在哪一条 seq 上」，也没把它放进可编辑集合，替身气泡因取不到文本而从未建起；紧接着的折叠照常执行，行就空了——而行数没变，客户端又不会重新拉 `/state`，于是这一屏永远卡在乐观态（服务端其实早已回退成功）。现在保存响应里的 `replacementSeq` / `shadowed` 会补齐映射与条目、保存后必定重新拉一次 `/state`（在途请求排队而非被复用），并加了一条不变量：**替代文本没画出来之前，用户消息那行不许折叠**（最坏情况是多显示一会儿旧原文，而不是什么都不显示）。

- **修复：回复编辑笔根本不渲染**。条目用 `jsx(PencilIcon, null)` 交给宿主，而这个宿主的 `jsx` 读 `config.key` 前不判空——一抛错，槽位就把这条记录 `abdicate`（本页生命周期内永久除名），该 assistant 单元格渲染成一个空的 `data-slot-error` 占位，界面上只是"没有笔"，没有任何报错。现在组件对缺失/为 `null` 的 props 全程防御（缺什么就只是不出这一颗笔），图标带配置对象渲染；崩溃现场与"条目被除名"的推断都写进了 `tools/verify-live-ui.mjs` 与 `test/client.dom.test.js`。
- **修复：被回滚的那行把平台自己的动作栏一起藏了**。此前 `setRowHidden` 对整行 `display:none`，时间戳、复制、删除（以及姊妹插件的入口）随之消失。现在行只收起消息内容，动作栏照常保留（`data-dshet-keep-actions`），样式表用 `:not([data-dshet-keep-actions])` 排除这类行。
- **修复：改写气泡里的编辑笔压住文字**。笔原本绝对定位在 60×40 的气泡内部并 `top:50%` 居中。现在笔移到字外的 gutter（`top:6px`），气泡用 `padding-inline-end` 把位置留出来。**（0.2.3 后期：这条留白退成兜底——行还有动作条时，笔改并进那条条里，见下一条。）**
- **修复：时间与复制条跑到了替代气泡头上**。替代气泡原先插在被折叠行的**后面**，行里剩下的时间戳与复制于是排在了改写文本的上方，读起来像属于下一条消息。现在气泡插进行内、动作条**之前**（`placeRevisionBubble`：幂等，仅在位置不对时才移动），并把 `collapseRowContent` 的豁免名单加上 `.dshet-revision`——气泡进了行，清空行内容的那一步就必须放过它；没有动作条可留的行会整行消失，此时气泡改插到行**前面**，消息照样可见（新增用例钉住这条）。气泡与动作条的间距对齐平台自己的 `gap:6px`。
- **修复：两支编辑笔不在该在的地方**。按规范——用户行那颗笔要排在**动作条最右**（时间、复制之后），回复行那颗笔要排在**动作条最左**（复制之前）。旧实现两处都不满足，且各卡在一个宿主限制上：折叠行把改写后的笔塞进替代气泡的字外留白（要悬停改写文本才可见，也够不着"复制"）；回复笔走宿主插槽注册，DOM 序必然排在平台自己画的复制按钮之后。现在 ①`renderRevision` 把笔交给那条活下来的动作条（`injectRowAction(row, editTarget, …)`）并同时从气泡里摘掉（`removeRowAction(bubble)`），无条可留才退回留白（`.dshet-revision-action` 成为纯兜底）；`applyDom` 在行可见时**只有行前没有替代气泡站位**才拆行上的笔，否则会把刚放进去的笔拆走。②回复笔加 `.dshet-reply-action` + flex `order:-1` 冲到最左——那一格宿主是 `display:contents`，DOM 序只能第二，只有顺序属性改得动。另修替代气泡被撑成整行宽的药丸（挪进行内后 `align-self` 失效，补 `width:fit-content`）。
- **修复：用户笔被兄弟插件的按钮挤下最右**。`dsh-delete-turn` 的垃圾桶会在它自己的 pass 里 `appendChild` 到同一条动作条，落点在我们的笔之后（现场：`时间 → 复制 → 笔 → 垃圾桶`），而两边都不会再移动已有的节点，DOM 插入序永远保不住右端。现在 `.dshet-action-host` 带 flex `order:9`（该条是 `display:flex`，平台项都是 `order:0`；留白/浮动两处不是 flex 项，不受影响）——现场已确认变成 `时间 → 复制 → 垃圾桶 → 笔`。真机断言同步改成**按布局量右边缘**，不再数节点顺序；静态检查加 1 条钉住 `order:9`。
- **修复：笔的颜色和平台的图标不一样**。`.dshet-action` 原用本插件自己的蓝灰墨色（`--dshet-ink-dim`，`#4b5872`），在平台的中性灰图标（`--dsw-alias-label-tertiary`，`#81858c`）旁边显得像「选中/可用」状态。现在改用平台同一个变量（悬停用 `--dsw-alias-label-primary`，兜底值取默认主题的实测值），实测铅笔与复制按钮的计算色完全一致；静态检查加 2 条钉住这两个变量。
- **修复：插件依赖解析失败会让功能整体消失**。插件目录的 `node_modules` 若是指向某处 npx 缓存的软链，缓存被清理后静态 `import` 抛错，宿主只打印一行 `failed to import`，界面上毫无痕迹。现在解析失败会降级为"没有设置表单"，插件照样加载。
- **修复：编辑笔的位置**。回复行的编辑笔此前排在时间戳之后（行的收尾信息之后），随后改为落在平台动作图标里；最终按规范定在**回复动作条最左**（见上一条），用户行的笔则落在**其动作条最右**。
- 新增：`npm run verify:ui`——真机渲染冒烟（裸 CDP 驱动已开的标签页，只读）：缓存击穿重载、断言下发字节即当前代码、读 DOM 与 console 断言四个缺陷的表现，切走再切回会话验证入口还在。
- 补强：`test/client.dom.test.js` 的 `jsx` 桩复刻宿主契约（`config` 为 `null` 直接抛），并新增平台真实行结构 fixture；`verify:live` 修好启动页模块组 href 的相对路径解析，锚点改为在**所有**模块组里找宿主节点形状；静态检查加了隐藏规则与 gutter 的断言。
- 补强：新增三个「按完保存那一屏」用例（替代气泡立即出现 / 保存后重拉 `/state` / 缺替代文本时不得折叠，91 → 94 项），并把 `lib/client.js` 的三处修复逐一还原做过反向复现——每个用例在没有自己那处修复时恰好失败一次；`verify:ui` 加断言「被折叠的用户行旁边必须有替代气泡」，静态检查加 4 条（映射、刷新、在途排队、折叠不变量），`verify:live` 加 2 个下发标记。
- 加固：`verify:ui` 读宿主 `/state` 的那一步自带 8 秒兜底——大会话（数千事件）会让宿主答上十几秒，此前这会把整轮冒烟拖成 `evaluate timed out`；现在降级为「分母未知」并继续跑。往返断言的分母也统一成别处一直在用的 `turns - 回退数`：替换载体在宿主侧算可编辑，但平台不为它渲染行，本就没有行内铅笔可言。
- 补强：两支笔的落位各配了真宿主 DOM 用例——原「铅笔在字外留白」的用例改写为「铅笔并进那条活下来的条的末尾、气泡里不再留笔」，无条用例补上「留白里仍有笔」，回复 entry 用例补 `.dshet-reply-action` class 断言；静态检查加 4 条（`injectRowAction(row, editTarget, …)`、气泡笔的摘除、`order:-1` 规则与按钮上的 class、气泡按内容收窄），`verify:live` 加 2 个下发标记，`verify:ui` 加 2 条现场断言（行末尾的笔、回复笔按布局算 x 是否最左）与气泡「零支笔」的改写断言——**已在真机重载后跑通**；三处新写法也各做过反向复现（还原后各有一个用例失败，其中 `applyDom` 守卫那处失败在「笔并进条末尾」用例上，它同时钉住"刚放好又被拆走"这条回归）。当前 `npm run check` 105 项 + 契约 + 静态全绿。
- 新增（跨插件契约）：按兄弟插件 `dsh-delete-turn` 回传的核对结果，把它声明依赖的形状钉进真实校验器并公开——①prompt 编辑保持**单节点窗口**（只遮蔽目标那一格，不回退到末尾）②替换事件与目标**同事件类型**③`sourceEventSeqs` **全窗口**覆盖④**每一个**替换都带语义标记（`source.kind = plugin:dsh-edit-turn` + `source.editedBy`），包括不含文本的空 `developer/message` 载体⑤回复编辑仍是**多节点回退 + 追加修正**，不往 `assistant/message` 挂 `sourceEventSeqs`（官方校验会拒）。契约测试新增 7 条（6 节 +1、新 8b 节 +5、9 节 +1，共 73 项）；`GET /state` 新增 `revisions[]`（`{ replacementSeq, startSeq, endSeq, shadowed }`，与 apply 响应同名）并扩了 host 用例；README 增「跨插件契约」一节，明确改写后那条 `user/message` 的 `source.kind` 是 `plugin:dsh-edit-turn` 而不是 `user`（**有意为之**：它是插件写入的文本、平台不该再回答；按 `source.kind === 'user'` 识别"人类提问"的消费者请改用 `revisions`/`editedBy`，别放宽这个判定）。
- **修复：编辑器的保存按钮「点不动」**。宿主拥有行，流式回复时它会不断重建行——一个按钮如果在 mousedown 与 mouseup 之间被换掉，click 事件根本不会触发，而从外部看就是「点了没反应」，且状态里看不出任何痕迹。现在编辑器的取消/保存、以及行内铅笔都改走 **pointerdown**（按下即生效），键盘仍走 click；同一个按钮只接线一次并在同一次按压后**吞掉随之而来的 click**，避免重复执行。两条新用例分别钉住「按下即开、后续 click 不重置草稿」与「按下即前进到确认步」；静态检查加 3 条。另：回复编辑的按钮文案由「保存替换」改为「保存」（中英一致）。
- **修复：编辑器不像个输入框**。文本框固定 4 行高，两行文字浮在半个空盒子里，右下角还挂着拖拽手柄（`resize` 默认值），上面还压着标题行和一段说明——平台自己的输入框（以及它的排队消息编辑态）不长这样。现在整个面板就是**平台输入框的形状**：一个 16px 圆角容器，输入区透明无边框（`display:block`、`resize:none`，`fitEditorHeight` 按 `scrollHeight` 随内容长高，上下限 `min-height:47px`/`max-height:46vh`），聚焦高亮画在容器上（`:focus-within`），取消/主按钮是右下角的胶囊（`.dshet-footer` 右对齐）；标题行与常驻说明删除（说明留在确认步、按钮提示与本文档）。键盘对齐输入框：**Enter 保存、Shift+Enter 换行、Esc 取消/退回**，并且**输入法组合中的 Enter 不算保存**（`event.isComposing`）。用例新增/改写为「Enter 生效、Shift+Enter 换行、组合中的 Enter 不生效」「内容长高」「Esc 退回再关闭」，静态检查加 2 条（容器形状、输入法组合），`verify:live` 加 1 个下发标记。
- **修复：编辑器打开着的时候，别的输入框打不了字**。宿主随时会重绘消息行，我们的编辑框随之重建，而重建代码**无条件**执行 `area.focus()`——于是每次重绘都把光标从用户正在打字的地方（底部输入框、给会话改名、任何输入框）抢回编辑框：用户看到的正是"下面输入框点进去打不了字，字都跑你框里去了"。现在编辑器只在**刚打开**时聚焦；重建时只有用户本来就在本框内打字才把焦点**还**给它，并按记录的 `selectionStart/End` 还原光标位置，其余情况一律不碰焦点（`focus`/`blur` 维护 `editorFocus`）。两条用例（重建不抢焦点；重建归还焦点并还原光标）与 3 条静态检查钉住；真机复现：模拟宿主重绘后，焦点留在底部输入框，随后输入的字进入底部输入框，编辑框保持不动。后续又修了两处同源问题：**焦点意图改由「点击编辑器之外」释放**（`blur` 不行——宿主重建或保存期间的临时禁用也会 blur，那会导致保存失败后焦点回不来、重建中丢光标），并让**再点一次铅笔不再重置草稿**（此前会静默丢掉已输入的内容）。两处各配用例（保存被拒后焦点回到新框、按外面才释放意图、重点铅笔保留草稿）。
- **修复：拼音打不了中文**。键处理只挡了 `event.isComposing`，而**选词的 Enter 在很多引擎里是 `isComposing=false` + `keyCode=229`**（平台自己的输入框两条都挡，这是从它的源码里核对的）——于是每次按回车选词都被当成"保存"，框直接保存并关闭。现在按平台的方式两条一起挡，并且**组合期间不做高度重排**（`compositionend` 才排），避免输入框在候选窗下移动。用例补 `keyCode 229` 形态，静态检查改为钉这两条；真机（合成事件）验证：组合 "nihao" 停留在框内、229 形态的 Enter **0 次 /apply**、随后 "你好" 正常进入输入框。
- 新增：`GET /dsh-edit-turn/debug` 现在也记录 **apply** 请求（成功记编辑类型/目标 seq/替换 seq，失败记错误码）。「点了没反应」从此可以一句话定位：请求记录里没有 apply，就是浏览器这半边的点击丢了；有 apply 且失败，就是宿主侧拒绝了它。静态检查加 1 条。
- 修复（工具自身）：`verify:live` 的「本插件切片」原先取 id 首次/末次出现位置的 ±4000 字窗口。插件重新启用后，同一模块组里别的插件在注释里提到本插件、组尾的 source-map 提示又列出 `dsh-edit-turn/client.js.map`，窗口于是膨胀到几乎吞下整个组，把隔壁插件（`dsh-delete-turn`）的 `t(\`error.${...}\`)` 当成"残留的朴素查错"误报。现在改为**锚定模块注册本身**（`id: 'dsh-edit-turn'` 往前找 `__ModuleLoader__.load({`，往后截到下一个模块），并新增一条「模块以该 id 注册」的正向断言。切片从此只含本模块，正反两类断言都不再受邻居影响。
- 补强：`verify:live` 加 2 个下发标记与 1 条模块注册断言；真机重载后 `verify:ui` 全部通过（新增「回复笔最左」「行末尾的笔」在三个视图确认），`verify:live` 全部通过。

**0.2.1** —— 修 0.1.7 上的两处界面问题，并补上让问题可自证的诊断手段。

- 修复：模型回复的编辑入口改注册进官方插槽 `conversation.chat.assistant-actions`，与平台自己的 复制 / 赞 / 踩 / 分支 / 用量 同排（此前是 DOM 注入，位置不一致、且会随工具调用行卸载而闪烁）。
- 修复：编辑模型回答后**重新闭合该轮**（`step/end` + `turn/end`）。此前修正消息被追加到 `turn/end` 之后、落在轮外，导致那一轮的尾巴（用时、动作条）渲染到回复正文**上面**。
- 修复：DSH 0.1.7 兼容——会话格式 v4 的 producer-owned source kind（`plugin:<id>`）、助手消息文本取自 `data.message.content`。
- 新增：只读诊断路由 `GET /dsh-edit-turn/debug`；`npm run probe:loaded [端口]`。

**0.2.0** —— 可以编辑模型的回答。回退该回答及其后内容，再追加一条带改写文本的助手消息（回答无法原地替换：官方格式禁止 `assistant/message` 携带 `sourceEventSeqs`）。不重跑模型；`source.editedBy` 如实标记文字由插件写入。

**0.1.1** —— 去掉多余的二次确认（默认一次点击即执行）；修皮肤下界面可读性。

**0.1.0** —— 首版：回退并重跑你自己发过的消息。

### 姊妹插件

- [dsh-delete-turn](https://github.com/DDDMUC/dsh-delete-turn) —— 单条消息/单步/单条回复的删除，同一套 surface-replace 契约。
- [dsh-free-search](https://github.com/DDDMUC/dsh-free-search) —— 免 key 多引擎网络搜索。
- [dsh-delete-session](https://github.com/DDDMUC/dsh-delete-session) —— 侧边栏会话删除。

### 兼容性

- `dsh.engines.dsh`: `>=0.1.6-alpha.2`（本插件依赖该版本的消息行定义与 surface 语义；`0.1.6-alpha.2` 与 `0.1.7-rc.1` 均已实测）。
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
- saving **replaces that one message in place**: only the old wording leaves the model context, the revised text takes its place, and every later turn is answered against the new version;
- **the reply under it and the whole conversation after it stay exactly as they were** - nothing is re-run and nothing is cleared;
- model replies are editable too: replacing one rolls back that answer and everything built on it (a changed answer invalidates what followed) and appends your text as a fresh reply;
- turn `rerun` on if you do want the edited turn answered again right away.

### Features

- **Official seam, log untouched.** A rollback appends one replacement event carrying `surfaceOp: { op: 'replace', startSeq, endSeq }`. Every original event stays in the session file; it simply stops entering `deriveMessages()`. This is the same contract `/compact` uses.
- **The revision is the carrier.** A prompt edit lands a `user/message` replacement whose content **is** your revised text: it updates the model context and shows in the transcript in place of the old wording. The platform does not answer it as a new input (that was tried: *appending* a user message makes the platform reply, and the next save added another copy). Reply edits stay silent too: their carrier is an empty `developer/message` - the format admits only system-prompt sources on `system/message`, and an empty plugin-owned system node is exactly what used to make sessions unreadable (see below).
- **The smallest window that is correct.** A prompt edit shadows exactly one node (`shadowed = [target.seq]`); a reply edit shadows the reply through the end of the surface - a changed answer invalidates everything built on it - which also keeps an assistant message (carrying its own tool_use blocks) and the tool/result it produced together. A dangling call/result pair is impossible.
- **A rewritten message stays editable.** It still shows where the original stood, and hovering it offers the pencil again.
- **No model call by default.** Saving only writes the context. `rerun: true` restores the old behaviour and goes through the one official prompt admission path, `ctx.sessionController.prompt()`.
- **The model's replies are editable too.** A reply cannot be swapped in place: the format refuses `sourceEventSeqs` on an `assistant/message` (verified against the real validator). The answer is rolled back together with everything after it, and the corrected text is **appended** as a fresh reply - the model goes on treating it as its own. `source.editedBy` records honestly that the plugin wrote those words.
- **One click applies** - no second confirmation by default. The editor is already an explicit action the user opened; with `confirm: true` the confirmation step states what this save will discard, while the input box itself stays clean.
- **Bilingual UI** that follows the current DSH locale.
- **Skin-friendly** - the editor paints its own opaque surface (`--dshet-panel`) instead of borrowing the theme's surface colours. A skin exists to make surfaces translucent so its artwork shows through, and it only compensates for *its own* elements; a plugin's class names are not on that list, so a panel that borrows those variables can end up fully transparent with text sitting straight on the art. The dark branch uses the official `body[data-ds-dark-theme]` hook (the same one `dsh-client-ui-theme` and several official UI packages use) and blends in with `backdrop-filter`.
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
2. An editor opens below it with the original text pre-filled. Click "**Save**" - **one click applies**: the old wording leaves the model context and the revised text takes its place. **No model call.** (`rerun: true` shows "Save and re-run" instead.)
3. The editor closes and the message shows your text in place; the reply under it and everything after it stay exactly where they were.

The editor is **shaped like the platform's own input box**: one rounded
container with the text at the top and Cancel / Save pills at its bottom right,
focus shown on the container itself. It **grows with its text** (no half-empty
slab for a two-line edit), with no title bar, no standing description and no
resize grip, and the keyboard matches the composer: **Enter saves, Shift+Enter
breaks the line, Escape cancels** (stepping back out of the confirmation first;
an Enter that commits IME composition is never taken as save).

If the editor warns that the message carries attachments, the rewrite keeps the
text only and drops them.

**Editing what the model said.** Hover any model reply and the same edit action
appears. Click "Save" - the reply is replaced with your text,
everything after it is removed, and the model goes on treating your words as its
own, so the conversation can continue from there.

Note that **tool calls and reasoning inside that reply cannot survive** the
replacement (only text is kept, and the editor warns first): their results are no
longer valid once you have changed what the model said.

### Configuration

```yaml
- id: dsh-edit-turn
  config:
    confirm: false              # default: apply in one click; true restores the two-step flow
    rerun: false                # default: saving only writes the context; true re-runs the turn
```

| Field | Default | Meaning |
|---|---|---|
| `confirm` | `false` | Whether the client asks for a second confirmation before applying. Off by default - one click applies, because the editor is already an explicit action the user opened; with `true` the confirmation step states what this save will discard. |
| `rerun` | `false` | Whether the edited turn is re-run right after saving. Off by default: the revision enters the context and the model reads it on your next message. `true` re-runs through the official `sessionController.prompt()`. |

### How it works

One edit is **one official replacement event**. Read the event stream
(`sessionQuery.readSession`, falling back to the live session's
`snapshotEvents()`), fold the official surface order, locate the target message
node, then:

- a prompt edit: the window is **that one node** (`[target.seq]`) and the carrier
  is the revised text itself;
- a reply edit: the window is `surface[index .. end]` (a changed answer
  invalidates everything built on it); a fresh turn is opened first
  (`turn/start` + `step/start`) because the read path only admits step messages
  inside an open turn and step; the carrier is the empty `developer/message`,
  the corrected text is appended as an assistant message inside that turn, and
  `step/end` + `turn/end` close it behind the correction.

Then append:

```js
// the reply-edit shape: the prompt edit carries the revised user message instead
session.append('developer/message', { turn, step, message: { role: 'developer', content: [] } }, {
  surfaceOp: { op: 'replace', startSeq, endSeq },
  sourceEventSeqs: shadowed,      // complete coverage: the validator requires every shadowed node
})
```

The append then waits for the official durability checkpoint (`sessions.flush`)
so a reload or a DSH restart still sees the rollback.

**Step two (optional): the re-run.** Off by default; `rerun: true` turns it on.

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
| Route | `GET /dsh-edit-turn/state?sessionId=` | Editable turns, the hidden-row ledger (`hidden` + `revisions`), the surface, busy state |
| Route | `POST /dsh-edit-turn/apply` | `{ sessionId, seq \| messageId \| turn, text }` → write the revised text (`rerun: true` re-runs too); the response carries `applied` / `reran` / `shadowed` / `replacementSeq` |
| Tool | `edit_turn_targets` | Read-only: list the session's editable turns and their text |
| Client | `conversation.input.overlay` | Per-session controller: edit entry, in-place editor, hidden-row ledger |

### Cross-plugin contract (for sibling plugins)

The transcript only builds rows for **append surface events** (ui-chat's user and assistant definitions both match on `isAppendSurfaceEvent`), so after an in-place edit **that row stays anchored to the original seq / messageId** — nothing in the row tells another plugin "I am now at seq N", while the live node in the model context is the replacement event. Any entry that validates by surface (say `dsh-delete-turn`'s delete action) finds the original seq dead and has to follow the replacement chain to the live node to stay useful. External consumers can rely on:

1. **A prompt edit keeps a single-node window**: `planRollback` for `mode === 'prompt'` shadows exactly the message itself (`shadowed = [target.seq]`) and never rolls back to the tail;
2. **The replacement event has the type of the target**: a `user/message` edit lands a `user/message` (a reply cannot be swapped in place — see 5);
3. **`sourceEventSeqs` always lists the whole window**: the official validator demands complete coverage; one missing node and the append is refused;
4. **Every replacement carries the semantic marker**: `source.kind === 'plugin:dsh-edit-turn'` and `source.editedBy === 'dsh-edit-turn'` — including the empty text-free `developer/message` carrier, so siblings can recognise rewrites by `editedBy` alone instead of inferring from the window shape;
5. **A reply edit is a multi-node rollback plus an appended correction**, not an in-place swap: the old reply row keeping no entry is **by design** (the new row carries it). Do not add `sourceEventSeqs` to an `assistant/message` to keep the old row's entry — the official validator refuses it outright;
6. **The mapping is published**: `revisions[]` on `GET /dsh-edit-turn/state` gives `{ replacementSeq, startSeq, endSeq, shadowed }` (the field names the `POST /apply` response already used), and `hidden[]` lists `{ seq, turn, replacement }` per shadowed row. No sibling has to re-derive the ledger from the event stream.

**The `source.kind` behaviour, intentionally:** after a prompt edit the landed `user/message` has `source.kind === 'plugin:dsh-edit-turn'`, **not `user`**. Any consumer that detects human prompts by `source.kind === 'user'` (for example, partitioning reply-deletion windows by human turns) will classify the revision as ordinary content. That is deliberate: the text was written by a plugin, it is not a fresh human turn, and the platform must not answer it. Consumers that need to find it should use `revisions`/`editedBy` above rather than loosening the `source.kind === 'user'` test.

### Verification status

Verified against DSH `0.1.6-alpha.2` and `0.1.7-rc.1`, entirely **without model calls**:

| Check | Command | Result |
|---|---|---|
| Is the plugin actually mounted in a running instance? (read-only route-guard probe, no token needed) | `npm run probe:loaded [port]` | pass: `/state` answers 400 and `/apply` answers 405 - status codes only this plugin produces |
| What the browser half asked for and got back (read-only diagnostics, failures included) | `GET /dsh-edit-turn/debug` | pass: a real browser was confirmed fetching replies, and an old v3 session was reproduced as session-not-found |
| Official append AND READ contract against the real validator, in process | `npm run verify:contract` | 80 checks pass (every write sequence is reloaded through the reader afterwards): the replacement is accepted, the derived history really shrinks, the log stays append-only, a tool result leaves with its call, the empty developer carrier adds no model message, **two consecutive rollbacks are both accepted**, **the whole reply-editing mechanism is accepted**, **the invariants siblings depend on (single-node window, same event type, full `sourceEventSeqs` coverage, an `editedBy` marker on every replacement, a rewritten prompt whose `source.kind` is not `user`, a correction that carries no `sourceEventSeqs`)** |
| Pure logic, host integration and browser-half DOM behaviour (real HTTP, real validator, stubbed services, DOM stub) | `npm test` | 105 tests pass |
| Browser-half static checks (registration, i18n completeness, styles, skin legibility, three-way version sync, wire contract) | `npm run verify:client` | all pass |
| Live client artifact (is the running DSH serving the current code?) | `npm run verify:live -- --token-file ~/path/to/dsh.log` | all pass, **including anchors on the host's node shapes** |
| **Real browser rendering smoke** (CDP drives an already-open tab, read-only) | `npm run verify:ui` | all pass: the served bytes are the edited bytes, no empty placeholder left by a retired entry, the reply pencil sits in the platform action bar, a rolled-back row keeps its action bar, **every collapsed user message still shows the text that replaced it**, **that bubble sits above the time and the copy, in the order the platform draws a message**, **the rewriting pencil sits at the end of the surviving bar (confirmed live in the original session, the other session, and back again)**, **the reply pencil leads its bar, ahead of the copy (confirmed live)**, no `.dshet-floating` covers the revision text, and the entries survive a session round trip |
| Real profile: install, patch composition, boot, tool contract, route guards | `npm run verify:profile` | all pass |
| **Real browser, end to end** (agent-browser drives Chrome at a running instance) | manual | done: an edit action appears on model reply rows, the editor opens pre-filled with the real reply, and cancelling leaves zero `apply` requests. See `docs/reply-editor-in-browser.png` |

`verify:live` targets an instance that is **already running**: it exchanges the
token DSH printed on boot for an auth cookie, reads the client module groups out
of the boot page, downloads the group containing this plugin, and asserts the
plugin's own markers are inside it. That proves "a browser reload gets the
current code", which is stronger than "the source looks right" - and after a
front-end edit it is the only automatic way to confirm the change took effect.

`verify:ui` drives a tab that is **already open** (Chrome started with
`--remote-debugging-port`, 9333 by default): it reloads with the cache bypassed,
asserts the bytes the browser just got are the edited bytes, then reads the DOM
and the console - every assistant cell rendered something (no empty placeholder
from a retired entry), the reply pencil sits in the platform's own action bar, a
rolled-back row lost its message but kept time / copy / delete, every collapsed
user message still has this plugin's replacement bubble - the live signature of
the "message vanished after saving" defect, since a row may collapse but never
with nowhere to show the replaced text - and that bubble sits **above** the time
and the copy, in the order the platform draws a message in (planted after the
row it would have left the bar on top of the message), **that the pencil
rewriting a prompt sits at the end of the bar that survived, behind the clock
and the copy, with no pencil left inside the bubble** (the bubble's own gutter
is only a fallback for a row with no bar at all), **and that the reply pencil
leads its strip, ahead of the copy button the host draws before the slot this
entry lands in** (that cell is `display:contents`, so DOM order can only ever be
second; the check reads the laid-out x positions, not the tree), no
`.dshet-floating` covers the revision text, and the entries survive switching
away and back. It is **read-only**: it never opens the editor, never clicks save,
never posts to `/apply`. (The two pencil-placement assertions have since been
run against a live reload and pass.)

`verify:profile` boots a sandbox instance on its own port with its own
`DSH_HOME`, and terminates only the process it started, **by pid**. It never
touches the DSH you are using:

```sh
DSH_BIN=/path/to/dsh/lib/bin.js PORT=4123 DSH_HOME=/tmp/dsh-edit-turn-home bash tools/verify-dsh-plugin.sh
```

**The one link that is NOT verified, stated plainly:** `verify:ui` covers *how it
renders* (read-only). **Actually pressing save** posts `/apply` and rolls the
session back - that step stays manual (last row of the table above, plus
`docs/reply-editor-in-browser.png`); the smoke tool never touches it. And there
is no React or Playwright on this machine, so `verify:ui` talks raw CDP instead
of a framework. The click path
itself is now covered: `test/client.dom.test.js` runs the real `OverlayEntry`
against a readable DOM implementation and asserts "click the action -> the editor
appears pre-filled -> click save -> the confirmation step appears -> click
confirm -> the right request is posted -> the editor closes", plus every failure
branch's message. That test is meaningful: reverting the re-render marker to its
old form makes 6 of its cases fail.

**The screen right after pressing save is covered too**, because it went wrong
for real once: the save succeeded, the old row collapsed, the replacement bubble
was never built, and the message simply left the interface (the server-side
rollback had landed all along; only the view was wrong). Three cases pin one
cause each - (1) the replacement bubble must be on screen the moment the save
response arrives, even if the `/state` refresh that follows never returns,
(2) a save must ask the host for the state it just changed, (3) a row with a
recorded replacement but no replacement text yet may not collapse. Reverting the
three fixes in `lib/client.js` one at a time makes exactly those three cases
fail, one each; restore them and all pass (94 at the time, 97 now).

**"the bubble sits above the time and the copy" is covered too**: the standing-in
bubble was planted *after* the collapsed row, so the timestamp and the copy
button that the row had left stood above the rewritten text and read as if they
belonged to the next line. The bubble now goes inside the row, ahead of the node
carrying the action bar (`placeRevisionBubble`, idempotent - it only moves when
the position is wrong), and `collapseRowContent`'s exemption list gained the
bubble itself, since a bubble inside the row would otherwise be emptied away with
it; a row with no bar to keep is displayed away entirely, and then the bubble is
parked *before* the row so it stays on screen. Two cases pin the two positions
(94 -> 95 then; 97 now); putting the planting back the old way fails exactly four cases at
once. `verify:ui` gained the live assertion "the bubble sits above the action
bar", the static checks two more, and `verify:live` one more served marker.

**"Where each of the two pencils sits" is covered too**, changed to the spec you
gave: the prompt pencil belongs at the **right end** of the action bar (behind
the clock, the copy, and any button a sibling plugin appends after us), and the
reply pencil at the **left end** (ahead of the
copy button). Neither is reachable by moving an insertion point; each was stuck
against a host constraint: the collapsed row parked its pencil in the revision
bubble's own gutter (visible only while hovering the rewritten text, and nowhere
near the copy), and the reply pencil is rendered through a host slot, so in DOM
order it can only sit after the copy button the platform draws. Now (1)
`renderRevision` hands the rewriting pencil to the bar that survived
(`injectRowAction(row, editTarget, ...)`) and takes it out of the bubble at the
same time (`removeRowAction(bubble)`) - the bubble's gutter is a fallback only,
for a row with no bar left at all; and `applyDom`, while a row is visible, tears
the row's pencil down only when **nothing of ours is standing in for it** -
otherwise it would remove what that call has just placed. (2) the reply pencil
gained `.dshet-reply-action` plus flex `order:-1` to get to the left end - that
cell is `display:contents`, so DOM order can only ever be second, and only an
order property can move it. The row pencil uses the same tool at the other end:
`dsh-delete-turn` appends its bin into the same bar on its own pass (live DOM:
`time -> copy -> pencil -> bin`), and neither plugin re-positions a node already
in the bar, so no insertion order can hold the right end - `.dshet-action-host`
carries flex `order:9` (every platform item in that `display:flex` bar is
`order:0`; the gutter and floating placements are not flex items and ignore it). The colour is matched to the platform's too: `.dshet-action` now
takes `var(--dsw-alias-label-tertiary)` (hover: `--dsw-alias-label-primary`,
with the default theme's value as the fallback) instead of our own blue-grey
ink, which read as a different, "active" icon beside the neutral grey ones -
the pencil and the copy button now measure the same computed colour
(`rgb(129, 133, 140)`).
The bubble also stopped stretching into a
full-width pill (moved inside the row, `align-self` no longer applies, so it
sets `width:fit-content`). The rewritten test asserts the pencil joins the end
of the surviving bar with none left in the bubble, the barless case asserts the
gutter fallback still holds a pencil, the reply-entry test asserts the class;
the static checks gained seven (including "the bubble is sized to its text, not
to the row", the pill defect, "the row pencil sorts to the right end of its
bar", and the two platform-colour checks), `verify:live` two served markers, and `verify:ui`
two live assertions plus the "zero pencils in the bubble" rewrite - **those two
live assertions have since been run against a real reload and pass** (the pencil
at the end of the bar was confirmed in the original session, in the other
session, and after switching back; the reply pencil was confirmed leftmost; and
the "end of the bar" check now measures the laid-out right edge instead of
counting children, because with flex order the DOM position no longer says where
a button is drawn - the live bar reads `time -> copy -> bin -> pencil`).
Each of the
three new placements was also checked in reverse: restoring the old "hand the
pencil to the bar", dropping the `.dshet-reply-action` class, or dropping
`applyDom`'s placement guard each makes exactly one case fail (the guard's
revert fails the "pencil joins the end of the bar" case, which pins the
"placed then torn down" regression too). One tool bug surfaced while re-running
`verify:live` with the plugin re-enabled: the "own slice" was a fixed window
around the first and last mention of the plugin id, and once another plugin's
comment and the group's source-map hint mentioned the id, that window swelled to
swallow nearly the whole group - reporting the neighbour's `t(\`error.${...}\`)` as
a stale lookup of ours. The slice is now anchored on the module registration
itself (`id: 'dsh-edit-turn'` back to `__ModuleLoader__.load({`, cut at the next
module), with a positive assertion that the module registers under that id.
`npm run check` is green: 105 tests, contract, static; `verify:live` and
`verify:ui` both pass against the running instance.

**A reply edit used to brick the session, and the contract suite now proves it
cannot.** The old write was illegal twice over: the silent carrier was an empty
plugin-owned `system/message` (the format admits only system-prompt sources
there), and the correction was appended with the turn/step of an already closed
turn. Appends are lenient and accepted both; readers are not, so DSH answered
`session-not-found` for the whole session from then on (`SessionFormatError:
system/message does not match an open turn and step`) - the edit entries
disappeared and the history would not open. Reply edits now open a turn of their
own first, use an empty `developer/message` as the carrier, and close the turn
behind the correction; the runtime projects `lastTurn` from every `turn/start` it
observes, so its next turn still gets the number the format expects. The contract
suite gained the layer that was missing: after every write sequence it RELOADS
the log through the same loader the server uses (plus message projections), and
it simulates the next real turn after an edit. And for sessions already broken,
`tools/repair-session.mjs` validates each log through that reader and truncates
at the first bad event with a backup - four sessions on this machine were
repaired that way, all losing only this plugin's corrupt reply-edit groups.

**"Pressed save and nothing happened" is covered too**, and it was a real
report. The host owns the row and rebuilds it freely - while a turn streams it
re-renders constantly - so a button replaced between mousedown and mouseup never
fires a click: from outside the button simply "does nothing", and no state
anywhere shows why. The editor's cancel/save and the row pencils now act on
**pointerdown** (the press counts immediately), the click path stays for the
keyboard, and the button swallows the click that follows its own press so the
action cannot run twice; the pencil keeps its guard across passes by being wired
once and reading the current target off its entry. Two new cases pin "the press
opens the editor and the swallowed click does not reset the draft" and "the
press advances to the confirmation step", and three static checks pin the
wiring. The host's request ring now records **apply** attempts as well, so the
next report is answerable in one look: no `apply` entry means the click never
reached the host, an `apply` with `ok:false` means the host refused it and the
`code` says why. **The focus bookkeeping was rebuilt around an explicit intent.** The first fix
still used `blur` as "the user left" - but the host replacing the row, or the
save temporarily disabling the box, blurs without the user going anywhere, and
the caret was dropped for good: after a refused save the box came back
unfocused, and a host rebuild mid-typing lost the caret. The intent is now
cleared by exactly one signal - a press **outside** the editor (a document-level
pointerdown) - so rebuilds, pending states and re-renders never move it, and a
refused save hands the focus back. Pressing the pencil again for the same
message also re-focuses the open box instead of resetting the draft, which had
silently thrown away whatever the user had typed. Three cases pin the refused
save, the outside press and the double pencil.

**An open editor used to disable every other input on the page.** The host
re-renders the row at will, the box is rebuilt with it, and the rebuild called
`focus()` unconditionally - so every re-render pulled the caret out of whatever
the user was typing in (the composer, a rename field, anything) and sent their
keystrokes into the editor instead. The box now takes focus only when it is
just opened; a rebuild hands the focus **back** only if the user was typing in
it, restoring the caret position, and otherwise leaves focus alone. Two cases
pin it (a rebuild does not steal; a rebuild mid-typing returns focus at the
caret) plus three static checks, and the live reproduction now keeps the
composer focused with the typed text landing in the composer.

The reply editor's button label also lost its redundant second
word: "Save replacement" is now just "Save"; the textarea itself became a normal
input box: one rounded container in the platform composer's shape, the text
transparent and borderless inside it, Cancel / Save pills at its bottom right,
focus drawn on the container. It grows with its text instead of sitting at a
fixed four rows with an empty half, the manual resize grip, title bar and
standing description are gone, Enter saves while Shift+Enter breaks the line,
Escape cancels, and IME input always wins: the Enter that commits a 拼音/かな
candidate (arriving either as `isComposing` or as the legacy `keyCode 229` -
the platform's own inputs guard both, and the missing half is what made every
candidate pick save the box) never counts as save, and the field is not
relaid out mid-composition. Cases pin the auto-fit, the keyboard path and the IME guard; two more static
checks pin the container shape and the IME guard; `verify:live` carries the
marker.

**Development prerequisite:** `npm test` and both `verify:*` commands need
`@deepseek-ai/dsh-session` and `@deepseek-ai/dsh-tools` to resolve. The plugin
itself does not depend on them (the host half imports only `schemastery` and
`dsh-tools`), so tests need a `node_modules` from a DSH installation:

```sh
ln -s /path/to/dsh-install/node_modules ./node_modules
```

### Known limitations

- **Human prompts and model replies** are both editable; injected context rows and the system prompt offer no edit entry.
- **Editing a reply replaces it with plain text**: the tool calls and reasoning inside it are removed (the editor warns first), because their results are no longer valid.
- **Editing a user message replaces that one message and leaves the rest of the conversation untouched - no re-run unless `rerun: true`**; editing a model reply only replaces the text and never asks the model again.
- **A prompt edit touches only that message.** The reply under it and the whole conversation after it are kept - no re-run unless `rerun: true`. A **reply edit** removes that answer and everything built on it, because a changed answer invalidates what followed. Keeping the original as a branch needs `sessionController.fork({ sessionId, atSeq })`, which is not implemented.
- **Text only.** A message carrying image or file attachments keeps its text and drops them (the editor warns first).
- **The session must be open in DSH**, otherwise the route answers `409 session-not-active`.
- **Running work is refused**: an unclosed turn or an in-flight compaction answers `409 busy`.
- **The rollback is durable; the hiding is not.** Once written, the rollback permanently changes the model context. Hiding those rows in the transcript is this plugin's browser half. Uninstall the plugin and the old rows reappear - while the rollback in the model context still stands, because the replacement is an official event that outlives the plugin.
- **The system prompt is never touched**: the window can never include surface node 0, and that node is never editable.
- **Old sessions (v3-format logs) cannot be read under DSH 0.1.7**: the session reader answers `session-not-found` for them, so the plugin does not work in one at all (the visible symptom is no edit entry). Newly written sessions are v4 and work normally.

### Troubleshooting: the edit entry disappeared entirely

Separate "the plugin never loaded" from "it loaded but nothing rendered" - the two have nothing in common, so do not guess.

1. **Is the plugin loaded?** `npm run probe:loaded [port]` (default 3080) from the plugin directory. `400`/`405` means the host half is running; `404` means it never loaded.
2. **When it did not load, look at the host's startup output** for:

   ```
   dsh-edit-turn (dsh-edit-turn): failed to import
   ```

   That line is almost always a **dependency resolution failure**, and the usual cause is a `link:` install (the development directory mounted into the profile) whose `node_modules` is a symlink into an npx cache - once npx prunes that cache the symlink dangles, the static `import` throws, and the whole plugin vanishes. Fix it by installing the dependencies for real:

   ```sh
   cd <plugin dir> && rm -f node_modules && npm install --omit=dev --legacy-peer-deps
   ```

   Mind the two kinds of dependency: **peers** provided by the host (`dsh-tools`, `dsh-settings`) are resolved by the DSH loader and need no install; **regular dependencies** (like `schemastery`) must resolve on their own - the loader will not find them for you.
3. **"The history fails to load / one session is unreadable"** (`session-not-found`,
with `SessionFormatError` in the console): this can be a log broken by the reply
edits of 0.2.0-0.2.3. The repository ships a repair tool that scans a sessions
directory, validates every log through the official loader, and - after a
byte-for-byte backup - truncates at the first event the reader refuses:

   ```sh
   node tools/repair-session.mjs ~/.dsh/sessions/<project-dir> --dry-run
   node tools/repair-session.mjs ~/.dsh/sessions/<project-dir>
   ```

   The truncated tail is kept as `*.corrupt-*.bak` next to the log; restart DSH
   (or the desktop app) and the session opens again.

4. **When it did load but shows no entry**, ask the read-only diagnostic route what the browser half actually requested:

   ```sh
   curl "http://127.0.0.1:<port>/dsh-edit-turn/debug"
   ```

   Entries with `state` and `replies` above zero mean the data reached the client, so the problem is rendering; **no entries at all** means the browser half never ran (check its console).

   **Saved and nothing happened? Look here first:** is there an `apply` entry? None means the click was lost in the browser half (the cause was the host rebuilding the row between mousedown and mouseup; the buttons now act on pointerdown). An `apply` with `ok:false` means the host refused it - the `code` says why (`busy`/`stale`/...).

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
