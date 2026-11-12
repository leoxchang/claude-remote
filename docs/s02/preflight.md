# S02 入口预检

**日期：** 2026-11-12
**分支：** `feat/s02-multi-workspace-multi-session`（基线 `073a8ea`，S01 实现已合入 master）
**结论：** **条件放行** — S00 Core PASS；S01 实现与自动化测试全部 PASS，但 E2E-01–12 尚未在真机执行（`verify:s01` 仍 FAIL）。用户 2026-11-12 决定「先完成所有 plan 的实现，最后统一真机验收」，因此 S02 继续执行，但**不宣称 S01 已验收**。

## 1. 上游门禁实测

```text
$ npm run s00:gate
S00 Core: PASS
ASR Contract: PASS
ASR Live: DEFERRED

$ npm run verify:s01
S01 Gate: FAIL
- E2E-01 is NOT_RUN
...
- E2E-12 is NOT_RUN
```

| 项 | 结果 | 证据 |
|---|---|---|
| S00 Core（SDK-01–12、CLI-01–03、PROTO-01–11） | PASS | `docs/s00/exit-report.md` |
| S00 ASR 契约 | PASS | `docs/s00/asr-contract.md` |
| S00 ASR 真实联调 | DEFERRED（S05 前关闭） | `docs/s00/status.json` |
| S01 Agent 测试 | PASS 152/152 | `npm run test:s01` |
| S01 Flutter 测试 | PASS 87/87 | `flutter test`（`apps/mobile`） |
| S01 真实 SDK 冒烟 | PASS 3/3 | `S01_LIVE=1 npm run test:s01:live` |
| S01 E2E-01–12 | **NOT_RUN** | `docs/s01/e2e-checklist.md` |
| S01 总门禁 | **FAIL**（仅因 E2E） | `npm run verify:s01` |
| CONC-01 双并发 | PASS | `docs/s02/concurrency-evidence.md` |

**放行裁决：** 记录在 `.superpowers/sdd/2026-11-08-s02-multi-workspace-multi-session/progress.md` 的 `Task 0: Ruling`。S02 Task 14 的 E2E 与 S01 的 E2E 一起在最后的真机会话中执行。

## 2. 版本矩阵（2026-11-12 实测）

| 项 | 计划要求 | 本机实测 | 结论 |
|---|---|---|---|
| Node.js | 24.15.0（22+） | v22.23.2 | 满足下限 |
| TypeScript | 7.0.2 | 7.0.2（仓库固定） | 满足 |
| Agent SDK | 0.3.319 | 0.3.319（仓库固定） | 满足 |
| SDK 内置 Runtime | 2.1.319 | 2.1.319 | 满足 |
| Claude Code CLI | 2.1.319 | 2.1.311 | 与 S00/S01 一致，按实测版本执行 |
| Flutter | 3.47.9 stable | 3.47.9 stable | 满足 |
| Dart | 3.13.7 | 3.13.7（随 Flutter） | 满足 |
| Tailscale | Serve，不启用 Funnel | 1.104.6，已连接，HTTPS Certificates 未启用 | 真机前补齐 |
| Xcode | 完整 Xcode + 真机签名 | Xcode 27.2，`xcode-select` 已指向 Xcode.app | 满足（签名待真机） |

## 3. S01 实际接口清单与计划差异

计划 Task 7–9 假设的接口与 S01 实际实现存在以下差异。**实现一律以本表右列为准**，不得假设不存在的方法。

| # | 计划假设 | S01 实际 | S02 处理 |
|---|---|---|---|
| 1 | `ManagedRunDriver.startRun` 同步返回 handle | `AgentDriver.startRun(input: StartRunInput): Promise<AgentRunHandle>`（`apps/agent/src/adapter/agent-driver.ts`） | Task 7 新建同步 `ManagedRunDriver`；Task 8 让 `AgentSdkAdapter` 实现它；Task 9 迁移完导入后删除 `agent-driver.ts` |
| 2 | `ManagedRunHandle.close(): Promise<void>` | `close(): void`（同步 `q.close()`） | Task 8 在 Adapter 内提供 async `close()`，内部仍调用同步 `q.close()` |
| 3 | Journal 需改造为按会话隔离 | 已隔离：`eventsBySession` / `seqBySession`，`recent(sessionId, limit)`、`lastSeq(sessionId)` 均按 session | Task 6 只补 queued/globalCapacity 预算与目标会话快照协调，不重写隔离 |
| 4 | `SnapshotFactory.create` 输入含 queuedRuns/globalCapacity | 输入为 `{session, activeRun, journal}`；已有 `MAX_SNAPSHOT_EVENTS=200`、`SNAPSHOT_PAYLOAD_BUDGET=48 KiB`、`oldestIncludedSeq` | Task 6 扩展输入并先把固定字段计入预算 |
| 5 | SnapshotCoordinator 可直接拿到队列 | `captureAndSend(sessionId, connectionEpoch)`，依赖 `getSession`/`getActiveRun`/`send` | Task 6 增加 `getQueuedRuns`/`getGlobalCapacity` 注入 |
| 6 | CommandRequest 已携带 workspaceId/traceId 到操作层 | `CommandMessage` 有 `commandId/traceId/sessionId?/workspaceId?/runId?/sourceDeviceId?`；`CommandRouter` 只接受 4 类命令，且只把 `sessionId/text/commandId` 传给 operations | Task 5 扩协议，Task 9 让 Router 调用新的 operations 签名 |
| 7 | 幂等按请求指纹 | `InMemoryIdempotency.execute(commandId, handler)`，仅按 commandId 命中 | Task 5 引入 canonical fingerprint 与 `COMMAND_ID_CONFLICT` |
| 8 | `SessionRecord` 含标题、runsById、时间戳 | `{sessionId, workspaceId:'default', claudeSessionId, status:'ready'|'running'}` | Task 2/4 定义 S02 类型；`status` 改为 `idle|queued|running|archived`，Dart 侧按字符串透传（`SessionSnapshot.sessionStatus`），不破坏解析 |
| 9 | `RunRecord` 含正文、入队时间、generation | `{runId, sessionId, commandId, status}` | Task 2 扩展；终态必须清空 text |
| 10 | Runtime 已有多项目/多会话 | 固定单 workspace：`cwd = config.workspace.rootPath`，`SessionController` 只允许 `workspaceId='default'` | Task 3–9 全部替换；Task 9 完成 wiring |
| 11 | `connection.ready` 可携带 agentInstanceId | `createReadyMessage` 只回 `desktopId/connectionEpoch/versions/capabilities/handshakeId` | Task 5/9 增加可选 `agentInstanceId`，`desktopId` 不变 |
| 12 | 配置已有 workspaces 数组 | V1：`version:1` + 单个 `workspace` 对象，`parseAgentConfig` 严格要求 `workspaceId='default'` | Task 2 实现 V1→V2 迁移与原子写入 |

其余已核对且与计划一致的部分：

- `AgentOperations`（S01）：`startSession/sendPrompt/cancelRun/snapshot`；S02 在 Task 9 扩展为多项目多会话门面。
- 事件投影规则（`message.delta` 按 assistantMessageId 累计 8 KiB、`tool.output` 只保留最新 4 KiB、`tool.started` 清空 input）已实现，Task 6 复用。
- 管理面只在 `~/.claude-remote/agent.sock` 暴露：`/admin/v1/status|devices|pair|revoke`；Task 3 在同一 socket 增加 workspace 路由，手机端无对应 mutating endpoint。
- 工具拒绝：`canUseTool` 立即 deny + `PreToolUse` hook 强制 deny，即使本机 `settings.json` 有 `permissions.allow` 也不会执行工具。

## 4. 运行期证据规则

- 测试与 E2E 只使用临时 fixture 目录，记录 `fixture-a` / `fixture-b` 标签，不记录个人绝对路径。
- workspaceId 使用脱敏值；不记录项目真实名称以外的敏感内容。
- 证据文件不保存完整模型回复、环境变量、网关凭证、token 或非公开 rootPath。
- 真机相关项（Serve、证书、iPhone）在 `docs/s02/e2e-checklist.md` 保持 NOT_RUN，直到实际执行。
- 当前 `settings.json` 与网关未做任何修改；S02 不允许写永久审批规则或启用 `bypassPermissions`。

## 5. 两套隔离 fixture

| 标签 | 用途 | 约束 |
|---|---|---|
| `fixture-a` | 同项目双会话、队列与取消 | 临时目录，无敏感文件 |
| `fixture-b` | 跨项目并发、workspace.remove 与路径校验 | 临时目录，无敏感文件 |

两套 fixture 都由测试在 `mkdtemp` 下创建并在结束时清理，不提交到仓库。