# CLI ↔ SDK 双向会话恢复（CLI-01–03）

## 结论

两个方向均成功：本机 Claude Code CLI `2.1.311` 与 Agent SDK `0.3.319`（内置 Runtime `2.1.319`）在同一 fixture 目录下复用同一个会话 ID，并且后一侧都能读出前一侧写入的标记。会话文件由 CLI/SDK 自己维护，spike 未复制、未修改任何 JSONL。

## 方向一：CLI 创建 → SDK 恢复（CLI-01）

| 项 | 值 |
|---|---|
| CLI 版本 | 2.1.311 |
| CLI 调用 | `claude -p <prompt> --output-format json --max-turns 1`（fixture cwd，无 shell） |
| CLI session ID | `9fa35b1f-7d8d-4008-a1ef-0b49173ed102` |
| SDK 恢复 | `query({ resume: <cliSessionId> })` |
| SDK session ID | 同上，`sameSession = true` |
| 恢复出的标记 | `S00_CLI_TO_SDK_5E10`（`markerRecovered = true`） |

## 方向二：SDK 创建 → CLI 恢复（CLI-02）

| 项 | 值 |
|---|---|
| SDK 版本 | 0.3.319（Runtime 2.1.319） |
| SDK session ID | `943501d2-b98d-4f71-9ef6-a6c97ae3d7a8` |
| CLI 恢复 | `claude --resume <sdkSessionId> -p <prompt> --output-format json --max-turns 1` |
| CLI session ID | 同上，`sameSession = true` |
| 恢复出的标记 | `S00_SDK_TO_CLI_7B20`（`markerRecovered = true`，CLI `result` 字段直接包含该标记） |

## 已观察到的差异与限制（CLI-03）

1. **版本组合不同**：CLI 侧是被安装的 2.1.311，SDK 侧是自带的 2.1.319 Runtime。跨版本恢复可以工作，但结论只覆盖这一组合。
2. **`--max-turns 1` 偶发 `error_max_turns`**：CLI 创建会话时，模型偶尔会把唯一一轮用在工具调用上，CLI 以 `subtype: error_max_turns`、`isError: true`、退出码 1 结束（此时用户消息已持久化，SDK 仍能恢复标记）。当前的创建提示显式要求「不要使用任何工具」，并把重试上限设为 3 次；每次尝试的 `exitCode/subtype/isError` 都记录在 `evidence/CLI-01.json` 的 `cliAttempts`。改为该提示后连续 3 次运行均为单次成功。
3. **只比较了文本上下文**：标记恢复证明会话上下文可跨入口读取；工具调用历史、消息顺序和权限记录的逐项对照未做（不影响受管会话方案，但属于未验证范围）。
4. **stderr 只有固定告警**：`ANTHROPIC_API_KEY... takes precedence` 之类的 CLI 告警，与互操作无关；证据中只保留长度和脱敏预览。
5. **没有依赖官方未声明的路径**：未复制会话数据库、未并行写入、未修改内部文件。若后续版本变更导致任一方向失败，应按计划回到架构层决策，而不是修补会话文件。

## 证据

- `evidence/CLI-01.json`、`evidence/CLI-02.json`、`evidence/CLI-03.json`
- 每次运行都会覆盖这些文件，`observedAt` 为最近一次运行时间；会话 ID 也随之变化，以上表格取自 2026-11-10T04:47Z 的运行。