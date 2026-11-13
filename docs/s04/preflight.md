# S04 实施预检

**日期：** 2026-11-13
**计划：** `docs/superpowers/plans/2026-11-08-s04-persistence-reconnect-recovery.md`
**Spec：** `docs/superpowers/specs/2026-11-08-s04-persistence-reconnect-recovery-design.md`

## 1. 入口门禁结果

| 门禁 | 结果 | 说明 |
|---|---|---|
| `npm run s00:gate` | **PASS** | Core PASS；ASR Live DEFERRED（S05 范围） |
| `npm run verify:s01` | **FAIL** | 仅 E2E-01–12 NOT_RUN |
| `npm run verify:s02` | **FAIL** | E2E-01–12 NOT_RUN + realDevice 缺失 |
| `npm run verify:s03` | **FAIL** | E2E-01–12 NOT_RUN + realDevice 缺失 + S02 门禁 FAIL；PERM-00、覆盖率、secrets、Funnel 检查均通过 |

**结论：计划要求的"全部 PASS"不成立。** 用户在实现前明确选择继续（与 S03 相同处理）：代码与自动化测试照常实施；STORE-00 的 Mac 部分作为硬门禁；物理 iPhone 与 E2E-01–15 记录 BLOCKED；S04 不得宣称验收通过。该决定已写入 SDD ledger。

## 2. 环境基线

- 系统默认 Node 为 **v22.23.2**，低于计划固定的 **Node 24.15.0**；已用 fnm 安装 v24.15.0，存储与测试命令必须以 `fnm exec --using=24.15.0 -- npm ...` 运行，不得用默认 Node 充当 STORE-00 证据。
- TypeScript 7.0.2、Vitest 5.1.0、tsx 4.23.15；Agent SDK 0.3.319。
- Flutter 3.47.9 / Dart 3.13.7；`sqflite`、`sqflite_common_ffi`、`path_provider`、`path` 尚未加入依赖（Task 1 添加）。
- 现有 S01–S03 实现全部通过自动化测试（Agent 363、Flutter 195）。

## 3. 实际接口与计划差异

| 计划假设 | 仓库实际 | 处理 |
|---|---|---|
| `CommandIdentity` + 内存幂等表 | `apps/agent/src/command/idempotency.ts` 的 `InMemoryIdempotency` 保存首次 Promise 和指纹 | Task 4 以 `PersistentCommandExecutor` 取代；首次结果改为同步序列化；内存表不再作为权威 |
| `DurableEventJournal` 前身 | `events/journal.ts` 的 `EventJournal.append()` 同步分配 seq 并立即通知订阅者 | Task 5 改为 `appendWithin(tx)` 收集、commit 后 `publishCommitted`；Runtime 只能 wiring 一套 |
| RunScheduler 以 DB 为权威 | `run/run-scheduler.ts` 以 `SessionRegistry` 内存 `activeRun/queue/runsById` 为权威；`enqueue()` 内直接 `drain()` 并可能返回 `starting` | Task 6/7 拆为 PromptAdmission（只持久接受）+ DB Scheduler；首次结果固定 `queued` |
| `RunRecord.text` 终态置 null | 现有 `complete()`/`removeQueued()` 成功路径把 `text` 置 null | S04 新增 `promptText/promptExpiresAt`，终态清空但 queued/recovery_required 保留 30 天；公开摘要仍不含正文 |
| PermissionBroker 直接可持久化 | `PermissionBroker` 依赖 `ApprovalStore` 内存记录（含 `content/originalInput/resultPromise`） | Task 8 拆分 `ApprovalRecordStore`（DB 安全记录）与 `VolatileApprovalContentRegistry`；Promise 仍只存在内存 |
| 设备/项目为 SQLite 权威 | `DeviceStore` 异步读写 `devices.json`；`WorkspaceManager` 异步/同步混用并写 `agent.json`（V3） | Task 2/3 引入同步 UnitOfWork 与仓库；保留现有公开方法语义（必要时 async 包装同步调用），V4 不再写可变 JSON |
| `AgentConfigV3` 内嵌 workspaces | `config/config-v3.ts` 校验严格、`.v2.bak` 0600 | Task 3 新增 V4 bootstrap 配置与 V3/devices 两阶段导入；V3 解析器保留供迁移 |
| `CommandRequest` 已有统一信包 | Flutter `connection/command_client.dart` 以 `CommandRequest<T>` + `CommandExecutor` 发送；无持久化 | Task 15 在其前加 `PersistentCommandCoordinator`；`CommandClient` 保持传输层职责 |
| `ConnectionController` 暴露实例变化 | 已有 `agentInstanceId` 与 `onAgentInstanceChanged(previous,next)` | Task 15/16 直接复用；不新增第二套实例检测 |
| prompt.send 首次结果可为 `queued|starting` | `run-scheduler.ts` 的 `PromptAccepted.status` 为 `'queued' | 'starting'` | Task 6 收窄为 `'queued'`；同步修改 S02 测试与 Flutter 断言，`starting` 只经 `run.started` 观察 |

## 4. 隔离崩溃夹具

- 每个测试用 `mkdtemp` 创建独立 `configDir`/DB 路径；不读取或复制真实 `~/.claude-remote`、真实项目、环境变量或凭证。
- 合成 V3 配置仅含 `desktop_*`/`ws_*`/`session_*` 固定 ID 与临时 rootPath；合成 devices 仅含固定 `deviceId` 和 `tokenHash` 占位。
- 崩溃点：prompt/event/approval/repair/migration 事务 commit 前与 commit 后；Markdown 采用固定无害 marker（如 `S04_CRASH_MARKER`），禁止真实命令副作用。
- SQLite 故障注入通过独立 child process 退出或包装 connection 抛错实现；不使用 Mock 冒充真实 SQLite 证据。

## 5. 执行顺序

Task 0 → Task 1（STORE-00：Mac PASS、iPhone BLOCKED）→ Task 2–13（Mac）→ Task 14–17（Flutter）→ Task 18（门禁与报告，E2E BLOCKED）。