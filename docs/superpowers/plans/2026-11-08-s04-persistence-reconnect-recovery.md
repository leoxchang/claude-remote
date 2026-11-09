# S04 持久化与断线恢复 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 S01–S03 的内存执行状态迁移为可重启恢复的 SQLite 权威状态，并在 iPhone 上交付不重复执行的持久命令、afterSeq 补同步、分页快照和显式队列恢复。

**Architecture:** Mac 以单实例、单 writer、BEGIN IMMEDIATE 事务串起命令、业务投影和事件，启动时先迁移/修复再开放服务；内存只保留 SDK handle、审批正文和发送队列。Flutter 以受 iOS Data Protection 保护的 RecoveryStore 保存未确认 mutating command、连续 seq、近期缓存和草稿，Agent 实例变化后必须人工确认重试，旧 queued 只能显式 requeue。

**Tech Stack:** Node.js 24.15.0、TypeScript 7.0.2、Agent SDK 0.3.319、Claude Code 2.1.319、Fastify 5.12.8、Vitest 5.1.0、`better-sqlite3 13.0.3`、`@types/better-sqlite3 9.6.0`、`proper-lockfile 4.1.2`、`@types/proper-lockfile 4.1.4`；Flutter 3.47.9、Dart 3.13.7、Riverpod 3.5.0、http 1.6.0、crypto 3.0.8、`sqflite 2.4.5`、`sqflite_common_ffi 2.4.5`、`path_provider 2.1.6`、`path 1.9.1`。

**Spec:** `docs/superpowers/specs/2026-11-08-s04-persistence-reconnect-recovery-design.md`

## Global Constraints

- **当前入口为 BLOCKED：**Task 0 未确认 S00 Core、S01、S02、S03 完整 PASS 前，不得执行 Task 1–18；Task 1 的 STORE-00 未以真实 Mac SQLite 和 iPhone 通过前，不得执行 Task 2–18。
- 当前只有 spec-to-spec 文档基线；Task 0 必须核对届时真实代码和 V3/devices 文件，不假设今天已有 S00–S03 实现，也不增加现网灰度工作流。
- 固定 `better-sqlite3 13.0.3`、`sqflite 2.4.5`；Mac DB/WAL/SHM/备份 0600、目录 0700，WAL、foreign_keys=ON、synchronous=FULL、busy_timeout=5000、wal_autocheckpoint=1000。
- 单进程单 writer；第二个实例返回 AGENT_ALREADY_RUNNING。迁移、integrity check 和启动修复完成前，不开放端口、不加载 Scheduler、不创建 query。
- mutating command 的业务状态、首批事件和首次 result 同事务提交；prompt.send 首次结果固定 queued。事件先 DB 后发送，Mac 不建立第二套持久 Outbox。
- mutating command 结果/指纹永不自动删除；read-only resultJson 7 天后转为永久 resultExpired 墓碑并返回 COMMAND_RESULT_EXPIRED。
- 旧 starting/running/waiting_approval/cancelling → interrupted+outcomeUnknown；旧 queued → recovery_required；旧 pending → invalidated/agent_shutdown；不自动重放、不自动 allow。
- recovery_required 不占槽、不阻塞 FIFO，但阻止 archive/remove；run.requeue 必须验 generation、重新校验路径/容量并排当前队尾，interrupted 不得 requeue。
- App 必须先持久化 mutating command 再发送；agentInstanceId 改变后停止自动重试并进入 confirmation_required，同 session 最多一个未确认 prompt.send/run.requeue。
- afterSeq 以 sessionId+seq 连续推进；缺口或超过 1,000 条返回 RESYNC_REQUIRED。同步页最多 100 条/48 KiB，快照最多 8 页，每页总消息 64 KiB/payload 48 KiB。
- 固定保留：events 30 天且每 session 最近 5,000 条；prompt 30 天且 requeue 不延长；审批/审计 90 天；只读结果 7 天；快照最新 2 份/30 天；Mac 512 MiB→448 MiB，App 20 MiB/200 events/10 sessions。
- 审批 originalInput/content/resultPromise 永不入库；run prompt 正文只存 `runs.promptText`，只经认证 no-store endpoint 读取，不得进入日志/快照/列表/错误；token 只在 iPhone Keychain，Mac 只存 SHA-256，不保存模型/ASR 密钥。
- Mac 仅依赖 0600/FileVault，App 仅依赖 sandbox/NSFileProtectionComplete，不宣称 SQLCipher、额外加密或安全擦除；不开启 Funnel、不关闭 TLS、不修改全局 settings.json、不启用 bypassPermissions。
- 核心 TypeScript 与 Dart 业务逻辑覆盖率均不低于 80%；Mock 不替代真实 SQLite 故障、固定 SDK resume、Tailscale 和 iPhone E2E。
- 当前目录已是 Git 仓库（若执行时不是，先记录并与用户确认）。只有用户明确授权提交后才执行 Commit 步骤，否则标记 SKIPPED，不得自行 `git init` 或提交。

## Review Focus

1. **queued prompt 在清理后与 driver.start 前到期：**启动事务必须再次检查 promptExpiresAt/promptText，到期原子取消且绝不创建 query；Task 7、Task 13 固定测试。
2. **beginStart 已提交、SDK query/handle/run.started 尚未完成时崩溃：**数据库不能仍是 queued 而允许恢复重放，必须 interrupted+outcomeUnknown；Task 7、Task 9 固定测试。
3. **持久 requested 已提交并准备发布，但完整审批正文仍在内存注册：**发布前必须能读取同一 approval 的内容，DB 写失败则立即 deny 且无 phantom pending；Task 8 固定测试。
4. **最后一页快照与 live seq>L 竞争，或旧快照迟到：**App 收齐/hash 后一次性应用，live 事件重放，旧 lastSeq 不覆盖新状态；Task 12、Task 16 固定测试。
5. **confirmation_required 前已有 retry timer，同 session 又点击 requeue：**旧 timer 不得发送，新执行意图必须被持久唯一门控阻止；Task 15 固定测试。

## File Structure

```text
apps/agent/
  src/storage/database.ts                  # SQLite 打开、PRAGMA、backup、liveBytes、close
  src/storage/instance-lock.ts             # 单实例锁、PID/stale 检查
  src/storage/unit-of-work.ts              # read/immediate 同步事务，无异步回调
  src/storage/migrations/001_initial.sql   # S04 全部表、唯一约束和索引
  src/storage/config-v4-migration.ts       # V3/devices 两阶段导入与 V4 完成
  src/storage/repositories/                # devices/workspaces/sessions/runs/commands/approvals/snapshots
  src/storage/persistent-command-executor.ts
  src/storage/startup-recovery.ts          # 单事务启动修复
  src/storage/retention-service.ts         # 保留、容量和 queued 到期
  src/events/durable-event-journal.ts      # commit 后 publish、seq/retentionFloor
  src/run/prompt-admission.ts              # 持久 queued 接受，不启动 SDK
  src/run/run-scheduler.ts                 # DB 投影 + 内存 handle，beginStart 先于 driver
  src/approval/approval-store.ts           # DB 安全记录 + volatile 正文索引
  src/run/recovery-service.ts              # requeue/discard/prompt 读取
  src/sync/session-sync-service.ts         # afterSeq 一致读与同步页
  src/sync/snapshot-service.ts             # 不可变分页快照
  src/app/runtime.ts                       # 先迁移修复后服务的唯一 wiring
  test/live/s04-store-gate.test.ts         # STORE-00 Mac 部分
  test/storage/                            # 真 SQLite、迁移、事务、故障注入
  test/integration/s04-agent-flow.test.ts  # 真实 Fastify/WSS + Mock SDK

apps/mobile/
  lib/recovery/recovery_database.dart      # sqflite 打开、迁移、Application Support
  lib/recovery/recovery_store.dart         # outbox/cursor/cache/draft 门面
  lib/recovery/outbox_repository.dart      # 持久执行意图唯一门控
  lib/recovery/cache_repository.dart       # 有界事件/摘要/草稿
  lib/connection/persistent_command_coordinator.dart
  lib/connection/session_sync_coordinator.dart
  lib/protocol/s04_messages.dart           # sync/snapshot/recovery 模型
  lib/domain/sync_state.dart               # 连续 seq、乱序缓冲和快照装配
  lib/features/recovery/                   # 未确认命令、prompt 查看、requeue/discard UI
  ios/Runner/S04StoreProtection.swift      # DB/WAL/SHM Data Protection 设置与验证
  integration_test/s04_store_gate_test.dart
  test/recovery/                           # FFI、outbox、sync、Widget 测试

protocol/v1/examples/s04/                  # Mac/Dart 共用合法与非法样例
docs/s04/
  preflight.md / store00-evidence.md
  e2e-checklist.md / rollback.md / exit-report.md
scripts/s04/                               # gate、故障注入证据和 secret 检查
```

---

### Task 0: S00–S03 入口与实际接口预检

**Files:**
- Create: `docs/s04/preflight.md`
- Read: `docs/s00/exit-report.md`, `docs/s01/exit-report.md`, `docs/s02/exit-report.md`, `docs/s03/exit-report.md`, `apps/agent/src/command/idempotency.ts`, `apps/agent/src/events/journal.ts`, `apps/agent/src/run/run-scheduler.ts`, `apps/agent/src/approval/permission-broker.ts`

**Interfaces:**
- Consumes: S03 实际 `CommandIdentity`、`DurableEventJournal` 前身、RunScheduler、PermissionBroker、WorkspaceManager/DeviceStore。
- Produces: 真实接口/配置格式差异表和 Task 1–18 的明确入口。

- [ ] **Step 1: Verify all upstream gates**

Run: `npm run s00:gate && npm run verify:s01 && npm run verify:s02 && npm run verify:s03`  
Expected: 全部 PASS，CONC-01、PERM-00、E2E 和覆盖率证据完整。当前缺少证据时记录 BLOCKED 并停止，不能创建产品迁移。

- [ ] **Step 2: Record interface and config drift**

核对真实 command 指纹、prompt.send 首次结果、Journal append/publish 顺序、beginStart/beginCancel、ApprovalStore/content 注册、V3 JSON/devices 字段和 Flutter CommandClient/ConnectionController。若与本计划不同，先更新 `preflight.md` 和对应接口，不得让实现者猜测。

- [ ] **Step 3: Prepare isolated crash fixtures**

创建两个无敏感 fixture、V3/devices 合成副本和临时 configDir；准备固定无害命令 marker、可控长文本/等待工具、独立 DB/WAL 路径。记录版本与脱敏标签，不复制真实项目、路径、环境变量或凭证。

- [ ] **Step 4: Commit**

```bash
git add docs/s04/preflight.md
git commit -m "docs: record S04 implementation prerequisites"
```

### Task 1: STORE-00 真实 SQLite 与 iPhone 存储门禁

**Files:**
- Create: `apps/agent/test/live/s04-store-gate.test.ts`, `apps/mobile/integration_test/s04_store_gate_test.dart`, `apps/mobile/ios/Runner/S04StoreProtection.swift`, `docs/s04/store00-evidence.md`
- Modify: `package.json`, `package-lock.json`, `apps/mobile/pubspec.yaml`, `apps/mobile/pubspec.lock`, `apps/mobile/ios/Runner/AppDelegate.swift`

**Interfaces:**
- Produces: `npm run test:s04:store00` 和真机 integration test；真实依赖、事务回滚、WAL backup、Data Protection 的 PASS/BLOCKED 证据。
- Produces: Swift `S04StoreProtection.setAndVerify(databasePath):Future<ProtectionReport>` 的最小测试通道，Task 14 复用。

- [ ] **Step 1: Pin the verified storage dependencies**

安装本计划 Tech Stack 中 Mac/Flutter 依赖，运行 `npm install` 与 `cd apps/mobile && flutter pub get`。Expected: 精确版本进入 lockfile，Node 24 可加载 better-sqlite3，未新增 ORM、SQLCipher 或另一套数据库。

- [ ] **Step 2: Write the real Mac storage gate**

用独立 child process 在 BEGIN IMMEDIATE 内分别模拟退出/提交，断言未提交 command/run/event 全回滚、已提交三者重开存在；检查 WAL/FULL/foreign keys、文件权限和 `.immediate()`。在 WAL 有未 checkpoint 内容时 `db.backup()`，对备份 integrity_check 并验证新行存在，禁止普通文件复制充当证据。

- [ ] **Step 3: Write the physical-iPhone storage gate**

在 Application Support 创建 sqflite 测试 DB，执行 v1→v2 测试迁移和重开；Swift 对 DB/WAL/SHM 设置并读取 NSFileProtectionComplete。锁屏后访问应失败并返回安全错误，解锁后可重开；不能因失败改 UntilFirstUserAuthentication。

- [ ] **Step 4: Run both gates and record sanitized evidence**

Run: `S04_LIVE=1 npm run test:s04:store00`  
Run: `cd apps/mobile && flutter test integration_test/s04_store_gate_test.dart -d <physical-iphone-id>`  
Expected: Mac/iPhone 全部 PASS；缺设备、原生模块、签名或 Data Protection 时保持 BLOCKED，停止 Task 2–18。证据不含合成正文以外的数据或个人路径。

- [ ] **Step 5: Commit**

```bash
git add package.json package-lock.json apps/agent/test/live/s04-store-gate.test.ts apps/mobile docs/s04/store00-evidence.md
git commit -m "test: verify real S04 storage prerequisites"
```

### Task 2: SQLite 打开、单实例锁、schema 与备份基础

**Files:**
- Create: `apps/agent/src/storage/database.ts`, `instance-lock.ts`, `unit-of-work.ts`, `migrations/001_initial.sql`
- Test: `apps/agent/test/storage/database.test.ts`, `instance-lock.test.ts`, `schema.test.ts`

**Interfaces:**
- Produces: `AgentDatabase.open(path:string):AgentDatabase`、`backup(destination:string):Promise<void>`、`liveBytes():number`、`close():void`。
- Produces: `UnitOfWork.read<T>((tx)=>T):T`、`immediate<T>((tx)=>T):T`；回调返回非 Promise，嵌套写事务直接抛 STORAGE_TRANSACTION_NESTED。
- Produces: `InstanceLock.acquire(input:{lockPath,desktopId,databasePath,pid}):InstanceLockHandle`、`release():void`。
- Produces: spec 7.2 全部表、外键和唯一索引；schemaVersion=1。

- [ ] **Step 1: Write failing PRAGMA, schema and permission tests**

断言所有表/索引存在，events(sessionId,seq)、eventId、commandId、approvalId、requestKey、snapshotId+pageIndex、非 null claudeSessionId 唯一；外键违规和最后 seq 无事件更新失败。DB/WAL/SHM/backup 0600，liveBytes 使用 live pages+WAL 而非主文件长度。

- [ ] **Step 2: Write failing lock and transaction tests**

两个 acquire 同 realpath 时第二个 AGENT_ALREADY_RUNNING；活 PID 不得被 stale 清理，死 PID 经验证后可恢复。read/immediate 同步返回，Promise 回调、嵌套 immediate、回滚后 publish 均拒绝；backup 必须在事务外 await。

- [ ] **Step 3: Run tests to verify they fail**

Run: `npm run test:agent -- test/storage/database.test.ts test/storage/instance-lock.test.ts test/storage/schema.test.ts`  
Expected: FAIL with missing storage modules。

- [ ] **Step 4: Implement minimal synchronous storage primitives**

使用 better-sqlite3 transaction `.immediate` 和 proper-lockfile 同步 API；锁目录记录 desktopId/database realpath/PID，stale 处理同时验证 PID 与锁新鲜度，不删除活跃锁。open 后逐项验证 PRAGMA/integrity_check，backup 使用 SQLite API，非 transaction 回调中不执行 SDK/网络操作。

- [ ] **Step 5: Run storage primitive tests**

Run: `npm run test:agent -- test/storage`  
Expected: PASS，包括 WAL 重开、死锁恢复和 rollback。

- [ ] **Step 6: Commit**

```bash
git add apps/agent/src/storage apps/agent/test/storage
git commit -m "feat: add durable SQLite storage primitives"
```

### Task 3: V3→V4 两阶段迁移与持久项目/设备仓库

**Files:**
- Create: `apps/agent/src/storage/config-v4-migration.ts`, `apps/agent/src/storage/repositories/device-repository.ts`, `apps/agent/src/storage/repositories/workspace-repository.ts`
- Modify: `apps/agent/src/store/device-store.ts`, `apps/agent/src/workspace/workspace-manager.ts`, `apps/agent/src/config/load.ts`
- Test: `apps/agent/test/storage/config-v4-migration.test.ts`, `persistent-devices.test.ts`, `persistent-workspaces.test.ts`

**Interfaces:**
- Produces: `AgentConfigV4`（不再含可变 workspaces/devices）和 `migrateV3Sources(input:{configDir,uow,sourceHashes,now}):MigrationResult`。
- Produces: `SqliteDeviceStore` 保持 S01 create/verify/revoke/active 语义；`SqliteWorkspaceRepository` 支撑 WorkspaceManager list/assertUsable/setApprovalMode/add/rename/remove。
- Produces: `MigrationState = absent|database_committed|completed`，migration_sources 只保存来源 SHA-256。

- [ ] **Step 1: Write failing migration matrix tests**

首次导入保留所有 IDs/rootPath/queueLimit/mobileApprovalMode/tokenHash，V4 无第二份项目/设备列表。分别在 DB commit 前后、V4 write 前注入退出；V3+同哈希 DB 只完成 V4，不重复导入。V3+哈希不符、V4+DB 缺失、不完整 migrationState 全 fail closed。

- [ ] **Step 2: Write failing repository regression tests**

重开后 revoke/verify、workspace policy/realpath/remove tombstone 语义不变；只有一部 active device，replace 先 revoke 旧设备。备份 0600，公开 WorkspaceSummary 无 rootPath，手机无策略写入口，DB/日志无明文 token。

- [ ] **Step 3: Run tests to verify they fail**

Run: `npm run test:agent -- test/storage/config-v4-migration.test.ts test/storage/persistent-devices.test.ts test/storage/persistent-workspaces.test.ts`  
Expected: FAIL with missing migration/repositories。

- [ ] **Step 4: Implement deterministic two-phase migration**

DB 导入单事务提交，integrity/count 核对后保留 V3/devices 0600 备份并原子写 V4；来源哈希决定恢复而非重复导入。DeviceStore/WorkspaceManager 改为仓库接口，V4 路径不再写 JSON 镜像，realpath 仍在每次执行前同步复核。

- [ ] **Step 5: Run migration and repository tests**

Run: `npm run test:agent -- test/storage/config-v4-migration.test.ts test/storage/persistent-devices.test.ts test/storage/persistent-workspaces.test.ts test/device-store.test.ts test/workspace-approval-policy.test.ts`  
Expected: PASS，S03 默认 deny/revoke/realpath 安全断言不放宽。

- [ ] **Step 6: Commit**

```bash
git add apps/agent/src/storage apps/agent/src/store apps/agent/src/workspace apps/agent/src/config apps/agent/test/storage
git commit -m "feat: migrate bootstrap state into SQLite"
```

### Task 4: 持久 CommandStore 与首次结果幂等

**Files:**
- Create: `apps/agent/src/storage/repositories/command-repository.ts`, `apps/agent/src/storage/persistent-command-executor.ts`
- Test: `apps/agent/test/storage/persistent-commands.test.ts`, `command-result-expiry.test.ts`

**Interfaces:**
- Produces: `CommandActor = {kind:'device';deviceId:string}|{kind:'local';actor:'local_cli'}`、`CommandKind='mutating'|'read_only'`。
- Produces: `AppendEvent = (input:{sessionId;type;payload;runId?;approvalId?;eventId?})=>TimelineEvent`、`EventAppender.for(tx):AppendEvent`、`EventAppender.publishCommitted(events):void`。
- Produces: `PersistentCommandExecutor(eventAppender)` 和 `execute<T>(input:{identity:CommandIdentity;actor;kind;now;business:(tx,append:AppendEvent)=>T}):CommandExecution<T>`。
- Produces: `CommandExecution<T> = {result:T;duplicate:boolean;events:TimelineEvent[]}`；Task 4 用 fake EventAppender，Task 5 提供持久实现。
- Produces: `CommandRepository.expireReadOnlyResults(now):number`；7 天结果过期，墓碑不过期。

- [ ] **Step 1: Write failing duplicate, conflict and rollback tests**

同 commandId/fingerprint 在 DB 重开后 business 仍只执行一次并 duplicate=true；改 payload/type/session/run/actor 返回 COMMAND_ID_CONFLICT。business 或 result 写入任一点抛错时业务、事件、result 全回滚，恢复后同 ID 可重试。schema/auth 失败仍可在 executor 前拒绝。

- [ ] **Step 2: Write failing read-only expiry tests**

第 7 天边界前 duplicate 返回原页面；到期只清 resultJson，旧 ID 同 fingerprint 返回 COMMAND_RESULT_EXPIRED，改 fingerprint 仍冲突；mutating 结果不受清理影响且不保存原 prompt/request payload。

- [ ] **Step 3: Run tests to verify they fail**

Run: `npm run test:agent -- test/storage/persistent-commands.test.ts test/storage/command-result-expiry.test.ts`  
Expected: FAIL with missing command executor/repository。

- [ ] **Step 4: Implement one transactional command boundary**

在 immediate 内依次查重、执行业务(tx,append)、序列化安全 result、写命令和审计；commit 后调用 EventAppender.publishCommitted，再返回 execution。只有 committed execution 发布事件，duplicate 不重发领域事件。异步业务函数直接拒绝，STORAGE_UNAVAILABLE 不伪造已接收结果。

- [ ] **Step 5: Run persistent command tests**

Run: `npm run test:agent -- test/storage/persistent-commands.test.ts test/storage/command-result-expiry.test.ts`  
Expected: PASS，包括重开、rollback 和两种命令保留语义。

- [ ] **Step 6: Commit**

```bash
git add apps/agent/src/storage apps/agent/test/storage/persistent-commands.test.ts apps/agent/test/storage/command-result-expiry.test.ts
git commit -m "feat: persist command idempotency and first results"
```

### Task 5: 持久 Session/Run/Event 仓库与 commit 后发布

**Files:**
- Create: `apps/agent/src/storage/repositories/session-repository.ts`, `apps/agent/src/storage/repositories/run-repository.ts`, `apps/agent/src/storage/repositories/event-repository.ts`, `apps/agent/src/events/durable-event-journal.ts`
- Modify: `apps/agent/src/events/journal.ts`（改为 DurableEventJournal 的测试适配器或标记 deprecated；Runtime 不得同时 wiring 两套 journal）
- Test: `apps/agent/test/storage/persistent-events.test.ts`, `event-publication.test.ts`

**Interfaces:**
- Produces: `SessionRepository.create/get/update`、`RunRepository.insert/get/update/listByStatus`，均返回不可变记录。
- Produces: `DurableEventJournal implements EventAppender`，包含 `commit<T>((tx,append)=>T):{value:T;events:TimelineEvent[]}`、`for(tx)`、`appendWithin(tx,input)`、`publishCommitted(events)`、`recent/afterSeq`。
- Consumes: Task 2 UnitOfWork 和 Task 4 `AppendEvent/EventAppender`；Task 4 executor 与本任务共享同一 tx/append，不嵌套 commit。

- [ ] **Step 1: Write failing seq and publication tests**

两 session 可各自 seq=1，同 session 递增且 lastSeq 只能随事件更新；eventId 重传去重、同 ID 冲突回滚。publisher 在 commit 前调用次数为 0，成功后按 seq 发布，rollback/发送异常不改 DB；发送异常只进入安全日志，事件仍可 afterSeq。

- [ ] **Step 2: Write failing replay and sensitive-field tests**

DB 重开后 recent/afterSeq 返回原 eventId/seq/timestamp/payload；不复制原始 SDK message。delta 50 ms/16 KiB 和 run result flush 语义沿用，run.queued/approval 事件不含 prompt/审批正文。

- [ ] **Step 3: Run tests to verify they fail**

Run: `npm run test:agent -- test/storage/persistent-events.test.ts test/storage/event-publication.test.ts`  
Expected: FAIL with missing durable journal/repositories。

- [ ] **Step 4: Implement transactional event append and post-commit publication**

appendWithin 只写 DB并收集事件，不直接通知 ConnectionManager；commit 返回后才 publish。Session/Run 仓库只接受当前 tx 的状态变更，所有记录新对象返回；不引入持久发送 Outbox。旧 `EventJournal` 若保留，只能作为 `DurableEventJournal` 的测试适配器；Runtime 只 wiring `DurableEventJournal`，禁止双写/双读。

- [ ] **Step 5: Run journal and S01–S03 event regressions**

Run: `npm run test:agent -- test/storage/persistent-events.test.ts test/storage/event-publication.test.ts test/journal-s02.test.ts test/normalizer-s03.test.ts`  
Expected: PASS，原截断、事件顺序和工具去重不回归。

- [ ] **Step 6: Commit**

```bash
git add apps/agent/src/storage/repositories apps/agent/src/events apps/agent/test/storage/persistent-events.test.ts apps/agent/test/storage/event-publication.test.ts
git commit -m "feat: persist session events before publication"
```

### Task 6: PromptAdmission 与原子 queued 接受

**Files:**
- Create: `apps/agent/src/run/prompt-admission.ts`
- Modify: `apps/agent/src/command/router.ts`, `apps/agent/src/app/agent-operations.ts`
- Test: `apps/agent/test/storage/prompt-admission.test.ts`, `prompt-command-regression.test.ts`

**Interfaces:**
- Produces: `PromptAdmission.send(input:{identity;actor:DeviceActor;text;now}):CommandExecution<PromptAccepted>`，首次 result 永远 `{sessionId,runId,status:'queued'}`。
- Consumes: Task 3 workspace/session checks、Task 4 executor、Task 5 journal/run repository。
- Produces: run promptExpiresAt=enqueuedAt+30 天、recoveryGeneration=0、outcomeUnknown=false、持久 nextEnqueueOrder。

- [ ] **Step 1: Write failing admission and no-side-effect tests**

重复 commandId 只一行 run/一个 run.queued；首次 result 即使可立即调度也 queued。事务提交前 driver.startRun 调用数为 0，commit 后本任务仍不主动 start；由 Scheduler drain 决定后续 starting。空白/16,385 字节、错误 workspace/session、归档、路径替换、容量和 STORAGE_LIMITED 均无 run。

- [ ] **Step 2: Add crash-point assertions**

在 run insert、event append、command result insert 各点故障时全回滚；commit 后模拟进程退出，重开只有 queued，启动修复前不得创建 driver。命令/事件/快照摘要均不含 prompt 正文，runs.promptText 是唯一新持久正文位置。

- [ ] **Step 3: Run tests to verify they fail**

Run: `npm run test:agent -- test/storage/prompt-admission.test.ts test/storage/prompt-command-regression.test.ts`  
Expected: FAIL with missing persistent admission。

- [ ] **Step 4: Implement admission without embedded execution**

在 executor 的同一 tx 内重验所有状态并插入 queued/run.queued/result；commit 后仅通知 Scheduler drain，driver 不由 CommandExecutor 调用。Router 从认证设备生成 actor，Operations 不信任 sourceDeviceId。

- [ ] **Step 5: Run admission tests**

Run: `npm run test:agent -- test/storage/prompt-admission.test.ts test/storage/prompt-command-regression.test.ts test/idempotency-s02.test.ts`  
Expected: PASS，S02 指纹/容量不回归，首次结果按 S04 收窄为 queued。同时把 S02 中所有断言首次结果可为 `starting` 的测试、Flutter 客户端和 `protocol/v1/README.md` 迁移为 `queued`-only；`starting` 只通过后续 `run.started` 观察，不得保留两套首次结果断言。

- [ ] **Step 6: Commit**

```bash
git add apps/agent/src/run/prompt-admission.ts apps/agent/src/command apps/agent/src/app/agent-operations.ts apps/agent/test/storage/prompt-admission.test.ts apps/agent/test/storage/prompt-command-regression.test.ts
git commit -m "feat: atomically persist prompt admission"
```

### Task 7: 数据库 Scheduler、RunController 与开始执行崩溃窗口

**Files:**
- Modify: `apps/agent/src/run/run-scheduler.ts`, `run-controller.ts`, `apps/agent/src/adapter/managed-run-driver.ts`, `apps/agent/src/storage/repositories/run-repository.ts`
- Modify (migration): `apps/agent/test/run-scheduler-s03.test.ts`, `apps/agent/test/run-controller-s03.test.ts` 及构造 `RunRecord`/`ManagedRunStart` 的 fixture，补 `promptExpiresAt`/`recoveryGeneration` 等新必填字段和 DB-backed scheduler 初始化
- Test: `apps/agent/test/storage/durable-scheduler.test.ts`, `run-start-crash.test.ts`, `run-controller-s04.test.ts`

**Interfaces:**
- Produces: `RunScheduler.drain():void`、`beginStart(runId,now):RunStartContext`、`markStarted(runId,handleGeneration)`、`markRunning`、`beginCancel`、`complete`。
- Produces: `beginStart` 在 driver 前将 queued→starting，并复核 promptExpiresAt/promptText、workspace realpath、active 状态和双槽；recovery_required 永不被选中。
- Consumes: 每 run 独立 ManagedRunHandle/AdapterRegistry；handle 仍是内存，DB starting/running/waiting/cancelling 是权威占用状态。

- [ ] **Step 1: Write failing scheduling and expiry-race tests**

同 session FIFO、跨 session 双槽、waiting/cancelling 占槽和 queue.remove 语义不回归。queued 到期或 promptText=null 时 beginStart 原子 cancelled/retention_expired+run.completed，driver 从未调用；requeue/recovery_required 不在 eligible 集合。

- [ ] **Step 2: Write failing start-window crash tests**

分别在 beginStart commit 后、driver.startRun 前、query 创建后、handle 注册后/run.started 前故障：DB 不得回到 queued，重开启动修复只能 interrupted+outcomeUnknown。markStarted 写失败时立即 interrupt/close，不继续未持久化执行；同步 start throw 写 failed 后只释放一次槽。

- [ ] **Step 3: Run tests to verify they fail**

Run: `npm run test:agent -- test/storage/durable-scheduler.test.ts test/storage/run-start-crash.test.ts test/storage/run-controller-s04.test.ts`  
Expected: FAIL with missing DB-backed start state transitions。

- [ ] **Step 4: Implement DB state before every irreversible SDK boundary**

drain 在同步调用栈内 beginStart→driver.startRun→registry.register→markStarted/run.started→resumeEvents。close 完成后才写终态/释放槽；SDK result、10 秒取消和 generation 隔离沿用 S02/S03。任何 DB 失败进入 degraded，不允许继续新 start。同步迁移 S03 的 `run-scheduler-s03.test.ts`、`run-controller-s03.test.ts` 及 fixture，补 `promptExpiresAt`/`recoveryGeneration` 等新必填字段和 DB-backed scheduler 初始化；FIFO、双槽、取消断言不得放宽。

- [ ] **Step 5: Run scheduler and run regressions**

Run: `npm run test:agent -- test/storage/durable-scheduler.test.ts test/storage/run-start-crash.test.ts test/storage/run-controller-s04.test.ts test/run-scheduler-s03.test.ts test/run-controller-s03.test.ts`  
Expected: PASS，无双 query、过期执行或旧 generation 污染。

- [ ] **Step 6: Commit**

```bash
git add apps/agent/src/run apps/agent/src/adapter apps/agent/src/storage/repositories/run-repository.ts apps/agent/test/storage apps/agent/test/run-scheduler-s03.test.ts apps/agent/test/run-controller-s03.test.ts
git commit -m "feat: drive managed runs from durable state"
```

### Task 8: PermissionBroker 持久审批与存储降级

**Files:**
- Modify: `apps/agent/src/approval/approval-store.ts`, `permission-broker.ts`, `run-approval-bridge.ts`, `apps/agent/src/storage/repositories/approval-repository.ts`, `apps/agent/src/run/run-controller.ts`
- Modify (migration): `apps/agent/test/permission-broker-request.test.ts`, `apps/agent/test/permission-broker-resolution.test.ts`, `apps/agent/test/permission-broker-invalidation.test.ts`，注入 DB-backed store 和 Volatile registry
- Test: `apps/agent/test/storage/durable-approvals.test.ts`, `approval-storage-failure.test.ts`

**Interfaces:**
- Produces: `ApprovalRecordStore`（DB 安全摘要/审计）与 `VolatileApprovalContentRegistry`（originalInput/content/deferred/timer/AbortListener）分离。
- Produces: Broker request/respond/invalidate 仍保留 S03 Promise identity、120 秒、8/16、completed allow 重入 deny；每个终态使用 Task 4/5 事务。
- Produces: `RunController.cancel(identity,actor)` 在同一 mutating transaction 中写 cancelling、全部 pending invalidated/run_cancelled、session.status/resolved 和 command.result；commit→publish→resolve deny→interrupt。
- Produces: `StorageHealth.degraded(reason):void`，写失败后新 run/requeue/allow 拒绝，pending callback 立即 interrupt:false deny。

- [ ] **Step 1: Write failing persistent approval tests**

重开可见安全 requested/resolved/audit，但 originalInput/content/resultPromise 不存在。pending 重入共享 Promise；completed allow 重入仍 deny 且无第二 resolved。allow commit 后 callback 前故障，重开审批 approved_once、run outcomeUnknown，不再次 allow。

- [ ] **Step 2: Write failing publication and write-failure tests**

requested publisher 触发同步 GET 时 Volatile registry 已注册且内容可读；commit 失败则移除注册并立即 deny，无 phantom pending。正常 cancel 的事件顺序为 cancelling→resolved→deny resolved Promise→interrupt，且 command.result 与这些状态同库提交。respond/timeout/cancel 任一 DB 写失败都立即 deny、清正文、degraded、无未持久 resolved，Promise 不悬挂；旧 approval 启动修复仍 invalidated。

- [ ] **Step 3: Run tests to verify they fail**

Run: `npm run test:agent -- test/storage/durable-approvals.test.ts test/storage/approval-storage-failure.test.ts`  
Expected: FAIL with missing persistent/volatile split。

- [ ] **Step 4: Implement register-before-publish and deny-on-storage-failure**

先构造 volatile entry，再用一个同步调用栈提交 DB/requested；journal 在 commit 后 publish，因此 GET 可见时正文已注册。事务失败撤销 volatile entry。终态正常时在一个事务中同时写审批终态、pendingCount/session.status 和 resolved，随后 commit→publish→resolve；失败时跳过 allow，直接 deny/degraded。同步迁移 S03 的 `permission-broker-request.test.ts`、`permission-broker-resolution.test.ts`、`permission-broker-invalidation.test.ts`，注入 DB-backed store 和 Volatile registry；120 秒、8/16、Promise identity 和重复 allow 断言不得放宽。

- [ ] **Step 5: Run approval regressions**

Run: `npm run test:agent -- test/storage/durable-approvals.test.ts test/storage/approval-storage-failure.test.ts test/permission-broker-request.test.ts test/permission-broker-resolution.test.ts test/permission-broker-invalidation.test.ts`  
Expected: PASS，S03 竞争、超时、工具范围和正文清理不回归。

- [ ] **Step 6: Commit**

```bash
git add apps/agent/src/approval apps/agent/src/storage/repositories/approval-repository.ts apps/agent/src/run/run-controller.ts apps/agent/test/storage/durable-approvals.test.ts apps/agent/test/storage/approval-storage-failure.test.ts apps/agent/test/permission-broker-request.test.ts apps/agent/test/permission-broker-resolution.test.ts apps/agent/test/permission-broker-invalidation.test.ts
git commit -m "feat: persist approval decisions without persisting content"
```

### Task 9: StartupRecovery 与先修复后服务的 Mac wiring

**Files:**
- Create: `apps/agent/src/storage/startup-recovery.ts`
- Modify: `apps/agent/src/app/runtime.ts`, `wire.ts`, `session/session-registry.ts`, `workspace/workspace-manager.ts`
- Test: `apps/agent/test/storage/startup-recovery.test.ts`, `apps/agent/test/integration/s04-runtime-start.test.ts`

**Interfaces:**
- Produces: `StartupRecovery.repair(input:{agentInstanceId;now}):RecoveryReport`，单一 immediate 修复所有旧活跃/queued/pending并产生对应事件。
- Produces: `createAgentRuntime` 顺序：acquire lock→open/migrate/integrity→repair→construct repositories/Scheduler/Broker→listen；close 反向释放。
- Produces: recoveryRequiredRuns 独立投影；archive/remove usage 包含 recovery_required。

- [ ] **Step 1: Write failing recovery matrix tests**

每种旧 run/approval 状态逐项断言 spec 9.2；active interrupted 的 outcomeUnknown/eventTailMayBeIncomplete=true，queued generation+1且 driver=0，终态不重复事件。每事件 session seq 连续，Claude ID/标题/归档保留，新 agentInstanceId 生成。

- [ ] **Step 2: Write failing startup-order and second-instance tests**

在迁移/integrity/repair 各点失败时 phone/admin listen=0、driver=0；修复事务中途 child exit 后下次完整重试。第二实例无 Scheduler/query。session.create/rename/archive 经 mutating executor 且重开保留；recovery_required 阻止 archive/remove，但不阻止普通新 prompt，discard 后才可归档/移除。

- [ ] **Step 3: Run tests to verify they fail**

Run: `npm run test:agent -- test/storage/startup-recovery.test.ts test/integration/s04-runtime-start.test.ts`  
Expected: FAIL with missing startup repair/wiring。

- [ ] **Step 4: Implement one recovery transaction and strict startup composition**

修复期间 publisher 不广播，事件由后续 sync 获取；成功后才创建内存 handle/content registry 和监听。Runtime 不保留旧内存 JSON/SessionRegistry 执行旁路，graceful close 沿用 S03 invalidate/close，强杀交给下次 repair。

- [ ] **Step 5: Run runtime recovery tests**

Run: `npm run test:agent -- test/storage/startup-recovery.test.ts test/integration/s04-runtime-start.test.ts test/integration/s03-restart.test.ts`  
Expected: PASS，旧“重启丢历史”断言只按 S04 已批准语义迁移，其余权限/连接安全断言不放宽。

- [ ] **Step 6: Commit**

```bash
git add apps/agent/src/storage/startup-recovery.ts apps/agent/src/app apps/agent/src/session apps/agent/src/workspace apps/agent/test/storage/startup-recovery.test.ts apps/agent/test/integration/s04-runtime-start.test.ts
git commit -m "feat: repair durable state before serving clients"
```

### Task 10: run.requeue、prompt 读取与 recovery discard

**Files:**
- Create: `apps/agent/src/run/recovery-service.ts`, `apps/agent/src/run/run-prompt-controller.ts`
- Modify: `apps/agent/src/run/run-controller.ts`, `apps/agent/src/transport/phone-server.ts`, `apps/agent/src/app/agent-operations.ts`
- Test: `apps/agent/test/storage/recovery-service.test.ts`, `apps/agent/test/run-prompt-http.test.ts`

**Interfaces:**
- Produces: `RecoveryService.requeue(input:{identity;actor;sessionId;runId;expectedRecoveryGeneration;now}):CommandExecution<PromptAccepted>`。
- Produces: `RunPromptController.read(runId,deviceId):{runId,text}`；`GET /v1/runs/{runId}/prompt`，no-store、正文最多 16 KiB。
- Modifies: queue.remove 接受 queued|recovery_required；后者 cancelled/recovery_discarded并立即清 prompt，不调用 interrupt。

- [ ] **Step 1: Write failing requeue tests**

只有 recovery_required 可 requeue；错状态 RUN_NOT_RECOVERABLE、旧 generation CONFLICT。路径替换、归档、设备吊销、QUEUE_FULL、prompt 到期/为空均无执行。成功同 runId/原 prompt command 关联、新 run.requeue commandId、新 enqueueOrder 在队尾，run.queued 含 requeued/generation/originalEnqueuedAt但无正文。

- [ ] **Step 2: Write failing prompt endpoint and discard tests**

合法当前设备可读 prompt，错/旧设备、未知 run、promptText=null 不可读；响应 no-store，GET 不占 seq、不写 command/Journal/日志正文。未加载正文也可 discard，discard 后 prompt GET 不可读且 archive/remove 不再 busy；interrupted 无 requeue 入口。

- [ ] **Step 3: Run tests to verify they fail**

Run: `npm run test:agent -- test/storage/recovery-service.test.ts test/run-prompt-http.test.ts`  
Expected: FAIL with missing recovery service/route。

- [ ] **Step 4: Implement explicit generation-checked recovery**

requeue 使用 mutating executor，事务内重新校验所有状态，requeue 不延长 promptExpiresAt。prompt endpoint 复用 Bearer 认证并只读 DB；session.resume 仍只读，不创建 driver，新 prompt 才使用持久 Claude ID resume。

- [ ] **Step 5: Run recovery and transport tests**

Run: `npm run test:agent -- test/storage/recovery-service.test.ts test/run-prompt-http.test.ts test/phone-auth.test.ts`  
Expected: PASS，无自动恢复、旧 generation 执行或正文泄漏。

- [ ] **Step 6: Commit**

```bash
git add apps/agent/src/run apps/agent/src/transport apps/agent/src/app/agent-operations.ts apps/agent/test/storage/recovery-service.test.ts apps/agent/test/run-prompt-http.test.ts
git commit -m "feat: add explicit queued-run recovery"
```

### Task 11: S04 共享协议 schema 与样例

**Files:**
- Modify: `protocol/v1/commands.schema.json`, `events.schema.json`, `README.md`
- Create: `protocol/v1/examples/s04/run-requeue.json`, `run-recovery-required.json`, `session-sync-page.json`, `session-sync-resync.json`, `snapshot-page-0.json`, `snapshot-page-1.json`, `command-result-expired.json`, `recovery-generation-conflict.json`
- Test: `apps/agent/test/protocol-s04.test.ts`

**Interfaces:**
- Produces: run.requeue/session.sync/page snapshot、run.recovery_required、recoveryRequiredRuns/outcomeUnknown/eventTailMayBeIncomplete/recoveryGeneration 和全部 S04 错误码。
- Produces: `CommandRequest` 新 payload expectedRecoveryGeneration/afterSeq/limit/snapshotId/pageIndex；不包含 prompt/updatedInput/content。

- [ ] **Step 1: Write failing shared-example tests**

验证全部合法样例和非法 afterSeq/limit/pageIndex/generation；未知 recovery/sync 类型不得被当作无操作。session.sync 页保持历史 eventId/seq，快照控制页无新 seq，RESYNC_REQUIRED details 只含 manifest，prompt 正文在任一普通样例中均不存在。

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm run test:agent -- test/protocol-s04.test.ts`  
Expected: FAIL with missing S04 definitions/examples。

- [ ] **Step 3: Implement additive protocol V1 schemas**

保持原信封和 command.result 规则，固定 limit 默认/最大 100、快照最多 8 页、消息 48/64 KiB；在 README 明确记录 prompt.send 首次结果从 S02 的 `queued|starting` 收窄为 S04 的 `queued`-only、queue.remove recovery 扩展和同版本组合升级（客户端必须等待 run.started 才能看到 starting）。

- [ ] **Step 4: Run protocol tests**

Run: `npm run test:agent -- test/protocol-s04.test.ts`  
Expected: PASS，为 Task 12 和 Task 16 提供同一份共享样例。

- [ ] **Step 5: Commit**

```bash
git add protocol/v1 apps/agent/test/protocol-s04.test.ts
git commit -m "feat: define S04 recovery and sync protocol"
```

### Task 12: Mac afterSeq 同步与不可变分页快照

**Files:**
- Create: `apps/agent/src/sync/session-sync-service.ts`, `snapshot-service.ts`
- Modify: `apps/agent/src/command/router.ts`, `apps/agent/src/events/snapshot-coordinator.ts`, `apps/agent/src/events/snapshot-factory.ts`（由 SnapshotService 复用或标记 deprecated；Runtime 只 wiring 分页快照路径）
- Test: `apps/agent/test/storage/session-sync.test.ts`, `snapshot-service.test.ts`, `sync-live-race.test.ts`

**Interfaces:**
- Produces: `SessionSyncService.sync(input:{identity;actor;sessionId;afterSeq;limit}):CommandExecution<SyncPage|ResyncRequired>`。
- Produces: `SyncPage = {events;nextAfterSeq;lastSeq;hasMore;volatile:SessionVolatileSummary|null}`，仅最后页 volatile 非 null。
- Produces: `SnapshotService.getPage(input:{identity;actor;sessionId;snapshotId?;pageIndex?}):CommandExecution<SnapshotPageResult>`。
- Produces: `SnapshotService.createWithin(tx,input:{sessionId;reason:'sync'|'retention'}):SnapshotManifest`，供 getPage/RESYNC 和 Task 13 清理共用，不开启嵌套事务。
- Produces: `SnapshotManifest = {snapshotId;sessionId;lastSeq;pageCount;byteLength;sha256}`。

- [ ] **Step 1: Write failing afterSeq boundary tests**

覆盖 afterSeq=F/F-1/L/L+1、F==L、空事件、limit 0/101、48 KiB 截页和 1,000/1,001 缺口；正常页严格 seq 升序且原 ID/timestamp 不变，缺口返回 RESYNC_REQUIRED+manifest，不能用 MIN(seq) 猜连续性。read-only duplicate 返回同页，7 天过期由 Task 4/13 处理。

- [ ] **Step 2: Write failing snapshot and live-race tests**

构造八页、全中文、大工具事件、8 pending+recovery+20 queued：每页 <=48/64 KiB，安全/易失状态不删，recentEvents 可缩减。收齐页可重建 canonical JSON/hash；缺页/错页/清理后 SNAPSHOT_NOT_FOUND。sync/snapshot 捕获后 live seq>L 只能随后发布，旧 lastSeq 快照不带新状态。

- [ ] **Step 3: Run tests to verify they fail**

Run: `npm run test:agent -- test/storage/session-sync.test.ts test/storage/snapshot-service.test.ts test/storage/sync-live-race.test.ts`  
Expected: FAIL with missing sync/snapshot services。

- [ ] **Step 4: Implement consistent read-only commands and immutable pages**

在 immediate 一致读中捕获 L/F/易失状态并保存只读首次结果；RESYNC 同事务创建快照。页 0 包含所有安全摘要+首批 recentEvents，后续页只含事件；SHA-256 对完整 canonical JSON UTF-8 bytes。新领域事件不占 seq，重复 command 不重复创建快照。S03 的 `SnapshotFactory` 只作为分页快照的页内容投影工具；Runtime 不得同时暴露单消息快照和分页快照两条路径。

- [ ] **Step 5: Run sync and snapshot tests**

Run: `npm run test:agent -- test/storage/session-sync.test.ts test/storage/snapshot-service.test.ts test/storage/sync-live-race.test.ts test/snapshot-s03.test.ts`  
Expected: PASS，无双倍 seq、无限重放或安全状态丢弃。

- [ ] **Step 6: Commit**

```bash
git add apps/agent/src/sync apps/agent/src/command apps/agent/src/events apps/agent/test/storage/session-sync.test.ts apps/agent/test/storage/snapshot-service.test.ts apps/agent/test/storage/sync-live-race.test.ts
git commit -m "feat: add durable incremental and snapshot synchronization"
```

### Task 13: 保留清理、存储容量与完整 Mac 回归

**Files:**
- Create: `apps/agent/src/storage/retention-service.ts`, `storage-health.ts`
- Modify: `apps/agent/src/app/runtime.ts`, `apps/agent/src/run/run-scheduler.ts`
- Test: `apps/agent/test/storage/retention-service.test.ts`, `storage-capacity.test.ts`, `apps/agent/test/integration/s04-agent-flow.test.ts`

**Interfaces:**
- Produces: `RetentionService.runOnce(now):RetentionReport`，启动修复后及每 15 分钟执行，单批最多 500 events。
- Produces: `StorageHealth.current():{state:'ok'|'limited'|'unavailable';liveBytes:number}`；limited/unavailable 拒绝新 run/requeue/allow，历史读取可用。
- Consumes: Task 12 SnapshotService.createWithin；所有清理与 retentionFloor/事件更新同事务，不为快照开启嵌套事务。

- [ ] **Step 1: Write failing retention matrix tests**

用 fake clock 验证 30 天、5,000、90 天、7 天、最新 2 快照边界；events 只删连续前缀，首次清理前快照存在，mutating commands/session/授权 tombstone 不删。read-only 到期 duplicate 返回 EXPIRED，mutating duplicate 仍返回首次结果。

- [ ] **Step 2: Write failing queued-expiry and live-capacity tests**

到期 queued/recovery 原子 cancelled/retention_expired、清 prompt+run.completed，driver=0；活跃 run 清 prompt但不自动取消，requeue 不延长。构造主文件未缩小但 freelist 大的 DB，liveBytes 应下降；清理目标 448 MiB，仍超 512 MiB才 limited，禁止自动 VACUUM/删幂等记录。

- [ ] **Step 3: Run tests to verify they fail**

Run: `npm run test:agent -- test/storage/retention-service.test.ts test/storage/storage-capacity.test.ts test/integration/s04-agent-flow.test.ts`  
Expected: FAIL with missing retention/health wiring。

- [ ] **Step 4: Implement bounded cleanup and complete Mac integration**

按时间/条数/全局 liveBytes 分批清理，queued 到期与 Scheduler 二次检查共享同一事务辅助函数。Runtime 先 repair 再 schedule cleanup；真实 Fastify/WSS 集成覆盖 prompt→run→approval→disconnect→sync→restart→requeue，无旧内存执行旁路。

- [ ] **Step 5: Run complete Mac tests and coverage**

Run: `npm run test:agent && npm run coverage:agent`  
Expected: PASS，核心 statements/branches/functions/lines >=80%，S00–S03 安全回归不失败。

- [ ] **Step 6: Commit**

```bash
git add apps/agent protocol/v1
git commit -m "feat: enforce durable retention and storage health"
```

### Task 14: Flutter RecoveryStore、Application Support 与 Data Protection

**Files:**
- Create: `apps/mobile/lib/recovery/recovery_database.dart`, `recovery_store.dart`, `outbox_repository.dart`, `cache_repository.dart`
- Modify: `apps/mobile/ios/Runner/S04StoreProtection.swift`, `AppDelegate.swift`
- Test: `apps/mobile/test/recovery/recovery_database_test.dart`, `cache_repository_test.dart`, `apps/mobile/integration_test/s04_store_gate_test.dart`

**Interfaces:**
- Produces: `RecoveryDatabase.open():Future<Database>`，路径为 `getApplicationSupportDirectory()/recovery.db`，schemaVersion=1。
- Produces: `RecoveryStore.outbox/cursors/events/sessions/drafts`、`clearAll()`；Flutter 不直接拼接 Documents 路径。
- Produces: `OutboxRepository`、`CacheRepository`；cached events 200/session、10 sessions、20 MiB，outbox/cursor/draft 不参与缓存淘汰。

- [ ] **Step 1: Write failing FFI schema and path tests**

使用 sqflite_common_ffi 注入临时目录，验证五类表、commandId/eventId/session cursor 唯一约束和 v1 重开；drafts 在重开后按 session 原样恢复。Application Support path adapter 被调用，未调用 Documents。DB 中无 deviceToken/approvalContent/run prompt endpoint response 字段。

- [ ] **Step 2: Write failing cache and native-protection tests**

每 session 201 条只留最近 200，11 个 idle session 只淘汰允许项，20 MiB 超限时 outbox/cursor/draft 原样保留。真机验证 DB/WAL/SHM 都是 NSFileProtectionComplete，锁屏访问失败、解锁重开；不能通过日志打印正文验证。

- [ ] **Step 3: Run tests to verify they fail**

Run: `cd apps/mobile && flutter test test/recovery`  
Expected: FAIL with missing RecoveryStore/repositories。

- [ ] **Step 4: Implement minimal persistent local store**

用 path_provider+path 组成 Application Support 路径，sqflite migration 创建表；原生 Swift 在 DB 创建和每次打开后设置/验证三类文件保护。缓存淘汰只删除 cached_events/cached_sessions，不引入 SQLCipher、token 字段或审批正文缓存。

- [ ] **Step 5: Run RecoveryStore and physical protection tests**

Run: `cd apps/mobile && flutter test test/recovery && flutter test integration_test/s04_store_gate_test.dart -d <physical-iphone-id>`  
Expected: PASS；真机失败保持 BLOCKED，不降低保护级别。

- [ ] **Step 6: Commit**

```bash
git add apps/mobile/lib/recovery apps/mobile/ios apps/mobile/test/recovery apps/mobile/integration_test
git commit -m "feat: add protected iPhone recovery storage"
```

### Task 15: 持久 Outbox、跨实例人工确认与执行意图门控

**Files:**
- Create: `apps/mobile/lib/connection/persistent_command_coordinator.dart`, `apps/mobile/lib/recovery/outbox_command.dart`
- Modify: `apps/mobile/lib/recovery/outbox_repository.dart`, `apps/mobile/lib/connection/connection_controller.dart`, `apps/mobile/lib/features/chat/prompt_command_coordinator.dart`
- Test: `apps/mobile/test/recovery/outbox_repository_test.dart`, `persistent_command_coordinator_test.dart`

**Interfaces:**
- Produces: `OutboxState = persisted|sending|awaitingAck|confirmationRequired|completed|discarded`；`OutboxCommand` 保存原信封/agentInstanceId/createdAt/state。
- Produces: `PersistentCommandCoordinator.send(request)`、`onReady(agentInstanceId)`、`confirmRetry(commandId)`、`discardUnknown(commandId)`、`onResult(result)`。
- Produces: `canStartExecutionIntent(sessionId):Future<bool>`；prompt.send/run.requeue 共用持久唯一门控，其他 session/cancel/remove/permission 不受阻。

- [ ] **Step 1: Write failing durable-outbox tests**

send 的 socket 调用前必能重开 DB读到原 commandId/正文；同实例网络失败自动 retry 的 ID/目标/正文完全相同，确定 result 清正文。read-only sync/list 不入 outbox，INVALID_MESSAGE 要求新命令，STORAGE_UNAVAILABLE 保留。

- [ ] **Step 2: Write failing cross-instance and gate-race tests**

```dart
test('restart blocks stale retry and same-session requeue', () async {
  unawaited(coordinator.send(promptRequest('s1','cmd_1')));
  await flushMicrotasks();
  sentCommandIds.clear();
  connection.emitReady(agentInstanceId: 'new-agent');
  await flushTimers();
  expect(sentCommandIds, isEmpty);
  expect(await coordinator.canStartExecutionIntent('s1'), isFalse);
  expect(await coordinator.canStartExecutionIntent('s2'), isTrue);
  await coordinator.confirmRetry('cmd_1');
  expect(sentCommandIds, ['cmd_1']);
});
```

覆盖同 session prompt/requeue 唯一约束、App 重开仍有效、confirmation_required 的放弃只清本地且显示“不会撤销 Mac 已接受执行”，旧 timer/generation callback 不发送，revoke/replace 清全库。

- [ ] **Step 3: Run tests to verify they fail**

Run: `cd apps/mobile && flutter test test/recovery/outbox_repository_test.dart test/recovery/persistent_command_coordinator_test.dart`  
Expected: FAIL with missing persistent coordinator/gate。

- [ ] **Step 4: Implement store-first command coordination and generation invalidation**

OutboxRepository 用 partial unique index 限制活跃执行意图，coordinator 串行化 send/onReady/onResult；实例变化先递增 generation、取消 timer，再标 confirmationRequired。confirm 用原 request，discard 只保留无正文的结果未知墓碑，不构造 cancel/remove，也不生成新 commandId。

- [ ] **Step 5: Run outbox and S02 ordering regressions**

Run: `cd apps/mobile && flutter test test/recovery test/connection test/features/chat/prompt_command_coordinator_test.dart`  
Expected: PASS，无自动跨实例重试、同 session 抢先或重启丢 outbox。

- [ ] **Step 6: Commit**

```bash
git add apps/mobile/lib/recovery apps/mobile/lib/connection apps/mobile/lib/features/chat/prompt_command_coordinator.dart apps/mobile/test/recovery
git commit -m "feat: persist commands across app and agent restarts"
```

### Task 16: Flutter 连续 seq、afterSeq 与分页快照恢复

**Files:**
- Create: `apps/mobile/lib/protocol/s04_messages.dart`, `apps/mobile/lib/domain/sync_state.dart`, `apps/mobile/lib/connection/session_sync_coordinator.dart`
- Modify: `apps/mobile/lib/domain/app_state.dart`, `apps/mobile/lib/recovery/cache_repository.dart`, `apps/mobile/lib/protocol/decoder.dart`
- Test: `apps/mobile/test/protocol/s04_decoder_test.dart`, `apps/mobile/test/recovery/session_sync_coordinator_test.dart`, `snapshot_assembler_test.dart`

**Interfaces:**
- Produces: `SessionSyncCoordinator.sync(sessionId)`、`applyLive(event)`、`applySnapshotPage(page)`、`clearConflict(sessionId)`。
- Produces: `SyncCursorState = {lastContiguousSeq;pendingBySeq;syncing}`；pending 单 session 最多 200 条/2 MiB。
- Produces: 内存 `SnapshotAssembler`，收齐页后验证 manifest/hash/canonical JSON并一次性返回完整快照，不持久临时页。

- [ ] **Step 1: Write failing shared-protocol and continuity tests**

读取全部 S04 样例；event 只有 seq=cursor+1 才推进，重复 eventId 去重，同 ID 不同 payload 清该 session 缓存并 SYNC_CONFLICT。乱序缓冲 201 条或 >2 MiB 触发 resync，不渲染到达顺序；不同 session 不串线。

- [ ] **Step 2: Write failing page/live and stale-snapshot tests**

中间页不修改 AppState，最后页应用 events 后才应用 volatile，live seq>L 随后重放。八页缺页/错页/hash 错均不应用；旧 lastSeq 快照不覆盖新状态。RESYNC_REQUIRED 后逐页拉取，COMMAND_RESULT_EXPIRED/SNAPSHOT_NOT_FOUND 用新 read-only commandId，read-only 请求不进 outbox。

- [ ] **Step 3: Run tests to verify they fail**

Run: `cd apps/mobile && flutter test test/protocol/s04_decoder_test.dart test/recovery/session_sync_coordinator_test.dart test/recovery/snapshot_assembler_test.dart`  
Expected: FAIL with missing sync models/coordinator。

- [ ] **Step 4: Implement transactional cursor updates and atomic snapshot application**

每个同步页与 cursor/cache 在同一 sqflite 事务提交，提交后更新 Riverpod；未知 recovery/sync 类型抛 ProtocolConflictException并禁止新执行。冷启动先显示标为“可能不是最新”的缓存，再 ready→sync，agentInstanceId 改变保留历史/cursor。

- [ ] **Step 5: Run sync and domain regressions**

Run: `cd apps/mobile && flutter test test/protocol test/domain test/recovery test/connection`  
Expected: PASS，无跳号、重复、旧快照覆盖或实例变化清历史。

- [ ] **Step 6: Commit**

```bash
git add apps/mobile/lib/protocol apps/mobile/lib/domain apps/mobile/lib/connection apps/mobile/lib/recovery apps/mobile/test/protocol apps/mobile/test/recovery
git commit -m "feat: restore iPhone timelines with incremental sync"
```

### Task 17: iPhone 恢复界面、prompt 查看与解绑清理

**Files:**
- Create: `apps/mobile/lib/features/recovery/recovery_controller.dart`, `apps/mobile/lib/features/recovery/recovery_prompt_api.dart`, `apps/mobile/lib/features/recovery/recovery_page.dart`, `apps/mobile/lib/features/recovery/unknown_command_banner.dart`
- Modify: `apps/mobile/lib/features/chat/chat_page.dart`, `apps/mobile/lib/features/sessions/session_page.dart`, `apps/mobile/lib/features/workspaces/workspace_page.dart`, `apps/mobile/lib/features/pairing/pairing_controller.dart`
- Test: `apps/mobile/test/features/recovery/recovery_page_test.dart`, `recovery_privacy_test.dart`, `unpair_cleanup_test.dart`

**Interfaces:**
- Produces: `RecoveryController.loadPrompt(runId)`、`requeue(runId,generation)`、`discard(runId)`；requeue 仅在正文加载成功且执行意图门控空闲时可用。
- Produces: interrupted+outcomeUnknown/eventTail 提示、recovery_required 卡片、confirmation_required 确认/放弃 UI。
- Consumes: Task 15/16 coordinators；prompt endpoint 正文只存页面内存。

- [ ] **Step 1: Write failing recovery interaction tests**

查看原 prompt 前 requeue 禁用，discard 可在未加载时使用；requeue 捕获 runId/sessionId/generation，切换页面不改目标，同 commandId 重试，generation conflict 后刷新且不自动再次 requeue。interrupted 显示结果未知且无 requeue，recovery 未处理时 archive/remove 显示 busy。

- [ ] **Step 2: Write failing privacy and unpair tests**

后台/resolved/discard 清 prompt 页面正文并显示遮罩，迟到 GET Future 不重新填正文；普通日志/崩溃上下文无正文/token。解除配对/replace 删除 RecoveryStore、Keychain、草稿和临时文件，重开不显示旧缓存；离线缓存固定标“可能不是最新”。

- [ ] **Step 3: Run tests to verify they fail**

Run: `cd apps/mobile && flutter test test/features/recovery`  
Expected: FAIL with missing recovery UI/controller。

- [ ] **Step 4: Implement explicit recovery UI without automatic execution**

所有按钮只调用 Task 15/16 controller，不另建命令或执行路径；“放弃本地重试”固定提示不撤销 Mac 已接受执行，“恢复会话”固定提示 Claude 上下文可能部分保留。页面不提供自动继续、批量 requeue 或旧审批恢复。

- [ ] **Step 5: Run all Flutter tests and coverage**

Run: `cd apps/mobile && flutter test --coverage`  
Expected: PASS，核心 Dart 业务逻辑覆盖率 >=80%，S01–S03 配对/队列/审批回归不失败。

- [ ] **Step 6: Commit**

```bash
git add apps/mobile
git commit -m "feat: add explicit iPhone recovery experience"
```

### Task 18: 真实崩溃注入、SDK resume、iPhone E2E 与退出门禁

**Files:**
- Create: `apps/agent/test/live/s04-real-recovery.test.ts`, `apps/agent/test/live/s04-crash-harness.ts`
- Create: `scripts/s04/verify-gate.ts`, `scripts/s04/verify-gate.test.ts`, `scripts/s04/check-secrets.ts`, `scripts/s04/check-secrets.test.ts`
- Create: `docs/s04/e2e-checklist.md`, `docs/s04/rollback.md`, `docs/s04/exit-report.md`
- Modify: `package.json`

**Interfaces:**
- Produces: `npm run test:s04`、`npm run test:s04:live`、`npm run verify:s04`。
- Produces: STORE-00、真实 SQLite fault points、固定 SDK 和 E2E-01–15 的 PASS/FAIL/BLOCKED 台账；Mock 不得替代真实证据。

- [ ] **Step 1: Write failing crash-harness and gate tests**

独立 child process 在 prompt/event/approval/repair/migration commit 前后退出，断言原子性和无自动 driver；真实 SDK 完成 run 后重启无自动 query，用户新 prompt 才 resume 同一 Claude ID。活跃固定无害命令中强杀，不自动产生第二次 marker。Gate 缺 STORE-00、E2E、真机 Data Protection、覆盖率或含 secret/Funnel 时失败。

- [ ] **Step 2: Run real storage and SDK recovery suite**

Run: `S04_LIVE=1 npm run test:s04:live`  
Expected: 全部真实执行，S00–S03 真实门禁仍 PASS；缺设备/fixture/网关时 BLOCKED，不能改 marker、用 Mock 冒充 live 或自动继续旧任务。

- [ ] **Step 3: Execute E2E-01–15 on the physical iPhone**

按 spec 逐项记录版本、时间、traceId 和真实结果：V3→V4；App 在 ACK 前后被杀；双端重启未确认命令；活跃/queued/pending 强杀；显式 requeue；旧 generation；allow commit 故障；高频断网；清理后快照；磁盘失败/容量；第二实例/损坏；真实 SDK resume；revoke/replace/unpair。每项检查副作用次数，不只看 UI。

- [ ] **Step 4: Verify isolated rollback without deleting evidence**

停止 Agent并用 SQLite backup 保存，确认无未处理迁移；独立临时目录恢复 V3 JSON/devices只证明旧项目/设备可回退，不声称 S04 新历史或旧 run 被恢复。DB 保留 0600，不自动删除、反向迁移或从备份静默重建执行状态。

- [ ] **Step 5: Run full verification and security scans**

Run: `npm run test:s04 && npm run coverage:agent && cd apps/mobile && flutter test --coverage && cd ../.. && S04_LIVE=1 npm run test:s04:live && npm run verify:s04`  
Expected: 全部 PASS，Agent/Dart 覆盖率 >=80%，E2E-01–15 全 PASS；无 token/密钥/审批正文泄漏，无自动重放，无 Funnel。

- [ ] **Step 6: Write the exit report**

记录真实结果和限制：outcomeUnknown、未 flush delta、30 天正文、只读结果 7 天、FileVault/Data Protection 而非 SQLCipher、无自动 transcript 对账/多设备/Relay；任何 FAIL/BLOCKED 都停止 S04 验收，不进入 S05。

- [ ] **Step 7: Commit**

```bash
git add apps scripts/s04 docs/s04 protocol/v1 package.json
git commit -m "test: verify S04 recovery on Mac and iPhone"
```
