# S01 SDK 映射表（冻结）

**冻结时间：** 2026-11-10
**来源：** `docs/s00/evidence/*.json` + 2026-11-10 补充只读探针（S00 同一 fixture，仅记录字段名与形态，不记录内容）
**环境：** Agent SDK `0.3.319`、SDK 内置 Runtime `2.1.319`、本机 CLI `2.1.311`、Node `v22.23.2`

本表是 `AgentSdkAdapter`、`RunController`、`EventNormalizer` 的唯一依据。任何一项标 BLOCKED 时，相关实现不得用猜测补齐。

## 1. Claude session ID 的准确字段

| 观察 | 值 |
|---|---|
| SDK 消息字段 | `session_id`（字符串） |
| 覆盖范围 | `system`（含 `init`）、`stream_event`、`assistant`、`user`、`result` 全类型携带 |
| CLI JSON 字段 | 同名 `session_id` |

**证据：** `evidence/SDK-05.json`（`sessionId`）、`SDK-09/10/11`（resume 比对）、`CLI-01/02`（`cliSessionId` 与 `sdkSessionId` 相同）；补充探针 96 条消息全部 `sessionIdPresent=true`。

**S01 落点：** 首次 `result` 或 `system:init` 中出现即写入内存 `claudeSessionId`；后续 run 用同一值 `resume`。

## 2. 助手消息与 content block 的稳定标识

| 观察 | 值 |
|---|---|
| assistant 完整消息 | `message.id` 存在（非空字符串） |
| stream 侧同源 ID | `message_start` 事件的 `event.message.id` 存在 |
| content block 位置 | `content_block_start/delta/stop` 的 `event.index`（从 0 起） |
| tool_use 块 ID | `content_block_start.content_block.id`，前缀 `toolu_` |
| 每事件唯一标识 | 所有消息带 `uuid` |

**证据：** 补充探针；`evidence/SDK-06.json`（delta 与完整 assistant 同时出现）。

**S01 落点：** `assistantMessageId = assistant.message.id`（stream 阶段用 `message_start.event.message.id` 关联）；`contentBlockIndex = event.index`。禁止为每个 delta 生成新 ID。

## 3. text_delta、assistant、result 的实际顺序

实测顺序（含工具调用的一轮）：

```text
message_start
content_block_start(index, thinking)
thinking_delta / signature_delta ...
content_block_start(index, tool_use)
input_json_delta ...
assistant(完整消息，含 tool_use 块)
content_block_stop
message_delta
message_stop
user(content=[tool_result])
... 下一轮 message_start ...
result(subtype=success)
```

要点：

- `thinking` 块先于 `text`/`tool_use`；`thinking_delta`、`signature_delta` 不属于助手正文，S01 不得计入 `message.delta`。
- 完整 `assistant` 消息可能早于 `content_block_stop` 到达，不能用“先 stop 后 assistant”做顺序假设。
- 同一轮可能有多个 content block，正文与工具可能并存。

**证据：** 补充探针完整序列；`evidence/SDK-06.json`（`messageTypeSequence`、`deltaCount=4`）。

## 4. success / error / deny 的 result subtype

| 场景 | `result.subtype` | `is_error` | 证据 |
|---|---|---|---|
| 正常完成 | `success` | `false` | SDK-05、SDK-06、补充探针 |
| 工具被 deny 后继续回复 | `success`（deny 不改变 result） | `false` | SDK-08 `denyCaseResultSubtypes=["success"]` |
| 被 `interrupt()` 打断 | `error_during_execution` | — | 补充探针 |
| CLI `--max-turns 1` 偶发 | `error_max_turns`（CLI JSON） | `true` | CLI-01 的 `cliAttempts`、CLI-03 |

`result` 消息带 `permission_denials` 字段，可用于补充权限拒绝摘要。

**S01 落点：** `success` → `succeeded`；其他 subtype → `failed`，但**处于 cancelling 的 run 收到 `error_during_execution` 时必须映射为 `cancelled`**，不能记为 failed。

## 5. interrupt() 的响应与后续事件

| 观察 | 值 |
|---|---|
| 返回 | 对象（receipt），约 4.8 s 后 resolve（本机网关下实测） |
| 后续消息 | `user` → 3 × `stream_event` → `result:error_during_execution` |
| 迭代行为 | SDK 在读取该 `result` 时**抛出 Error**（`Claude Code returned an error result`） |

**证据：** `evidence/SDK-09.json`（`interruptOutcome=receipt`、`closed=true`，未记录后续消息）；补充探针首次记录后续序列。

**S01 落点：** `interrupt()` resolve 只表示中断请求被接收；RunController 必须继续消费直到 `result`，并把捕捉到的 `error_during_execution` 视为取消终态。10 秒内没有终态时关闭 query 并发 `run.completed(interrupted)`。

## 6. query.close() 的清理行为

| 观察 | 值 |
|---|---|
| S00 全部场景 | 每个 query 在 `finally` 中 `close()` |
| SDK-09 | `closed=true`，迭代结束，进程正常退出 |
| 补充探针 | `result` 后迭代自然结束，无额外消息 |

**S01 落点：** 每个 run 的终态处理完成后 `close()`；关闭后不得再向该 query 写入。

## 7. tool_use / tool_result 的关联字段与输出时机

| 观察 | 值 |
|---|---|
| tool_use 块 | `assistant.message.content[].type='tool_use'`，带 `id`（`toolu_*`）、`name`、`input` |
| tool_result 块 | 下一条 `user` 消息的 `content[].type='tool_result'`，带 `tool_use_id` |
| 输出时机 | `message_stop` 之后才出现 `tool_result`；S01 不承诺实时 stdout |
| canUseTool | 回调拿到 `requestId` 与 `toolUseID`，与工具事件可关联 |
| 权限拒绝信号 | `system:permission_denied` 子类型，或 `result.permission_denials` 非空 |

**证据：** 补充探针；`evidence/SDK-07.json`（`requestId`/`toolUseID` 非空、输出 marker 可见）；`evidence/SDK-08.json`（`denialObserved=true`、命令未执行）。

**S01 落点：** `tool.started` 用 `tool_use.id`；`tool.output` / `tool.completed` 用 `tool_result.tool_use_id` 关联；`canUseTool` deny 时补 `tool.completed(denied)`。

## 未覆盖项

| 项 | 状态 | 影响 |
|---|---|---|
| 真实 `result.error` 的 subtype 全域枚举 | PARTIAL | 只实测 `success`、`error_during_execution`、`error_max_turns`；未知 subtype 按 `failed` 处理并记安全摘要 |
| `close()` 对子进程的时序保证 | PARTIAL | 只有“迭代结束、进程退出”的观察，无进程级断言 |