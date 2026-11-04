# 更新日志 / Changelog

## 中文

**0.5.14** —— 裁剪器与 `dsh-log-trim` 同步；清空流式回放时不再丢信息。

- `tools/compact-session.mjs`：内容级闸门（裁完按重编号后的可见内容逐条比对，不一致就不裁）、切点回退到整轮起点、`commitTrim` 先复制备份再替换。
- 新增 `stripOldStreams`：清空旧回合的 `assistant/message.data.stream`（与正文逐块重复）；缺 `data.usage` 或正文含图片/文件的行不动——宿主有两条回退路径会读它（图片查找、用量兜底）。
- 该文件不进 npm 包（`files` 只含 `lib/`），所以这次发布只有版本号变化。

**0.5.13** —— 打开着的会话不再重新解码整份日志（性能）。
