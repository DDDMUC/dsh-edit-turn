# 更新日志 / Changelog

## 中文

**0.5.22** —— 导出 `dropShadowedPrefix`（供 dsh-log-trim 0.7.6 的扫描试算使用）。

**0.5.21** —— 裁剪内核丢被 checkpoint 遮蔽的前缀（供 dsh-log-trim 0.7.5 同步）。

- 保留区改成「连续尾巴 + 系统提示词/设置」；compaction 组、`session/*`、`agent/inbox/spliced` 结构事件保留。
- 过不了宿主校验时自动退回旧做法。

**0.5.20** —— 裁剪内核处理迟到的 tool/result（供 dsh-log-trim 0.7.3 同步）。

- 新增 `repairLateToolResults()`：把落在 step 之外的工具结果挪回原位，丢弃调用已被裁掉的孤儿结果；`stageTrim` 在重编号后调用并在有改动时再编号一次。

**0.5.19** —— 裁剪内核保留目标事件（供 dsh-log-trim 0.7.1 同步）。

- `KEEP_ALWAYS` 增加 `goal/`：窗口裁剪不再丢掉被覆盖的 `goal/change`。
- `renumber()` 把 `goal/change` 留在原位（不再搬到日志最前面，否则目标轮次成孤儿）。
- 新增 `assertNoGoalEventsDropped()`，`stageTrim()` 在写盘前守卫：会删目标事件就放弃这次写入。

**0.5.18** —— 补测：`stageTrim` / `commitTrim` 改异步后，两条用例补上 `await`（0.5.17 里它们会因为异步落盘未完成而误报）。

**0.5.17** —— 裁剪内核改异步（供 dsh-log-trim 0.7.0 的 worker 扫描复用）。

- `tools/compact-session.mjs`：新增 `readLogAsync` / `encodeLogAsync`（分片让出事件循环），
  `stageTrim` / `commitTrim` 改异步；`keepLastWindows` 去掉 O(n²) 与多余的 `structuredClone`。
- 与 log-trim 的 vendor 副本逐字一致（`npm run sync:vendor` 可复现）。

**0.5.16** —— 设置卡片只挂在包自己的页面上。

- 去掉 `plugins.row.config` 注册：不再给行加「配置」按钮，编辑设置只出现在 `#/panel/plugins/dsh-edit-turn`。
- 同一张卡、同一个组件，只有一个入口。

**0.5.15** —— 设置卡片同时出现在包自己的页面上。

- 新增 `plugins.bundle.config` 注册（key 是裸包名）：`#/panel/plugins/dsh-edit-turn` 直接能看到编辑设置，不再只能从 `…/dsh-edit-turn/dsh-edit-turn` 那一层进去。
- 与 `plugins.row.config` 注册的是同一个组件，设置只有一份来源。

**0.5.14** —— 裁剪器与 `dsh-log-trim` 同步；清空流式回放时不再丢信息。

- `tools/compact-session.mjs`：内容级闸门（裁完按重编号后的可见内容逐条比对，不一致就不裁）、切点回退到整轮起点、`commitTrim` 先复制备份再替换。
- 新增 `stripOldStreams`：清空旧回合的 `assistant/message.data.stream`（与正文逐块重复）；缺 `data.usage` 或正文含图片/文件的行不动——宿主有两条回退路径会读它（图片查找、用量兜底）。
- 该文件不进 npm 包（`files` 只含 `lib/`），所以这次发布只有版本号变化。

**0.5.13** —— 打开着的会话不再重新解码整份日志（性能）。
