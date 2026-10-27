# 失败实验：给一条回复「加块」（加页）

这个分支保留了 2026-10-26 ~ 10-27 做的一次尝试，**结论是失败，已从 main 回滚**。
留在这里是为了不重复踩同样的坑，不是为了继续做。

## 想做什么

编辑器的块下拉（`正文 13 / 思维链 27 / 全部`）旁边加 `+正文` `+思维链`，
在选中的块下面插入一个新块，存进日志、让模型下一轮看得见。

## 机制上做成了什么

- 补丁记录升到 v2，多了第二种目标：`{ seq, kind, text, insert: { id, position } }`
- 插入块用**稳定 id** 而不是下标做身份（插入会让后面所有下标平移）
- 投影里 `applyTargetsToMessage` 真正把块插进 content，模型确实能看到
- 空内容保存 = 不落盘；已写入的清空 = 写 `removed: true` 墓碑
- 客户端两条保存路径（单块 / 全部）都能发插入目标

这些本身都跑通了，测试也在（`test/patch.test.js`、`test/host.test.js` 的插入用例）。

## 为什么失败

**1) 对话区看不到，而这不是 bug，是宿主的边界。**
宿主只渲染**记录下来的消息**（`assistant/message` 的 content）。插入块只存在于
**投影**（模型上下文），投影不参与对话区渲染。实测：保存后 `/state` 有、日志有、
对话区不动。

**2) 想让它显示，只剩「画一个假的」。**
插件能覆盖改写块的文字（宿主渲染的节点上改 textContent），但插入块**没有节点可覆盖**，
只能自己往那一行里追加 DOM。做出来之后它长这样：

```
▾ 思考
   0
```

外观、字号、折叠都对齐官方。但它是**插件造的节点**，不是宿主的推理块组件；
复制/引用/宿主对思考区的任何行为都不会作用在它身上。

更糟的是：**读者分不出哪句是模型说的、哪句是我们加的**。一个把用户内容伪装成
模型发言的界面，比「看不到」坏得多。

**3) 让它变成「真块」的路被宿主封死。**
要让宿主用它的组件渲染，必须把块写进消息本身；而替换一条回复时载体只能是非
assistant 消息（`sourceEventSeqs` 必须列全被 shadow 的节点，`assistant/message`
载体直接不允许）。所以「原回复内 + 宿主渲染」不可兼得，只能另起一行——那就不是
「加一个子页」了。

## 如果以后还想做

- 别再试图在对话区伪造官方组件的外观
- 若一定要「真块」，唯一出路是接受**另起一行**的模型消息（写新事件，代价大）
- 或者推动上游：让 `closing === null` 的轮次也渲染 `conversation.chat.assistant-actions`，
  以及允许 assistant 消息作为替换载体

## 相关提交

    6943b05  feat: add a block to a reply, of either kind, below the one you are editing
    3d9d40c  fix: adding a body block to a reasoning-only reply was rejected as invalid
    1c906e9  fix: an inserted block keeps its position, and a refusal explains itself
    79ae795  feat: the transcript shows the blocks the user added
    0e79670  fix: an injected stylesheet is refreshed on every apply, and added blocks read as blocks
    09b13b4  feat: an added reasoning block is drawn the way the host draws its own
