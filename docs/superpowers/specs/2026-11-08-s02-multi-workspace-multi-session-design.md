# S02 详细 Spec：多项目与多会话

**版本：** V1.0  
**日期：** 2026-11-08  
**状态：** 设计已确认，实施计划已编写  
**上游文档：**
- `claude-code-mobile-control-architecture.md`
- `docs/superpowers/specs/2026-11-07-personal-mobile-claude-control-spec-breakdown-design.md`
- `docs/superpowers/specs/2026-11-07-s00-technical-validation-protocol-design.md`
- `docs/superpowers/specs/2026-11-07-s01-personal-direct-text-mvp-design.md`

## 1. 目的与成功结果

S02 把 S01 的“一个固定项目、一个受管会话、忙碌拒绝”扩展为个人日常可用的多项目、多会话控制工具。用户仍然只使用一部 iPhone 控制一台 Mac，但可以在 Mac 预先授权的多个项目之间切换，创建、恢复、重命名和归档多个受管会话，并在同一会话中连续发送多条按顺序执行的 prompt。

S02 同时建立明确的队列和并发模型：同一会话严格串行，不同会话可以并行，但整台 Mac 最多同时执行两个 run。取消当前 run 不会清空队列；队列中的下一条会在资源清理完成后自动开始。用户必须能在手机上看到并移除尚未开始的队列项。

成功时，用户可以：

1. 在 Mac 本机添加、查看、重命名和移除项目授权；
2. 在 App 中只看到已授权项目的公开名称，不能提交任意工作目录；
3. 为项目创建多个会话，并在进程内恢复、切换、重命名和归档；
4. 在一个会话运行期间继续发送 prompt，看到它进入队列而不是收到 `SESSION_BUSY`；
5. 同时运行属于不同会话的最多两个 run，第三组工作按规则等待；
6. 取消指定活跃 run，或单独移除指定 queued run，不影响其他会话；
7. 在会话之间切换、断线重连和请求快照时，不混淆消息、工具事件、run 或队列；
8. 明确知道 S02 的历史和队列仍是 Agent 进程内存状态，Mac Agent 重启后不会自动恢复或重放。

## 2. 入口条件与当前状态

开始 S02 实施前必须满足：

- S00 Core gate 为 PASS，协议 V1 schema 和真实 SDK 证据完整；
- S01 已完成，核心 TypeScript/Dart 覆盖率达标，E2E-01–12 在真实 iPhone、Mac 和 Tailscale 环境通过；
- S01 的配对、设备鉴权、连接代次、命令幂等、内存 Journal、快照和 RunController 可复用；
- S00 已证明同一 Claude session 可通过 `claudeSessionId` 在新 query 中恢复；
- S02 实施第一阶段必须通过新增 CONC-01 并发门禁：两个不同 Claude session 在同一 workspace 并发、在不同 workspace 并发，以及在另一 query 存活时独立 interrupt 其中一个 query，均有真实 SDK 证据；未通过则双执行槽实施和验收保持 BLOCKED，必须回到架构层决定是否改为单槽，不能静默降级后仍宣称本 spec 通过；
- 至少准备两个隔离测试项目，不使用真实个人项目做验收；
- S01 的 `canUseTool` 默认拒绝行为保持不变。

**当前文档编写时，S00 和 S01 尚未实际实施，因此 S02 实施入口仍为 BLOCKED。设计完成不代表入口条件已经满足。**

如果 S01 实现与 S01 spec 存在已确认偏差，S02 计划必须先列出实际接口和协议差异，不得假装已有组件完全符合设计。

## 3. 目标、非目标与反目标

### 3.1 目标

- Mac 本机维护最多 50 个项目授权，保存稳定 `workspaceId`、显示名、规范化真实路径和最小队列策略；
- App 提供项目列表、会话列表、创建、进程内恢复、切换、重命名和归档；
- 本地 `sessionId` 与 `claudeSessionId` 一一对应，运行期间不得改绑到另一个 Claude 会话；
- 每个会话一个 FIFO 队列，每个 prompt 对应唯一 `runId`；
- 全局最多两个活跃 run，`starting/running/cancelling` 都占执行槽；
- 每会话最多 20 条 queued run，全局最多 100 条 queued run；
- 队列可查看、可移除；活跃 run 可单独取消，二者使用不同命令；
- 不同会话的 Journal、seq、快照、事件归并和 composer 草稿相互隔离；
- 配置与项目授权跨 Agent 重启保留；会话、run、队列、事件和命令幂等仍只保存在内存；
- 协议 V1 采用向后兼容的字段和类型扩展，不创建 S02 私有信封。

### 3.2 非目标

S02 不包含：

- SQLite、持久会话历史、持久命令幂等、`afterSeq` 增量同步和 Agent 重启恢复；
- 从手机添加项目、输入任意路径、修改 Mac 项目策略或管理设备；
- 导入、搜索或接管已有 Claude Code CLI 历史会话；
- 同时从 CLI 和 App 写入同一受管会话；
- 手机权限审批、“始终允许”、永久规则编辑或全局 `bypassPermissions`；
- 多设备订阅、控制租约、多用户、公网 Relay、Tailscale Funnel 和推送；
- Git worktree、自动任务调度、复杂项目看板和跨项目依赖；
- 队列持久化、批量清空队列、队列项拖拽排序和优先级编辑；
- 语音、launchd、完整诊断平台和无限历史保存承诺。

### 3.3 反目标

以下结果视为失败：

- App 通过 `rootPath`、`cwd` 或符号链接变更获得未授权目录；
- 同一会话出现两个活跃 SDK query，或 queued run 越过前一项执行；
- 取消当前 run 隐式删除其他 queued prompt，或移除 queued run 误取消活跃 run；
- 某会话因等待自身活跃 run 而阻塞其他本来可执行的会话；
- 项目移除或会话归档后，已排队 prompt 仍然开始执行；
- 一个会话的快照清空另一个会话的时间线，或不同会话相同的 seq 被当作冲突；
- 重试命令因当前 UI 已切换会话而写入新会话；
- 重复 `commandId` 被用于不同 prompt 时仍返回成功或执行第二次；
- Agent 重启后自动重放 queued prompt，或把空会话列表称为历史恢复成功；
- 为实现并发而共享 SDK query、Streaming Input 或 Adapter 运行状态；
- 为演示工具执行而默认批准权限或写入永久允许规则。

## 4. 方案比较与选择

### 4.1 方案 A：内存多会话 + 每会话 FIFO + 全局双并发（选定）

在 S01 上增加 WorkspaceManager、SessionRegistry 和 Scheduler。会话元数据、队列和 Journal 保持进程内存，项目授权保留在本地配置。

优点：完整覆盖 S02 用户能力，保持 S04 的持久化边界；不同项目可独立工作，调度规则可确定测试。  
代价：必须处理跨会话路由、全局容量、队列竞态和进程重启的明确失效。

### 4.2 方案 B：多会话但全局单执行器

所有会话共享一个执行槽，仍提供每会话队列。

优点：调度简单、资源使用最低。  
代价：一个长任务会阻塞所有项目，多会话的日常价值和真实并发路径都较弱。

### 4.3 方案 C：S02 同时加入 SQLite 和崩溃恢复

在多会话阶段直接实现持久命令、事件同步和重启修复。

优点：更早获得持久历史。  
代价：混合 S02/S04 两个独立验收目标，事务幂等和恢复问题会掩盖队列与会话隔离问题。

**结论：**采用方案 A。全局并发固定为 2，不由 App 配置；后续如需调整，必须经过新的资源和网关限流评估。

## 5. 总体结构

```text
iPhone Flutter App
  ├─ PairingView
  ├─ WorkspaceListView
  ├─ SessionListView
  ├─ ChatView + QueuePanel
  ├─ Per-session Riverpod State / Reducers
  └─ Keychain Device Credential
                 │
                 │ 既有 Tailscale Serve + WSS
                 ▼
Mac Node.js Agent
  ├─ Local CLI / Unix Admin Socket
  ├─ WorkspaceManager + Protected Local Config
  ├─ SessionRegistry（多 SessionRecord）
  ├─ Scheduler（全局双执行槽）
  ├─ Per-session FIFO Run Queue
  ├─ RunController + Per-run Adapter Handle
  ├─ Per-session EventJournal + SnapshotFactory
  ├─ CommandRouter + In-memory Idempotency
  └─ ConnectionManager（向单个已配对设备广播）
                 │
                 ▼
Claude Agent SDK / Claude Code Runtime
  ├─ 每个活跃 run 一个独立 query
  ├─ 每个 session 独立 claudeSessionId 映射
  └─ 每个 workspace 固定真实 cwd
```

Mac 仍是项目、会话、run、队列和事件的事实源。App 的“当前会话”只是本地 UI 选择，不是 Mac 全局唯一附着点，也不会停止其他会话的任务。

## 6. Mac 项目授权管理

### 6.1 CLI 与本机管理边界

在 S01 CLI 上增加：

```text
claude-remote-agent workspace add --path <absolute-path> --name <display-name>
claude-remote-agent workspace list
claude-remote-agent workspace rename <workspaceId> --name <display-name>
claude-remote-agent workspace remove <workspaceId>
```

规则：

- `workspace list` 可离线读取配置；add/rename/remove 通过 `~/.claude-remote/agent.sock` 序列化到运行中的 Agent，避免 CLI 与 Agent 双写内存和配置；
- 所有变更只能由 Mac 本机当前用户执行；手机协议不存在 workspace add/remove/rename；
- 管理 socket、目录权限、stale socket 处理完全沿用 S01；
- 显示名去除首尾空白后为 1–80 个 Unicode code point，不得包含控制字符；
- `workspace remove` 不是安全擦除，不删除项目文件、Claude 原生会话文件或 Mac 日志；
- App 不获得真实路径。CLI 本机列表可以显示真实路径，但默认日志不得重复记录完整个人路径。

### 6.2 配置 V2 与迁移

```json
{
  "version": 2,
  "desktopId": "desktop_01...",
  "workspaces": [
    {
      "workspaceId": "ws_01...",
      "displayName": "Fixture Alpha",
      "rootPath": "/absolute/real/path/alpha",
      "createdAt": 1762432800000,
      "policy": {
        "perSessionQueueLimit": 20
      }
    }
  ],
  "listen": {
    "host": "127.0.0.1",
    "port": 8787
  },
  "tailscale": {
    "baseUrl": "https://macbook.example-tailnet.ts.net"
  }
}
```

约束：

- S02 唯一项目策略字段为 `perSessionQueueLimit`，只能由 Mac 本机配置，合法值为 1–20，缺省 20；
- 全局 `maxActiveRuns=2` 和 `maxQueuedRuns=100` 是固定实现常量，不写入可由手机覆盖的配置；
- workspace 数量最多 50，超过时本机 add 失败；
- S01 `version:1` 的单个 `workspace` 启动时迁移为单元素 `workspaces`，保留原 `workspaceId`（包括 `default`）、displayName 和 rootPath；
- 迁移前保留权限为 `0600` 的 `agent.json.v1.bak`，新配置使用同目录临时文件、fsync 和原子 rename；失败时不启动服务，不静默创建空配置；
- 配置 V2 不复制 Claude `settings.json`、env、模型密钥或网关密钥；
- S02 仍只监听 localhost，不修改 Tailscale、设备和 TLS 配置。

### 6.3 路径校验

添加项目时：

1. 要求输入为绝对路径，目录已存在且可读；
2. 使用文件系统 `realpath` 解析符号链接，保存解析后的目录真实路径；
3. 同一真实路径重复添加时拒绝，不创建第二个 workspaceId；
4. App 永远只提交 workspaceId，Mac 从受保护配置查找 rootPath；
5. 每次新 run 启动前重新执行 realpath 和目录检查，结果必须与保存值完全一致；根目录被删除、替换或重定向时，run 失败为 `WORKSPACE_NOT_ALLOWED`，不启动 SDK query。

本机制防止远程客户端选择未授权目录和配置根路径被替换后的误用，不宣称把 Claude 工具沙箱化。工具在授权项目内是否能访问其他路径，仍由 Claude Code 自身工具和权限规则决定，S02 不新增任意 shell 或文件接口。

### 6.4 重命名与移除

- 重命名只修改 displayName，不改变 workspaceId、rootPath、Claude 会话或正在执行的 run；
- 修改 rootPath 不受支持，必须移除后重新添加；重新添加会生成新的 workspaceId；
- 移除前，目标 workspace 下不得存在任何 `starting/running/cancelling` 或 queued run，否则返回 `WORKSPACE_BUSY`；
- 移除成功后，该 workspace 及其内存会话立即从 App 列表和快照可用范围中隐藏；旧 workspaceId/sessionId 的执行命令返回 `WORKSPACE_NOT_ALLOWED`；
- 被移除项目的内存记录只保留到进程结束，用于拒绝陈旧 ID，不提供只读历史入口，也不会在重新添加同一路径时自动复活；
- 移除操作与 prompt、cancel、archive、queue.remove 在同一 Agent 内序列化，按实际先后顺序决定成功或忙碌错误，不能出现移除成功后仍启动 queued run。

## 7. 多会话数据模型与生命周期

### 7.1 内部记录

```ts
type SessionRecord = {
  sessionId: string
  workspaceId: string
  title: string
  claudeSessionId: string | null
  lifecycle: 'active' | 'archived'
  createdAt: number
  lastActivityAt: number
  activeRun: RunRecord | null
  queue: RunRecord[]
  runsById: Map<string, RunRecord>
  lastSeq: number
  lastRunStatus: TerminalRunStatus | null
}

type RunRecord = {
  runId: string
  sessionId: string
  workspaceId: string
  commandId: string
  traceId: string
  text: string | null
  status: 'queued' | 'starting' | 'running' | 'cancelling' | TerminalRunStatus
  enqueueOrder: number
  enqueuedAt: number
  startedAt: number | null
  endedAt: number | null
  errorSummary: string | null
}
```

`TerminalRunStatus = succeeded | failed | cancelled | interrupted`。`runsById` 保存本会话从创建到 Agent 进程结束的全部 run 元数据，包括终态项，供新 commandId 的 cancel/remove 区分 RUN_NOT_FOUND 与错误的运行状态；S04 再以保留策略替换它。RunRecord 的 text 只用于尚未开始的 queued run 和当前执行，进入终态时必须置为 null；所有 run 文本都不进入日志、列表或快照。S02 不宣称该内存索引有持久或无限保存能力。

### 7.2 会话公开状态

会话摘要中的 `status` 按以下优先级计算：

```text
lifecycle=archived → archived
activeRun != null → running
queue 非空 → queued
否则 → idle
```

`activeRun.status` 另行表达 starting/running/cancelling。queued 不表示已有 SDK query，running 也不表示连接状态。

### 7.3 创建与 Claude 映射

- `session.create` 只创建本地 SessionRecord，`claudeSessionId=null`，不立即启动 query；
- 第一次 prompt 被调度时创建不传 resume 的新 query，从 S00 已验证的 init/result 字段保存 Claude ID；
- 后续 run 使用该 session 自己的 Claude ID resume，不能使用工作区默认 ID 或最近其他会话 ID；
- 一旦设置 claudeSessionId，收到不同 ID 时必须将当前 run 标为 failed 并记录安全内部错误，不得改绑、拼接历史或继续当作同一会话；
- 默认标题由 Mac 使用本地时间生成 `会话 YYYY-MM-DD HH:mm`，允许重名，sessionId 才是身份；
- 不调用模型自动生成标题，不把首条 prompt 隐式写入标题。

### 7.4 恢复、切换与 S01 兼容

- `session.resume` 是“附着到仍存活的内存 SessionRecord”：校验会话和项目授权，返回摘要并发送该会话快照，不立即启动 SDK query；
- 下一次 prompt 被调度时才通过已有 claudeSessionId 创建 resume query；claudeSessionId 为 null 时按首次 run 处理；
- App 切换会话只修改本地 selectedSessionId，并请求目标快照；Mac 不维护全局 currentSessionId；
- `session.start {workspaceId}` 保留 S01 兼容语义：目标项目没有任何非归档会话时创建一个；恰有一个时附着到它；存在多个时返回 `SESSION_SELECTION_REQUIRED`，由客户端使用 list/create/resume，不能猜测最近会话；
- archived 会话不参与 session.start 的自动附着；session.resume 可查看其快照，但不能发送 prompt；
- S02 不枚举或导入任意 CLI 会话，也不提供 CLI 与 App 同时附着写入的入口。

### 7.5 重命名、列表与归档

- `session.rename` 使用与 workspace 相同的标题规则；改名不影响 Claude 映射、Journal seq、run 或队列；
- `session.list` 按 `createdAt DESC, sessionId DESC` 稳定排序，默认 limit=20，最大 50；cursor 是基于该排序键的 opaque keyset cursor，不使用易变化的 lastActivityAt 作为分页顺序；
- 列表只返回摘要，不返回 prompt、工具输入、rootPath 或事件正文；非法 cursor 返回 `INVALID_CURSOR`；
- 默认排除 archived，`includeArchived:true` 时包含；
- `session.archive` 在存在活跃或 queued run 时返回 `SESSION_BUSY`，不能先隐式取消或清空；
- 归档保留内存 Journal 供只读快照，禁止 create run；重复归档返回当前 archived 摘要，不重复修改历史；
- S02 不提供 unarchive 和永久删除会话，持久保留与清理由 S04 设计。

## 8. 队列与调度器

### 8.1 接收入队

每个合法 `prompt.send` 都执行以下原子内存步骤：

1. 校验协议、16 KiB prompt 限制、workspace 授权和 session active 状态；
2. 校验 commandId 幂等及请求一致性；
3. 检查每会话和全局 queued 上限；
4. 分配 runId、递增全局 enqueueOrder，创建 queued RunRecord；
5. 在该会话 Journal 写入 `run.queued`；
6. 在同步临界区内尝试调度，不等待任何 SDK Promise；
7. 返回该命令首次处理完成时的 `{sessionId,runId,status:'queued'|'starting'}`。

所有接受的 prompt 都先有 queued 记录。立即可执行的项可以在同一命令处理内转为 starting；run.queued 与 run.started 仍按 seq 顺序保留。若 Adapter 在启动时同步失败，已接受命令的首次结果仍表达 starting/已接受，run.completed(failed) 表达后续业务失败；不能把 command.result 改写成 run 已成功或把失败命令当作可重新创建的新 prompt。

Mac 的 enqueueOrder 只表示命令实际到达并被接受的顺序，无法恢复未到达命令的用户点击顺序。为保持用户意图顺序，App 对每个 session 同时最多允许一个尚未收到首次 command.result 的 prompt.send：收到结果后才允许发送该会话下一条；超时只能重试原 commandId，不能先把后续 prompt 发出去。不同会话的待确认命令互不影响。Agent 新实例使旧命令失效后的处理见 10.4。

`SESSION_BUSY` 不再用于普通 prompt.send 的忙碌拒绝。每会话队列达到项目策略上限或全局达到 100 时返回 `QUEUE_FULL`，details 只包含 `scope:'session'|'global'` 和对应上限，不包含 prompt 内容。

### 8.2 调度规则

- 全局最多两个 activeRun；starting、running、cancelling 全部占用执行槽，queued 不占；
- 同一会话只有 `activeRun=null` 时其队头才 eligible，队头之后的项不能越过；
- 调度器扫描所有 eligible 队头，按 enqueueOrder 升序选择，直到执行槽占满；
- 某会话队头因自身 activeRun 不可调度时，跳过该会话，不能形成全局 head-of-line blocking；
- 移除任意 queued 项后保持其余项相对顺序，不重排、不更新 prompt 文本；
- Scheduler 在同步临界区将 eligible 队头迁移为 starting 并预留槽位，随后在当前 JavaScript 调用栈内、任何 await 之前调用 Adapter.start；Adapter.start 同步创建 query、提交 Streaming Input，并把包含 interrupt/close 的 AdapterHandle 注册到 runId，SDK 初始化消息可以异步到达；
- AdapterHandle 注册后才发出 run.started(status=starting) 并返回 prompt.send 结果。其他命令只能在当前调用栈结束后处理，因此对外可见的 starting run 必然已有可取消句柄；Adapter 创建抛错时走 run.completed(failed)，并释放预留槽位；
- Adapter 按 S00 证据观察到 query 已进入可执行阶段后，通过 session.status 将 activeRun.status 更新为 running；App 不需要从首条文本或工具事件猜测 running；
- SDK 启动失败也走 run.completed(failed)，完成 Adapter 清理后释放槽位并继续调度；
- 前一个 run 的终态处理、Journal 写入和 S01 规定的有界 query 清理完成前，不得启动同一会话下一项；
- Node 异步回调不得直接修改记录；所有状态迁移通过同步 reducer/临界区返回新对象，SDK await 放在临界区外。

### 8.3 run.cancel

- run.cancel 只接受指定 sessionId+runId 的 starting/running run；cancelling 中重复的新命令返回当前 cancelling 状态，不再次调用 interrupt；
- starting 对外可见时 AdapterHandle 必然已经注册，因此取消不等待 query 创建，直接走与 running 相同的 interrupt/10 秒终态路径；
- 首次 run 在 starting 被取消时，只有在取消前已从受信 init/result 收到 Claude ID 才保存映射，否则 claudeSessionId 保持 null；终态后的迟到 init 不得补写映射，下一次 run 按首次会话处理，不能伪造或借用其他 session 的 ID；
- queued run 使用 run.cancel 返回 `RUN_NOT_ACTIVE`，安全消息提示使用 queue.remove；
- 已在 runsById 中找到的终态 run 返回 `RUN_NOT_ACTIVE`；当前进程该 session 的 runsById 中不存在时返回 `RUN_NOT_FOUND`，不能依赖最近 200 条快照事件作判断；
- 接受取消后仍沿用 S01 interrupt 与 10 秒无终态处理；
- 当前 run 终态和清理完成后自动调度同会话下一 queued run；
- **run.cancel 绝不清空队列。** App 必须在取消按钮附近和队列面板中明确说明这一点。

### 8.4 queue.remove

- 命令信封携带 sessionId+runId，payload 为 `{}`；
- 仅 queued 状态可移除，成功结果为 `{sessionId,runId,status:'cancelled',removed:true}`；
- 被移除项从未调用 Adapter，不产生 Claude 用户消息；
- Journal 写入 `run.completed(status:'cancelled',reason:'queue_removed')`，随后调度其他 eligible 项；
- starting/running/cancelling/terminal 项返回 `RUN_NOT_QUEUED`，不能为了兼容而改成 run.cancel；
- run 属于另一个 session 时返回 `RUN_SESSION_MISMATCH`，不得按全局 runId 直接删除；
- queue.remove 与调度器竞争时按同步状态迁移结果只允许一种成功：要么先移除且永不启动，要么已经进入 starting 并返回 RUN_NOT_QUEUED。

S02 不提供 clear-queue。用户需要阻止后续任务时，必须逐项移除 queued run。

## 9. 协议 V1 扩展

### 9.1 命令

| 命令 | Payload | 成功结果 | 主要错误 |
|---|---|---|---|
| `workspace.list` | `{}` | workspaces、scheduler | `UNAUTHENTICATED` |
| `session.create` | `{workspaceId,title?}` | session 摘要 | `WORKSPACE_NOT_FOUND`、`WORKSPACE_NOT_ALLOWED` |
| `session.list` | `{workspaceId,includeArchived?,limit?,cursor?}` | sessions、nextCursor | `WORKSPACE_NOT_ALLOWED`、`INVALID_CURSOR` |
| `session.resume` | `{sessionId}` | session 摘要；快照发送后返回 | `SESSION_NOT_FOUND`、`WORKSPACE_NOT_ALLOWED` |
| `session.rename` | `{sessionId,title}` | session 摘要 | `SESSION_NOT_FOUND`、`INVALID_MESSAGE` |
| `session.archive` | `{sessionId}` | archived 摘要 | `SESSION_BUSY`、`WORKSPACE_NOT_ALLOWED` |
| `session.start` | `{workspaceId}` | S01 兼容附着结果 | `SESSION_SELECTION_REQUIRED` |
| `session.snapshot` | `{sessionId}` | `{sessionId,lastSeq}`；快照后返回 | `SESSION_NOT_FOUND`、`WORKSPACE_NOT_ALLOWED` |
| `prompt.send` | `{text}`，信封含 workspaceId/sessionId | runId、queued/starting | `SESSION_ARCHIVED`、`QUEUE_FULL`、`WORKSPACE_NOT_ALLOWED` |
| `run.cancel` | `{}`，信封含 sessionId/runId | cancelling 状态 | `RUN_NOT_ACTIVE`、`RUN_SESSION_MISMATCH` |
| `queue.remove` | `{}`，信封含 sessionId/runId | cancelled、removed | `RUN_NOT_QUEUED`、`RUN_NOT_FOUND` |

`workspace.list` 返回：

```json
{
  "workspaces": [
    {"workspaceId":"ws_01...","displayName":"Fixture Alpha"}
  ],
  "scheduler": {
    "maxActiveRuns": 2,
    "activeRunCount": 1,
    "queuedRunCount": 3,
    "maxQueuedRuns": 100
  }
}
```

session.list 和 workspace.list 是拉取式摘要。App 在进入列表、完成本地变更、收到相关会话状态或重连后刷新；S02 不新增 workspace.changed 广播协议。

### 9.2 新增与扩展事件

| 事件 | Payload 关键字段 | 是否占用会话 seq |
|---|---|---|
| `run.queued` | runId、enqueuedAt、可选 waitReason=`SESSION_BUSY/GLOBAL_CAPACITY` | 是 |
| `run.started` | runId、startedAt、status=`starting` | 是 |
| `session.status` | 沿用 S01，明确承载 activeRun 从 starting 到 running 的状态 | 是 |
| `run.completed` | 沿用 S01，新增可选 reason=`queue_removed` | 是 |
| `session.snapshot` | 新增 title、queuedRuns、globalCapacity | 否；覆盖目标会话易失状态 |
| 其他 S01 事件 | 不变，信封必须携带正确 workspaceId/sessionId/runId | 沿用 S01 |

run.queued 不携带 queuePosition，因为位置会变化；App 从目标会话快照的 queuedRuns 顺序和后续事件计算当前队列。waitReason 只记录入队当时的等待原因提示，之后可能因其他 run 状态变化而过时；App 展示当前状态时必须结合 activeRun、队列和 globalCapacity，不能把历史 waitReason 当作实时调度结论。

### 9.3 快照扩展

```json
{
  "session": {
    "sessionId": "session_01...",
    "claudeSessionId": "claude_01...",
    "workspaceId": "ws_01...",
    "title": "会话 2026-11-08 10:00",
    "status": "queued"
  },
  "activeRun": null,
  "queuedRuns": [
    {"runId":"run_01...","commandId":"cmd_01...","status":"queued","enqueuedAt":1762432800000}
  ],
  "globalCapacity": {"activeRunCount":2,"maxActiveRuns":2},
  "recentEvents": [],
  "lastSeq": 12,
  "oldestIncludedSeq": 1,
  "snapshotTruncated": false
}
```

- queuedRuns 按当前 FIFO 顺序，最多该会话策略允许的 20 条，包含 runId/commandId/status/enqueuedAt，不包含 prompt 正文；
- 一个快照只覆盖其 sessionId 对应的 session/run/queue/timeline，不能清空其他会话；
- S01 的 200 条、48 KiB payload、64 KiB 总消息及摘要投影限制不变，queuedRuns 和 globalCapacity 必须计入预算；
- 不同会话各自从 seq=1 编号，相同 seq 不构成重复；eventId 仍全局唯一；
- S02 仍不实现 afterSeq。App 冷启动或缓存失效时请求目标会话完整有界快照。

### 9.4 幂等增强

- commandId 在同一 desktopId 内全局唯一，不按当前选中会话重新解释；App 使用具有全局唯一性的 UUID/ULID 等生成器，不得使用每会话从 1 开始的计数器；
- Agent 对首次命令保存类型、规范化的 workspaceId/sessionId/runId、规范化请求的 SHA-256 指纹及首次结果，不另存一份原始 prompt payload；
- 相同 commandId 且请求完全一致时返回首次结果并 `duplicate:true`，即使该 run 已推进到 running/completed，也返回最初 queued/starting 结果；当前状态以快照和事件为准；
- 相同 commandId 用于不同命令类型、会话、run 或 payload 时返回 `COMMAND_ID_CONFLICT`，不执行任何新业务操作；
- 首次结果仍在内存，Agent 重启后持久幂等不成立；App 不得在网络重连之外的 Agent 新实例中自动重放未确认 prompt。

### 9.5 新实例标识与错误码

`connection.ready` 新增 `agentInstanceId`：每次 Agent 进程启动生成的随机 ID，desktopId 保持长期稳定。App 用它区分普通网络重连和 Mac Agent 重启。

新增或明确：

- `WORKSPACE_NOT_FOUND`：workspaceId 不存在；
- `WORKSPACE_NOT_ALLOWED`：未授权、已移除或 realpath 校验失败；
- `WORKSPACE_BUSY`：本机移除时仍有活跃或 queued run；
- `SESSION_ARCHIVED`：向归档会话发送执行命令；
- `SESSION_SELECTION_REQUIRED`：S01 session.start 无法唯一附着；
- `SESSION_BUSY`：归档等要求会话完全空闲的操作被拒绝；
- `QUEUE_FULL`：会话或全局 queued 上限；
- `RUN_NOT_FOUND`：当前进程无此 run；
- `RUN_NOT_QUEUED`：queue.remove 目标已不是 queued；
- `RUN_SESSION_MISMATCH`：runId 不属于信封 sessionId；
- `COMMAND_ID_CONFLICT`：同一 commandId 的请求内容不一致；
- `INVALID_CURSOR`：列表 cursor 非法。

`WORKSPACE_LIMIT_REACHED` 和真实路径重复添加属于 Mac CLI 本机错误，不需要手机协议处理。

## 10. SDK Adapter 与事件隔离

### 10.1 每 run 独立生命周期

- 沿用 S01“一次 run 一次 query”；不同 run 不共享 query、AsyncIterable、interrupt handle 或消息收集器；
- 每个 query 使用 RunRecord 对应 workspace 的固定 rootPath 和 session 的 claudeSessionId；
- AdapterRegistry 以 runId 保存活跃 handle，以 sessionId+runId 校验所有回调；
- Adapter.start 返回前到达的回调按 runId 暂时缓冲，run.started 写入 Journal 后再按原序释放；不得在 run.started 前发出 message、tool 或 session.status；
- 每次启动分配 adapterGeneration，终态后旧 generation 的迟到事件只能记录安全诊断，不能写入新 run 或新会话 Journal；
- 全局活跃 query 数量不得多于 Scheduler 的两个执行槽；
- run 完成后从 registry 删除 handle，queued RunRecord 不存在 handle。

### 10.2 事件路由

- Normalizer 输入必须包含 Adapter 已绑定的 sessionId/runId/workspaceId，不能从当前 UI 或“最近会话”推断；
- EventJournal 按 sessionId 分实例，独立分配 seq；eventId 全局生成；
- ConnectionManager 向同一已配对设备广播所有会话事件，App 按 sessionId 路由，不引入选中会话订阅；
- session.snapshot 请求只影响目标会话；其他会话的活跃事件继续缓存；
- 同一 eventId 重复且内容一致时去重；同 eventId 内容冲突或同 sessionId+seq 内容冲突按协议错误处理，不静默覆盖；
- 不同 sessionId 下相同 seq 是合法情况，reducer 不得使用全局 seq 作为唯一键。

### 10.3 权限边界

S02 尚未实现手机审批。所有会话的 `canUseTool` 继续立即返回 S01 固定 deny，不返回 updatedPermissions，不写永久规则，不开启 bypassPermissions。排队本身不得预先触发工具权限或创建 SDK query。

### 10.4 Agent 重启

- workspaces 配置与设备绑定保留；SessionRegistry、Scheduler、queue、Journal、命令幂等表和 agentInstanceId 全部重建；
- 启动过程不读取旧内存记录，不自动恢复 Claude session，不自动重放活跃或 queued prompt；
- App 发现 agentInstanceId 变化后，使所有会话快照、时间线和未确认命令的自动重试资格失效，重新拉取 workspace.list/session.list；
- App 进程仍存活并发现 agentInstanceId 变化时，对本机仍记得的未确认或 queued prompt 显示“Mac 服务已重启，执行结果未知，请确认后手动重新发送”，不能自动沿用旧 commandId 重试，也不能宣称旧任务已取消成功；用户明确放弃旧命令后，才能在新的内存会话中创建新的 prompt 命令；
- 如果 App 也被杀，S02 没有持久待确认命令记录，冷启动只能看到新实例的空会话列表，不能补造 queued 卡片或声称已判断旧任务结果；
- 新实例中的空会话列表表示没有 S02 内存历史，完整持久恢复留待 S04。

## 11. iOS App 设计

### 11.1 页面与导航

S02 在配对流程后提供项目列表、会话列表和聊天页：

```text
项目列表                         会话列表（Fixture Alpha）
┌───────────────────────┐       ┌───────────────────────┐
│ Fixture Alpha    2 运行 │  →    │ + 新建会话             │
│ Fixture Beta     3 排队 │       │ 修复测试      运行中    │
│ 全局执行槽 1/2          │       │ 阅读代码      排队 2    │
└───────────────────────┘       │ 已归档会话 >            │
                                └───────────────────────┘

聊天页
┌─────────────────────────────┐
│ Fixture Alpha / 修复测试      │
│ 运行中 · 队列 2 · 全局 2/2    │
├─────────────────────────────┤
│ 当前会话消息与工具事件         │
├─────────────────────────────┤
│ 队列                         │
│ 1. 下一条任务       [移除]    │
│ 2. 再下一条任务     [移除]    │
│ 停止当前不会清除队列           │
├─────────────────────────────┤
│ [当前会话草稿]        [排队]  │
│ 正在执行…             [停止]  │
└─────────────────────────────┘
```

不包含手机添加项目、任意路径输入、永久删除、队列排序或批量清空。

### 11.2 Riverpod 状态

- `workspacesState`：公开项目摘要和全局 scheduler；
- `sessionsState`：按 workspace 分页的摘要和 archived 过滤；
- `selectedSessionId`：仅本地导航状态；
- `sessionStatesById`：各会话状态、Claude 映射和 activeRun；
- `timelinesBySessionId`：以 sessionId 为一级键、sessionId+seq 为事件顺序、eventId 去重；
- `queuesBySessionId`：按快照顺序和 run 事件更新的 queued run 摘要；
- `composerDraftsBySessionId`：每个会话独立草稿和待确认 command；
- `connectionState`：包含 desktopId、agentInstanceId、connectionEpoch，不与 run 状态混用。

所有更新使用不可变对象和 reducer。切换 selectedSessionId 不得修改命令目标、事件目标或其他会话草稿。

### 11.3 发送、取消和队列交互

- 活跃 run 存在或全局执行槽已满时，composer 仍可使用，按钮显示“排队”；
- 只有 QUEUE_FULL、非 online、快照同步中、archived、workspace 未授权或 prompt 非法时禁止发送；
- 点击发送时捕获当时的 sessionId/workspaceId 和 commandId；即使用户立刻切换会话，结果和重试仍归属于原会话；
- queued 卡片只在本地仍持有对应草稿时显示安全短预览；Mac 列表/快照不回传完整 prompt，也不补发正文预览；
- App 进程冷启动但 Agent 实例未变时，queuedRuns 仍然有效，未知正文的卡片显示“排队任务”、runId 短标识和 enqueuedAt，只提供移除操作，不显示虚构标题或“执行结果未知”；
- 每个 session 同时最多一个未收到首次 command.result 的 prompt.send；结果未知时保留草稿并只提供同 commandId 重试，后续草稿可编辑但不能抢先发送；
- 活跃 run 显示停止，queued run 显示移除；按钮不能混用；
- 停止前以非阻塞说明展示“只停止当前任务，后续排队任务仍会执行”；
- queue.remove 成功后立即按事件更新，失败时刷新目标会话快照；
- run.completed 后若仍有 queued 项，UI 显示等待/启动状态，不能显示整个会话已全部完成。

### 11.4 切换、重连与缓存

- App 对未知或已淘汰会话收到实时事件时，只保存该会话状态，不把事件插入当前聊天；选中该会话前先请求快照；
- 快照只替换目标会话，保留其他会话时间线、队列和草稿；
- 为避免多历史无限占用 App 内存，只保证保留当前会话及有活跃/queued run 的会话时间线；其他 idle 时间线可淘汰，重新选择时请求快照；
- S01 单工具 256 KiB 预览和截断规则在每个会话独立应用；
- 断线/退后台不取消任何活跃或 queued run；回前台重连后刷新 workspace/session 列表，并为当前及活跃会话请求快照；
- agentInstanceId 改变时按 10.4 处理，不把普通快照恢复逻辑当作重启恢复；
- archived 会话可只读查看，composer、取消和队列操作禁用。

## 12. 日志、安全与资源限制

- 沿用 S01 Tailscale Serve、系统 CA、Bearer 认证、Keychain、Mac 令牌哈希和设备 revoke，不新增网络监听；
- App、配对 QR 和协议响应不包含 rootPath、模型密钥、网关密钥或 deviceToken；
- Mac 日志默认不记录 prompt 正文、queued 文本、工具完整输入、rootPath 或完整模型回复；
- 日志可记录 workspaceId、sessionId、runId、commandId、traceId、enqueueOrder、queueDepth、scheduler 决策和安全错误码；
- 单 prompt UTF-8 1–16,384 字节，单条协议消息 64 KiB；queued 上限每会话配置 1–20、默认 20，全局 100；
- 全局执行槽固定 2，cancelling 和 Adapter 清理未完成时不提前释放；
- workspace 最多 50，session.list 每页最多 50；快照和发送队列沿用 S01 上限；
- 项目策略只能由本机管理接口修改，不能通过 connection.hello、workspaceId 或命令 details 提升权限；
- S02 不做遥测、自动上传、持久事件保留或无限内存历史承诺。

## 13. 测试策略

### 13.1 Mac 单元与集成测试

| ID | 场景 | 通过标准 |
|---|---|---|
| CONC-01 | 同 workspace 两 Claude session、跨 workspace 两 session 并发及独立 interrupt | 两个 query 真正并存且事件各自关联；中断一个不影响另一个；失败则 S02 双槽 BLOCKED，不静默改为单槽 |
| WKS-01 | V1 配置迁移、原子写入失败 | 保留 default 映射和备份；失败不启动、不生成空配置 |
| WKS-02 | 非绝对/不存在/重复真实路径/根 symlink 替换 | add 校验真实路径；运行前替换导致 WORKSPACE_NOT_ALLOWED，无 query |
| WKS-03 | 50 个项目、队列策略 1–20、非法本机配置 | 上限和策略 fail fast，App 无法修改 |
| WKS-04 | rename/remove 与活跃或 queued run | rename 不影响 run；remove 返回 WORKSPACE_BUSY；空闲移除后旧 ID 不可执行 |
| SESS-01 | create/list/resume/create-first-query | 本地 ID 独立，初始 Claude ID 为 null，恢复使用本 session 映射 |
| SESS-02 | 多页 list、archived、非法 cursor | 排序稳定、无重复页项、摘要不泄露正文/路径 |
| SESS-03 | rename 控制字符/长度、archive 与 prompt 竞争 | 标题合法；按先后顺序得到 SESSION_BUSY 或 SESSION_ARCHIVED，无归档后启动 |
| SESS-04 | session.start 零/一/多个会话 | 分别创建、附着、SESSION_SELECTION_REQUIRED，不猜测目标 |
| QUEUE-01 | 同会话连续两条 prompt | 第一项完成后第二项才创建 query，Claude resume ID 相同 |
| QUEUE-02 | 三个会话同时提交 | 最多两个 activeRun，第三个 queued；cancelling 仍占槽 |
| QUEUE-03 | 全局最老项所属会话仍忙碌 | 跳过该会话，其他 eligible 队头可运行，无全局队头阻塞 |
| QUEUE-04 | 同会话队列中间项移除 | 其他项保持 FIFO，被移除项从未调用 Adapter |
| QUEUE-05 | cancel 当前 run | 不影响其他会话；当前终态清理后下一项自动开始，队列未被隐式清空 |
| QUEUE-06 | queue.remove 与调度竞争 | 仅一种状态迁移成功，不出现移除后启动或重复 run.completed |
| QUEUE-07 | starting 首次 run 在 SDK init 前后取消 | run.started 前句柄已注册；cancel 不等待创建；Claude ID 只保存取消前受信值，迟到 init 不改绑 |
| QUEUE-08 | 新 commandId 取消/移除已终态或不存在的 run | runsById 区分 RUN_NOT_ACTIVE/RUN_NOT_QUEUED 与 RUN_NOT_FOUND，终态正文已清除 |
| QUEUE-09 | 会话/全局 QUEUE_FULL | 超限不分配新 run、不写 Journal，已有队列不变 |
| QUEUE-10 | Adapter 启动失败/终态清理 | failed 有界收尾，槽位只释放一次，后续调度不重复 |
| CMD-01 | 同 commandId 重试已推进 run | 返回首次 queued/starting 且 duplicate:true，仅一个 run；当前状态由快照提供 |
| CMD-02 | 同 commandId 改 prompt/session/run/type | COMMAND_ID_CONFLICT，无第二次副作用 |
| ISO-01 | 两会话相同 seq、重复/乱序 eventId | 按 sessionId+seq 独立归并，不串线、不重复 |
| ISO-02 | 旧 adapterGeneration 迟到事件 | 不写入新 run/session，安全诊断无正文 |
| SNAP-01 | 含 20 queued 和大事件的快照 | 不超过 48 KiB payload/64 KiB 总消息，只覆盖目标会话，不含 queued 正文 |
| RESTART-01 | 新 agentInstanceId | 配置保留，内存列表为空，不自动 resume/replay，旧命令不自动重试 |
| SEC-01 | 配置、协议、日志和错误扫描 | 无 token、密钥、Authorization、prompt 正文或非公开 rootPath |

### 13.2 Flutter 单元与 Widget 测试

- 项目/会话分页、空状态、archived 过滤和错误文案；
- 同 seq 不同 session、eventId 去重、乱序事件和快照只覆盖目标会话；
- 会话 A 发送中切换到 B，command.result、重试和草稿仍属于 A；
- 同 session 首条 prompt 结果未知时，第二条可编辑但不能发送；只能重试首条原 commandId，不同 session 不受此门控；
- App 冷启动但 agentInstanceId 未变时，无本地草稿的 queued 卡片只显示 runId/enqueuedAt 和移除，不虚构正文或结果未知；
- 活跃、queued、全局容量满、QUEUE_FULL、archived、offline 的 composer 状态；
- 停止与移除按钮分离，取消后 queued 项仍可见；
- queue.remove/run.completed/run.started 的队列 reducer，无跳项和重复；
- 切换会话保留独立草稿，idle timeline 淘汰后可快照恢复；
- 断线/后台不触发 cancel/remove，重连刷新当前和活跃会话；
- agentInstanceId 变化使旧缓存和自动重试失效，显示结果未知；
- rootPath、prompt 完整正文和 token 不出现在列表快照、Widget 日志或错误提示。

### 13.3 Mock SDK 调度集成测试

使用可控 Mock Adapter 精确控制启动、完成、失败、interrupt、迟到事件和清理时序，覆盖全部 Scheduler 与跨会话隔离用例。Mock 只能证明内部状态机，不得替代真实 SDK、Tailscale 和 iPhone 验收。

### 13.4 真机端到端验收

| ID | 操作 | 通过标准 |
|---|---|---|
| E2E-01 | Mac 授权两个隔离 fixture，App 查看项目 | 只显示授权名称，无路径；未授权 workspaceId 不能创建 run |
| E2E-02 | 在两个项目各建会话并写入不同上下文标记 | 各自 Claude 映射正确，后续提问只读取本会话上下文 |
| E2E-03 | 同一会话连续发送两条指令 | 第二条可见 queued，第一条完成后才执行，顺序正确 |
| E2E-04 | 两个不同会话执行长任务，再提交第三会话任务 | 手机显示全局双执行槽和等待状态，无会话串线 |
| E2E-05 | 移除一条 queued prompt | 该项从未执行，其他队列顺序不变 |
| E2E-06 | 取消当前活跃 run | 只取消指定 run；明确提示并观察下一 queued 项按设计开始 |
| E2E-07 | 任务运行中反复切换会话和项目 | 消息、工具、run 状态、草稿和队列不串线 |
| E2E-08 | 重命名、归档忙碌/空闲会话 | 忙碌归档拒绝；空闲归档只读，不能发送 |
| E2E-09 | 多会话运行中断网再恢复 | Mac run/queue 继续，目标快照和列表恢复，无重复消息 |
| E2E-10 | 测试客户端重复发送同 commandId | 只有一个 run，duplicate:true；改变 payload 返回冲突 |
| E2E-11 | Mac 本机移除有活跃/queued run 的项目 | WORKSPACE_BUSY；无隐式取消，空闲移除后旧 ID 不可执行 |
| E2E-12 | 有 queued prompt 时重启 Agent | 配置和绑定仍在；不自动重放；App 显示历史不可恢复及结果未知 |

## 14. 完成标准

S02 只有同时满足以下条件才能通过：

- S00 Core 与 S01 验收仍有效，CONC-01 已用真实 SDK 证明同项目和跨项目双 query 及独立 interrupt；S02 未破坏配对、TLS、权限默认拒绝和单 run 生命周期；
- Mac、协议和 Flutter 核心测试全部通过，核心 TypeScript 与 Dart 业务逻辑覆盖率均不低于 80%；
- E2E-01–12 在真实 iPhone、Mac、Tailscale、Agent SDK 和隔离项目中通过；
- App 无法添加任意目录，真实路径替换和未授权 workspaceId 均不能启动 query；
- 同会话严格 FIFO，全局活跃 run 从不超过 2，取消、移除和失败路径无悬挂或重复调度；
- 多会话消息、工具、快照、命令结果、草稿和队列按 sessionId 隔离；
- 项目移除和会话归档不会留下之后偷偷执行的 queued run；
- 命令重试不产生第二个 run，commandId 内容冲突不被当作合法重复；
- Agent 重启不自动恢复或重放任何 prompt，App 明确展示 S02 的内存限制；
- 配置、日志、QR、App 包和协议摘要中没有密钥、长期 token 明文、queued prompt 正文或非公开 rootPath；
- 文档明确记录无双设备订阅、无 CLI 历史导入、无持久队列、无 afterSeq 和无手机审批。

## 15. 回滚与兼容

- S02 对协议 V1 只做新增命令、事件和可选字段扩展，不修改 eventId/seq、command.result 和快照基础语义；
- App 与 Mac Agent 作为同一版本组合升级；旧 S01 App 遇到多个会话时会收到 SESSION_SELECTION_REQUIRED，而不是误附着；
- 回滚前必须停止所有活跃 run 并逐项移除 queued run，确认全局执行槽和队列均为空；
- 配置回滚使用迁移前的 `agent.json.v1.bak`，且只允许回到原 S01 单 workspace；不得把 V2 多项目配置截断成一个项目后静默启动；
- S02 内存会话和队列在降级/重启后不可恢复，回滚文档必须把它列为数据不可见而非“已安全完成”；
- 当前目录不是 Git 仓库，不因本 spec 自动初始化、提交或回滚 Git。

## 16. 留给实现者的事项

以下可由实现者决定，不需要新的产品决策：

- WorkspaceManager、SessionRegistry、Scheduler 的内部文件拆分和函数命名；
- Node 中 realpath、原子配置写入、规范 JSON 请求指纹和 keyset cursor 的具体库；
- Dart 模型代码生成或手写方式、Riverpod Provider 命名和列表 Widget 组件；
- 默认标题的本地时区格式细节，只要可辨识且不包含 prompt；
- 队列面板的具体视觉样式、空状态和安全短预览长度；
- 全局 enqueueOrder 的整数表示和单调生成方式，只要单进程内严格唯一；
- Mock Adapter 的测试控制接口和隔离 fixture 的无害内容。

不得自行改变：

- Mac 本机项目白名单、App 只传 workspaceId、真实路径启动前复核；
- 每会话 FIFO、全局双执行槽、每会话 20/全局 100 queued 上限；
- run.cancel 不清队列、queue.remove 仅针对 queued、无批量清空；
- 项目移除和会话归档必须无活跃/queued run；
- 每 run 独立 query、每 session 固定 Claude 映射和跨会话事件隔离；
- S02 内存历史边界，Agent 重启不得自动恢复或重放；
- S01 的 TLS、配对、密钥、权限 deny 和 localhost 管理边界。

## 17. 后续接口预留

- S03 在每个 RunRecord/Adapter handle 上关联 approvalId 和 Permission Broker；queued run 未启动前不得产生审批；
- S04 将 Workspace/Session/Run/Command/Journal 映射到 SQLite，以事务保证命令首次结果与业务状态一致，并增加 afterSeq 和重启修复；
- S04 需要明确持久化 queued prompt 后仍不得启动时自动重放；恢复策略必须重新经过用户可见状态设计；
- S05 继续只向指定 session 的 composer 写入确认识别文本，普通 prompt.send 和队列语义不变；
- S06 再基于 workspaceId/sessionId/runId 增加诊断、launchd 和统一验收，不提前引入 Relay 或多设备控制。
