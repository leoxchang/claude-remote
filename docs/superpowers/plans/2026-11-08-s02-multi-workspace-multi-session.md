# S02 多项目与多会话 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 S01 的 iPhone + Mac 直连文字 MVP 上交付 Mac 本机项目白名单、多内存会话、每会话 FIFO 队列和全局双 SDK run 并发。

**Architecture:** Mac 以 WorkspaceManager 管理受保护配置，以 SessionRegistry 保存独立会话与终态 run 索引，以 RunScheduler 和每 run AdapterHandle 执行双槽调度；协议 V1 只做增量扩展。Flutter 以 sessionId 隔离时间线、队列、草稿和命令，项目/会话切换仅是本地导航，S04 前不引入 SQLite 或 afterSeq。

**Tech Stack:** 沿用 S01 固定版本：Node.js 24.15.0（22+）、TypeScript 7.0.2、Agent SDK 0.3.319、Claude Code 2.1.319、Fastify 5.12.8、`@fastify/websocket` 11.3.7、Vitest 5.1.0、Flutter 3.47.9 stable、Dart 3.13.7、Riverpod 3.5.0、web_socket_channel 3.0.3、flutter_secure_storage 11.2.0、http 1.6.0。

**Spec:** `docs/superpowers/specs/2026-11-08-s02-multi-workspace-multi-session-design.md`

## Global Constraints

- **当前入口为 BLOCKED：**Task 0 未确认 S00 Core 与 S01 完整 PASS 前，不得执行 Task 1–14；Task 1 的 CONC-01 未以真实 SDK 通过前，不得执行 Task 2–14。
- CONC-01 必须覆盖同 workspace 两 Claude session、跨 workspace 两 session 和另一 query 存活时独立 interrupt；不支持时保持 BLOCKED，不能静默改为单槽。
- 全局最多 2 个活跃 run，starting/running/cancelling 和 Adapter 清理均占槽；每会话 queued 上限为本机策略 1–20、默认 20，全局 100。
- 一次 run 一个独立 query/Streaming Input/handle；handle 必须在 run.started 和 starting 对外可见前同步注册，SDK 事件可以异步到达。
- App 只传 workspaceId，不能传 cwd/rootPath；每次启动 run 前同步复核 realpath，未授权、已移除或路径被替换时不得创建 query。
- run.cancel 不清空队列；queue.remove 只移除 queued run；没有批量清空、优先级编辑、自动重排或重启自动重放。
- `canUseTool` 继续立即 deny、`interrupt:false`，不得写永久规则或启用 `bypassPermissions`。
- 项目授权配置持久保存；session/run/queue/Journal/idempotency 只在内存，Agent 重启生成新 agentInstanceId，不宣称恢复。
- 单条协议消息最大 64 KiB；prompt UTF-8 为 1–16,384 字节；快照 payload 48 KiB、总消息 64 KiB、最多 200 条摘要事件，queuedRuns 也计入预算。
- Mac 只监听 `127.0.0.1:8787` 与 `~/.claude-remote/agent.sock`；仅 Tailscale Serve，不启用 Funnel，不关闭 iOS TLS 校验。
- 日志、快照、列表和错误不得包含 token、密钥、prompt 正文、queued 文本或非公开 rootPath；核心 TypeScript 与 Dart 业务逻辑覆盖率均不低于 80%。
- 当前目录不是 Git 仓库。只有用户明确授权初始化/提交后才执行 Commit 步骤，否则标记 SKIPPED，不得自行 `git init` 或提交。

## Review Focus

1. **Unicode 名称边界：**80 个 code point 的 emoji/组合字符名称可用，第 81 个和控制字符必须拒绝，不能按 UTF-16 length 误判；Task 2 固定测试。
2. **同毫秒会话与伪造分页 cursor：**createdAt 相同仍按 sessionId 稳定分页，cursor 换 workspace/filter 或篡改必须 INVALID_CURSOR；Task 4 固定测试。
3. **幂等记录中的秘密 prompt：**相同 commandId 不同正文返回冲突，store/log/错误中不得留下原始正文；Task 5 固定测试。
4. **20 条 queued + 大事件 + 长 Unicode 标题：**queuedRuns、globalCapacity 和摘要事件共同受 48/64 KiB 预算约束，UTF-8 不截断字符；Task 6 固定测试。
5. **Agent 重启时旧重试计时器仍存活：**agentInstanceId 改变后旧 callback 不得自动发送，必须标为结果未知并等待用户处理；Task 11 固定测试。

## File Structure

```text
apps/agent/
  src/config/config-v2.ts              # V1→V2 迁移、原子写入与配置校验
  src/config/workspace-path.ts         # realpath 与目录身份复核
  src/workspace/workspace-manager.ts   # 本机项目增删改查与使用检查
  src/workspace/workspace-admin.ts     # Unix socket 管理路由
  src/session/session-registry.ts      # 多 SessionRecord、Claude 映射与归档
  src/session/session-list.ts          # 稳定 keyset 分页和公开摘要
  src/command/canonical-request.ts     # 规范请求 SHA-256，不保存原 prompt
  src/command/idempotency.ts           # 并发幂等与 COMMAND_ID_CONFLICT
  src/events/snapshot-factory.ts       # queued/globalCapacity 有界投影
  src/adapter/managed-run-driver.ts    # 同步句柄、resumeEvents、异步事件
  src/adapter/adapter-registry.ts      # runId+generation 隔离
  src/run/run-scheduler.ts             # FIFO、双槽、queue.remove、终态索引
  src/run/run-controller.ts            # cancel、interrupt、清理与 SDK 结果
  src/app/agent-operations.ts          # 多项目/多会话命令门面
  src/app/runtime.ts                   # agentInstanceId 和完整生命周期
  test/live/s02-concurrency.test.ts    # CONC-01 真实 SDK 门禁

apps/mobile/
  lib/protocol/s02_messages.dart       # 新增命令、事件与快照模型
  lib/domain/app_state.dart            # 按 sessionId 的不可变总状态
  lib/domain/session_state.dart        # session/run/queue/draft reducer
  lib/connection/session_sync_controller.dart
  lib/features/chat/prompt_command_coordinator.dart
  lib/features/workspaces/             # 项目列表与 Controller
  lib/features/sessions/               # 会话列表、创建、改名、归档
  lib/features/chat/widgets/queue_panel.dart
  test/                                # 协议、reducer、连接、Widget 测试

protocol/v1/examples/s02/              # Mac/Dart 共用合法与非法样例
docs/s02/
  preflight.md                        # S00/S01 入口和实际接口差异
  concurrency-evidence.md             # CONC-01 脱敏真实证据
  e2e-checklist.md                    # E2E-01–12 台账
  rollback.md                         # 空队列、V1 配置备份与回滚边界
  exit-report.md                      # 覆盖率、限制和最终结论
scripts/s02/                           # gate 与 secret 检查及测试
```

---

### Task 0: S00/S01 入口与实际接口预检

**Files:**
- Create: `docs/s02/preflight.md`
- Read: `docs/s00/exit-report.md`, `docs/s01/exit-report.md`, `apps/agent/src/adapter/agent-driver.ts`, `apps/agent/src/events/journal.ts`, `apps/agent/src/app/agent-operations.ts`

**Interfaces:**
- Produces: 已核对的 S01 实际接口清单；Task 1–14 的明确入口。
- Consumes: S01 `AgentDriver`、`EventJournal`、`AgentOperations` 和 `npm run verify:s01`。

- [ ] **Step 1: Verify both upstream gates**

Run: `npm run s00:gate && npm run verify:s01`  
Expected: S00 Core PASS、S01 E2E-01–12 PASS、Agent/Dart 覆盖率均 >=80%。当前缺少证据时记录 BLOCKED 并停止，不能创建产品 scaffold 或用计划文档代替结果。

- [ ] **Step 2: Record interface drift before designing around it**

逐项记录 S01 实际 `startRun` 返回类型、close 行为、Journal 是否已按 sessionId 隔离、SnapshotFactory 输入、CommandRequest 字段和 Runtime wiring。若与 S01 计划不同，更新 `preflight.md` 和本计划对应接口后再继续，不得假设不存在的方法。

- [ ] **Step 3: Prepare isolated fixtures and evidence rules**

准备两个无敏感内容的临时项目，只记录脱敏 workspaceId 和 fixture 标签；确认当前 settings.json/网关无需修改，Bash 审批仍拒绝。记录 Node/SDK/Runtime/Flutter 版本和真机前提。

- [ ] **Step 4: Commit**

```bash
git add docs/s02/preflight.md
git commit -m "docs: record S02 implementation prerequisites"
```

### Task 1: CONC-01 真实 SDK 双并发门禁

**Files:**
- Create: `apps/agent/test/live/s02-concurrency.test.ts`, `docs/s02/concurrency-evidence.md`
- Modify: `package.json`

**Interfaces:**
- Consumes: S01 当前 `AgentSdkAdapter.startRun(...):Promise<AgentRunHandle>`，本任务不改产品接口。
- Produces: `npm run test:s02:concurrency`；同项目、跨项目、独立中断的真实 PASS/BLOCKED 证据。

- [ ] **Step 1: Write the live overlap and interrupt-isolation tests**

```ts
it('keeps two different Claude sessions live in one workspace', async () => {
  const pair = await startTwoLongTextRuns({sameWorkspace:true})
  await Promise.all([pair.a.firstDelta,pair.b.firstDelta])
  expect(pair.a.claudeSessionId).not.toBe(pair.b.claudeSessionId)
  expect(pair.activeOverlapObserved()).toBe(true)
  await pair.closeBoth()
})
```

增加跨 workspace 用例；独立 interrupt 用例必须在 A/B 都产生 delta 后中断 A，断言 A 进入 cancelled/interrupted、B 在 A 终态后仍产生新 delta，最后中断并关闭 B。使用无工具长文本 prompt 和唯一标记，不把 `Promise.all` 两个立即完成的请求算作并发。

- [ ] **Step 2: Run the real concurrency gate**

Run: `S02_LIVE=1 npm run test:s02:concurrency`  
Expected: 三个场景全部 PASS，且事件只进入各自 run。若没有观察到真实重叠、同 cwd 第二 query 失败、resume/会话文件冲突或 interrupt 影响另一 query，记录 FAIL/BLOCKED 并停止 Task 2–14；不得缩短证据、改成 Mock 或静默使用单槽。

- [ ] **Step 3: Record sanitized evidence and cleanup**

保存版本、时间窗口、fixture 标签、脱敏 Claude session 映射、事件顺序和关闭结果；不保存完整回复、个人路径、环境变量或网关凭证。确认没有残留 query/子进程。

- [ ] **Step 4: Commit**

```bash
git add apps/agent/test/live/s02-concurrency.test.ts docs/s02/concurrency-evidence.md package.json
git commit -m "test: verify concurrent Claude SDK sessions"
```

### Task 2: 配置 V2、Unicode 名称与真实路径校验

**Files:**
- Create: `apps/agent/src/config/config-v2.ts`, `apps/agent/src/config/workspace-path.ts`, `apps/agent/src/workspace/workspace-types.ts`
- Modify: `apps/agent/src/domain/types.ts`
- Test: `apps/agent/test/config-v2.test.ts`, `workspace-path.test.ts`

**Interfaces:**
- Produces: `WorkspaceRecord = {workspaceId:string;displayName:string;rootPath:string;createdAt:number;policy:{perSessionQueueLimit:number}}`。
- Produces: `AgentConfigV2`、`TerminalRunStatus`、`RunRecord`、`SessionRecord`（含 `runsById:ReadonlyMap<string,RunRecord>`）和 `SessionStatus='idle'|'queued'|'running'|'archived'`。
- Produces: `migrateConfigV1ToV2(input:unknown):AgentConfigV2`、`writeConfigV2Atomic(configDir:string,config:AgentConfigV2):Promise<void>`、`writeConfigV2AtomicSync(configDir:string,config:AgentConfigV2):void`。
- Produces: `validateDisplayName(value:string):string`、`resolveWorkspacePath(path:string):Promise<string>`、`assertWorkspacePathCurrent(record:WorkspaceRecord):void`。

- [ ] **Step 1: Write failing migration, name and path tests**

```ts
it('counts Unicode code points rather than UTF-16 units', () => {
  expect(validateDisplayName('🙂'.repeat(80))).toHaveLength(160)
  expect(() => validateDisplayName('🙂'.repeat(81))).toThrow('INVALID_MESSAGE')
  expect(() => validateDisplayName('bad\nname')).toThrow('INVALID_MESSAGE')
})
```

覆盖 V1 default 映射、V2 queueLimit 缺省 20/合法 1–20、50 workspace 上限、0600 备份、写入失败不替换原文件；路径覆盖相对、不存在、文件而非目录、符号链接初次解析、重复真实路径和运行前根目录替换。

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm run test:agent -- test/config-v2.test.ts test/workspace-path.test.ts`  
Expected: FAIL with missing config-v2/workspace-path modules。

- [ ] **Step 3: Implement immutable validated V2 config and synchronous run-time path checks**

使用 `realpathSync.native`/`statSync` 实现 `assertWorkspacePathCurrent`，供 Scheduler 无 await 地复核；配置加载/迁移可使用 Promise。原子写入前保留 `agent.json.v1.bak`，任何失败都抛出安全错误，不返回空 workspaces。

- [ ] **Step 4: Run config and path tests**

Run: `npm run test:agent -- test/config-v2.test.ts test/workspace-path.test.ts`  
Expected: PASS，Unicode、备份权限和 symlink 替换均有证据。

- [ ] **Step 5: Commit**

```bash
git add apps/agent/src apps/agent/test/config-v2.test.ts apps/agent/test/workspace-path.test.ts
git commit -m "feat: add S02 workspace config and path validation"
```

### Task 3: WorkspaceManager 与本机管理 CLI

**Files:**
- Create: `apps/agent/src/workspace/workspace-manager.ts`, `apps/agent/src/workspace/workspace-admin.ts`
- Modify: `apps/agent/src/admin/routes.ts`, `apps/agent/src/cli.ts`
- Test: `apps/agent/test/workspace-manager.test.ts`, `workspace-admin.test.ts`

**Interfaces:**
- Produces: `WorkspaceUsage = {hasActiveOrQueued(workspaceId:string):boolean}`，Task 9 由 RunScheduler 实现。
- Produces: `WorkspaceManager.add(input:{path:string;displayName:string}):Promise<WorkspaceRecord>`、`list():WorkspaceSummary[]`、`rename(workspaceId,displayName):Promise<WorkspaceSummary>`、`remove(workspaceId):Promise<void>`。
- Produces: `WorkspaceManager.assertUsable(workspaceId:string):WorkspaceRecord`，同步执行存在性、removed 集合和 Task 2 realpath 检查；`WORKSPACE_NOT_FOUND` 与 `WORKSPACE_NOT_ALLOWED` 分开。
- Produces: `AdminClient.workspaceAdd/list/rename/remove`，只经 Unix socket；手机路由无对应 mutating endpoint。

- [ ] **Step 1: Write failing manager and admin tests**

```ts
it('serializes removal against workspace usage without deleting files', async () => {
  usage.hasActiveOrQueued.mockReturnValue(true)
  await expect(manager.remove('ws_a')).rejects.toMatchObject({code:'WORKSPACE_BUSY'})
  usage.hasActiveOrQueued.mockReturnValue(false)
  await manager.remove('ws_a')
  expect(() => manager.assertUsable('ws_a')).toThrow('WORKSPACE_NOT_ALLOWED')
  expect(await fs.stat(fixtureRoot)).toBeDefined()
})
```

覆盖 rename 不改 ID/path、重新添加生成新 ID、最多 50、App rootPath 不进入 public summary、管理只走 socket、CLI 不直接修改运行中内存。

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm run test:agent -- test/workspace-manager.test.ts test/workspace-admin.test.ts`  
Expected: FAIL with missing workspace manager/admin modules。

- [ ] **Step 3: Implement local-only workspace mutations**

add/rename/remove 在同一 JavaScript 调用栈内完成“校验与 usage 检查 → `writeConfigV2AtomicSync` → 替换内存快照”，中间不得 await；写盘失败不替换内存。这样 remove 成功后不会再启动 queued run，也不会暴露只改内存或只改磁盘的半完成状态。removedWorkspaceIds 只保存在当前进程，remove 不删除项目或 Claude 原生文件。

- [ ] **Step 4: Run workspace tests**

Run: `npm run test:agent -- test/workspace-manager.test.ts test/workspace-admin.test.ts`  
Expected: PASS，无 TCP/Tailscale 管理路径，busy removal 无隐式取消。

- [ ] **Step 5: Commit**

```bash
git add apps/agent
git commit -m "feat: add local workspace authorization management"
```

### Task 4: SessionRegistry、稳定分页与归档

**Files:**
- Create: `apps/agent/src/session/session-registry.ts`, `apps/agent/src/session/session-list.ts`, `apps/agent/src/session/session-summary.ts`
- Test: `apps/agent/test/session-registry.test.ts`, `session-list.test.ts`

**Interfaces:**
- Produces: `SessionSummary = {sessionId:string;workspaceId:string;title:string;claudeSessionId:string|null;status:SessionStatus;activeRunId:string|null;queuedCount:number;createdAt:number;lastActivityAt:number}`。
- Produces: `SessionRegistry.create(input:{workspaceId:string;title?:string}):SessionRecord`、`get(sessionId):SessionRecord`、`update(sessionId,reducer:(current:SessionRecord)=>SessionRecord):SessionRecord`。
- Produces: `startCompatible(workspaceId:string):SessionRecord`、`rename(sessionId,title):SessionSummary`、`archive(sessionId):SessionSummary`、`recordClaudeSession(sessionId,runId,claudeSessionId):void`。
- Produces: `listSessions(input:{workspaceId:string;includeArchived?:boolean;limit?:number;cursor?:string}):{sessions:SessionSummary[];nextCursor:string|null}`。

- [ ] **Step 1: Write failing lifecycle, mapping and pagination tests**

```ts
it('uses sessionId as a tie breaker and binds cursors to their query', () => {
  const a = registry.create({workspaceId:'ws_a'})
  const b = registry.create({workspaceId:'ws_a'})
  const page = listSessions({workspaceId:'ws_a',limit:1})
  expect([page.sessions[0].sessionId]).toEqual([expectedFirst(a,b)])
  expect(() => listSessions({workspaceId:'ws_b',cursor:page.nextCursor!})).toThrow('INVALID_CURSOR')
  expect(() => listSessions({workspaceId:'ws_a',cursor:'tampered'})).toThrow('INVALID_CURSOR')
})
```

覆盖 create 不启动 query、默认标题不含 prompt、零/一/多 session.start、archived 只读、活跃或 queued 时 SESSION_BUSY、Claude ID 冲突拒绝改绑、update 不修改原对象。

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm run test:agent -- test/session-registry.test.ts test/session-list.test.ts`  
Expected: FAIL with missing session registry/list modules。

- [ ] **Step 3: Implement immutable records and bound keyset cursors**

cursor 使用 base64url JSON，包含 workspaceId/includeArchived/createdAt/sessionId；换 filter、非法字段、错误版本均 INVALID_CURSOR。按 createdAt DESC/sessionId DESC，默认 20、最大 50；runsById 使用新 ReadonlyMap 复制，归档只改 lifecycle。

- [ ] **Step 4: Run session tests**

Run: `npm run test:agent -- test/session-registry.test.ts test/session-list.test.ts`  
Expected: PASS，包括同 createdAt、80/81 code point、归档与 prompt 先后顺序。

- [ ] **Step 5: Commit**

```bash
git add apps/agent/src/session apps/agent/test/session-registry.test.ts apps/agent/test/session-list.test.ts
git commit -m "feat: add isolated multi-session registry"
```

### Task 5: 协议 V1 扩展与请求指纹幂等

**Files:**
- Create: `apps/agent/src/command/canonical-request.ts`
- Modify: `apps/agent/src/command/idempotency.ts`, `apps/agent/src/command/errors.ts`
- Modify: `protocol/v1/commands.schema.json`, `protocol/v1/events.schema.json`, `protocol/v1/README.md`
- Create: `protocol/v1/examples/s02/workspace-list.json`, `session-list-page.json`, `run-queued.json`, `run-started.json`, `queue-remove.json`, `session-snapshot.json`, `command-id-conflict.json`, `invalid-cursor.json`
- Test: `apps/agent/test/protocol-s02.test.ts`, `apps/agent/test/idempotency-s02.test.ts`

**Interfaces:**
- Produces: `CommandIdentity = {commandId:string;type:string;workspaceId?:string;sessionId?:string;runId?:string;payload:JsonObject}`。
- Produces: `canonicalRequestFingerprint(identity:CommandIdentity):string`，规范化对象 key、保留数组顺序和正文，输出 SHA-256 base64url。
- Produces: `InMemoryIdempotency.execute<T>(identity:CommandIdentity,handler:()=>Promise<T>):Promise<{value:T;duplicate:boolean}>`；冲突抛 `COMMAND_ID_CONFLICT`。
- Produces: S02 命令、run.queued/run.started、queuedRuns/globalCapacity、agentInstanceId 和新错误码的共享 schema/examples。

- [ ] **Step 1: Write failing shared-schema and idempotency tests**

```ts
it('does not retain a secret prompt while detecting conflicting reuse', async () => {
  const secret = 'do-not-store-this-prompt'
  await store.execute(identity('cmd_1',secret),async () => 'accepted')
  await expect(store.execute(identity('cmd_1','different'),async () => 'bad'))
    .rejects.toMatchObject({code:'COMMAND_ID_CONFLICT'})
  expect(JSON.stringify(store)).not.toContain(secret)
})
```

覆盖同 key 不同顺序对象仍是 duplicate、数组顺序变化是冲突、同 ID 改 session/run/type 冲突、并发重试只执行一次；Mac/Dart 后续共用全部 S02 合法/非法样例。

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm run test:agent -- test/protocol-s02.test.ts test/idempotency-s02.test.ts`  
Expected: FAIL with missing S02 schema definitions/fingerprint identity。

- [ ] **Step 3: Implement schema-first additive protocol and hashed idempotency**

只新增 V1 类型和可选字段，不改变 seq/command.result 基础语义。Idempotency 保存首次 Promise/result、identity 元数据和 fingerprint，不保存原始 payload；未知 rootPath/cwd 字段永不参与 cwd 选择，Task 9 另测忽略或拒绝行为。

- [ ] **Step 4: Run protocol and idempotency tests**

Run: `npm run test:agent -- test/protocol-s02.test.ts test/idempotency-s02.test.ts`  
Expected: PASS，错误 details 无 prompt/rootPath。

- [ ] **Step 5: Commit**

```bash
git add apps/agent/src/command apps/agent/test/protocol-s02.test.ts apps/agent/test/idempotency-s02.test.ts protocol/v1
git commit -m "feat: extend protocol V1 for S02"
```

### Task 6: 每会话 Journal 与 queued 有界快照

**Files:**
- Modify: `apps/agent/src/events/journal.ts`, `apps/agent/src/events/snapshot-factory.ts`, `apps/agent/src/events/snapshot-coordinator.ts`
- Test: `apps/agent/test/journal-s02.test.ts`, `apps/agent/test/snapshot-s02.test.ts`

**Interfaces:**
- Produces: `QueuedRunSummary = {runId:string;commandId:string;status:'queued';enqueuedAt:number}`、`GlobalCapacity = {activeRunCount:number;maxActiveRuns:2}`。
- Produces: `SnapshotFactory.create(input:{session:SessionRecord;activeRun:RunRecord|null;queuedRuns:QueuedRunSummary[];journal:EventJournal;globalCapacity:GlobalCapacity}):SessionSnapshotEvent`。
- Consumes: Task 4 SessionRecord 和 Task 5 S02 snapshot schema。

- [ ] **Step 1: Write failing per-session and worst-case snapshot tests**

```ts
it('isolates equal seq values and budgets queuedRuns with long Unicode data', () => {
  const a = journal.append(eventInput('session_a'))
  const b = journal.append(eventInput('session_b'))
  expect(a.seq).toBe(1)
  expect(b.seq).toBe(1)
  const snapshot = factory.create(worstCaseInput({queued:20,title:'会'.repeat(80)}))
  expect(utf8Bytes(JSON.stringify(snapshot))).toBeLessThanOrEqual(65536)
  expect(utf8Bytes(JSON.stringify(snapshot.payload))).toBeLessThanOrEqual(49152)
  expect(snapshot.payload.queuedRuns).toHaveLength(20)
  expect(JSON.stringify(snapshot)).not.toContain('queued prompt text')
})
```

覆盖快照只读目标 session、queued FIFO、globalCapacity、事件摘要预算、长 completed/tool output、活跃 delta、零事件和全中文截断。

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm run test:agent -- test/journal-s02.test.ts test/snapshot-s02.test.ts`  
Expected: FAIL because S02 snapshot fields/budget accounting are absent。

- [ ] **Step 3: Implement target-only snapshot coordination**

每 session 独立 seq/event index，eventId 仍全局唯一；先将 queuedRuns/globalCapacity 计入固定预算，再按 S01 newest-first 投影选择 recentEvents。SnapshotCoordinator 只冻结目标 session 临界区，其他 session Journal 可继续。

- [ ] **Step 4: Run event and snapshot tests**

Run: `npm run test:agent -- test/journal-s02.test.ts test/snapshot-s02.test.ts`  
Expected: PASS，200 条 32 KiB 输出加 20 queued 仍不突破预算。

- [ ] **Step 5: Commit**

```bash
git add apps/agent/src/events apps/agent/test/journal-s02.test.ts apps/agent/test/snapshot-s02.test.ts
git commit -m "feat: add per-session bounded S02 snapshots"
```

### Task 7: RunScheduler、FIFO、双槽与 queue.remove

**Files:**
- Create: `apps/agent/src/adapter/managed-run-driver.ts`, `apps/agent/src/adapter/adapter-registry.ts`, `apps/agent/src/adapter/mock-managed-run-driver.ts`
- Create: `apps/agent/src/run/run-scheduler.ts`
- Test: `apps/agent/test/run-scheduler.test.ts`, `apps/agent/test/adapter-registry.test.ts`

**Interfaces:**
- Produces: `ManagedRunDriver.startRun(input:ManagedRunStart):ManagedRunHandle`，同步返回；`ManagedRunHandle.interrupt():Promise<void>`、`close():Promise<void>`、`resumeEvents():void`。
- Produces: `ManagedRunStart = {sessionId:string;workspaceId:string;claudeSessionId:string|null;runId:string;adapterGeneration:number;text:string;cwd:string;onEvent:(event:AdapterEvent)=>void}`。
- Produces: `AdapterRegistry.register(runId:string,generation:number,handle:ManagedRunHandle):void`、`get(runId:string):ManagedRunHandle|null`、`remove(runId:string):void`、`assertCurrent(runId:string,generation:number):boolean`。
- Consumes: `WorkspaceManager.assertUsable(workspaceId):WorkspaceRecord`，每次 driver start 前同步复核路径。
- Produces: `PromptAccepted = {sessionId:string;runId:string;status:'queued'|'starting'}`、`CancelAccepted = {sessionId:string;runId:string;status:'cancelling'}`、`QueueRemoved = {sessionId:string;runId:string;status:'cancelled';removed:true}`。
- Produces: `RunScheduler.enqueue(input:{sessionId:string;text:string;commandId:string;traceId:string}):PromptAccepted`、`removeQueued(sessionId,runId):QueueRemoved`、`markRunning(sessionId,runId):void`、`beginCancel(sessionId,runId):{outcome:'started'|'alreadyCancelling';run:RunRecord;handle:ManagedRunHandle}`、`complete(input:{sessionId:string;runId:string;status:TerminalRunStatus;errorSummary?:string}):void`。
- Produces: `activeCount():number`、`queuedRuns(sessionId):QueuedRunSummary[]`、`hasActiveOrQueued(workspaceId):boolean`、`handle(runId):ManagedRunHandle|null`。

- [ ] **Step 1: Write failing scheduler race and capacity tests**

```ts
it('skips a busy session head without blocking another session', () => {
  const a1 = enqueue('session_a','a1')
  const a2 = enqueue('session_a','a2')
  const b1 = enqueue('session_b','b1')
  const c1 = enqueue('session_c','c1')
  expect(startedRunIds()).toEqual([a1.runId,b1.runId])
  expect([a2.status,c1.status]).toEqual(['queued','queued'])
  complete(a1.runId)
  expect(a2.runId).toBe(startedRunIds()[1])
})
```

覆盖三会话双槽、starting→running 的 session.status、cancelling 占槽、同 session FIFO、中间 queue.remove 且 reason=queue_removed、重复 cancel 返回 alreadyCancelling 且只 interrupt 一次、remove/start 竞争、RUN_NOT_FOUND/RUN_NOT_QUEUED/RUN_SESSION_MISMATCH、每会话 20/全局 100、终态 text=null、启动前 realpath 失败无 driver、同步 start throw 后 failed 且只释放一次。

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm run test:agent -- test/run-scheduler.test.ts test/adapter-registry.test.ts`  
Expected: FAIL with missing managed driver/scheduler modules。

- [ ] **Step 3: Implement synchronous state transitions and driver-start contract**

每个 accepted prompt 先 append run.queued；eligible 队头按 enqueueOrder 调度。调用 driver 前执行 `WorkspaceManager.assertUsable`，driver 同步返回后先 registry.register，再 append run.started，最后 handle.resumeEvents。start throw 仍使命令保持已接受语义，通过 run.completed(failed) 收尾；complete 清空 text、保留 runsById、释放槽并继续 drain。

- [ ] **Step 4: Run scheduler tests**

Run: `npm run test:agent -- test/run-scheduler.test.ts test/adapter-registry.test.ts`  
Expected: PASS，Mock 可证明 starting 对外可见时 handle 已注册，queued 无 handle/query。

- [ ] **Step 5: Commit**

```bash
git add apps/agent/src/adapter apps/agent/src/run apps/agent/test/run-scheduler.test.ts apps/agent/test/adapter-registry.test.ts
git commit -m "feat: add dual-slot per-session run scheduler"
```

### Task 8: RunController、取消与真实 Adapter generation 隔离

**Files:**
- Create: `apps/agent/src/run/run-controller.ts`
- Modify: `apps/agent/src/adapter/agent-sdk-adapter.ts`, `apps/agent/src/adapter/mock-driver.ts`, `apps/agent/src/events/normalizer.ts`
- Test: `apps/agent/test/run-controller-s02.test.ts`, `apps/agent/test/agent-sdk-adapter-s02.test.ts`

**Interfaces:**
- Consumes: Task 7 `ManagedRunDriver`、`RunScheduler`、`AdapterRegistry`。
- Produces: `RunController.sendPrompt(sessionId,text,commandId,traceId):Promise<PromptAccepted>`、`cancel(sessionId,runId):Promise<CancelAccepted>`、`removeQueued(sessionId,runId):Promise<QueueRemoved>`。
- Produces: `AgentSdkAdapter implements ManagedRunDriver`；真实 SDK import 仍只存在于该 Adapter 文件。
- Produces: S01 `RunController` 的多会话替代实现，旧 AgentOperations 在 Task 9 切换。

- [ ] **Step 1: Write failing cancellation, cleanup and late-event tests**

```ts
it('cancels starting before init without inventing a Claude session mapping', async () => {
  const accepted = await controller.sendPrompt('s1','first','cmd_1','trace_1')
  expect(registry.get(accepted.runId)).not.toBeNull()
  await controller.cancel('s1',accepted.runId)
  await waitForRunTerminal(accepted.runId)
  driver.emitLateInit(accepted.runId,'claude_late')
  expect(sessions.get('s1').claudeSessionId).toBeNull()
  expect(eventsFor(accepted.runId).at(-1).type).toBe('run.completed')
})
```

覆盖 init 前/后 cancel、10 秒无终态 close+interrupted、其他 run 继续、close 后才 complete/释放槽、第二次 run resume 本 session、Claude ID 冲突 failed、旧 generation 事件丢弃、Adapter.start 前回调缓冲至 run.started 后、deny 行为不变。

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm run test:agent -- test/run-controller-s02.test.ts test/agent-sdk-adapter-s02.test.ts`  
Expected: FAIL with missing multi-session RunController/ManagedRunDriver implementation。

- [ ] **Step 3: Implement one-query-per-run controller and synchronous SDK handle creation**

AgentSdkAdapter 在当前调用栈创建 query/Streaming Input 并返回 handle，事件先缓冲，resumeEvents 后交给 Normalizer。S00 已确认的 init/可执行事件先 recordClaudeSession（如适用）再 markRunning；冲突由 RunController 捕获并完成 failed。RunController 只处理当前 generation；SDK result 后 await close、registry.remove，再 scheduler.complete。cancel 先 beginCancel，仅 outcome=started 时调用 interrupt，alreadyCancelling 直接返回当前状态；interrupt Promise 不当终态，沿用 10 秒有界路径。

- [ ] **Step 4: Run run and adapter tests**

Run: `npm run test:agent -- test/run-controller-s02.test.ts test/agent-sdk-adapter-s02.test.ts`  
Expected: PASS，无永久 cancelling、跨 session resume 或旧回调污染。

- [ ] **Step 5: Commit**

```bash
git add apps/agent/src/adapter apps/agent/src/run apps/agent/src/events/normalizer.ts apps/agent/test/run-controller-s02.test.ts apps/agent/test/agent-sdk-adapter-s02.test.ts
git commit -m "feat: isolate concurrent managed SDK runs"
```

### Task 9: Mac 多会话命令门面与完整 wiring

**Files:**
- Modify: `apps/agent/src/app/agent-operations.ts`, `apps/agent/src/app/runtime.ts`, `apps/agent/src/app/wire.ts`, `apps/agent/src/command/router.ts`, `apps/agent/src/transport/handshake.ts`, `apps/agent/src/cli.ts`
- Modify: `apps/agent/test/integration/agent-flow.test.ts`, `apps/agent/test/run-controller.test.ts`, `apps/agent/test/command-router.test.ts`
- Delete after imports migrate: `apps/agent/src/adapter/agent-driver.ts`
- Test: `apps/agent/test/integration/s02-agent-flow.test.ts`, `apps/agent/test/integration/workspace-removal.test.ts`, `apps/agent/test/integration/restart-s02.test.ts`

**Interfaces:**
- Produces: `AgentOperations.listWorkspaces()`、`createSession(workspaceId,title?)`、`listSessions(input)`、`resumeSession(sessionId)`、`renameSession(sessionId,title)`、`archiveSession(sessionId)`、`startSession(workspaceId)`。
- Produces: `sendPrompt(workspaceId,sessionId,text,commandId,traceId)`、`cancelRun(sessionId,runId)`、`removeQueuedRun(sessionId,runId)`、`snapshot(sessionId)`。
- Produces: `AgentRuntime.agentInstanceId:string`；每次 createAgentRuntime 新建，connection.ready 携带，desktopId 不变。
- Produces: `AgentOperations.activeCount():number`、`queuedRunCount():number`，供 workspace.list 的 SchedulerSummary 和集成断言使用。
- Consumes: Task 3 WorkspaceUsage 由 RunScheduler.hasActiveOrQueued 实现；Task 8 RunController。

- [ ] **Step 1: Write failing real-transport multi-session integration tests**

```ts
it('keeps command targets and broadcasts isolated over one WSS', async () => {
  const {a,b} = await createTwoSessionsOverWss()
  const a1 = await sendPrompt({sessionId:a,workspaceId:'ws_a',text:'A1'})
  const b1 = await sendPrompt({sessionId:b,workspaceId:'ws_b',text:'B1'})
  expect(eventsFor(a).every(e => e.sessionId === a)).toBe(true)
  expect(eventsFor(b).every(e => e.sessionId === b)).toBe(true)
  expect(runtime.operations.activeCount()).toBe(2)
})
```

覆盖 workspace/session 全命令、session.start 多会话错误、重复/冲突 commandId（run 已推进后仍返回首次 queued/starting）、remove busy、空闲 remove 后旧 session list/snapshot 均 WORKSPACE_NOT_ALLOWED 且 re-add 不复活、archive 与 prompt 竞态、queued snapshot、rootPath/cwd 注入不改变 cwd、同 WSS 广播、新 agentInstanceId、重启不自动 start/replay。只针对已批准的语义变化迁移 S01 测试：忙碌 prompt 从 SESSION_BUSY 改为 queued，单会话 start 改为多会话选择；配对、TLS、deny、事件截断等原断言不得为通过而放宽。

- [ ] **Step 2: Run integration tests to verify they fail**

Run: `npm run test:agent -- test/integration/s02-agent-flow.test.ts test/integration/workspace-removal.test.ts test/integration/restart-s02.test.ts`  
Expected: FAIL because runtime still uses S01 single-session operations。

- [ ] **Step 3: Replace the single-session wiring without alternate execution paths**

所有命令经 schema/idempotency/AgentOperations，所有 run 经新 RunController，所有事件经目标 session Journal 后广播。resume/snapshot 先发送目标快照再 command.result；WorkspaceManager.remove 使用真实 Scheduler usage；旧 single-session driver/import 删除，不保留可绕过的执行入口。

- [ ] **Step 4: Run the complete Mac suite**

Run: `npm run test:agent && npm run coverage:agent`  
Expected: PASS，核心 statements/branches/functions/lines >=80%，S01 配对/TLS/权限回归不失败。

- [ ] **Step 5: Commit**

```bash
git add apps/agent protocol/v1
git commit -m "feat: wire multi-workspace multi-session agent"
```

### Task 10: Flutter S02 协议与按 session 的不可变状态

**Files:**
- Create: `apps/mobile/lib/protocol/s02_messages.dart`, `apps/mobile/lib/domain/workspace.dart`, `apps/mobile/lib/domain/app_state.dart`, `apps/mobile/lib/domain/session_state.dart`
- Modify: `apps/mobile/lib/protocol/decoder.dart`, `apps/mobile/lib/domain/run.dart`, `apps/mobile/lib/domain/timeline.dart`
- Test: `apps/mobile/test/protocol/s02_decoder_test.dart`, `apps/mobile/test/domain/app_state_test.dart`, `apps/mobile/test/domain/session_state_test.dart`

**Interfaces:**
- Produces: Dart `WorkspaceSummary`、`SessionSummary`、`QueuedRunSummary`、`GlobalCapacity`、`SchedulerSummary`、`AgentInstanceId`。
- Produces: `AppState applySessionSnapshot(AppState previous,SessionSnapshot snapshot)`、`AppState applyTimelineEvent(AppState previous,TimelineEvent event)`。
- Produces: `AppState` 固定字段 `sessionsById/timelinesBySessionId/queuesBySessionId/composerDraftsBySessionId/selectedSessionId/agentInstanceId`，全部不可变。

- [ ] **Step 1: Write failing shared-example and cross-session reducer tests**

```dart
test('same seq in two sessions is legal and snapshot only replaces its target', () {
  var state = AppState.initial()
  state = applyTimelineEvent(state, event(sessionId: 'a', seq: 1));
  state = applyTimelineEvent(state, event(sessionId: 'b', seq: 1));
  final beforeB = state.timelinesBySessionId['b'];
  state = applySessionSnapshot(state, snapshot(sessionId: 'a'));
  expect(state.timelinesBySessionId['b'], same(beforeB));
  expect(state.timelinesBySessionId.keys, containsAll(['a','b']));
});
```

覆盖全部 `protocol/v1/examples/s02`、queued FIFO、globalCapacity、过期 waitReason 不覆盖实时 activeRun/globalCapacity、eventId 去重/冲突、不同 session 同 seq、run.queued/started/completed、archived 只读、草稿独立、未知 session 事件不插入当前聊天。

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd apps/mobile && flutter test test/protocol/s02_decoder_test.dart test/domain/app_state_test.dart test/domain/session_state_test.dart`  
Expected: FAIL with missing S02 models/reducers。

- [ ] **Step 3: Implement immutable per-session projections**

使用 sealed classes/copyWith 和新 Map/List，不以全局 seq 作 key；applySnapshot 只替换目标 session 的易失状态，不删除其他 session。queuedRuns 不合成 prompt 正文；idle timeline 淘汰只删缓存，不删 session summary/queue/draft。

- [ ] **Step 4: Run protocol and domain tests**

Run: `cd apps/mobile && flutter test test/protocol test/domain`  
Expected: PASS，与 Mac 对共享样例结论一致。

- [ ] **Step 5: Commit**

```bash
git add apps/mobile/lib apps/mobile/test/protocol apps/mobile/test/domain
git commit -m "feat: add per-session Flutter state for S02"
```

### Task 11: Flutter 命令顺序门控与 agentInstanceId 重连

**Files:**
- Create: `apps/mobile/lib/connection/session_sync_controller.dart`, `apps/mobile/lib/features/chat/prompt_command_coordinator.dart`
- Modify: `apps/mobile/lib/connection/command_client.dart`, `apps/mobile/lib/connection/connection_controller.dart`
- Test: `apps/mobile/test/connection/s02_connection_test.dart`, `apps/mobile/test/features/chat/prompt_command_coordinator_test.dart`

**Interfaces:**
- Consumes: S01 `CommandClient.execute<T>`，Task 10 AppState。
- Produces: `CommandRequest<T>` 新增 `String? workspaceId`；原 commandId/traceId/type/sessionId/runId/payload/decode 保留。
- Produces: `PromptCommandCoordinator.send(CommandRequest<PromptAccepted> request):Future<PromptAccepted>`、`retry(String sessionId)`、`canSend(String sessionId):bool`、`unknownFor(String sessionId):UnknownPrompt?`、`invalidateForRestart()`、`discardUnknown(String sessionId)`；`UnknownPrompt` 保存原 sessionId/request 和 `reason:'agent-restarted'`，不自动生成新 commandId。
- Produces: `SessionSyncController.refreshSnapshot(String sessionId)`、`refreshCurrentAndActive()`；ConnectionController ready 解析 agentInstanceId。

- [ ] **Step 1: Write failing ordering and stale-retry tests**

```dart
test('second prompt cannot overtake an unresolved first prompt in one session', () {
  fakeAsync((clock) {
    unawaited(coordinator.send(request('a','first')));
    clock.elapse(const Duration(seconds: 11));
    expect(coordinator.canSend('a'), isFalse);
    expect(coordinator.canSend('b'), isTrue);
    unawaited(coordinator.retry('a'));
    clock.flushMicrotasks();
    expect(sentCommandIds('a'), ['cmd_first','cmd_first']);
    expect(sentTexts('a'), ['first','first']);
  });
});

test('instance change prevents an already scheduled retry callback', () async {
  scheduleRetry(request('a','first'));
  connection.emitReady(agentInstanceId: 'new-instance');
  await flushTimers();
  expect(sentRequests, isEmpty);
  expect(coordinator.unknownFor('a'), isNotNull);
});
```

覆盖切换 session 不改 request 目标、同实例重连可 retry、新实例使缓存/自动重试失效、断线/后台不 cancel/remove、当前和活跃会话快照顺序、旧 connectionEpoch callback 丢弃。

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd apps/mobile && flutter test test/connection/s02_connection_test.dart test/features/chat/prompt_command_coordinator_test.dart`  
Expected: FAIL with missing per-session gate/instance handling。

- [ ] **Step 3: Implement one coordinator and instance-aware synchronization**

CommandClient 仍只负责传输/超时，PromptCommandCoordinator 统一保存每 session 唯一 pending request 和重试，ChatController 不另写重试逻辑。agentInstanceId 改变时使旧 timer/callback generation 失效并刷新列表；只有用户 discardUnknown 后可在新会话创建新 prompt。

- [ ] **Step 4: Run connection and coordinator tests**

Run: `cd apps/mobile && flutter test test/connection test/features/chat/prompt_command_coordinator_test.dart`  
Expected: PASS，无新 commandId 重试、跨会话抢先或重启自动发送。

- [ ] **Step 5: Commit**

```bash
git add apps/mobile/lib/connection apps/mobile/lib/features/chat/prompt_command_coordinator.dart apps/mobile/test/connection apps/mobile/test/features/chat/prompt_command_coordinator_test.dart
git commit -m "feat: preserve prompt order across reconnects"
```

### Task 12: 项目与会话列表、创建、恢复和归档 UI

**Files:**
- Create: `apps/mobile/lib/features/workspaces/workspace_controller.dart`, `apps/mobile/lib/features/workspaces/workspace_page.dart`
- Create: `apps/mobile/lib/features/sessions/session_controller.dart`, `apps/mobile/lib/features/sessions/session_page.dart`
- Modify: `apps/mobile/lib/main.dart`, `apps/mobile/lib/features/pairing/pairing_page.dart`
- Modify: `apps/mobile/test/bootstrap_test.dart`, `apps/mobile/test/features/pairing/pairing_page_test.dart`
- Test: `apps/mobile/test/features/workspaces/workspace_page_test.dart`, `apps/mobile/test/features/sessions/session_controller_test.dart`, `apps/mobile/test/features/sessions/session_page_test.dart`

**Interfaces:**
- Produces: `WorkspaceController.refresh():Future<void>`、`SessionController.loadFirstPage(workspaceId)`、`loadNextPage()`、`create(title?)`、`resume(sessionId)`、`rename(sessionId,title)`、`archive(sessionId)`。
- Produces: 配对成功后 Workspace 路由；Workspace → Session list → Chat 的导航，selectedSessionId 只在 App。

- [ ] **Step 1: Write failing controller and Widget tests**

```dart
testWidgets('workspace page exposes no path or authorization editor', (tester) async {
  await pumpWorkspacePage(tester,workspaces:[workspace(name:'Fixture Alpha')]);
  expect(find.text('Fixture Alpha'), findsOneWidget);
  expect(find.textContaining('/absolute/'), findsNothing);
  expect(find.byTooltip('添加项目'), findsNothing);
  expect(find.text('全局执行槽 1/2'), findsOneWidget);
});
```

覆盖 workspace 只显示名称和全局 scheduler、无 rootPath/添加项目输入；session 默认/最大分页、同毫秒顺序、includeArchived、非法 cursor 安全提示、create/resume/rename/archive、busy archive 错误、archived 只读、返回列表刷新和空状态。断言切换项目不清空其他 session 草稿/时间线。只针对新导航迁移 S01 bootstrap/配对成功断言：Pairing 后进入 Workspace，而不是直接 Chat。

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd apps/mobile && flutter test test/features/workspaces test/features/sessions`  
Expected: FAIL with missing workspace/session pages。

- [ ] **Step 3: Implement pull-based list flows without new subscription protocol**

Controller 使用 Task 11 CommandClient 与 Task 10 models；resume 完成后进入目标 Chat，session.start 只用于兼容路径，多会话使用 list/create/resume。页面不提供 cwd、永久删除、unarchive 或 Mac 管理按钮。

- [ ] **Step 4: Run workspace/session tests**

Run: `cd apps/mobile && flutter test test/features/workspaces test/features/sessions`  
Expected: PASS，无路径泄露、跨项目状态清空或归档后发送入口。

- [ ] **Step 5: Commit**

```bash
git add apps/mobile/lib apps/mobile/test/features/workspaces apps/mobile/test/features/sessions
git commit -m "feat: add workspace and session management UI"
```

### Task 13: 每会话 Composer、QueuePanel 与停止/移除控制

**Files:**
- Create: `apps/mobile/lib/features/chat/widgets/queue_panel.dart`, `apps/mobile/lib/features/chat/queue_controller.dart`
- Modify: `apps/mobile/lib/features/chat/chat_controller.dart`, `apps/mobile/lib/features/chat/chat_page.dart`, `apps/mobile/lib/features/chat/widgets/composer.dart`, `apps/mobile/lib/features/chat/widgets/run_controls.dart`
- Modify: `apps/mobile/test/features/chat/chat_controller_test.dart`, `apps/mobile/test/features/chat/chat_page_test.dart`
- Test: `apps/mobile/test/features/chat/s02_chat_controller_test.dart`, `apps/mobile/test/features/chat/queue_panel_test.dart`, `apps/mobile/test/features/chat/s02_chat_page_test.dart`

**Interfaces:**
- Consumes: Task 11 PromptCommandCoordinator/SessionSyncController、Task 12 selected session。
- Produces: `ChatController.sendText()`、`retryUnknownCommand()`、`cancelActiveRun()`、`removeQueuedRun(String runId)`。
- Produces: QueuePanel 的本地预览/匿名冷启动卡片和明确“停止当前不会清除队列”提示。

- [ ] **Step 1: Write failing queue interaction and privacy tests**

```dart
testWidgets('cold queued card is anonymous and only offers removal', (tester) async {
  await pumpChat(tester, queued: [queuedRun(runId: 'run_12345678')], drafts: {});
  expect(find.textContaining('run_1234'), findsOneWidget);
  expect(find.text('排队任务'), findsOneWidget);
  expect(find.text('执行结果未知'), findsNothing);
  expect(find.byTooltip('移除'), findsOneWidget);
  expect(find.textContaining('prompt secret'), findsNothing);
});
```

覆盖 running 时按钮“排队”、不同 session 使用全局唯一 UUID/ULID commandId 而非会话计数器、QUEUE_FULL/offline/syncing/archived 禁止、同 session pending 阻止第二条抢先、不同 session 草稿独立、cancel 后 queued 不消失、remove 只传目标 runId、run.completed 后仍显示下一项、快照只覆盖目标、idle cache 淘汰与恢复。只针对已批准的 S02 行为迁移 S01 busy 测试；空白/超长、offline、权限拒绝和取消安全断言不得放宽。

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd apps/mobile && flutter test test/features/chat`  
Expected: FAIL with S01 busy-reject/single-session UI behavior。

- [ ] **Step 3: Implement queue-aware chat without adding clear/reorder controls**

发送时捕获 sessionId/workspaceId/request；queued 本地预览仅来自仍存在的 draft，否则显示 runId 短标识+enqueuedAt。活跃和 queued 按钮分离，取消附近固定提示；cache 只保证当前及活跃/queued session 时间线，其他 idle 可淘汰后快照恢复。

- [ ] **Step 4: Run all Flutter tests and coverage**

Run: `cd apps/mobile && flutter test --coverage`  
Expected: PASS，核心 Dart 业务逻辑覆盖率 >=80%，S01 配对/权限/截断回归不失败。

- [ ] **Step 5: Commit**

```bash
git add apps/mobile
git commit -m "feat: add queued multi-session iPhone chat"
```

### Task 14: 真实 E2E、覆盖率、安全与退出门禁

**Files:**
- Create: `apps/agent/test/live/s02-real-sdk.test.ts`
- Create: `scripts/s02/verify-gate.ts`, `scripts/s02/verify-gate.test.ts`, `scripts/s02/check-secrets.ts`, `scripts/s02/check-secrets.test.ts`
- Create: `docs/s02/e2e-checklist.md`, `docs/s02/rollback.md`, `docs/s02/exit-report.md`
- Modify: `package.json`

**Interfaces:**
- Produces: `npm run test:s02`、`npm run test:s02:live`、`npm run verify:s02`。
- Produces: E2E-01–12 的 PASS/FAIL/BLOCKED 真实台账；Mock 不得替代真机或 CONC-01。

- [ ] **Step 1: Write failing live regression and gate/checker tests**

```ts
it('rejects incomplete real evidence even when all mocks pass', () => {
  const report = fakeReport({mocks:'PASS',conc01:'PASS',e2e:{'E2E-07':'BLOCKED'}})
  expect(() => verifyGate(report)).toThrow('E2E-07')
  expect(() => verifyGate(fakeReport({conc01:'BLOCKED'}))).toThrow('CONC-01')
  expect(() => checkSecrets('queued prompt text=/private/root/token=secret')).toThrow()
})
```

真实 SDK 回归覆盖两个项目的独立上下文、同 session 两个顺序 run、双 session 并发和指定 interrupt；Bash ask 仍 deny。Gate 测试缺失 CONC-01、任一 E2E、真实设备标记、覆盖率、回滚步骤或包含 secret/Funnel 时必须失败。

- [ ] **Step 2: Run the real SDK suite before device acceptance**

Run: `S02_LIVE=1 npm run test:s02:live`  
Expected: 全部可执行且结果真实，CONC-01 仍 PASS；缺网关、fixture 或真实能力时标 BLOCKED 并停止，不能改写 marker/断言、默认放行工具或把 Mock 写成 live。

- [ ] **Step 3: Execute E2E-01–12 on the physical iPhone**

按 spec 顺序记录时间、版本、traceId 和结果：双项目授权、独立上下文、同 session 排队、全局双槽、queue.remove、cancel 后下一项、反复切换、rename/archive、断网快照、重复/冲突 commandId、WORKSPACE_BUSY、Agent 重启不重放。E2E-06 必须实际看到下一 queued 项开始，不能只检查 toast。

- [ ] **Step 4: Verify rollback prerequisites without destroying evidence**

在独立临时 configDir 演练：停止活跃 run、逐项移除 queued、确认 active=0/queued=0、使用 V1 backup 恢复原单项目；断言不会截断多项目 V2 配置后静默启动。只记录内存历史不可见，不写成任务已完成。

- [ ] **Step 5: Run full verification and security scans**

Run: `npm run test:s02 && npm run coverage:agent && cd apps/mobile && flutter test --coverage && cd ../.. && S02_LIVE=1 npm run test:s02:live && npm run verify:s02`  
Expected: 全部 PASS，Agent/Dart 覆盖率 >=80%，无 prompt/queued 正文/rootPath/token/密钥泄漏，无 Funnel，E2E-01–12 全 PASS。

- [ ] **Step 6: Write the exit report**

记录真实结果、已知内存历史/队列限制、匿名冷启动 queued 卡片、无 CLI 历史导入、无 afterSeq、无手机审批、无双设备订阅；任何 FAIL/BLOCKED 都停止 S02 验收，不进入 S03。

- [ ] **Step 7: Commit**

```bash
git add apps scripts/s02 docs/s02 protocol/v1 package.json
git commit -m "test: verify S02 on Mac and iPhone"
```
