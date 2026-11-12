# S03 实施预检

日期：2026-11-12
计划：`docs/superpowers/plans/2026-11-08-s03-mobile-permission-approval.md`
Spec：`docs/superpowers/specs/2026-11-08-s03-mobile-permission-approval-design.md`

## 1. 上游门禁结果

| 门禁 | 命令 | 结果 |
|---|---|---|
| S00 Core | `npm run s00:gate` | PASS（ASR Live: DEFERRED，S00 既定口径） |
| S01 | `npm run verify:s01` | FAIL：E2E-01–12 全部 NOT_RUN |
| S02 | `npm run verify:s02` | FAIL：E2E-01–12 全部 NOT_RUN，real device evidence is missing |

两者失败原因都只有真机 E2E：Tailscale HTTPS Certificates、Serve 与 iPhone 尚未接入
（见 `docs/s01/e2e-checklist.md`、`docs/s02/e2e-checklist.md` 的解除条件）。

**入口结论：BLOCKED。** 用户在本会话明确授权先实现、后统一真机验收；实现期间：

- S03 的 Task 13 结论保持 BLOCKED，不宣称 S03 验收通过；
- PERM-00（Task 1，真实 SDK 权限门禁）仍是硬门禁：未通过不进入 Task 2–13；
- 不以 Mock 替代 PERM-00、真实 SDK 或 E2E。

## 2. S02 实际接口与计划差异

| 接口 | S02 实际 | S03 计划要求 | 处理 |
|---|---|---|---|
| `ManagedRunStart` | `sessionId/workspaceId/claudeSessionId/runId/adapterGeneration/text/cwd/onEvent` | 增加 `deviceId`、`permissionBroker` | Task 7/8 追加字段，不改为可选 |
| `RunRecord` | 无 `deviceId`、无 `pendingApprovalCount` | 新增两字段 | Task 8 在创建时写入 |
| `RunStatus` | `queued/starting/running/cancelling/succeeded/failed/cancelled/interrupted` | 新增 `waiting_approval` | Task 8 扩展 |
| `RunScheduler.beginCancel` | 同步返回 `{outcome, run, handle}`；`cancel` 在 `started` 后立即 `handle.interrupt()` | cancel 在 beginCancel 后、interrupt 前同步 `invalidateRun` | Task 8 在两者之间插入同步失效 |
| `RunScheduler.enqueue` | 输入 `{sessionId,text,commandId,traceId}` | 输入增加 `deviceId` | Task 8 追加 |
| `RunController.sendPrompt` | `(sessionId,text,commandId,traceId)` | 追加 `deviceId` | Task 8 追加；Router 从认证设备填入 |
| `WorkspacePolicy` | `perSessionQueueLimit` | 增加 `mobileApprovalMode` | Task 2 追加，V3 迁移默认 deny |
| `WorkspaceSummary` | `workspaceId/displayName` | 同名增加 `mobileApprovalMode`，仍无 rootPath | Task 2 扩展 `toSummary` |
| `WorkspaceManager` | `add/list/rename/remove/assertUsable`，写盘 `writeConfigV2AtomicSync`（0600，保留 `.v1.bak`） | `setApprovalMode`、`approvalMode`；V3 备份 `.v2.bak` | Task 2 新增；沿用「校验→同步写盘→替换内存」 |
| 配置结构 | `AgentConfigV2`，`migrateConfigV1ToV2` | `AgentConfigV3`，`migrateConfigV2ToV3`，`agent.json.v2.bak` | Task 2 新增 V3 模块 |
| `AdminClient` | 有 workspace add/rename/remove | `workspaceSetApproval` + CLI `workspace set-approval` | Task 2 新增 |
| 设备吊销 | `admin /revoke` → `DeviceStore.revoke` → `connections.revoke` | revoke/replace 还要 `invalidateDevice` | Task 8 在 runtime 接线 |
| `SnapshotFactory` | 输入 `session/activeRun/queuedRuns/journal/globalCapacity`，预算 48 KiB | 增加 `pendingApprovals` 安全摘要与 `pendingApprovalCount` | Task 9 先为 pending 预留预算 |
| `CommandMessage`/`CommandIdentity` | 无 `approvalId` | 信封新增可选 `approvalId` | Task 9 追加 |
| `AgentSdkAdapter` | `canUseTool` 无条件 deny + `PreToolUse` hook deny | 直接 `permissionBroker.request`，保留原 Promise identity；保留 `permissionMode:'default'` | Task 7 替换 deny 接线；`PreToolUse` hook 移除（S03 由 Broker 决策） |
| `CanUseTool` 选项 | SDK 0.3.319 提供 `signal/requestId/toolUseID/agentID/decisionReason/defaultToNo/blockedPath/mcpServer/suggestions` | 同 spec §7.2 | 一致，无差异 |
| `Normalizer.permissionDenied` | 全局 `startedTools` Set，只按 toolUseId 补一次 completed | 按 runId+toolUseId 跟踪 denied outcome | Task 7 迁移为 run 维度 |
| 内容 HTTP | 无 | `GET /v1/approvals/{id}/content`，复用 Bearer 认证 | Task 6 新增；`authenticateUpgrade` 提取为可复用 request 认证 |

## 3. PERM-00 fixture

使用运行期创建的临时项目（`mkdtemp`），不含个人路径或敏感内容；标签写入证据文件：

| 标签 | 内容 |
|---|---|
| `fixture-alpha` | `.claude/settings.local.json`：`{"permissions":{"allow":["Read"],"ask":["Bash","Edit"]}}`；固定无害命令 `echo S03_PERM00_ALPHA`；Edit 目标为项目内新文件 |
| `fixture-beta` | `.claude/settings.local.json`：`{"permissions":{"allow":["Read"],"deny":["Bash"]}}`；用于本机 allow/deny 不进入 callback 的对照 |

执行标记：fixture 内固定文件名（如 `s03-marker.txt`），只断言存在/不存在，不写入个人目录。

全局设置冻结证据（2026-11-12）：

- `~/.claude/settings.json` 存在，SHA-256：`8af724a41f34812dbb39df0d0169d2a3922733691b65686c426d2860da6a3599`
- PERM-00 测试在运行前后各计算一次 SHA-256 并断言不变；不修改全局 `settings.json`。

## 4. 入口清单

- Task 1 只依赖固定版本 SDK 0.3.319 与上述 fixture，不依赖手机；
- Task 2–13 的接口按第 2 节差异实现，不假设 S02 不存在的方法；
- 真机 E2E-01–12 与 Tailscale 验收待用户统一执行，Task 13 结论必须保持 BLOCKED。