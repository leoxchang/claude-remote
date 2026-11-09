# S03 手机权限审批 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 S02 多项目、多会话和双槽调度之上，交付 Mac 逐项目开启的 iPhone“允许一次/拒绝”审批，并保证完整内容核对、超时、并发、取消、吊销和重启均 fail closed。

**Architecture:** Mac 以同步不可变 PermissionBroker 串行化 SDK 回调、用户响应、monotonic timeout 与失效事件；完整输入只在 pending 内存中保存，并通过既有认证 localhost/Tailscale HTTPS 分块读取。RunController 负责 waiting_approval 占槽和先失效审批再 interrupt，Flutter 以按 session 隔离的摘要、仅内存内容缓存和固定 commandId 完成审批，S04 前不引入 SQLite 或持久审批。

**Tech Stack:** 沿用 S02 固定版本：Node.js 24.15.0、TypeScript 7.0.2、Agent SDK 0.3.319、Claude Code 2.1.319、Fastify 5.12.8、`@fastify/websocket` 11.3.7、Vitest 5.1.0、Flutter 3.47.9 stable、Dart 3.13.7、Riverpod 3.5.0、web_socket_channel 3.0.3、flutter_secure_storage 11.2.0、http 1.6.0；新增 Dart `crypto 3.0.8`，仅用于 SHA-256 内容校验。

**Spec:** `docs/superpowers/specs/2026-11-08-s03-mobile-permission-approval-design.md`

## Global Constraints

- **当前入口为 BLOCKED：**Task 0 未确认 S00 Core、S01、S02 完整 PASS 前，不得执行 Task 1–13；Task 1 的 PERM-00 未以固定版本真实 SDK 通过前，不得执行 Task 2–13。
- 所有受管 query 显式使用 `permissionMode:'default'`；不得使用 dontAsk、acceptEdits、auto、plan、bypassPermissions 或动态 setPermissionMode，不修改全局 `settings.json`。
- 配置 V2→V3 后所有项目默认 `mobileApprovalMode:'deny'`；只有 Mac Unix socket CLI 可逐项目开启 `allow_once`，手机不能修改项目策略。
- 固定审批 TTL 120 秒、每 run 8 个/global 16 个 pending、完整内容 1 MiB、单块 32 KiB、最多 32 块；断线不暂停 TTL，Mac monotonic clock 是唯一超时事实源。
- allow 只返回 Mac 回调开始时的原始不可变 `updatedInput`；deny 始终 `interrupt:false`；不得返回 updatedPermissions、suggestions、永久规则或 App 修改后的输入。
- 同一 requestId 的 pending 重入共享原 Promise；completed allow 重入必须 deny 并报 `APPROVAL_DUPLICATE_AFTER_RESOLUTION`，不得再次 allow 或伪造第二个 resolved。
- 普通审批仅支持 `Bash、Write、Edit、NotebookEdit、Read、Glob、Grep、WebFetch、WebSearch`；AskUserQuestion、所有 MCP/connector 和未知工具均 fail closed。
- requested/resolved/快照/命令幂等结果/日志不得包含完整审批正文；S01 既有 tool.started/tool.output 预览不清洗，可能早于审批且包含命令、路径或参数，不得宣称内容 endpoint 是绝对保密边界。
- 内容只经既有 `127.0.0.1:8787` + Tailscale Serve 认证 HTTPS 读取，响应 `Cache-Control:no-store`；token 只在 Authorization header，不启用 Funnel，不关闭 iOS TLS 校验。
- waiting_approval 继续占 S02 执行槽；run.cancel 先同步失效 pending 再 interrupt，不清 queued run；审批拒绝/超时不自动取消 run，最终 run 状态只取 SDK result。
- App 完整加载并核对 chunkCount/byteLength/SHA-256 后才允许 allow_once；正文只存内存，退后台、resolved、revoke 或 agentInstanceId 改变时清除，不写普通磁盘、日志或崩溃上下文。
- 审批、审计、队列和 Journal 均为当前进程内存；Agent 重启不得恢复 pending、自动 allow/replay 或宣称旧 run 已有确定结果。
- 核心 TypeScript 与 Dart 业务逻辑覆盖率均不低于 80%；Mock 不替代 PERM-00、真实 SDK、Tailscale 和 iPhone E2E。
- 当前目录已是 Git 仓库（若执行时不是，先记录并与用户确认）。只有用户明确授权提交后才执行 Commit 步骤，否则标记 SKIPPED，不得自行 `git init` 或提交。

## Review Focus

1. **120 秒已到但 timeout task 尚未执行：**用户响应和内容 GET 都必须先按 monotonic deadline 结算 expired，不能因事件循环延迟继续 allow/读取；Task 5、Task 6 固定测试。
2. **后台或 resolved 后，旧分块 Future 才完成：**迟到结果不得重新写入正文缓存或重新启用允许按钮；Task 11、Task 12 固定测试。
3. **requested append 在 pending 注册后失败：**必须撤销索引、计时器和内容路由并 deny，不能留下 App 可见但无法决策的 phantom pending；Task 4 固定测试。
4. **completed allow 重入与迟到 tool_result 同时出现：**只能保留原 approved_once 历史，新回调 deny，error/resolved/tool.completed 均不得重复；Task 5、Task 7 固定测试。
5. **策略关闭或设备吊销的监听回调尚未清理完：**respond 必须重新检查当前策略和设备状态，不能仅凭仍是 pending 就 allow；Task 5、Task 8 固定测试。

## File Structure

```text
apps/agent/
  src/config/config-v3.ts                 # V2→V3 默认 deny、0600 备份与原子写入
  src/workspace/workspace-manager.ts      # 逐项目 setApprovalMode 与公开策略摘要
  src/workspace/workspace-admin.ts        # Unix socket set-approval 路由
  src/approval/approval-types.ts          # Record/Audit/Request/Result/安全摘要类型
  src/approval/permission-request.ts      # 严格 JSON 克隆、指纹、工具范围分类
  src/approval/approval-content.ts        # 完整 JSON、SHA-256 与 UTF-8 安全分块
  src/approval/approval-store.ts          # 不可变内存索引、pending 计数和终态审计
  src/approval/permission-broker.ts       # 创建、去重、原子终态、timeout 与失效
  src/approval/approval-content-controller.ts
  src/approval/run-approval-bridge.ts      # Run/Workspace/Device/Journal/Normalizer 端口
  src/adapter/agent-sdk-adapter.ts        # 唯一 SDK 权限类型边界，default 模式
  src/events/normalizer.ts                # 两种工具事件顺序与仅一次 completed
  src/run/run-scheduler.ts                # waiting_approval、pendingCount 与 deviceId
  src/run/run-controller.ts               # 先 invalidate 后 interrupt/complete/close
  src/app/agent-operations.ts             # permission.respond 与快照门面
  src/app/runtime.ts                      # policy/revoke/shutdown 完整 wiring
  src/transport/phone-server.ts           # 认证 no-store 内容 endpoint
  test/live/s03-permission-gate.test.ts   # PERM-00 真实 SDK 门禁
  test/approval-*.test.ts                 # 内容、Broker、竞争与清理
  test/integration/s03-agent-flow.test.ts # 真实 Fastify/WSS + Mock SDK 集成

apps/mobile/
  lib/protocol/s03_messages.dart          # 审批命令、事件、摘要和内容响应
  lib/domain/approval.dart                # 不可变审批与完整内容模型
  lib/domain/app_state.dart               # 按 session 的安全 pending 投影
  lib/features/approvals/approval_content_api.dart
  lib/features/approvals/approval_content_loader.dart
  lib/features/approvals/approval_command_coordinator.dart
  lib/features/approvals/approval_controller.dart
  lib/features/approvals/approval_detail_page.dart
  lib/features/approvals/widgets/         # Bash/文件/JSON/请求参数预览与隐私遮罩
  lib/features/chat/widgets/pending_approval_card.dart
  test/features/approvals/                # loader、竞争、重连、Widget 和隐私测试

protocol/v1/examples/s03/                 # Mac/Dart 共用合法与非法审批样例
docs/s03/
  preflight.md                            # S00–S02 入口和实际接口差异
  perm00-evidence.md                      # 脱敏真实 SDK 权限与事件顺序证据
  e2e-checklist.md                        # E2E-01–12 真机台账
  rollback.md                             # 全 deny、pending 失效和 V2 配置回滚
  exit-report.md                          # 覆盖率、限制和最终结论
scripts/s03/                              # gate 与 secret 检查及测试
```

---

### Task 0: S00–S02 入口与实际接口预检

**Files:**
- Create: `docs/s03/preflight.md`
- Read: `docs/s00/exit-report.md`, `docs/s01/exit-report.md`, `docs/s02/exit-report.md`, `apps/agent/src/adapter/managed-run-driver.ts`, `apps/agent/src/run/run-controller.ts`, `apps/agent/src/events/snapshot-factory.ts`

**Interfaces:**
- Consumes: S02 `ManagedRunDriver.startRun(input:ManagedRunStart):ManagedRunHandle`、`RunScheduler.beginCancel(...)`、`RunController.cancel(...)`、`SnapshotFactory.create(...)`。
- Produces: 已核对的 S02 实际接口与差异清单；Task 1–13 的明确入口。

- [ ] **Step 1: Verify all upstream gates**

Run: `npm run s00:gate && npm run verify:s01 && npm run verify:s02`  
Expected: S00 Core、S01 E2E、S02 CONC-01/E2E 全 PASS，Agent/Dart 覆盖率均 >=80%。当前缺少证据时记录 BLOCKED 并停止，不能创建产品 scaffold 或用计划文档代替结果。

- [ ] **Step 2: Record actual interface drift**

逐项核对 `ManagedRunStart` 是否含 deviceId、RunRecord 状态与 pendingCount、beginCancel 的同步边界、revoke/pair replace 回调、WorkspaceManager 配置写盘、SnapshotFactory 输入、CommandRequest/CommandIdentity 和 Normalizer 的 denied 去重。若与 S02 计划不同，先更新 `preflight.md` 和本计划接口，不得假设不存在的方法。

- [ ] **Step 3: Prepare two isolated permission fixtures**

只使用无敏感内容的临时项目；在项目内准备 Read allow、Bash deny、固定无害 Bash/Edit ask 规则和执行标记文件，记录 fixture 标签而非个人路径。冻结全局 settings.json 的哈希/只读证据，确认无需修改网关或全局配置。

- [ ] **Step 4: Commit**

```bash
git add docs/s03/preflight.md
git commit -m "docs: record S03 implementation prerequisites"
```

### Task 1: PERM-00 真实 SDK 权限门禁

**Files:**
- Create: `apps/agent/test/live/s03-permission-gate.test.ts`, `docs/s03/perm00-evidence.md`
- Modify: `package.json`

**Interfaces:**
- Consumes: 固定 Agent SDK 0.3.319、Claude Code 2.1.319 和 Task 0 fixtures；直接 SDK query 仅限 live test，不进入产品模块。
- Produces: `npm run test:s03:perm00`；default 规则、回调字段、allow/deny、signal、工具事件顺序与 settings 不变的脱敏证据。

- [ ] **Step 1: Write the live permission matrix**

覆盖：本机 allow 不进 callback 且只读成功；本机 deny 不进 callback 且命令不执行；ask Bash/Edit 进入 callback，requestId/toolUseID/signal 存在，decisionReason/defaultToNo/blockedPath/agentID/suggestions 按实际值或缺省记录。allow 返回原 input/toolUseID 后固定命令只执行一次；deny 返回 interrupt:false 后标记文件不存在，run 终态只读取 SDK result。

- [ ] **Step 2: Add lifecycle, settings and ordering probes**

在 pending callback 中调用 interrupt/close，记录 signal.aborted、deny、result 的真实顺序；逐项记录 assistant tool_use、canUseTool、permission resolved、tool_result。触发 AskUserQuestion，证明能按 toolName 识别而不是 decisionReason。比较测试前后 fixture `.claude/settings.local.json`，不存在 updatedPermissions 时不得创建或改变它。

- [ ] **Step 3: Attempt completed-request reentry without weakening the gate**

尽可能通过丢失 control_response/reinitialize 诱导同 requestId 重发；可稳定诱导时断言 completed allow 重发风险并记录，无法诱导时标 `NOT_REPRODUCED` 而不是 PASS。无论实测结果，Task 5 都必须实现 completed allow 重入 deny。

- [ ] **Step 4: Run the real gate and record sanitized evidence**

Run: `S03_LIVE=1 npm run test:s03:perm00`  
Expected: 除明确允许 `NOT_REPRODUCED` 的重入诱导外全部 PASS。AskUserQuestion 无法识别、allow/deny 行为不符、规则顺序被改变、settings 被写入或事件顺序无证据时保持 BLOCKED，停止 Task 2–13；不得改用 dontAsk、默认 allow 或 Mock。证据不保存完整输入、个人路径、环境变量或凭证。

- [ ] **Step 5: Commit**

```bash
git add apps/agent/test/live/s03-permission-gate.test.ts docs/s03/perm00-evidence.md package.json
git commit -m "test: verify real SDK permission behavior"
```

### Task 2: 配置 V3 与逐项目本机审批策略

**Files:**
- Create: `apps/agent/src/config/config-v3.ts`
- Modify: `apps/agent/src/workspace/workspace-types.ts`, `apps/agent/src/workspace/workspace-manager.ts`, `apps/agent/src/workspace/workspace-admin.ts`, `apps/agent/src/cli.ts`
- Test: `apps/agent/test/config-v3.test.ts`, `apps/agent/test/workspace-approval-policy.test.ts`

**Interfaces:**
- Produces: `MobileApprovalMode = 'deny'|'allow_once'`；`WorkspaceRecord.policy` 新增 `mobileApprovalMode`，公开 `WorkspaceSummary` 同名可见但仍无 rootPath。
- Produces: `migrateConfigV2ToV3(input:unknown):AgentConfigV3`、`writeConfigV3AtomicSync(configDir:string,config:AgentConfigV3):void`。
- Produces: `WorkspaceManager.setApprovalMode(workspaceId:string,mode:MobileApprovalMode):WorkspaceSummary`、`approvalMode(workspaceId:string):MobileApprovalMode`。
- Produces: `AdminClient.workspaceSetApproval(workspaceId,mode)`；CLI `workspace set-approval <workspaceId> --mode allow_once|deny`，只走 Unix socket。

- [ ] **Step 1: Write failing migration and local-policy tests**

```ts
it('migrates every workspace to deny and only changes the selected workspace', () => {
  const migrated = migrateConfigV2ToV3(twoWorkspaceV2)
  expect(migrated.workspaces.map(w => w.policy.mobileApprovalMode)).toEqual(['deny','deny'])
  const updated = manager.setApprovalMode('ws_a','allow_once')
  expect(updated.mobileApprovalMode).toBe('allow_once')
  expect(manager.approvalMode('ws_b')).toBe('deny')
})
```

覆盖 V2 其他 ID/queueLimit 不变、V3 非法 mode 拒绝、`agent.json.v2.bak` 0600 且已存在时不覆盖、写盘失败不替换内存、手机路由无 mutating endpoint、rename/remove 语义不变。

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm run test:agent -- test/config-v3.test.ts test/workspace-approval-policy.test.ts`  
Expected: FAIL with missing V3 config/approval policy members。

- [ ] **Step 3: Implement synchronous fail-closed policy changes**

沿用 V2 原子写入，在“校验 → writeConfigV3AtomicSync → 替换内存快照 → 同步调用 admin onApprovalModeChanged”之间不得 await。deny→allow_once 不触碰旧审批；allow_once→deny 的失效清理由 Task 8 listener 完成，模式在 listener 前已经 deny，Broker respond 还会复核当前模式。

- [ ] **Step 4: Run policy tests**

Run: `npm run test:agent -- test/config-v3.test.ts test/workspace-approval-policy.test.ts`  
Expected: PASS，CLI 不直接修改运行中内存，配置无 token/审批正文/模型密钥。

- [ ] **Step 5: Commit**

```bash
git add apps/agent/src/config apps/agent/src/workspace apps/agent/src/cli.ts apps/agent/test/config-v3.test.ts apps/agent/test/workspace-approval-policy.test.ts
git commit -m "feat: add per-workspace mobile approval policy"
```

### Task 3: 权限请求快照、指纹与完整内容分块

**Files:**
- Create: `apps/agent/src/approval/approval-types.ts`, `apps/agent/src/approval/permission-request.ts`, `apps/agent/src/approval/approval-content.ts`
- Test: `apps/agent/test/permission-request.test.ts`, `apps/agent/test/approval-content.test.ts`

**Interfaces:**
- Produces: 与 spec 7.2/7.3 结构一致的本地 `SdkPermissionRequest`、`PermissionResult`；SDK package import 仍只允许在 AgentSdkAdapter/live tests。
- Produces: `SUPPORTED_APPROVAL_TOOLS:ReadonlySet<string>` 和 `classifyPermissionTool(request):{kind:'supported'}|{kind:'unsupported';code:'APPROVAL_TOOL_UNSUPPORTED'|'UNSUPPORTED_USER_INTERACTION';message:string}`。
- Produces: `clonePermissionInput(input:Record<string,unknown>):Record<string,JsonValue>`，严格拒绝 cycle、BigInt、function、undefined、非有限 number，并递归冻结返回副本。
- Produces: `permissionRequestFingerprint(request:SdkPermissionRequest):string`，覆盖 toolName/input/toolUseID/agentID/decisionReason/defaultToNo/blockedPath/mcpServer，不含 signal/suggestions，输出 SHA-256 base64url。
- Produces: `ApprovalContent = {encoding:'json-utf8';jsonText:string;chunks:readonly string[];byteLength:number;sha256:string}`；`buildApprovalContent(input:{request:SdkPermissionRequest;workingDirectory:string}):ApprovalContent`。

- [ ] **Step 1: Write failing clone, fingerprint and unsupported-tool tests**

断言原对象后续 mutation 不影响 clone/fingerprint；对象 key 顺序不影响指纹，数组顺序变化会冲突；指纹和错误不含秘密正文。逐一覆盖固定九种工具、AskUserQuestion、`mcp__*`、存在 mcpServer 和未知工具，不使用 decisionReason 猜测类型。

- [ ] **Step 2: Write failing exact-byte content tests**

```ts
it('recombines exact JSON without splitting UTF-8 or exposing secrets in descriptors', () => {
  const content = buildApprovalContent({request:unicodeEditRequest,workingDirectory:'/fixture/项目'})
  expect(content.chunks.join('')).toBe(content.jsonText)
  expect(content.chunks.every(c => Buffer.byteLength(c,'utf8') <= 32768)).toBe(true)
  expect(sha256Base64Url(Buffer.from(content.chunks.join(''),'utf8'))).toBe(content.sha256)
})
```

覆盖 32 KiB 边界、全中文/emoji/组合字符、恰好 1 MiB、1 MiB+1、最多 32 块、非法 JSON 值；完整 JSON 包含 workingDirectory/input/context，安全 descriptor 只含 encoding/byteLength/sha256/chunkCount。

- [ ] **Step 3: Run tests to verify they fail**

Run: `npm run test:agent -- test/permission-request.test.ts test/approval-content.test.ts`  
Expected: FAIL with missing approval modules。

- [ ] **Step 4: Implement strict immutable JSON and UTF-8 chunking**

指纹使用递归 key 排序的 canonical JSON，完整内容使用固定外层结构和克隆 input；SHA-256 对完整 UTF-8 bytes 计算。按 Unicode code point 累积不超过 32 KiB 的文本块，不按 UTF-16 index 切片。超限抛 `APPROVAL_CONTENT_TOO_LARGE`，无法安全序列化抛 `APPROVAL_CONTENT_UNAVAILABLE`，错误不回显正文。

- [ ] **Step 5: Run content and request tests**

Run: `npm run test:agent -- test/permission-request.test.ts test/approval-content.test.ts`  
Expected: PASS，包括不可变输入、1 MiB 和 Unicode 边界。

- [ ] **Step 6: Commit**

```bash
git add apps/agent/src/approval apps/agent/test/permission-request.test.ts apps/agent/test/approval-content.test.ts
git commit -m "feat: add immutable approval content encoding"
```

### Task 4: ApprovalStore 与 Broker 创建、去重和容量门禁

**Files:**
- Create: `apps/agent/src/approval/approval-store.ts`, `apps/agent/src/approval/permission-broker.ts`
- Test: `apps/agent/test/approval-store.test.ts`, `apps/agent/test/permission-broker-request.test.ts`

**Interfaces:**
- Produces: spec 的 `ApprovalRecord`、`ApprovalAuditRecord`、`ResolutionReason`，以及 `RunApprovalContext = {workspaceId;sessionId;runId;deviceId;workingDirectory}`。
- Produces: `ApprovalRuntimePorts.runContext(runId):{context:RunApprovalContext;acceptingApprovals:boolean}|null`、`workspaceMode(workspaceId)`、`deviceActive(deviceId)`、`setPendingApprovalCount(runId,count)`。
- Produces: `ApprovalEventSink.requested(summary)`、`resolved(notice)`、`reportError(safeError)`、`toolDenied({sessionId,runId,toolUseID,toolName,outcome:'denied'|'cancelled'})`；所有方法同步且只接受安全字段。
- Produces: `ApprovalClock = {monotonicNow():number;wallNow():number}`、`ApprovalTimers.schedule(callback,delayMs):()=>void`。
- Produces: `PermissionBroker.request(runId:string,request:SdkPermissionRequest):Promise<PermissionResult>`，非 async 包装，pending 重入返回完全相同的 Promise。
- Produces: `ApprovalStore.getById/getByRequestKey/registerPending/removeUncommitted/pendingForRun/pendingForSession/pendingForWorkspace/pendingForDevice/pendingCount/globalPendingCount`。

- [ ] **Step 1: Write failing creation, dedupe and capacity tests**

同 runId+requestId+相同 fingerprint 两次调用只注册一条、requested 一次且 `p1 === p2`；同 toolUseID 不同 requestId 创建两个 approvalId；fingerprint 冲突 deny 且不共享 Promise。第 9 个同 run pending、全局第 17 个 pending 均 deny、无卡片并报 `APPROVAL_CAPACITY_EXCEEDED`。

- [ ] **Step 2: Write failing pre-creation and append-failure tests**

signal 已 aborted、run 不存在/cancelling、workspace deny、device revoked、unsupported 工具、无法序列化和超 1 MiB 都不得产生 pending；默认 deny 报 PERMISSION_REQUIRED，其他情况报 spec 对应安全码。让 `events.requested` 第一次抛错，断言 Promise deny、register/remove 各一次、timer 取消、内容 GET 索引不存在、pendingCount 未增加且没有 resolved。

- [ ] **Step 3: Run tests to verify they fail**

Run: `npm run test:agent -- test/approval-store.test.ts test/permission-broker-request.test.ts`  
Expected: FAIL with missing store/broker。

- [ ] **Step 4: Implement synchronous register-before-publish creation**

在同一 JavaScript 调用栈完成检查、clone/fingerprint/content、deferred/timer 创建、索引注册、requested append 和 pendingCount 更新；任何决策路径不插入 await。内容读取直接查同一 store，requested append 失败走 removeUncommitted。record/content/originalInput 全部新对象，审计和日志只保存 fingerprint/hash/安全 IDs；内部 requestKey 可用于内存去重，但日志中的 requestId 只能保存 SHA-256 摘要。

- [ ] **Step 5: Run store and creation tests**

Run: `npm run test:agent -- test/approval-store.test.ts test/permission-broker-request.test.ts`  
Expected: PASS，容量、重入、phantom pending 和无正文错误均有证据。

- [ ] **Step 6: Commit**

```bash
git add apps/agent/src/approval apps/agent/test/approval-store.test.ts apps/agent/test/permission-broker-request.test.ts
git commit -m "feat: add fail-closed approval creation"
```

### Task 5: 原子审批终态、超时、取消与失效竞争

**Files:**
- Modify: `apps/agent/src/approval/approval-store.ts`, `apps/agent/src/approval/permission-broker.ts`
- Test: `apps/agent/test/permission-broker-resolution.test.ts`, `apps/agent/test/permission-broker-invalidation.test.ts`

**Interfaces:**
- Produces: `PermissionResponseInput = {approvalId;workspaceId;sessionId;runId;deviceId;commandId;decision:'allow_once'|'deny'}`。
- Produces: `PermissionBroker.respond(input):{approvalId;status:'approved_once'|'denied';resolvedAt:number}`，同步决策；终态新 commandId 抛 APPROVAL_EXPIRED/APPROVAL_ALREADY_RESOLVED。
- Produces: `settleIfExpired(approvalId):ApprovalRecord|null`、`invalidateRun(runId,reason)`、`invalidateWorkspace(workspaceId,'policy_disabled')`、`invalidateDevice(deviceId,'device_revoked')`、`invalidateAll('agent_shutdown')`。
- Produces: `ApprovalStore.commitTerminal(...):{previous;current}|null`，仅 pending 可迁移，终态 record 的 content/originalInput/resultPromise 均为 null。
- Consumes: Task 4 ports；production monotonic 使用 `performance.now()`，展示时间使用 `Date.now()`。

- [ ] **Step 1: Write failing atomic response and deadline tests**

```ts
it('expires a response when the timer task has not run yet', () => {
  const {broker,clock} = pendingAt(0)
  clock.advanceMonotonic(120000)
  expect(() => broker.respond(allowInput())).toThrow('APPROVAL_EXPIRED')
  expect(record().status).toBe('expired')
  expect(denyResult().interrupt).toBe(false)
  expect(eventsOfType('permission.resolved')).toHaveLength(1)
})
```

覆盖 119.999 秒 allow/deny 先到唯一获胜、120 秒 expired 优先、timeout/abort/cancel 后响应不能 allow、resolvedAt/responseCommandId、关联 ID 错误、错误设备和 current policy/device 复核。wallNow 向前或向后跳变均不得延长/缩短 monotonic TTL，expiresAt 只保留创建时的展示值。

- [ ] **Step 2: Write failing duplicate-allow and invalidation cleanup tests**

completed allow 同 requestId/fingerprint 重入必须返回新 deny、报 APPROVAL_DUPLICATE_AFTER_RESOLUTION，原记录仍 approved_once、resolved 仍一条；completed deny/expired/invalidated 重入返回相同安全 deny。invalidate run/workspace/device/all 只影响目标 pending；allow 后 cancel 不改审批历史。

每个终态断言 timer/AbortListener 清理、content/originalInput/resultPromise=null、审计保留 hash 但无正文；abort/timeout/cancel 重复到达只发一次 resolved，deny message 无输入。

- [ ] **Step 3: Run tests to verify they fail**

Run: `npm run test:agent -- test/permission-broker-resolution.test.ts test/permission-broker-invalidation.test.ts`  
Expected: FAIL with missing terminal reducer/invalidation methods。

- [ ] **Step 4: Implement one synchronous terminal reducer**

所有用户、timer、signal 和生命周期入口先 settleIfExpired，再由 commitTerminal 竞争唯一 pending；先 append resolved/toolDenied，再递减 pendingCount，最后 resolve Promise。allow 在局部变量构造原 snapshot 的 updatedInput 后清除 Broker 引用；completed allow 重入绝不重放缓存 allow。respond 在提交前重新读取 run/policy/device，失效监听未完成时也不能 allow。

- [ ] **Step 5: Run terminal race tests**

Run: `npm run test:agent -- test/permission-broker-resolution.test.ts test/permission-broker-invalidation.test.ts test/permission-broker-request.test.ts`  
Expected: PASS，无 allow/deny 双结果、重复 resolved 或终态正文引用。

- [ ] **Step 6: Commit**

```bash
git add apps/agent/src/approval apps/agent/test/permission-broker-resolution.test.ts apps/agent/test/permission-broker-invalidation.test.ts
git commit -m "feat: serialize approval resolution races"
```

### Task 6: 认证完整内容 HTTPS 分块读取

**Files:**
- Create: `apps/agent/src/approval/approval-content-controller.ts`
- Modify: `apps/agent/src/transport/authenticate.ts`, `apps/agent/src/transport/phone-server.ts`
- Test: `apps/agent/test/approval-content-controller.test.ts`, `apps/agent/test/approval-content-http.test.ts`

**Interfaces:**
- Produces: `ApprovalContentController.readChunk(input:{approvalId:string;chunkIndex:number;deviceId:string}):ApprovalChunkResponse`。
- Produces: `ApprovalContentRateLimiter.consume(deviceId:string,nowMonotonic:number):boolean`，每设备滚动 60 秒最多 120 次，不读取 localhost IP。
- Produces: `GET /v1/approvals/{approvalId}/content?chunkIndex=0`，复用 Bearer DeviceStore 认证，成功和错误响应均 `Cache-Control:no-store`。
- Consumes: Task 5 `settleIfExpired` 和同一 ApprovalStore；内容 GET 不进入 commandId、Journal 或 seq。

- [ ] **Step 1: Write failing controller and real HTTP tests**

覆盖完整重组/hash、chunkIndex 非整数/负数/越界、错误设备 FORBIDDEN、未知 NOT_FOUND、已过期/其他终态不可读、revoke 后 401/403、无/错 token 401。第 120 次允许、第 121 次 RATE_LIMITED；两个 deviceId 不因为 Serve 后都是 127.0.0.1 而共享计数。

- [ ] **Step 2: Add expiry-race and side-effect-free assertions**

在 monotonic 已到 120 秒但 timer 未执行时 GET，必须先 settle expired 且不返回 text；respond allow 后、App 尚未收到 resolved 时 GET 也返回 ALREADY_RESOLVED。比较 GET 前后 Journal lastSeq、idempotency 数量和 record 不变；日志/错误不含 Authorization、workingDirectory、input 或响应正文。

- [ ] **Step 3: Run tests to verify they fail**

Run: `npm run test:agent -- test/approval-content-controller.test.ts test/approval-content-http.test.ts`  
Expected: FAIL with missing content route/controller。

- [ ] **Step 4: Implement shared bearer auth and bounded no-store reads**

将既有 upgrade Bearer 校验提取为可复用 request 认证，不改配对/WSS 语义。路由只接受整数 chunkIndex，controller 只返回当前 pending 且 deviceId 匹配的指定 chunk；使用 400/401/403/404/409/410/429 映射安全错误，Fastify 不序列化 request/response body 到访问日志。

- [ ] **Step 5: Run content transport tests**

Run: `npm run test:agent -- test/approval-content-controller.test.ts test/approval-content-http.test.ts test/phone-auth.test.ts`  
Expected: PASS，既有配对/WSS 鉴权不回归，所有内容响应 no-store。

- [ ] **Step 6: Commit**

```bash
git add apps/agent/src/approval/approval-content-controller.ts apps/agent/src/transport apps/agent/test/approval-content-controller.test.ts apps/agent/test/approval-content-http.test.ts
git commit -m "feat: serve bounded authenticated approval content"
```

### Task 7: AgentSdkAdapter 权限接线与工具事件顺序

**Files:**
- Modify: `apps/agent/src/adapter/agent-sdk-adapter.ts`, `apps/agent/src/adapter/managed-run-driver.ts`, `apps/agent/src/events/adapter-events.ts`, `apps/agent/src/events/normalizer.ts`
- Modify (migration): `apps/agent/test/agent-sdk-adapter-s02.test.ts`（注入 `permissionBroker`，把“无条件 deny”断言改为“default 策略下 deny”）
- Test: `apps/agent/test/agent-sdk-adapter-s03.test.ts`, `apps/agent/test/normalizer-s03.test.ts`

**Interfaces:**
- Produces: `ManagedRunStart.permissionBroker:PermissionBroker`；Adapter 的 canUseTool 直接 `return permissionBroker.request(runId,mappedRequest)`，不 async 包装，保留 pending Promise identity。
- Produces: 内部 `AdapterEvent.permissionDenied` 增加 `outcome:'denied'|'cancelled'`；ApprovalEventSink.toolDenied 通过 RunApprovalBridge 输入 Normalizer，Adapter 不重复发 managed denial。
- Consumes: Task 1 实际 tool_use/canUseTool/tool_result 顺序；Task 4/5 Broker 和固定工具范围。

- [ ] **Step 1: Write failing adapter option and Promise-identity tests**

注入 queryFactory，断言 permissionMode=default、原 presets/settingsSources/cwd 不变、canUseTool 两次同 pending 请求返回同一 Promise。allow 只含 behavior/updatedInput/toolUseID，deny 只含 behavior/message/interrupt:false/toolUseID；无 updatedPermissions/suggestions/setPermissionMode。

- [ ] **Step 2: Write both event-order and exactly-once completion tests**

```ts
it('handles tool.started before and after a managed denial without duplicate completion', () => {
  normalizer.consume(toolStarted('toolu_1'))
  normalizer.consume(permissionDenied('toolu_1','denied'))
  normalizer.consume(toolCompletedFromSdk('toolu_1','failed'))
  expect(eventsOfType('tool.completed')).toHaveLength(1)

  normalizer.consume(permissionDenied('toolu_2','denied'))
  expect(eventsFor('toolu_2')).toHaveLength(0)
  normalizer.consume(toolStarted('toolu_2'))
  expect(eventsOfTypeFor('tool.completed','toolu_2')).toHaveLength(1)
})
```

覆盖 approved_once 不伪造 started/output/completed、run_cancelled/sdk_aborted 映射 cancelled、completed allow 重入只补必要的一次 denied、迟到 SDK completed 不重复。

- [ ] **Step 3: Run tests to verify they fail**

Run: `npm run test:agent -- test/agent-sdk-adapter-s03.test.ts test/normalizer-s03.test.ts`  
Expected: FAIL because adapter still uses unconditional S02 deny and normalizer lacks managed outcomes。

- [ ] **Step 4: Implement the SDK-only mapping and order-neutral normalizer**

Adapter 复制 SDK 回调字段到本地结构并绑定 handle 的 runId，Broker 负责所有支持性/策略判断和安全错误。Normalizer 按 runId+toolUseID 跟踪 started/completed 和近期 denied outcome；只有真实 toolStarted 创建工具卡片，resolved 时不创建空卡片，run close 清理短期状态。旧 `agent-sdk-adapter-s02.test.ts` 必须注入 `permissionBroker` 并把“无条件 deny”断言迁移为“default 策略下 deny”，不得删除 deny 断言或放宽为允许。

- [ ] **Step 5: Run adapter and regression tests**

Run: `npm run test:agent -- test/agent-sdk-adapter-s03.test.ts test/normalizer-s03.test.ts test/normalizer.test.ts test/agent-sdk-adapter-s02.test.ts`  
Expected: PASS，S01/S02 工具截断、deny 补卡和 generation 隔离不回归。

- [ ] **Step 6: Commit**

```bash
git add apps/agent/src/adapter apps/agent/src/events apps/agent/test/agent-sdk-adapter-s03.test.ts apps/agent/test/normalizer-s03.test.ts apps/agent/test/agent-sdk-adapter-s02.test.ts
git commit -m "feat: connect SDK permissions to mobile broker"
```

### Task 8: waiting_approval 调度、取消顺序与生命周期失效

**Files:**
- Create: `apps/agent/src/approval/run-approval-bridge.ts`
- Modify: `apps/agent/src/domain/types.ts`, `apps/agent/src/run/run-scheduler.ts`, `apps/agent/src/run/run-controller.ts`, `apps/agent/src/app/runtime.ts`, `apps/agent/src/workspace/workspace-admin.ts`
- Modify (migration): `apps/agent/test/run-scheduler.test.ts`, `apps/agent/test/run-controller-s02.test.ts` 及构造 `RunRecord`/`ManagedRunStart` 的 fixture，补 `deviceId`、`pendingApprovalCount`、`permissionBroker`
- Test: `apps/agent/test/run-scheduler-s03.test.ts`, `apps/agent/test/run-controller-s03.test.ts`, `apps/agent/test/approval-lifecycle.test.ts`

**Interfaces:**
- Produces: `RunStatus` 新增 waiting_approval；`RunRecord` 新增 `deviceId:string`、`pendingApprovalCount:number`；`ManagedRunStart` 同样携带 deviceId。
- Produces: `RunScheduler.enqueue` input 新增 deviceId；`setPendingApprovalCount(runId,count):void`、`approvalContext(runId):{context;acceptingApprovals:boolean}|null`。
- Produces: `RunApprovalBridge implements ApprovalRuntimePorts,ApprovalEventSink`，组合 Scheduler、WorkspaceManager、DeviceStore、Journal 和 Normalizer。
- Modifies: `RunController.sendPrompt(...,deviceId)`；cancel 在 beginCancel 后、interrupt 前同步 `broker.invalidateRun(runId,'run_cancelled')`。

- [ ] **Step 1: Write failing slot, FIFO and cancellation-order tests**

首个 pending 使 starting/running→waiting_approval，1→2 计数准确，2→1 仍 waiting，0 后 waiting→running；waiting/cancelling 都占双槽，同 session queued 不启动，另一 session 可运行。cancel 记录严格顺序：cancelling→全部 resolved→deny Promise 已 resolve→interrupt；cancelling 中新 callback deny 无卡片。

- [ ] **Step 2: Write failing lifecycle and cleanup-listener tests**

run terminal/10 秒 close 前 remaining pending 先 resolved 再 run.completed，complete 时 pendingCount 必须为 0；approved_once 后 cancel 不改历史。set-approval deny 使目标 workspace pending invalidated 但不取消 run，enable 不复活旧审批；revoke/replace 只失效旧 deviceId，App socket disconnect 不失效，graceful shutdown 先 agent_shutdown 再 close。

模拟 policy listener 尚未调用 invalidate，respond 仍因当前 mode=deny 拒绝；deviceActive=false 同理。archive/remove waiting 仍 SESSION_BUSY/WORKSPACE_BUSY，queue.remove 不影响审批。

- [ ] **Step 3: Run tests to verify they fail**

Run: `npm run test:agent -- test/run-scheduler-s03.test.ts test/run-controller-s03.test.ts test/approval-lifecycle.test.ts`  
Expected: FAIL with missing waiting_approval/device binding/invalidation wiring。

- [ ] **Step 4: Implement synchronous run approval ports and lifecycle order**

RunRecord 状态与计数不可变更新，waiting_approval 不释放 activeRun/槽。Runtime revoke 同时关闭旧连接和 invalidateDevice；policy admin listener 仅在切到 deny 时 invalidateWorkspace；close 先 invalidateAll 再关闭 Adapter。SDK result/timeout close 路径重复 invalidateRun 作为幂等兜底，全部审批清理和 Adapter close 完成后才 scheduler.complete。同步迁移 S02 的 `run-scheduler.test.ts`、`run-controller-s02.test.ts` 及构造 `RunRecord`/`ManagedRunStart` 的 fixture，补 `deviceId`、`pendingApprovalCount`、`permissionBroker`；不得为绕过迁移把这些字段改成可选。

- [ ] **Step 5: Run run and lifecycle regressions**

Run: `npm run test:agent -- test/run-scheduler-s03.test.ts test/run-controller-s03.test.ts test/approval-lifecycle.test.ts test/run-scheduler.test.ts test/run-controller-s02.test.ts`  
Expected: PASS，FIFO、双槽、queue.remove、10 秒取消和独立 interrupt 不回归。

- [ ] **Step 6: Commit**

```bash
git add apps/agent/src/approval/run-approval-bridge.ts apps/agent/src/domain/types.ts apps/agent/src/run apps/agent/src/app/runtime.ts apps/agent/src/workspace/workspace-admin.ts apps/agent/test/run-scheduler-s03.test.ts apps/agent/test/run-controller-s03.test.ts apps/agent/test/approval-lifecycle.test.ts apps/agent/test/run-scheduler.test.ts apps/agent/test/run-controller-s02.test.ts
git commit -m "feat: integrate approvals with managed run lifecycle"
```

### Task 9: 协议 V1、命令幂等、快照与 Mac 完整 wiring

**Files:**
- Modify: `protocol/v1/commands.schema.json`, `protocol/v1/events.schema.json`, `protocol/v1/README.md`
- Create: `protocol/v1/examples/s03/permission-requested.json`, `permission-resolved.json`, `permission-respond.json`, `approval-content.json`, `session-snapshot.json`, `duplicate-after-resolution.json`, `unsupported-interaction.json`
- Modify: `apps/agent/src/command/router.ts`, `apps/agent/src/command/canonical-request.ts`, `apps/agent/src/events/snapshot-factory.ts`, `apps/agent/src/app/agent-operations.ts`, `apps/agent/src/app/wire.ts`, `apps/agent/src/app/runtime.ts`
- Test: `apps/agent/test/protocol-s03.test.ts`, `apps/agent/test/integration/s03-agent-flow.test.ts`, `apps/agent/test/integration/s03-restart.test.ts`, `apps/agent/test/snapshot-s03.test.ts`

**Interfaces:**
- Produces: `CommandIdentity`/CommandRequest 信封新增可选 approvalId；`permission.respond` payload 仅 `{decision:'allow_once'|'deny'}`，所有目标 IDs 和认证 deviceId 同时校验。
- Produces: `AgentOperations.respondPermission(input:PermissionResponseInput)`、`pendingApprovals(sessionId):ApprovalSummary[]`。
- Produces: SessionSummary/activeRun/session.status 的 pendingApprovalCount 和 waiting_approval；session.snapshot.pendingApprovals；workspace.list SchedulerSummary.pendingApprovalCount（全局 pending 数）。
- Consumes: Task 6 content route、Task 8 RunApprovalBridge；所有命令仍经 schema/idempotency，所有时间线仍经 Journal。

- [ ] **Step 1: Write failing shared-schema and command tests**

Mac 校验全部 S03 合法/非法样例；payload 带 input/updatedInput/updatedPermissions/content hash 均 INVALID_MESSAGE。覆盖同 commandId 重试返回首次 result 且不二次决策、同 ID 改 decision/run/approval 冲突、新 commandId 终态 ALREADY/EXPIRED、错关联 MISMATCH、错设备 FORBIDDEN。

- [ ] **Step 2: Write failing transport, snapshot and privacy integration tests**

requested 发出后立即 GET 内容成功；两 session pending/response 不串线；WSS 断开 TTL 继续，重连快照只含最新 pending 安全摘要；八 pending+大事件仍 payload<=48 KiB、总消息<=64 KiB 且不删除 pending。requested/resolved/snapshot/idempotency/log 均不含 secret input，S01 tool.started 预览断言保留。

Agent 新实例无旧 pending、不自动 replay；revoke/policy disable 后旧响应无效。只迁移 S02 明确新增的 waiting_approval 断言，配对/TLS/FIFO/取消等旧安全测试不得放宽。

- [ ] **Step 3: Run tests to verify they fail**

Run: `npm run test:agent -- test/protocol-s03.test.ts test/integration/s03-agent-flow.test.ts test/integration/s03-restart.test.ts test/snapshot-s03.test.ts`  
Expected: FAIL with missing S03 protocol/runtime operations。

- [ ] **Step 4: Implement additive protocol and single runtime path**

SnapshotFactory 先为最多八条 pending 摘要和 scheduler 计数预留预算，再选择 recentEvents；内容永不经快照。Router 从认证 DeviceRecord 为 prompt.send 和 permission.respond 填 deviceId，Operations 不信任 App sourceDeviceId 与认证不一致的请求。Runtime 只保留一个 Broker/Adapter/RunController 执行路径，graceful close/revoke/policy 使用 Task 8 wiring。

- [ ] **Step 5: Run complete Mac verification**

Run: `npm run test:agent && npm run coverage:agent`  
Expected: PASS，核心 statements/branches/functions/lines >=80%，S00–S02 回归不失败。

- [ ] **Step 6: Commit**

```bash
git add apps/agent protocol/v1
git commit -m "feat: wire mobile approval protocol and snapshots"
```

### Task 10: Flutter 审批协议与按 session 的不可变 reducer

**Files:**
- Create: `apps/mobile/lib/protocol/s03_messages.dart`, `apps/mobile/lib/domain/approval.dart`
- Modify: `apps/mobile/lib/protocol/decoder.dart`, `apps/mobile/lib/domain/app_state.dart`, `apps/mobile/lib/domain/run.dart`, `apps/mobile/lib/domain/session_state.dart`
- Test: `apps/mobile/test/protocol/s03_decoder_test.dart`, `apps/mobile/test/domain/approval_state_test.dart`

**Interfaces:**
- Produces: Dart `ApprovalSummary`、`ApprovalContentDescriptor`、`PermissionResolution`、`ApprovalContentChunk`、`ApprovalStatus`、`ResolutionReason`；RunStatus 增加 waitingApproval。
- Produces: `AppState` 新增不可变 `pendingApprovalsById`、`approvalIdsBySessionId`；Session/Scheduler summary 增加 pendingApprovalCount。
- Produces: `AppState applyApprovalEvent(AppState previous,ProtocolMessage event)`；`applySessionSnapshot` 只替换目标 session 的 pending，不清其他 session。

- [ ] **Step 1: Write failing shared-example and cross-session tests**

```dart
test('approval routes remain isolated and snapshots replace only their target', () {
  var state = AppState.initial();
  state = applyApprovalEvent(state, requested(sessionId: 'a', approvalId: 'p1'));
  state = applyApprovalEvent(state, requested(sessionId: 'b', approvalId: 'p2'));
  state = applyApprovalEvent(state, resolved(approvalId: 'p1'));
  expect(state.pendingApprovalsById.keys, ['p2']);
  expect(state.pendingApprovalsById['p1'], isNull);
  expect(state.approvalIdsBySessionId['a'], isEmpty);
  expect(state.approvalIdsBySessionId['b'], ['p2']);
});
```

覆盖所有共享样例、eventId 去重/冲突、同 approvalId 跨 session 冲突、双 session pending、waiting count、unknown/MCP error 只形成不可批准安全卡片、resolved 清正文触发通知但不把正文放入 AppState。旧 App/decoder 遇到无法识别的 permission 事件必须抛 ProtocolConflictException 并进入不可发送的同步错误状态，不能忽略事件后继续需要审批的 run。

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd apps/mobile && flutter test test/protocol/s03_decoder_test.dart test/domain/approval_state_test.dart`  
Expected: FAIL with missing S03 models/reducers。

- [ ] **Step 3: Implement safe-summary-only immutable projections**

requested/resolved/snapshot 模型不包含 input/workingDirectory/context；terminal 摘要只保留在时间线的安全状态，pending map 移除可决策项。waiting_approval 下 Composer 仍按 S02 排队，cancel 可用；未知工具不生成 approvalId 或可允许操作，未知审批协议事件 fail closed。

- [ ] **Step 4: Run protocol and domain tests**

Run: `cd apps/mobile && flutter test test/protocol test/domain`  
Expected: PASS，与 Mac 对共享样例结论一致。

- [ ] **Step 5: Commit**

```bash
git add apps/mobile/lib/protocol apps/mobile/lib/domain apps/mobile/test/protocol apps/mobile/test/domain
git commit -m "feat: add Flutter approval state projections"
```

### Task 11: Flutter 内容校验、固定命令重试与后台/重连清理

**Files:**
- Create: `apps/mobile/lib/features/approvals/approval_content_api.dart`, `approval_content_loader.dart`, `approval_command_coordinator.dart`, `approval_controller.dart`
- Modify: `apps/mobile/lib/connection/command_client.dart`, `apps/mobile/lib/connection/connection_controller.dart`, `apps/mobile/pubspec.yaml`, `apps/mobile/pubspec.lock`
- Test: `apps/mobile/test/features/approvals/approval_content_loader_test.dart`, `approval_command_coordinator_test.dart`, `approval_lifecycle_test.dart`

**Interfaces:**
- Produces: `ApprovalContentApi.getChunk(ApprovalSummary summary,int chunkIndex):Future<ApprovalContentChunk>`，从既有 CredentialStore 生成 Bearer header，不记录 token。
- Produces: `ApprovalContentLoader.load(ApprovalSummary):Future<VerifiedApprovalContent>`，顺序加载并验证 descriptor、chunkCount/byteLength/SHA-256/JSON；失败抛本地 `ContentIntegrityException`。
- Produces: 仅内存 `approvalContentCache` 和 `approvalActionStateById`，状态为 loadingContent/ready/submitting/resolved/error；提供 `clear(approvalId)`、`clearAll()`。
- Produces: `ApprovalCommandCoordinator.allowOnce(ApprovalSummary)`、`deny(ApprovalSummary)`、`retry(approvalId)`、`resolved(approvalId,resolution)`；点击时捕获全部 IDs，重试复用同一 CommandRequest/commandId。
- Modifies: `CommandRequest<T>` 新增 `String? approvalId`；ConnectionController 在 ready/snapshot/lifecycle 中调用 approval controller。

- [ ] **Step 1: Pin the verified SHA dependency**

在 pubspec 固定 `crypto: 3.0.8`，运行 `cd apps/mobile && flutter pub get`。Expected: lockfile 解析为 3.0.8，不新增 Diff、持久化或审批相关包。

- [ ] **Step 2: Write failing loader tests**

测试全中文/emoji、多 chunk、32 KiB 边界、chunkCount/byteLength/hash 不一致、chunk 顺序、非法 JSON、请求中途 resolved/错误设备；任何失败均为 CONTENT_INTEGRITY_ERROR，缓存不进入 ready，deny 仍可用。

- [ ] **Step 3: Write failing command and lifecycle-race tests**

allow 只有在线且当前 summary.sha256 已 verified 才发送；deny 无需内容；submitting 禁重复点击，切换 session 不改目标，超时 retry 的 commandId 完全相同。defaultToNo 的额外确认由 Task 12 UI 验证，coordinator 不自动确认。

```dart
test('late content cannot repopulate cache after background or resolution', () async {
  final pendingLoad = controller.loadContent(summary);
  controller.onLifecycle(AppLifecycleState.paused);
  completeChunksAfterClear();
  await pendingLoad;
  expect(controller.approvalContentCache[summary.approvalId], isNull);
  expect(controller.canAllow(summary.approvalId), isFalse);
});
```

覆盖断线禁止新响应、恢复先 snapshot 再决定 retry、resolved 清正文/请求、APPROVAL_DUPLICATE_AFTER_RESOLUTION 不自动重试、agentInstanceId 改变清所有正文和自动重试并标“旧审批失效/执行结果未知”、revoke 沿用凭证清理。上述迟到 content 竞争分别覆盖 background 和 resolved 两种清理原因。

- [ ] **Step 4: Run tests to verify they fail**

Run: `cd apps/mobile && flutter test test/features/approvals`  
Expected: FAIL with missing loader/coordinator/lifecycle implementation。

- [ ] **Step 5: Implement generation-guarded memory-only loading and commands**

每块检查 encoding/json-utf8、approvalId 和 descriptor 一致，拼接后 UTF-8 encode，再用 `sha256.convert` 校验 base64url hash；只保留已验证 JSON，不写 Keychain/UserDefaults/文件。cache generation 在 clear/resolved/restart/background 时递增，旧 Future 完成后先核对 generation，不能重新缓存。inactive/hidden/paused 显示遮罩并清正文，回前台仅对仍 pending 的摘要重新加载。

- [ ] **Step 6: Run approval and connection tests**

Run: `cd apps/mobile && flutter test test/features/approvals test/connection`  
Expected: PASS，无新 commandId 重试、跨 session 改目标、后台正文复活或重启自动响应。

- [ ] **Step 7: Commit**

```bash
git add apps/mobile/lib/features/approvals apps/mobile/lib/connection apps/mobile/pubspec.yaml apps/mobile/pubspec.lock apps/mobile/test/features/approvals
git commit -m "feat: verify approval content and preserve response identity"
```

### Task 12: iPhone 审批卡片、详情页与请求参数预览

**Files:**
- Create: `apps/mobile/lib/features/approvals/approval_detail_page.dart`
- Create: `apps/mobile/lib/features/approvals/widgets/bash_approval_view.dart`, `file_change_approval_view.dart`, `json_approval_view.dart`, `request_change_preview.dart`, `approval_privacy_mask.dart`
- Create: `apps/mobile/lib/features/chat/widgets/pending_approval_card.dart`
- Modify: `apps/mobile/lib/features/chat/chat_page.dart`, `apps/mobile/lib/features/sessions/session_page.dart`, `apps/mobile/lib/features/workspaces/workspace_page.dart`, `apps/mobile/lib/main.dart`
- Test: `apps/mobile/test/features/approvals/approval_detail_page_test.dart`, `approval_privacy_test.dart`, `apps/mobile/test/features/chat/pending_approval_card_test.dart`

**Interfaces:**
- Consumes: Task 10 safe summaries、Task 11 controller/loader/coordinator。
- Produces: `PendingApprovalCard`、`ApprovalDetailPage`、`RequestChangePreview` 和 session/workspace 等待 badge；打开详情不改变 selectedSessionId，不取消其他 run。

- [ ] **Step 1: Write failing content-gating and rendering tests**

初始自动加载；loading/chunk mismatch/hash error/resolved/offline 时 allow 禁用，deny 在在线时可用。完整加载后显示工作目录、decisionReason/blockedPath（如有）；Bash 显示完整 command/description/timeout，Write 显示 file_path/content，Edit 显示 file_path/old/new，其他支持工具显示完整 JSON；测试 fixture 的完整秘密只出现在详情展示，不出现在 debugPrint、普通 storage 或 requested 卡片。

- [ ] **Step 2: Write failing interaction, preview and privacy Widget tests**

Edit/Write 预览固定显示“由请求参数生成，不是实际文件 Diff 或执行结果”；defaultToNo=true 显示显著警告，首次点击只出现额外确认，未预勾允许。断线时本地倒计时只显示“可能已过期，重连确认”，不得本地伪造 resolved。点击后 submitting 禁双按钮，切换 session 不改目标，resolved/APPROVAL_DUPLICATE_AFTER_RESOLUTION 不把 approved_once 改成 denied。

后台立即显示 privacy mask 并清空正文，迟到的 loader Future 完成时按钮仍禁用；回前台按当前 pending 重新加载。断言无双击批量、“以后都允许”、输入编辑、AskUserQuestion/MCP 可批准 UI。

- [ ] **Step 3: Run tests to verify they fail**

Run: `cd apps/mobile && flutter test test/features/approvals test/features/chat/pending_approval_card_test.dart`  
Expected: FAIL with missing approval pages/widgets。

- [ ] **Step 4: Implement detail views without a real-Diff claim**

使用只读 SelectableText/JSON 视图展示完整字段；Edit 以 old/new 行列表、Write 以 proposed content 行列表生成请求预览，不读取 Mac 文件、不声称实际 Diff。所有 allow/deny 经 Task 11 coordinator，页面不自行生成 commandId 或缓存正文；系统日志和 Widget 测试仅使用合成 fixture。

- [ ] **Step 5: Run all Flutter tests and coverage**

Run: `cd apps/mobile && flutter test --coverage`  
Expected: PASS，核心 Dart 业务逻辑覆盖率 >=80%，S01/S02 配对、聊天、队列和重连回归不失败。

- [ ] **Step 6: Commit**

```bash
git add apps/mobile
git commit -m "feat: add iPhone permission approval experience"
```

### Task 13: 真实 SDK、iPhone E2E、覆盖率与退出门禁

**Files:**
- Create: `apps/agent/test/live/s03-real-sdk.test.ts`
- Create: `scripts/s03/verify-gate.ts`, `scripts/s03/verify-gate.test.ts`, `scripts/s03/check-secrets.ts`, `scripts/s03/check-secrets.test.ts`
- Create: `docs/s03/e2e-checklist.md`, `docs/s03/rollback.md`, `docs/s03/exit-report.md`
- Modify: `package.json`

**Interfaces:**
- Produces: `npm run test:s03`、`npm run test:s03:live`、`npm run verify:s03`。
- Produces: PERM-00、CONC-01 和 E2E-01–12 的 PASS/FAIL/BLOCKED 真实台账；Mock 不得替代真机或真实 SDK。

- [ ] **Step 1: Write failing live regression and gate/checker tests**

真实 Adapter/Broker 覆盖 allow once 固定无害命令只执行一次、第二次相同命令重新审批、deny/expire 不执行、waiting_approval 双 run 独立响应、无 settings.local.json 变化。Gate 测试缺 PERM-00/CONC-01、任一 E2E、真实设备标记、覆盖率、回滚步骤或包含 secret/Funnel 时必须失败。

```ts
it('rejects mock-only or incomplete approval evidence', () => {
  expect(() => verifyGate(fakeReport({perm00:'PASS',sdk:'MOCK',e2e:'PASS'}))).toThrow('real SDK')
  expect(() => verifyGate(fakeReport({e2e:{'E2E-08':'BLOCKED'}}))).toThrow('E2E-08')
  expect(() => checkSecrets('workingDirectory=/private/root command=secret token=abc')).toThrow()
})
```

- [ ] **Step 2: Run the real SDK suite before device acceptance**

Run: `S03_LIVE=1 npm run test:s03:live`  
Expected: 全部可执行且结果真实，PERM-00/CONC-01 仍 PASS；缺网关、fixture 或真实能力时标 BLOCKED 并停止，不能改 marker、放宽断言、默认放行工具或把 Mock 写成 live。

- [ ] **Step 3: Execute E2E-01–12 on the physical iPhone**

按 spec 顺序记录时间、版本、traceId 和结果：V2 升级全 deny/只开 A；完整查看并无害 Bash allow once；相同 Bash 再审批；deny 给模型且不执行；Edit 完整 old/new 和非真实 Diff 标记；实际等待 120 秒 expired；过期前后断网恢复；pending cancel；双 session pending；重复/冲突/错 run 响应；set-approval deny/revoke；强杀重启不 allow/replay。

每项必须核对工具副作用次数和 settings.local.json，不只看卡片或 toast。E2E-08 必须确认迟到响应不能执行，queued run 仍按 S02 处理；E2E-12 必须显示“旧审批失效/执行结果未知”。

- [ ] **Step 4: Verify rollback prerequisites in an isolated configDir**

先把全部 workspace set-approval deny，确认 pending 全 invalidated，再停止或等待活跃 run；按 S02 清空 queued 后才使用 V2 backup 演练回滚。断言旧 approvalId 不可读/响应、V3 项目不静默变 allow_once、回滚后无 callback 永久等待；只记录内存审批不可恢复，不宣称旧 run 已成功。

- [ ] **Step 5: Run full verification and security scans**

Run: `npm run test:s03 && npm run coverage:agent && cd apps/mobile && flutter test --coverage && cd ../.. && S03_LIVE=1 npm run test:s03:live && npm run verify:s03`  
Expected: 全部 PASS，Agent/Dart 覆盖率 >=80%，E2E-01–12 全 PASS；无完整审批正文/token/密钥进入 requested/resolved/快照/幂等表/日志/App 普通磁盘，无 Funnel，无全局 settings 修改。

- [ ] **Step 6: Write the exit report**

记录真实结果和限制：1 MiB 内容上限、无真实 Diff 保证、不支持 AskUserQuestion/MCP/未知工具、无持久审批/afterSeq/推送、S01 工具预览可能早于审批且含路径；任何 FAIL/BLOCKED 都停止 S03 验收，不进入 S04。

- [ ] **Step 7: Commit**

```bash
git add apps scripts/s03 docs/s03 protocol/v1 package.json
git commit -m "test: verify S03 mobile approvals on Mac and iPhone"
```
