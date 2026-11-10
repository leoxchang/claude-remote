# Agent SDK 测试记录（SDK-01–12、CLI-01–03）

本文件汇总 live 测试的可读记录；`docs/s00/evidence/*.json` 是每次运行的真实产物，**时间窗口、session ID 和数值以证据文件为准**。原始 SDK 事件只保留在内存，写盘前已脱敏。

## 环境

- Agent SDK `0.3.319`，内置 Runtime `2.1.319`；本机 Claude Code CLI `2.1.311`（经用户确认的版本组合）。
- 隔离 fixture：`spikes/s00-agent-sdk/fixture/`，只含无害文本和 `permissions.ask: ["Bash"]`。
- 统一选项：`cwd=fixture`、`maxTurns: 6`、`permissionMode: 'default'`、`persistSession: true`、`includePartialMessages: true`、`settingSources: ['user','project','local']`、`claude_code` system/tool preset。

## 结果

| ID | 观察 | 证据 |
|---|---|---|
| SDK-01 | Node v22.23.2、SDK 0.3.319、CLI 2.1.311、Runtime 2.1.319；配置来源 `~/.claude/settings.json` | `evidence/SDK-01.json` |
| SDK-02 | `settingSources: ['user']` 不加载项目 CLAUDE.md；省略来源与显式完整来源一致；三个对照 probe 的工具调用数均为 0 | `evidence/SDK-02.json` |
| SDK-03 | 请求归因到 `http://127.0.0.1:15721/` 与预期模型；无 `api.anthropic.com` 回落痕迹 | `evidence/SDK-03.json` |
| SDK-04 | `claude_code` preset 生效，init 报告完整工具列表，项目 CLAUDE.md 标记可见 | `evidence/SDK-04.json` |
| SDK-05 | 同一 query 两轮流式输入，两个 `result`，第二轮读出第一轮标记 | `evidence/SDK-05.json` |
| SDK-06 | 完整 assistant 消息与 `stream_event → content_block_delta → text_delta` 同时出现，事件顺序已记录 | `evidence/SDK-06.json` |
| SDK-07 | `canUseTool` 收到 Bash 调用；allow 后命令执行，输出 marker 出现；requestId/toolUseID 非空 | `evidence/SDK-07.json` |
| SDK-08 | deny 后命令未执行、denial 被记录、Agent 继续回复；fixture 未新增 `settings.local.json` | `evidence/SDK-08.json` |
| SDK-09 | 首个 text delta 后 `interrupt()` 返回 receipt，query 关闭 | `evidence/SDK-09.json` |
| SDK-10 | 新 query `resume` 正常会话，session ID 相同，标记恢复 | `evidence/SDK-10.json` |
| SDK-11 | 中断会话显式 `resume`，session ID 相同，标记恢复，result=success | `evidence/SDK-11.json` |
| SDK-12 | 全零 UUID 直接抛错，未创建替代会话 | `evidence/SDK-12.json` |
| CLI-01 | CLI 创建会话（exit 0）后 SDK resume，session ID 相同，标记恢复 | `evidence/CLI-01.json` |
| CLI-02 | SDK 创建会话后 CLI `--resume`，session ID 相同，输出包含标记 | `evidence/CLI-02.json` |
| CLI-03 | 版本组合与未覆盖范围的限制记录 | `evidence/CLI-03.json` |

## 事件形式样例（SDK-06/SDK-05）

- `SDK-06.messageTypeSequence` 按到达顺序记录了 `system → stream_event → assistant → result` 的完整序列，可用于 S01 的 `message.delta` 归一化。
- `SDK-05.turnResults = 2`：同一受管会话内两个 turn 各自产生 `result`；第二轮回答直接包含第一轮写入的标记。
- `SDK-07/08`：`canUseTool` 回调分别收到 `requestId` 与 `toolUseID`，与 `run.completed` 的关联方式一致。

## 安全与隔离

- fixture 之外没有读写；未开启 `bypassPermissions`；未写入 `updatedPermissions`；未修改用户全局设置。
- 所有 query 在 `finally` 中 `close()`；CLI 调用使用 argv 数组、无 shell、显式超时。
- 证据只保存摘要与计数，不保存原始消息或完整 stderr。