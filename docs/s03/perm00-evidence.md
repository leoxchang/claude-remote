# PERM-00 真实 SDK 权限门禁证据

**日期：** 2026-11-12
**结论：** **PASS（6/6）** — 仅 `completed allow 重入` 为 `NOT_REPRODUCED`，计划明确允许。
**命令：** `S03_LIVE=1 npm run test:s03:perm00`
**测试：** `apps/agent/test/live/s03-permission-gate.test.ts`

## 1. 环境

| 项 | 值 |
|---|---|
| Agent SDK | `@anthropic-ai/claude-agent-sdk` 0.3.319 |
| Claude Code Runtime | 2.1.319（SDK 固定依赖） |
| Node.js | v24.15.0 |
| `permissionMode` | `default` |
| `settingSources` | `['user','project','local']` |
| 全局 `~/.claude/settings.json` SHA-256（运行前后一致） | `8af724a41f34812dbb39df0d0169d2a3922733691b65686c426d2860da6a3599` |
| fixture | `mkdtemp` 临时项目，标签 `allow-read` / `deny-bash` / `allow-bash` / `deny-ask` / `ask-user-question` / `interrupt-pending` |

证据只保留字段是否存在、顺序标签和布尔值；不保存命令、输入正文、绝对路径、环境变量或凭证。
`disallowedTools: ['ToolSearch']` 仅用于让探测稳定触发目标工具，不影响权限求值。

## 2. 实测矩阵

| 用例 | 规则 | 实测消息顺序 | 结论 |
|---|---|---|---|
| allow-read | `allow:['Read']` | `tool_use:Read → tool_result:ok → result:success` | 本机 allow 不进入 callback，只读成功 |
| deny-bash | `allow:['Read'], deny:['Bash(touch:*)']` | `tool_use:Bash → tool_result:error → result:success` | 本机 deny 不进入 callback，命令未执行（marker 不存在） |
| allow-bash | `allow:['Read'], ask:['Bash']` | `tool_use:Bash → canUseTool:Bash → tool_result:ok → result:success` | ask 进入 callback；返回原始 `updatedInput` 后命令只执行一次（marker 恰好 1 行） |
| deny-ask | `allow:['Read'], ask:['Bash']` | `tool_use:Bash → canUseTool:Bash → tool_result:error → result:success` | deny `interrupt:false` 工具不执行，run 继续并由 SDK result 定终态 |
| ask-user-question | 无 | `tool_use:AskUserQuestion → canUseTool:AskUserQuestion → tool_result:error → result:success` | 可按 `toolName` 识别结构化交互，不依赖 `decisionReason` |
| interrupt-pending | `allow:['Read'], ask:['Bash']` | `tool_use:Bash → canUseTool:Bash → tool_result:error → result:error_during_execution → query.error:error_result` | pending 中 `interrupt()` 使 `signal.aborted=true`；SDK 以错误结果结束并抛出；marker 不存在 |

## 3. 回调字段实测

| 字段 | Bash ask | AskUserQuestion |
|---|---|---|
| `requestId` | 存在 | 存在 |
| `toolUseID` | 存在 | 存在 |
| `signal` | 存在（AbortSignal） | 存在（AbortSignal） |
| `decisionReason` | **不存在**（本次 ask 场景） | 不存在 |
| `defaultToNo` | 不存在 | 不存在 |
| `blockedPath` | 存在 | 不存在 |
| `agentID` | 不存在（非子代理） | 不存在 |
| `mcpServer` | 不存在 | 不存在 |
| `suggestions` | 空数组 | 空数组 |
| `title` | 不存在 | 不存在 |

实现必须按“字段可能缺省”处理，不能假设 `decisionReason`/`defaultToNo` 一定存在；`defaultToNo` 缺省按 false 展示。

## 4. 关键结论

1. **顺序：** 所有用例中 `assistant.tool_use` 都先于 `canUseTool`。因此 S01 的 `tool.started` 可能早于审批，S03 Normalizer 必须同时兼容“工具卡片先于审批”和“审批先于工具卡片”。
2. **ask 优先于 user 级 allow：** 本机全局设置含 `permissions.allow:['Bash(*)']`，但项目级 `ask:['Bash']` 仍进入 callback；项目规则没有被 Adapter 改写。
3. **完全 deny 的工具不会被模型尝试：** 项目级 `deny:['Bash']` 时模型改用其他工具，无法产生 `tool_use:Bash` 证据；改用作用域 deny `Bash(touch:*)` 证明“本机 deny 不进入 callback 且不执行”。
4. **allow：** 返回回调开始时的原始 `updatedInput` 和原 `toolUseID`；不返回 `updatedPermissions`、`suggestions` 或 `setPermissionMode`。命令只执行一次。
5. **deny：** `interrupt:false` 时工具不执行，模型继续，run 终态与工具成功/失败均以 SDK 事件为准。
6. **interrupt：** pending 中 interrupt 会中止 signal，SDK 以 `error_during_execution` 结束并从迭代器抛出错误；Broker 不能依赖 AbortSignal 一定先到，需自行同步失效。
7. **设置不被写入：** 所有用例 fixture `.claude/settings.local.json` 与全局 `settings.json` 哈希均未变化。
8. **completed allow 重入：** `NOT_REPRODUCED` — SDK 公共 API 不暴露重发已完成 `control_response` 的入口，无法在不修改 SDK 的前提下稳定诱导同一 `requestId` 重发。Task 5 仍按 spec 9.1 实现“completed allow 重入一律 deny + `APPROVAL_DUPLICATE_AFTER_RESOLUTION`”，不因未复现而放宽。

## 5. 对实现的门禁要求

- Task 2–13 保留 `permissionMode:'default'` 与 `['user','project','local']`；
- 移除 S01 的无条件 `PreToolUse` deny hook，普通工具决策交给 Broker；
- 已由本机 allow 规则放行的工具不产生手机审批（方案 A 的既有边界）；
- 兼容 `decisionReason`/`defaultToNo`/`blockedPath` 缺省；
- deny 永远 `interrupt:false`，run 取消由 RunController 单独 interrupt。