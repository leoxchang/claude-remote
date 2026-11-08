# S04 详细 Spec：持久化与断线恢复

**版本：** V1.0  
**日期：** 2026-11-08  
**状态：** 设计评审稿，已完成独立实现检查与修订  
**上游文档：**
- `claude-code-mobile-control-architecture.md`
- `docs/superpowers/specs/2026-11-07-personal-mobile-claude-control-spec-breakdown-design.md`
- `docs/superpowers/specs/2026-11-07-s00-technical-validation-protocol-design.md`
- `docs/superpowers/specs/2026-11-07-s01-personal-direct-text-mvp-design.md`
- `docs/superpowers/specs/2026-11-08-s02-multi-workspace-multi-session-design.md`
- `docs/superpowers/specs/2026-11-08-s03-mobile-permission-approval-design.md`

## 1. 目的与成功结果

S04 把 S01–S03 的内存会话、run、队列、事件、命令幂等和审批审计迁移为可重启恢复的持久状态，并补齐 App 本地未确认命令、同步游标和增量恢复。目标不是让 Mac 崩溃后的任务“像没崩溃一样继续”，而是让双方在任何已知故障点都能区分：已被接受、已开始、结果未知、已结束、需要用户恢复。

成功时，用户可以：

1. 杀掉 App 后重开，使用原 commandId 恢复未确认命令，不产生第二个 run；
2. 断网、锁屏和长时间后台后，通过 `session.sync(afterSeq)` 按 sessionId+seq 补齐事件，缺日志时通过分页快照全量重同步；
3. Mac Agent 重启后继续查看项目、会话、历史事件和 Claude session 映射；
4. 看到崩溃前活跃 run 为 `interrupted + outcomeUnknown`，而不是伪造成功、失败或 cancelled；
5. 看到崩溃前 queued run 为 `recovery_required`，查看原 prompt 后显式重新入队或丢弃；
6. 确认旧 pending 审批全部 invalidated，旧 allow/deny 终态保留但绝不重新执行回调；
7. 在 Agent 重启后明确发送新 prompt，通过持久 `claudeSessionId` 恢复原 Claude 上下文；
8. 在事件清理、磁盘写失败、数据库迁移和存储上限场景中保持 fail closed，不因释放空间而删除副作用命令的幂等依据。

## 2. 入口条件与技术门禁

开始 S04 前必须满足：

- S00 Core、S01、S02、S03 全部验收通过；
- S02 的 command 指纹、每 session seq、FIFO/双槽、run 索引可复用；
- S03 的原子审批、requested 先于内容可见、先 invalidate 再 interrupt 可复用；
- 固定 Node.js 24.15.0、Agent SDK 0.3.319、Claude Code 2.1.319；
- 新增 Mac `better-sqlite3 13.0.3`、Flutter `sqflite 2.4.5`，升级时重新执行存储和真机门禁；
- 所有存储测试只使用临时 configDir、隔离 fixture 和合成正文，不复制真实个人项目、密钥或环境变量。

STORE-00 必须先以真实依赖验证：

1. better-sqlite3 在 Node 24.15.0 下可加载，同步 transaction 与 `.immediate()` 确实使用 BEGIN IMMEDIATE；
2. WAL、foreign_keys、busy timeout、synchronous=FULL、integrity_check 和 SQLite backup 在临时目录可用；
3. 在事务中模拟进程退出时，未提交命令/run/event 全部回滚，已提交记录重启后存在；
4. WAL 未 checkpoint 时通过 SQLite backup API 得到的备份仍完整，不能用普通文件复制代替；
5. sqflite 2.4.5 在真实 iPhone 可创建、迁移和重开数据库；iOS Data Protection 文件属性由原生代码验证，不能由包名推断；
6. 原生 Swift 设置数据库、WAL、SHM 文件保护后，锁定时访问按预期失败，不以降低保护级别绕过。

STORE-00 未通过时，S04 产品迁移保持 BLOCKED。当前 S00–S03 尚未实际验收，因此 S04 实施入口仍为 BLOCKED。

**当前文档基线：**本仓库目前只有架构、spec 和计划文档，没有可复用的 S00–S03 TypeScript/Dart 产品实现，也没有已部署的 S01–S03 App/Mac 客户端。S04 是明确的 spec-to-spec 设计；实施 Task 0 必须先核对届时真实代码接口和 V3/devices 文件，不能声称今天已经能复用具体类。版本兼容只要求同版本组合升级和隔离 fixture 迁移测试，不增加现网灰度、旧客户端长期支持或现场回滚工作流。

## 3. 目标、非目标与反目标

### 3.1 目标

- Mac 以单 writer SQLite 保存设备、项目、会话、run、事件、审批安全记录、命令结果、快照和审计；
- 副作用命令的业务状态、首次 command.result 和首个领域事件在同一事务提交；
- 事件先持久化再发送，网络发送队列仍可有界丢弃，因为 afterSeq 才是补同步依据；
- App 持久保存 mutating command outbox、每 session 连续 seq、近期缓存和草稿；
- 继续执行 S02 的同 session 顺序门控，并将 run.requeue 纳入同一执行意图门控；
- 全系统始终只有一部活跃 iPhone 和一台 Mac；pair --replace/revoke 先使旧设备失效，不支持两台手机同时连接、查看或控制；
- Agent 启动先完成迁移和修复，再开放管理/手机端口或创建任何 SDK query；
- 旧 queued 进入隔离的 recovery_required，只有显式 `run.requeue` 才回到当前 FIFO 队尾；
- 旧活跃 run 进入 interrupted+outcomeUnknown，旧 pending 审批进入 invalidated/agent_shutdown；
- App 检测到 agentInstanceId 改变时，不自动重试未确认 mutating command，必须经用户确认；
- 事件保留、数据库上限、快照和同步水位可确定测试；
- App 解除配对或设备替换时清理凭证、outbox、草稿、游标和缓存。

### 3.2 非目标

S04 不包含：

- 自动恢复 SDK query、自动重放活跃/queued prompt、自动重新 allow 旧审批；
- 将崩溃前活跃 run 标记为 succeeded，或声称能判断工具副作用是否全部完成；
- 从 Claude 原生 transcript 自动对账并补写 Agent run 终态；
- 多 Agent 进程共同执行同一数据库中的队列；
- Relay、PostgreSQL、Redis、多设备同步、控制租约和推送；
- SQLCipher、自定义加密、公网零知识存储或密钥迁移到手机；
- 完整原始 SDK 日志下载、完整文件 Diff、终端输出回放系统；
- 无限事件/正文保存、自动 VACUUM、跨设备云端备份；
- S05 音频持久化、S06 launchd/诊断导出产品化。

### 3.3 反目标

以下结果视为失败：

- Agent 重启后 queued 自动开始、旧 prompt 自动重试或旧审批自动 allow；
- App 因 agentInstanceId 改变而清空历史/outbox 并生成新 commandId 重发；
- 同一副作用 commandId 在数据库重开后产生第二个 run；
- commandId 已提交但 run.queued/run 记录缺失，或事件已发送却未提交；
- 为控制数据库大小而删除副作用命令幂等记录，使旧命令可再次执行；
- 将 recovery_required 当作 queued 参与 Scheduler，或 requeue 后插到已有任务之前；
- 用 wall clock expiresAt 恢复旧 pending，或在新进程继续等待原 canUseTool Promise；
- afterSeq 存在缺口时仍按网络到达顺序渲染，或旧快照覆盖更新的本地状态；
- 数据库/WAL/备份/日志/App 普通存储出现 token、模型密钥、审批完整输入；
- 以 SQLite/sqflite 的名称宣称数据已加密。

## 4. 方案比较与选择

### 4.1 方案 A：queued 保留为 recovery_required（选定）

旧 queued prompt 保留，重启后不参与执行；用户查看正文后显式 requeue 到当前队尾，或丢弃。活跃 run 和审批按保守规则修复。

优点：排队状态不丢失，每次恢复执行都有明确授权，原 run/command 关联连续。  
代价：增加恢复状态、正文读取和 recovery generation，需要限时保存 queued prompt。

### 4.2 方案 B：旧 queued 全部取消

重启时将 queued 标为 cancelled/agent_shutdown，用户查看后作为新 prompt、新 commandId/runId 再发送。

优点：状态和调度更简单。  
代价：排队任务必须逐项重建，原命令与恢复执行的关系较弱。

**结论：**选择方案 A。恢复的是“可审阅的待恢复记录”，不是可执行队列。

## 5. 核心不变量与术语

- **持久接受不等于已执行：**prompt.send command.result=ok 只表示 run 已持久接受。
- **工具副作用无法恰好一次：**数据库提交与 SDK/文件系统之间没有全局事务，崩溃后必须保留 outcomeUnknown。
- **恢复不等于续跑：**session.resume 只读取映射和同步状态；只有新 prompt 或 run.requeue 能产生新执行。
- **events 是历史事实源，runs/sessions 是当前投影：**二者同事务更新，不能以 WSS 是否发送判断事实。
- **Mac 不建立第二套持久 Outbox：**events/commands 已支持补拉；连接 BoundedSender 仍是内存，失败不删数据库。
- **App outbox 只保存未确认 mutating command：**收到确定 command.result 后按规则清理，不作为第二套会话历史。
- **单进程单 writer：**第二个 Agent 实例不得打开同一可写执行环境。
- **先修复后服务：**迁移、integrity check、启动修复未完成前，不开放端口、不加载 Scheduler、不创建 query。
- **正文与摘要分离：**run/审批/同步摘要不含不必要的完整正文；显式正文读取不进入 command 幂等结果或 Journal。

## 6. 总体结构

```text
iPhone Flutter
  ├─ sqflite RecoveryStore
  │    ├─ mutating command outbox（含未确认 prompt 正文）
  │    ├─ per-session continuous seq / cached events
  │    └─ drafts / session summaries
  ├─ Keychain：deviceToken（唯一长期凭证位置）
  ├─ SyncCoordinator：snapshot → gap check → afterSeq pages
  └─ Recovery UI：确认重试 / 查看 prompt / requeue / discard
                 │
                 │ WSS command/sync + 认证 HTTPS prompt/content 读取
                 ▼
Mac Agent（单实例）
  ├─ Migration / Integrity / StartupRecovery
  ├─ SQLiteUnitOfWork（BEGIN IMMEDIATE）
  │    ├─ commands + business mutation + first events
  │    ├─ events + session.lastSeq / retentionFloor
  │    └─ approvals + resolved events + audit
  ├─ Scheduler / RunController / PermissionBroker
  ├─ Immutable Snapshot Pages
  └─ 内存 BoundedSender（不是持久事实源）
                 │
                 ▼
       agent.sqlite3 + WAL（0600）
       Claude Code 原生会话存储（独立既有边界）
```

## 7. Mac SQLite 与启动迁移

### 7.1 固定数据库设置

数据库默认位于 `~/.claude-remote/agent.sqlite3`，目录 0700，DB/WAL/SHM/备份均 0600。每次打开连接后验证：

```text
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
PRAGMA synchronous = FULL;
PRAGMA busy_timeout = 5000;
PRAGMA wal_autocheckpoint = 1000;
PRAGMA integrity_check;
```

- 所有写操作经同一个 better-sqlite3 连接和同步 UnitOfWork；需要竞争业务状态时使用 `.immediate()`，不得先读后写地跨 await。
- FULL 是默认值，不为提高 delta 吞吐静默改 NORMAL；性能问题先通过 50 ms/16 KiB delta 合并和批量事件解决。
- `better-sqlite3` transaction 函数内不得返回 Promise 或执行异步 SDK/网络操作；commit 后才 interrupt、resolve SDK 权限或启动 run。
- 启动时执行单实例锁，锁与 desktopId/database realpath 绑定；第二个实例返回 AGENT_ALREADY_RUNNING，不能只依赖 SQLite busy timeout 防止双 Scheduler。
- PID 文件本身不是安全凭证； stale lock 处理必须验证旧进程已不存在且没有另一实例持有锁。

### 7.2 逻辑表

| 表 | 关键字段与约束 | 正文边界 |
|---|---|---|
| `schema_meta` | schemaVersion、desktopId、migrationState | 无密钥 |
| `migration_sources` | 来源类型、配置/设备文件 SHA-256、迁移时间 | 不保存来源完整内容 |
| `devices` | deviceId、tokenHash、状态、时间 | tokenHash 可保存，明文 token 不可 |
| `workspaces` | workspaceId、displayName、rootPath、policy、状态 | 仅 Mac DB；公开列表仍无 rootPath |
| `sessions` | sessionId、workspaceId、claudeSessionId、title、状态、lastSeq、retentionFloor、时间 | claudeSessionId 非 null 时唯一 |
| `runs` | runId、sessionId、commandId、deviceId、status、promptText、promptExpiresAt、enqueueOrder、recoveryGeneration、outcomeUnknown、时间 | promptText 有保留期，列表/事件默认不复制 |
| `events` | eventId 唯一、`(sessionId,seq)` 唯一、runId/type/payloadJson/timestamp | 保存可重放的有界规范化事件 |
| `approvals` | approvalId 唯一、关联 IDs、状态、fingerprint、content hash/length、原因、时间 | 不保存 originalInput/content/resultPromise |
| `commands` | commandId 唯一、actorDeviceId/localActor、kind、fingerprint、resultJson、resultExpired、时间 | 不保存原始 prompt/request payload；本机 CLI 无 deviceId，使用 localActor |
| `snapshots` | snapshotId、sessionId、lastSeq、pageCount、hash、原因、时间 | 不可变清单 |
| `snapshot_pages` | `(snapshotId,pageIndex)` 唯一、payloadJson | 每页有界，不含新 seq |
| `audit_logs` | actor/device、对象 IDs、action/result、traceId、时间 | 无 prompt/工具正文 |
| `scheduler_meta` | nextEnqueueOrder 等持久计数 | 无正文 |

补充约束：

- run 的 commandId、审批的 requestKey、快照页 ID 均有适当唯一索引；外键始终开启。
- `sessions.lastSeq` 只能随同事务中的事件插入递增，不允许单独修改。
- 原始 SDK message、完整环境变量、模型/ASR 密钥、设备明文 token 不进入任何表。
- Agent DB 保存 S01–S03 已定义的有界规范化事件；Claude 原生 transcript 仍是 Claude 完整原始上下文的存储边界，S04 不复制第二套完整原始日志。

### 7.3 配置 V4 与两阶段来源迁移

S03 的 V3 JSON 中可变 workspaces 和设备 JSON 迁移到 SQLite。V4 `agent.json` 只保留 desktopId、Tailscale/listen、数据库位置和版本等 bootstrap 配置，不再保留第二份可变项目/设备事实源。

首次迁移：

1. 获取单实例锁，校验 V3 配置和 devices 文件权限、schema 与哈希；
2. 在一个 SQLite 事务中创建 schema、导入原 IDs/tokenHash/rootPath/policy，并记录 migration_sources；
3. 提交后执行 integrity_check 和逐项目/设备计数核对；
4. 保留 `agent.json.v3.pre-sqlite.bak` 与原 devices 备份，权限 0600；
5. 原子写入 V4，之后只从 SQLite 读取项目和设备。

崩溃恢复：

- V3 + 已存在带相同来源哈希的 DB：视为“DB 已提交、V4 尚未写完”，核对后继续完成 V4，不重复导入；
- V3 + 来源哈希不匹配、V4 + DB 缺失、V4 + migrationState 不完整：全部 fail closed，返回 STORAGE_MIGRATION_CONFLICT/STORAGE_UNAVAILABLE；
- 不得在 V4 缺失 DB 时从旧 JSON 静默重建空库或继续执行；
- 迁移前使用 SQLite backup API 创建 pre-migration 备份，不能在 WAL 活跃时直接复制主 DB 文件；
- schema 迁移只向前，使用 user_version/schema_meta 和事务；不支持自动向下迁移。

### 7.4 损坏与版本不兼容

- integrity_check、外键检查、必要 JSON 解码或唯一约束失败时返回 STORAGE_CORRUPT，不开放执行服务；
- 可以修复的未完成事务由 SQLite 回滚，不能由应用随意删除“看起来异常”的行；
- 不兼容的未来 schema 只读打开也必须先证明不会误解释字段，否则拒绝启动；S06 再统一诊断导出；
- 所有备份包含敏感历史，沿用 0600 和 macOS 用户/FileVault 边界，不上传、不写日志正文。

## 8. 事务与命令幂等

### 8.1 副作用命令原子提交

`prompt.send、run.cancel、queue.remove、permission.respond、run.requeue、session.create/rename/archive、workspace set-approval、revoke` 等 mutating command 使用同一模式：

1. 完成信封/schema/设备认证；
2. BEGIN IMMEDIATE；
3. 在事务内重新读取目标状态、当前策略、设备、workspace realpath 所需状态和 commandId；
4. commandId 已存在：同 fingerprint 返回首次结果，不同 fingerprint 返回 COMMAND_ID_CONFLICT，均不执行业务；
5. 首次命令：写业务记录、必要的 run/session/approval 状态、首批事件、审计和首次 command.result；
6. COMMIT；
7. commit 后才更新内存句柄、启动 Scheduler、resolve SDK Promise 或调用 interrupt；
8. 发送 command.result/事件；发送失败不修改已提交事实。

`prompt.send` 的首次结果在 S04 固定为 `status:'queued'`。即使它随后立即可调度，也通过后续 run.started 表达，不再为了让首次结果写成 starting 而把 SDK 启动放进事务。S02 的 queued|starting 因此收窄为 queued，App 已需兼容 queued。

### 8.2 只读命令结果与保留

`session.sync/session.snapshot/workspace.list/session.list` 等 read-only command 也保存首次结果，避免同 commandId 重试返回不同页面：

- 结果正文保留 7 天；之后删除 resultJson，但永久保留 commandId/fingerprint/resultExpired 紧凑墓碑；
- 同 fingerprint 的过期重试返回 COMMAND_RESULT_EXPIRED，App 必须用新 commandId 发起新读取；
- 不同 fingerprint 始终 COMMAND_ID_CONFLICT；
- mutating command 的首次结果和安全墓碑不自动过期，不能因存储清理重新执行；
- schema/auth 失败在业务命令接收前发生，可不创建命令记录；一旦已产生业务结果，成功或业务错误都按上述规则保存；
- STORAGE_UNAVAILABLE 无法提交时不伪装已记录，允许同 commandId 在存储恢复后重试。

### 8.3 事件提交

- EventJournal 的 append 变为事务操作：分配 seq、插 events、更新 sessions.lastSeq，并与对应 run/approval/session 投影同时提交；
- commit 成功后才 publish 到 ConnectionManager；发布失败只影响当前连接，不影响 afterSeq；
- delta 继续按相邻同 assistant/content block、50 ms 或 16 KiB 合并；run result/close 前必须 flush；
- 强杀可能丢失最多一个未 flush 的 delta 窗口，恢复 run 标记 `eventTailMayBeIncomplete=true`，不得从 Claude 原生记录猜测补齐；
- 数据库写失败时不得先发送事件。Agent 进入 storage degraded，拒绝新 run 和新 allow，取消/关闭活跃 Adapter 以尽力止损；无法写入的终态留待下次启动修复。

### 8.4 审批事务

- pending 创建时，DB 只保存安全摘要/审计和 requested 事件；完整 originalInput/content 仍只存在 pending 内存；
- permission.respond 在同一事务中完成 pending 检查、终态、resolved 事件、审计和首次 command.result；commit 后才 resolve allow/deny；
- allow commit 后、callback resolve 前崩溃：审批仍 approved_once，run 启动修复为 interrupted+outcomeUnknown，不能再次 allow；
- run.cancel 事务同时写 cancelling、该 run 全部 pending invalidated/run_cancelled、resolved 事件和 command result；commit 后才 resolve deny 和 interrupt；
- timeout/abort/policy/revoke 沿用 S03 reducer；正常可写时，每个终态与事件持久提交后才对 SDK 生效，写失败则只能走下述立即 deny 的降级路径；
- Agent 启动时所有 DB pending 均 invalidated/agent_shutdown，完整内容 endpoint 永不读取 DB 重建正文；
- 任一审批终态事务提交失败时，不得让 canUseTool 无限等待：立即清理本地正文并以 interrupt:false deny，标记 storage degraded，不发送未持久化的 resolved；allow 绝不能因“稍后再补写”先生效。下次启动仍将 DB pending 修复为 invalidated。

## 9. Agent 启动修复

### 9.1 Run 状态扩展

```ts
type RunStatus = S02Status | 'waiting_approval' | 'recovery_required'

type RunRecovery = {
  outcomeUnknown: boolean
  eventTailMayBeIncomplete: boolean
  recoveryGeneration: number
  recoveryReason: 'agent_shutdown' | null
}
```

- recovery_required 是非活跃、非 queued、非终态的可恢复状态，不占执行槽、不阻塞 FIFO，也不阻止普通新 prompt；但为避免把待恢复任务藏进只读历史，session.archive/workspace remove 仍将其视为 SESSION_BUSY/WORKSPACE_BUSY，需先 requeue 或 discard；
- interrupted 是终态，outcomeUnknown=true 表示工具/SDK 最终结果未完整观察，不等于已失败或已取消；
- cancelling 在崩溃后也进入 interrupted+outcomeUnknown，因为无法证明 interrupt 已完成；
- recovery_required 只能由 queued 经启动修复产生，不能由 starting/running/waiting_approval/cancelling 产生。

### 9.2 单一修复事务

新进程生成新的 agentInstanceId，在开放端口前执行：

| 重启前记录 | 修复结果 | 同事务事件 |
|---|---|---|
| queued | recovery_required，recoveryGeneration+1，保留 prompt | run.recovery_required |
| starting/running/waiting_approval/cancelling | interrupted，outcomeUnknown=true，清空 activeRun | run.completed(interrupted/agent_shutdown) |
| pending approval | invalidated/agent_shutdown | permission.resolved |
| approved_once/denied/expired/invalidated | 保持原终态 | 无重复 resolved |
| 已终态 run | 保持，不补成功 | 无 |

- SessionRecord 的 claudeSessionId、lastSeq、标题和归档状态保留；没有受信 Claude ID 时仍为 null。
- recoveryRequiredRuns 与 queuedRuns 分开投影，Scheduler 只读取 queued。
- 修复事务中的每个事件仍占用目标 session 的下一个 seq。
- 修复失败或中途强杀时整体回滚/由 SQLite 恢复，下次启动重试；不得半开放服务。
- 修复完成后才创建 Scheduler/Broker 内存索引和加载连接；没有自动 driver.startRun。

## 10. 显式恢复执行

### 10.1 run.requeue

新增命令：

```json
{
  "type": "run.requeue",
  "sessionId": "session_01...",
  "runId": "run_01...",
  "payload": {"expectedRecoveryGeneration": 1}
}
```

规则：

- 只接受 recovery_required，generation 不匹配返回 RECOVERY_GENERATION_CONFLICT，其他状态返回 RUN_NOT_RECOVERABLE；
- 事务内重新校验当前设备、workspace 仍存在且 realpath 未替换、session 未归档、queue 容量和 promptText 可读；
- 成功后使用同一 runId、原 prompt 和原 prompt commandId 关联，生成新的 enqueueOrder，排到**当前队尾**；
- `run.requeue` 自身使用新 commandId，并持久化首次结果；
- 新 run.queued 事件包含 `requeued:true、recoveryGeneration、originalEnqueuedAt`，不包含 prompt 正文；
- 新进程再次崩溃可再次 recovery_required，generation 递增；旧 requeue 请求不能跨 generation 生效；
- requeue 后权限仍按当前 workspace/mobileApprovalMode 和 Claude Code 规则执行，不继承旧审批。

### 10.2 查看正文与丢弃

```http
GET /v1/runs/{runId}/prompt
Authorization: Bearer <deviceId>.<deviceToken>
Cache-Control: no-store
```

- 仅当前已配对设备、run 仍存在且 promptText 非 null 时可读；响应只含 runId/text，最大 16 KiB；
- 不进入 command 幂等结果、Journal 或访问日志正文；
- App 在 requeue 前必须加载并展示原 prompt，但未加载也可选择丢弃；
- `queue.remove` 扩展为同时接受 queued 和 recovery_required；后者转为 cancelled/recovery_discarded 并立即清 promptText；
- recovery_required 不调用 SDK interrupt，因为从未启动新进程中的 query。

### 10.3 恢复 Claude 会话

- `session.resume` 只返回持久会话与同步状态，不创建 query；
- interrupted run 没有 requeue 入口，避免自动重复原任务；
- 用户明确发送新 prompt 时，Adapter 按 S00 已验证方式使用持久 claudeSessionId resume；
- UI 提示“上次执行结果未知，Claude 会话可能包含部分上下文”；不得自动向模型发送“继续上次任务”；
- CLI 与 App 仍不得同时写入同一受管会话。

## 11. 同步协议

### 11.1 session.sync

```json
{
  "type": "session.sync",
  "sessionId": "session_01...",
  "payload": {"afterSeq": 128, "limit": 100}
}
```

- afterSeq 为非负整数，limit 默认 100、最大 100；每页同时受 payload 48 KiB、总消息 64 KiB 限制，可少于 limit；
- Mac 在目标 session 的一致读边界捕获 `lastSeq=L` 和 `retentionFloor=F`；F 表示已连续清理的最大 seq，初始为 0；
- `afterSeq > L` 或 `afterSeq < F`：返回 RESYNC_REQUIRED 和不可变 snapshot manifest；
- `L-afterSeq > 1000`：为避免长离线无限重放，返回 RESYNC_REQUIRED；
- 否则返回从 afterSeq+1 开始的有序事件、`nextAfterSeq、lastSeq、hasMore`；最后一页附带同一捕获点的易失状态摘要；
- afterSeq==F 时下一事件应为 F+1，或 F==L 表示当前无保留事件；不能用 MIN(seq) 猜测丢失区间；
- session.sync 是控制命令，不占新 seq；其中包含的历史事件保留原 eventId/seq/timestamp。

### 11.2 直播与分页竞争

- 每次 sync 捕获和回复排入目标 session 临界区后，后续 live event 才发布；eventId 去重可吸收分页与直播重复；
- App 在每 session 按 seq 合并，只有 `seq==lastContiguousSeq+1` 才推进连续游标；
- gap 期间暂存乱序事件，单 session 最多 200 条/2 MiB；超限停止渲染新乱序事件并重新 sync；
- 只有全部中间页应用后，才应用最后一页的易失状态摘要；live seq>L 保留并在其后重放；
- 相同 eventId 不同 sessionId/seq/payload 属于 SYNC_CONFLICT，App 清除该 session 缓存并 RESYNC，不选择先到的版本。

### 11.3 分页快照

`session.snapshot` 支持 `{sessionId,snapshotId?,pageIndex?}`：

- 新请求在一致读边界创建不可变 snapshotId，记录 lastSeq、pageCount、byteLength 和 SHA-256；
- 第 0 页包含 session/activeRun/queuedRuns/recoveryRequiredRuns/pendingApprovals、recentEvents 首批和 manifest；后续页只包含后续 recentEvents；
- 每页总消息 <=64 KiB、payload <=48 KiB，最多 8 页；先保留所有安全/易失状态，再缩减 recentEvents，不为大事件删除 pending 或 recovery 状态；
- snapshot 是控制消息，不占 seq；所有页共享同一 snapshotId/lastSeq/hash；
- App 收齐并校验页码、数量、byteLength/hash 后一次性应用，旧 lastSeq 快照不得覆盖较新的本地状态；
- snapshotId 在 Mac DB 保留，重启后仍可读取；被清理时返回 SNAPSHOT_NOT_FOUND，App 以新 commandId 请求新快照；
- RESYNC_REQUIRED 只携带安全 manifest，不把整份快照塞入错误 details。

### 11.4 新增状态与错误码

- 状态/字段：recovery_required、outcomeUnknown、eventTailMayBeIncomplete、recoveryGeneration、recoveryRequiredRuns；
- `RUN_NOT_RECOVERABLE`：目标不在 recovery_required；
- `RECOVERY_GENERATION_CONFLICT`：恢复代次已变化；
- `COMMAND_RESULT_EXPIRED`：只读命令首次结果已清理，需新 commandId；
- `SYNC_CONFLICT`：本地事件身份冲突，需要全量重同步；
- `SNAPSHOT_NOT_FOUND`：快照已清理或不存在；
- `STORAGE_UNAVAILABLE`、`STORAGE_LIMITED`、`STORAGE_CORRUPT`、`STORAGE_MIGRATION_CONFLICT`；
- `AGENT_ALREADY_RUNNING`：同一执行环境已有活跃实例；
- RESYNC_REQUIRED 沿用 S00，不新增另一种全量同步语义。

## 12. App 本地持久化

### 12.1 RecoveryStore

Flutter 使用 sqflite 2.4.5，数据库位于 App Application Support，而非 Documents 用户可见目录。原生 iOS 代码为 DB/WAL/SHM 设置并验证 `NSFileProtectionComplete`；包本身不提供 SQLCipher，不宣称额外加密。

逻辑表：

| 表 | 内容 | 清理规则 |
|---|---|---|
| `outbox_commands` | mutating 信封、commandId、agentInstanceId、createdAt、状态 | 确定 result 后清正文；解除配对全清 |
| `sync_cursors` | sessionId、lastContiguousSeq、lastSnapshotId | 解除配对全清 |
| `cached_events` | 有界 eventId/seq/payload | 每 session 最近 200 条、最多 10 个最近/活跃 session |
| `cached_sessions` | workspace/session 安全摘要 | 解除配对全清 |
| `drafts` | 每 session 草稿和更新时间 | 发送/用户清除/解除配对 |

- 不保存 deviceToken、模型/ASR 密钥、审批 originalInput/content、完整 run prompt endpoint 响应或 snapshot 分页临时正文；
- outbox 中尚未确认的 prompt 是必须保存的例外，仅保存到首次确定 command.result；
- 本地缓存总量目标 20 MiB；事件/摘要可淘汰，outbox、游标和用户草稿不得为释放缓存自动删除；
- 普通日志、Analytics、崩溃上下文不得序列化 outbox/drafts/cached payload。

### 12.2 Outbox 状态机

```text
persisted → sending → awaiting_ack → completed（删除正文/保留必要 UI 状态）
                     ├─ 同 agentInstanceId 网络失败 → persisted，可自动同 ID 重试
                     └─ agentInstanceId 改变 → confirmation_required
```

- 所有 mutating command 必须先写 outbox 再发送；App 被杀重启后先读 outbox，再连接 Mac；
- Agent 实例未变时，自动重试仍使用完全相同的 commandId、目标 IDs 和正文；
- ready 显示 agentInstanceId 改变时，旧未确认命令转为 confirmation_required，停止已排定的 timer/callback，不自动发送；
- 用户点击“确认查询/重试”后才恢复同 commandId 发送。若 Mac 已接受则返回 duplicate，若未接受则这是用户明确授权的第一次执行；
- command.result=ok 或确定业务错误后结束 outbox；STORAGE_UNAVAILABLE 等不可确认错误保留，INVALID_MESSAGE 要求用户修正并生成新命令；
- session.sync/snapshot/list 等只读请求不进入 mutating outbox，使用各自新 commandId 分页；
- device revoke/replace 或用户解除配对时清除整个 outbox，不把旧 deviceId 命令带到新绑定。

**同 session 执行意图门控：**S02“每 session 同时最多一个未收到首次 command.result 的 prompt.send”在 S04 保留，并扩展为每 session 最多一个未确认的 `prompt.send | run.requeue`。persisted/sending/awaiting_ack/confirmation_required 都占用该门控；其他 session 不受影响，run.cancel、queue.remove、permission.respond 不被此门控阻塞。门控释放前，后续 prompt 可以编辑草稿但不能抢先发送，其他 recovery_required 卡片只能查看或丢弃，不能并发 requeue。

confirmation_required 时用户可“确认查询/重试”或“放弃本地重试”。后者只丢弃本地 outbox 并标记旧命令结果未知，**不撤销 Mac 已接受的执行**；App 必须显示这一警告。放弃后允许新发送，因为用户已明确放弃旧意图，Mac 仍按实际接受顺序串行。RecoveryStore 用 sessionId+状态唯一约束和领域测试防止两个执行意图并发逃出持久门控。

### 12.3 本地恢复与隐私

- App 冷启动先展示本地安全摘要/缓存，再 ready→sync；离线缓存标为“可能不是最新”，不能显示为 Mac 当前状态；
- agentInstanceId 改变不再清空历史、游标或 outbox，改为启动修复后的同步和人工确认；
- 审批完整内容仍在 resolved/后台/实例改变时清除；run prompt 正文查看页采用同样内存与遮罩规则；
- App 退后台可保留加密边界内的 sqflite 缓存，但清除审批/run prompt 的临时展示内存；
- 解除配对删除 RecoveryStore、Keychain 凭证和临时文件，重配对不恢复旧缓存。

## 13. 保留、清理与存储上限

### 13.1 固定默认值

| 数据 | 默认策略 |
|---|---|
| events | 每 session 保留最近 30 天且最多最近 5,000 条，超出任一条件清理连续前缀 |
| run promptText | 从原 enqueuedAt 起最多 30 天，requeue 不延长；到期置 null，queued/recovery_required 同时改为 cancelled/retention_expired |
| approvals/audit_logs | 90 天安全元数据；完整输入从不入库 |
| read-only command resultJson | 7 天，之后永久紧凑 resultExpired 墓碑 |
| mutating command | 结果/指纹不自动删除 |
| snapshots/pages | 每 session 最新 2 份且最多 30 天 |
| sessions/workspaces/devices | 保留到显式归档/移除/吊销；授权 tombstone 不自动复活 |
| Mac DB | 512 MiB soft limit，清理目标 448 MiB |
| App 缓存 | 20 MiB，最近 200 events/session、最多 10 session |

### 13.2 清理事务

- 启动修复后及每 15 分钟执行一次，单批最多 500 events，避免长时间独占 writer；
- 每 session 只能删除连续最旧前缀；事务内更新 retentionFloor，并在首次清理前生成最新不可变快照；
- 达到全局 soft limit 时按最老事件逐批清理至 448 MiB，仍保持每 session 后缀连续；
- 不删除 mutating commands、sessions 映射或授权 tombstone 来腾空间；
- queued 或 recovery_required prompt 超过 30 天时，在同一事务中移出可调度集合、转为 cancelled/retention_expired、清正文并 append run.completed，不自动 requeue；每次 Scheduler 启动前也必须在事务中复核 promptExpiresAt/promptText，已到期的 queued 绝不能创建 query；
- starting/running/waiting_approval/cancelling 的 promptText 到期可置 null，但当前 query 不因此取消；崩溃后仍按 outcomeUnknown 修复，不恢复正文；
- soft limit 按 SQLite live pages（page_count-freelist_count）和 checkpoint 后 WAL 实际占用评估，不仅看不会因 DELETE 自动缩小的主文件长度；物理磁盘写失败仍按 STORAGE_UNAVAILABLE 处理；
- WAL 使用被动 checkpoint；不自动 VACUUM，避免阻塞和额外磁盘峰值；
- 清理后仍超过 soft limit 时进入 STORAGE_LIMITED：保留历史读取，拒绝新 run/requeue 和新 allow，不破坏旧幂等记录。用户需释放磁盘或通过后续本机存储管理处理，不能静默重置数据库。

## 14. 安全与隐私边界

- Mac DB 是包含 prompt、回复预览、路径和工具事件的敏感本地数据库；首版依赖 macOS 用户权限、0600 和 FileVault，不宣称数据库字段加密；
- App RecoveryStore 依赖 iOS sandbox 与 NSFileProtectionComplete，不宣称 SQLCipher 或安全擦除；
- token 仍只存 iPhone Keychain，Mac 只保存 SHA-256；数据库备份不包含明文 token；
- 审批 originalInput/content/resultPromise 永不入库；approved_once 审计不等于工具已执行；
- run prompt 通过认证 no-store endpoint 显式读取，不进入列表/快照/事件/命令结果；
- S01 工具预览和 S03 路径边界不变，事件持久化意味着这些预览会在 Mac DB 保留相应期限；
- 不记录 SQL 参数正文、outbox JSON、prompt、approval content、Authorization 或完整环境变量；
- 不开启 Funnel、不关闭 TLS 校验、不修改全局 settings.json、不开启 bypassPermissions；
- 核心 TypeScript 与 Dart 业务逻辑覆盖率均不低于 80%；Mock 不替代真实 SQLite 故障、SDK resume 和 iPhone E2E。

## 15. 关键故障流程

| 故障点 | 必须结果 |
|---|---|
| App 发送后被杀，Mac 未重启 | outbox 恢复原 commandId；Mac duplicate 或首次接受，最多一个 run |
| App 发送后 Mac 也重启 | agentInstanceId 改变，命令转 confirmation_required，不自动发送 |
| prompt 事务 commit 后、Scheduler 前崩溃 | run 修复为 recovery_required，不自动开始 |
| SDK 已开始、run.completed 前崩溃 | interrupted+outcomeUnknown，不自动重放 |
| allow commit 后、SDK callback 前崩溃 | approved_once 保留，run outcomeUnknown，旧审批不重发 allow |
| 工具已产生副作用、SDK result 前崩溃 | 不推定成功/失败，不自动执行第二次 |
| pending 时崩溃 | invalidated/agent_shutdown，内容不可读，迟到响应不能 allow |
| 事件 DB commit 失败 | 不发送该事件，拒绝新执行/allow，活跃 run 尽力取消并留待修复 |
| afterSeq 跨越已清理区间 | RESYNC_REQUIRED + 分页快照，不跳号假装连续 |
| 第二 Agent 打开同一 DB | AGENT_ALREADY_RUNNING，不形成第二 Scheduler |
| Mac 休眠/断电 | 不承诺执行连续；恢复后按启动修复和同步处理 |
| App 解除配对 | Keychain、outbox、草稿、游标和缓存全部清理 |

## 16. 兼容、升级与回滚

- 协议 V1 做增量扩展：run.requeue、session.sync、快照分页和恢复字段；App/Mac 同版本组合升级；
- 旧 App 遇到 recovery/sync 新类型不得忽略后继续执行，必须进入 VERSION_INCOMPATIBLE/RESYNC_REQUIRED 安全状态；
- S02 prompt.send 首次结果收窄为 queued；queue.remove 扩展至 recovery_required；S02 其他 FIFO/cancel 语义不变；
- S02“终态 prompt 立即清 null”在 S04 修订为 Mac DB 有 30 天保留，公开摘要仍不含正文；
- S03 审批完整内容不持久化是明确隐私决策，未来改变必须另开 spec；
- 回滚 S03 前必须停止 Agent、完成备份并确认没有未处理迁移；旧版本看不到 S04 新历史，不得把旧 JSON 备份称为完整回滚；
- 不因回滚删除 SQLite；恢复原 V3 JSON 只能恢复旧项目/设备配置，不能恢复旧内存 run/审批；
- 当前目录不是 Git 仓库，不因本 spec 自动初始化、提交或回滚 Git。

## 17. 测试策略

### 17.1 Mac 单元与集成

| ID | 场景 | 通过标准 |
|---|---|---|
| DB-01 | WAL/foreign key/FULL/备份 | 设置真实生效，WAL 下备份完整，权限 0600 |
| DB-02 | V3→V4 两阶段迁移 | IDs/policy/tokenHash 保留，崩溃点不重复导入，不双事实源 |
| DB-03 | schema/损坏/第二实例 | 损坏 fail closed，第二实例无 Scheduler/query |
| TX-01 | prompt 并发与重启重试 | 同 commandId 同 fingerprint 只一 run，冲突无副作用 |
| TX-02 | commit 前后故障注入 | 未提交全回滚；已提交业务+事件+result 同在或同不在 |
| TX-03 | read-only 结果过期 | 7 天后墓碑返回 COMMAND_RESULT_EXPIRED，不重新计算旧页面 |
| EVENT-01 | 先 DB 后发送/写失败 | 发送失败可 afterSeq；DB 失败不发送且 degraded；pending callback 立即 interrupt:false deny，不无限等待 |
| REC-01 | 活跃/queued/pending 启动修复 | 状态、事件、generation、outcomeUnknown 全符合表 |
| REC-02 | requeue/generation/remove | 显式到队尾，旧 generation 拒绝，丢弃清正文 |
| SYNC-01 | afterSeq/直播/乱序 | 无重复无跳号，跨 session 不串线 |
| SYNC-02 | retentionFloor/1000 上限 | 缺口和长离线 RESYNC，不伪造连续 |
| SNAP-01 | 8 页/大小/旧快照 | 收齐校验后应用，安全状态不丢，旧快照不覆盖新状态 |
| RET-01 | 时间/条数/容量/queued 到期清理 | 连续前缀、快照先建、mutating 幂等记录不删；到期 queued 原子取消且 driver 从未启动 |
| SEC-01 | DB/日志/endpoint 扫描 | 无 token/密钥/审批正文，prompt 只经 no-store 读取 |

### 17.2 Flutter 单元、Widget 与真机存储

- outbox 先持久后发送，同实例自动重试同 ID，跨实例 confirmation_required 且旧 timer 不发送；
- 同 session 的 prompt.send/run.requeue 持久门控在 App 被杀后仍只有一项未确认；confirmation_required 的确认/放弃语义明确，其他 session 和 cancel/deny 不被阻塞；
- App 被杀恢复 outbox/cursor/draft，收到确定 result 清正文；
- afterSeq 连续性、乱序缓冲、eventId 冲突、200 条/2 MiB 上限；
- 多页 snapshot 收齐/hash 后应用，旧 snapshot 不覆盖新事件；
- recovery prompt 查看、requeue/discard、generation 错误和后台清正文；
- 缓存 200/10/20 MiB 淘汰不删除 outbox/cursor/draft；
- revoke/replace/unpair 全清，真机验证 DB/WAL/SHM Data Protection；
- Widget/log/崩溃上下文不输出真实 prompt、token 或审批正文。

### 17.3 真实 SDK 与故障注入

Mock 只用于确定性故障点；以下必须使用真实 SQLite、固定 SDK 和隔离 fixture：

1. 完成 run 后强杀重启，确认无自动 query，再由用户新 prompt 恢复同一 Claude 上下文；
2. 活跃 run 中强杀，验证 interrupted+outcomeUnknown 和 eventTailMayBeIncomplete；
3. 在 prompt commit、event commit、approval commit、修复事务和迁移事务前后分别故障注入；
4. 使用无害固定命令证明崩溃后没有自动第二次副作用；
5. 真实 iPhone 验证锁屏、Data Protection、App 被杀和数据库重开。

### 17.4 真机端到端验收

| ID | 操作 | 通过标准 |
|---|---|---|
| E2E-01 | V3 升级 V4 | 项目/设备/策略/会话映射正确，无权限扩大 |
| E2E-02 | App 在 prompt ACK 前后被杀 | 同 commandId 恢复，只有一个 run |
| E2E-03 | App 与 Agent 都重启且有未确认命令 | 不自动重试，用户确认后才查询/执行 |
| E2E-04 | 活跃 run 时强杀 Agent | interrupted+outcomeUnknown，无自动重放 |
| E2E-05 | queued 时强杀 Agent | recovery_required 可查看/丢弃，不参与 Scheduler |
| E2E-06 | 显式 requeue | 看过原 prompt，确认后排到当前队尾，只执行一次 |
| E2E-07 | 跨另一次重启使用旧 requeue | generation 冲突，不产生执行 |
| E2E-08 | pending 时强杀 Agent | invalidated，旧内容/响应无效，不自动 allow |
| E2E-09 | allow commit 附近故障注入 | 原审批历史稳定，run outcomeUnknown，无二次工具副作用 |
| E2E-10 | 高频输出中断网再恢复 | afterSeq 无重复/错乱，活跃状态准确 |
| E2E-11 | 清理事件后旧客户端重连 | RESYNC_REQUIRED，多页快照恢复 |
| E2E-12 | 模拟磁盘写失败/容量上限 | 不发送未持久事件，不执行新 allow/run，不删幂等墓碑 |
| E2E-13 | 启动第二实例/损坏迁移 | fail closed，无双 Scheduler、无静默重建 |
| E2E-14 | 重启后用户发送新 prompt | 真实 SDK resume 同一 Claude 会话，无自动继续旧任务 |
| E2E-15 | revoke/replace/unpair | App 敏感缓存、outbox、草稿和凭证全部清理 |

## 18. 完成标准

S03 验收仍有效，且同时满足：

- STORE-00、Mac/Flutter 核心测试和真实 SQLite 故障注入通过，TypeScript/Dart 覆盖率均 >=80%；
- E2E-01–15 在真实 iPhone、Mac、Tailscale、SQLite 和固定 Agent SDK 中通过；
- 副作用 commandId 跨重启幂等，未确认命令跨 Agent 实例必须人工确认；
- 活跃 run 不伪造成功，queued 不自动执行，旧 pending 不自动有效；
- requeue 只由用户显式触发并排当前队尾，generation 可防旧请求；
- 事件先 DB 后发送，afterSeq/快照在乱序、重复和清理后保持一致；
- 保留清理不会删除副作用幂等依据，存储故障不静默放行；
- 审批完整正文、token、模型/ASR 密钥不进入 DB/日志/App 普通存储；
- 文档明确 Mac DB/FileVault、iOS Data Protection、30 天正文保留和 outcomeUnknown 限制。

## 19. 留给实现者的事项

实现者可决定：

- Repository/UnitOfWork 文件拆分、SQL migration 文件命名和索引物理布局；
- 单实例锁的成熟库实现，但必须满足 stale lock 与第二实例测试；
- Swift Data Protection 设置/验证的最小原生代码结构；
- SnapshotCoordinator、SyncCoordinator 和 RecoveryStore 内部类命名；
- 清理批处理调度、快照页分组算法和 UI 视觉样式；
- 故障注入点封装和测试 fixture 内容。

不得自行改变：

- 方案 A recovery_required、显式 requeue 到队尾和 generation；
- interrupted+outcomeUnknown、旧 pending invalidated、无自动重放；
- mutating command 永久幂等墓碑、事件先 DB 后发送；
- agentInstanceId 改变后 App 不自动重试未确认命令，同 session prompt.send/run.requeue 持久顺序门控不绕过；
- 全系统只有一部活跃设备，pair replace 不产生第二控制端；
- WAL/FULL/单 writer/先修复后服务；
- 审批正文不入库、prompt 不经普通摘要公开、token/密钥边界；
- 固定保留与容量默认值、RESYNC_REQUIRED 和存储失败 fail closed。

## 20. 后续接口预留

- S05 复用 mutating outbox 的 prompt.send 契约，音频默认不入 RecoveryStore；
- S06 可增加 launchd、storage doctor、备份/脱敏导出和用户主动清理，但不得改变幂等与恢复语义；
- 未来若需要自动对账 Claude 原生 transcript、加密数据库或完整原始日志，必须另开 spec；
- 多设备、Relay 和云同步不能复用本地 agentInstanceId/afterSeq 伪装实现，需要重新设计。
