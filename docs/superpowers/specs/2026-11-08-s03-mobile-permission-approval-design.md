# S03 详细 Spec：手机权限审批

**版本：** V1.0  
**日期：** 2026-11-08  
**状态：** 设计评审稿，已完成独立实现检查与修订  
**上游文档：**
- `claude-code-mobile-control-architecture.md`
- `docs/superpowers/specs/2026-11-07-personal-mobile-claude-control-spec-breakdown-design.md`
- `docs/superpowers/specs/2026-11-07-s00-technical-validation-protocol-design.md`
- `docs/superpowers/specs/2026-11-07-s01-personal-direct-text-mvp-design.md`
- `docs/superpowers/specs/2026-11-08-s02-multi-workspace-multi-session-design.md`

**SDK 设计依据（2026-11-08 核对）：**
- `https://code.claude.com/docs/en/agent-sdk/permissions.md`
- `https://code.claude.com/docs/en/agent-sdk/user-input.md`
- `https://code.claude.com/docs/en/agent-sdk/typescript.md#canusetool`

## 1. 目的与成功结果

S03 把 S01/S02 中“需要人工决策就立即 deny”的行为，扩展为由 Mac 本机逐项目明确开启的手机审批。用户可以在自己的 iPhone 上查看工具名称、完整原始输入、工作目录、触发原因和由参数生成的变更预览，然后选择“允许一次”或“拒绝”。

S03 的核心不是增加两个按钮，而是保证审批在重复回调、并发工具、超时、断线、取消、设备吊销、项目策略变化和 Agent 重启时仍然 fail closed：一个审批只能有一个终态，旧响应不能改变新状态，任何无法安全展示或关联的请求都不能被批准。

成功时，用户可以：

1. 在 Mac 上只对指定项目开启 `allow_once` 手机审批，其他项目保持原有 deny；
2. 在手机上看到一个或多个待审批请求，并准确关联到 workspace/session/run/toolUseID；
3. 在允许前加载并核对完整工具输入，而不是只看到“是否允许”或截断参数；
4. 允许一次无害 Bash 或文件修改，下一次相同请求仍需重新审批；
5. 拒绝请求后观察 Claude 按 SDK 行为继续或结束，而不是由 App 擅自判定 run 失败；
6. 在超时、断线重连、run.cancel、双会话并发和策略关闭时得到确定结果；
7. 确认没有“始终允许”、永久规则、输入修改、批量批准或全局 bypassPermissions。

## 2. 入口条件与技术门禁

开始 S03 前必须满足：

- S00 Core、S01 和 S02 全部验收通过；
- S02 的多会话、双槽 Scheduler、每 run 独立 AdapterHandle、agentInstanceId 和快照可复用；
- 固定 Agent SDK 0.3.319、Claude Code 2.1.319；若实际升级，重新核对权限类型和行为；
- 所有受管 query 使用 `permissionMode:'default'`，继续使用 S00 确定的 user/project/local settingSources 与 Claude Code preset；
- 至少两个隔离 fixture，可在项目内配置 ask 规则和执行无害固定命令，不修改全局 settings.json；
- S03 第一阶段先完成 PERM-00 真实 SDK 门禁，再实现产品 Broker。

PERM-00 至少验证：

1.  default 模式下，未被 allow 规则批准的 Bash/Edit 请求确实进入 canUseTool；本机 allow/deny/ask 规则顺序没有被 Adapter 改写；
2. 回调实际提供 requestId、toolUseID、signal，以及可用时的 decisionReason、defaultToNo、blockedPath、agentID、suggestions；
3. allow 返回原始 updatedInput 后只执行当前请求，deny 返回 interrupt:false 后工具不执行，最终 run 状态以 SDK result 为准；
4. run.cancel/interrupt 时 AbortSignal 的实际触发顺序，以及 deny/interrupt/close 的组合行为；
5. 不返回 updatedPermissions 时不会写 `.claude/settings.local.json`；
6. AskUserQuestion 或其他需要结构化用户输入的回调能被识别，不会被误当作普通 yes/no 权限批准；
7. 记录 assistant/tool_use、canUseTool、permission resolved、tool_result 的真实先后顺序，以确定 tool.started 是否可能早于审批，以及 denied 时是否存在工具卡片；
8. 尽可能通过 control_response 丢失或 reinitialize 验证已回答 requestId 是否重发；无论实测是否可稳定诱导，S03 都采用“已 completed 的 allow 回调再次调用时 deny”的保守规则，防止二次执行。

PERM-00 未通过时，S03 产品实施保持 BLOCKED。不能把 Mock 回调当作真实 SDK 证据，也不能通过 dontAsk、bypassPermissions 或默认 allow 绕过。

**当前文档编写时，S00–S02 尚未实际实施，因此 S03 实施入口仍为 BLOCKED。**

## 3. 目标、非目标与反目标

### 3.1 目标

- Mac 逐项目配置 `mobileApprovalMode:'deny'|'allow_once'`，迁移时全部默认 deny；
- Permission Broker 以 runId+requestId 幂等接收 SDK 回调，以 approvalId 对 App 暴露；
- 同一 run 支持最多 8 个并发 pending，全局最多 16 个；超限新请求 fail closed；
- 审批固定 120 秒有效期，断线不暂停，Mac monotonic clock 是超时事实源；
- 状态仅允许 `pending → approved_once | denied | expired | invalidated`；
- 完整审批内容通过同一 Tailscale Serve 下的认证 HTTPS 分块读取，单份内容最多 1 MiB；
- 允许一次只返回回调开始时的原始输入快照，不采用 App 回传参数；
- 多会话、多工具审批独立路由，waiting_approval 仍占用 S02 执行槽；
- pending 摘要进入会话 Journal 和快照，完整内容只在 pending 期间按设备读取；
- 终态后清除原始输入和完整 JSON，只保留安全审计元数据；
- App 退后台清除已加载完整内容并遮挡敏感页面，不写普通磁盘缓存。

### 3.2 非目标

S03 不包含：

- “始终允许”、updatedPermissions、永久规则编辑或接受 suggestions；
- 修改工具输入、批准编辑后的命令、拒绝时自由文本指导或重定向 prompt；
- 批量批准、一键批准全部、自动高风险审批、语音审批和生物识别；
- 把手机审批扩展到已经被本机规则自动允许的 Read/Glob/Grep 等调用；
- 启用 acceptEdits、auto、plan、bypassPermissions 或动态 setPermissionMode；
- AskUserQuestion 答题 UI、所有 MCP/connector 审批或结构化交互、自定义交互工具框架；
- 实际执行后的 Diff 保证、完整文件 Diff 下载、远程终端或任意 shell；
- APNs/FCM、后台推送、多设备审批、多用户、Relay 和公网 Funnel；
- SQLite、持久审批、持久审计、afterSeq 和 Agent 重启后恢复 pending；
- 队列清空、run 自动重放和审批超时自动重试。

### 3.3 反目标

以下结果视为失败：

- 使用 dontAsk 后发现 canUseTool 不触发，或为让回调触发而使用 bypassPermissions；
- 只显示工具名或截断命令就启用“允许一次”；
- App 能修改 updatedInput、返回永久规则或批准另一个 run 的 approvalId；
- 同一 requestId 重发产生两张卡片或两次工具副作用；
- 用户响应、120 秒超时和 AbortSignal 竞争时出现 allow/deny 双结果；
- 拒绝或超时后直接中断整个 run，导致 Claude 无法按 SDK 行为继续；
- waiting_approval 释放执行槽，导致同会话下一 run 或其他全局任务超限启动；
- run 已终态、项目已禁用审批或设备已吊销后，旧响应仍能 allow；
- 完整审批内容被复制进 requested/resolved、命令幂等结果、App 磁盘、访问日志或错误堆栈；S01 已定义的工具事件预览不属于此处的复制通道；
- 把 Write/Edit 参数渲染的预览称为实际文件 Diff 或执行结果；
- Agent 重启后旧 pending 自动有效、自动 allow 或被显示为确定 deny。

## 4. 方案比较与选择

### 4.1 方案 A：Mac 逐项目开启 allow_once（选定）

迁移后所有项目默认 deny，只有本机用户通过 Unix socket 管理接口将指定项目设为 allow_once。Broker 只处理已经到达 canUseTool 的权限请求。

优点：升级不隐式扩大项目权限，保留 Claude Code 原有规则，可逐项目快速回退。  
代价：需要配置 V3 和本机策略管理，手机审批不是开箱即用于所有项目。

### 4.2 方案 B：所有已授权项目默认开启

升级后所有项目立即允许手机审批。

优点：少一步配置。  
代价：升级本身改变所有项目的远程权限边界，缺乏逐项目明确授权。

### 4.3 方案 C：所有工具包括自动允许项都经手机

通过 PreToolUse Hook 把本机已经允许的调用也发送到手机。

优点：手机上能看到全部工具决策。  
代价：破坏现有 Claude Code 权限规则和高频只读体验，扩大 S03 Hook 兼容性范围。

**结论：**采用方案 A。S03 只改变“到达 canUseTool 后如何决策”，不改变到达 callback 之前的 Claude Code 权限求值顺序。

## 5. 总体结构

```text
iPhone Flutter App
  ├─ PendingApprovalCard / Session Badges
  ├─ ApprovalDetailPage
  │    ├─ 完整内容分块加载 + SHA-256 校验
  │    ├─ Bash/Write/Edit/JSON 参数视图
  │    └─ 允许一次 / 拒绝
  ├─ Per-session Approval Reducers
  └─ Keychain Device Credential（仅用于认证头）
                 │
                 │ WSS：requested/resolved/respond
                 │ HTTPS：只读完整内容分块，Cache-Control:no-store
                 ▼
Tailscale Serve → 127.0.0.1:8787
                 │
Mac Node.js Agent
  ├─ Workspace Approval Policy（本机默认 deny）
  ├─ PermissionBroker
  │    ├─ runId+requestId 回调去重
  │    ├─ 原子 pending/terminal reducer
  │    ├─ 120 秒超时与 AbortSignal
  │    └─ 原始输入安全清除 + 审计元数据
  ├─ ApprovalContentController（仅 pending、仅绑定设备）
  ├─ RunController / Scheduler（waiting_approval 占槽）
  └─ AgentSdkAdapter（唯一 SDK 权限类型边界）
                 │
                 ▼
Claude Agent SDK / Runtime（permissionMode=default）
```

## 6. 项目策略与本机管理

### 6.1 配置 V3

S02 配置 V2 升级为 V3，在每个 workspace.policy 中增加：

```json
{
  "workspaceId": "ws_01...",
  "displayName": "Fixture Alpha",
  "rootPath": "/absolute/real/path/alpha",
  "createdAt": 1762432800000,
  "policy": {
    "perSessionQueueLimit": 20,
    "mobileApprovalMode": "deny"
  }
}
```

规则：

- V2→V3 迁移必须为每个项目补 `mobileApprovalMode:'deny'`，保留 queueLimit 和其他 ID；
- 迁移前保留 `agent.json.v2.bak`，权限 0600，沿用同步原子写入与失败不启动；
- timeout=120 秒、每 run 8/global 16 pending、内容 1 MiB 都是 S03 固定常量，不由 App 或项目配置覆盖；
- App 只能在 workspace 公开摘要中看到 `mobileApprovalMode`，不能修改；
- 配置不包含模型密钥、设备 token 或审批正文。

### 6.2 本机 CLI

```text
claude-remote-agent workspace set-approval <workspaceId> --mode allow_once
claude-remote-agent workspace set-approval <workspaceId> --mode deny
```

- 只通过 `~/.claude-remote/agent.sock`，不增加 TCP/Tailscale 管理路径；
- set-approval 与 callback、permission.respond、timeout、cancel 在同一同步状态边界中序列化；
- `deny → allow_once` 只影响之后到达的 canUseTool，不复活旧审批，不改变本机 allow/deny 规则；
- `allow_once → deny` 立即使该 workspace 全部 pending 变为 `invalidated/policy_disabled`，每个 callback 返回 deny；之后请求沿用 S01 默认 deny 和 PERMISSION_REQUIRED；
- 活跃 run 不因策略切换自动取消，queued run 不变；
- workspace remove 仍要求无活跃/queued run，因此不能在 pending 时移除。

## 7. SDK 权限边界

### 7.1 固定模式与既有规则

- 所有 S03 受管 query 显式使用 `permissionMode:'default'`；不得使用 dontAsk，因为它会跳过 callback；
- 不允许 App 或项目审批命令调用 setPermissionMode，也不启用 acceptEdits/auto/plan/bypassPermissions；
- user/project/local 设置中的 deny、ask、allow 规则仍由 Claude Code 按官方顺序求值；
- 已被自动允许的工具不生成手机审批，已被提前拒绝的调用也不能由 App 反转；
- Broker 不自行解析 Bash 是否危险，不用自写规则替代 Runtime 的 critical path、blockedPath 或 decisionReason。

### 7.2 回调输入快照

Adapter 收到：

```ts
type SdkPermissionRequest = {
  toolName: string
  input: Record<string, unknown>
  signal: AbortSignal
  toolUseID: string
  requestId: string
  agentID?: string
  decisionReason?: string
  defaultToNo?: boolean
  suppressAlwaysAllowRule?: boolean
  blockedPath?: string
  mcpServer?: {name:string;source:string}
  suggestions?: unknown[]
}
```

- Adapter 立即深拷贝 input 和可展示上下文，计算规范化请求指纹；之后不读取可能被修改的原对象；
- runId/sessionId/workspaceId 来自 AdapterHandle 绑定，不能从当前 App 页面推断；
- requestId 只用于 Mac 内部回调去重，App 只使用新生成的 approvalId；
- suggestions 永不返回 Runtime；suppressAlwaysAllowRule 不影响 S03，因为本就没有 always 选项；
- S03 普通权限审批只支持固定工具集合 `Bash、Write、Edit、NotebookEdit、Read、Glob、Grep、WebFetch、WebSearch`，其他工具名返回 APPROVAL_TOOL_UNSUPPORTED 并 deny，不根据 input 形状猜测；
- `toolName='AskUserQuestion'`、`toolName` 以 `mcp__` 开头或存在 mcpServer 的请求一律不创建普通审批，固定 deny `User interaction is not supported in S03` 并显示 UNSUPPORTED_USER_INTERACTION；这会同时拒绝普通 MCP 权限与结构化 MCP 交互，是 S03 的明确限制；
- 不用 decisionReason 文本启发式判断交互类型；固定 SDK 若新增其他结构化内置交互，PERM-00 必须先将工具名加入不支持集合，不能默认放行未知工具。

### 7.3 返回 Runtime

用户允许一次：

```ts
{
  behavior: 'allow',
  updatedInput: <该回调开始时的不可变输入快照>,
  toolUseID: <原 toolUseID>
}
```

用户拒绝、超时或失效：

```ts
{
  behavior: 'deny',
  message: <固定安全原因>,
  interrupt: false,
  toolUseID: <原 toolUseID>
}
```

- 不包含 updatedPermissions，不返回 suggestions，不写 settings.local.json；
- deny message 固定为 user denied、approval expired、run cancelled、policy disabled 等安全文本，不包含完整输入；
- interrupt 始终 false；run.cancel 由 RunController 单独调用 interrupt，审批超时不等于取消 run；
- callback Promise 只 resolve 一次；仍处于 pending 的重复 requestId 回调共享原 Promise，已经 completed 的回调重入按 9.1 防止二次执行，不能简单重放缓存 allow；
- permission.resolved(approved_once) 只表示权限放行，不表示工具成功；tool.completed 和 run.completed 仍以 SDK 事件为准。

## 8. Approval 数据模型与状态机

### 8.1 内存记录

```ts
type ApprovalRecord = {
  approvalId: string
  requestKey: string             // runId + requestId 的内部键
  requestFingerprint: string
  workspaceId: string
  sessionId: string
  runId: string
  deviceId: string
  toolUseID: string
  toolName: string
  agentID: string | null
  status: 'pending' | 'approved_once' | 'denied' | 'expired' | 'invalidated'
  createdAt: number
  expiresAt: number
  resolvedAt: number | null
  resolutionReason: ResolutionReason | null
  responseCommandId: string | null
  content: ApprovalContent | null // 仅 pending 保留
  originalInput: Record<string, unknown> | null // 仅 pending 保留
  resultPromise: Promise<PermissionResult> | null // 仅 pending 保留，终态清除
}

type ApprovalAuditRecord = {
  // 终态后保留 IDs、toolName、状态、时间、requestFingerprint、
  // contentByteLength/contentSha256 和 resolutionReason，不含正文。
}
```

- `ResolutionReason = user_allow_once | user_deny | timeout | run_cancelled | sdk_aborted | policy_disabled | device_revoked | agent_shutdown`；
- approvalsById 和 auditsById 在当前进程保留，用于区分 NOT_FOUND、EXPIRED 和 ALREADY_RESOLVED；S04 再持久化与清理；
- 终态时将 content、originalInput 和 Broker 持有的 resultPromise 引用置 null、取消 timer，只保留安全 terminal outcome；尤其不能为了重发 allow 而把含 updatedInput 的 Promise 留在审计索引中；
- 已完成审批的 callback 重入不再返回缓存 allow，统一按 9.1 的防二次执行规则处理；
- 所有状态更新返回新对象，不允许 UI、timeout 或 SDK callback 原地修改记录。

### 8.2 状态与竞争

```text
pending → approved_once（用户在 expiresAt 前明确响应）
pending → denied（用户明确拒绝）
pending → expired（Mac 到达 120 秒）
pending → invalidated（run/SDK/策略/设备/进程生命周期失效）
```

原子规则：

1. `now >= expiresAt` 时超时优先，即使 timeout task 尚未执行，permission.respond 也只能得到 APPROVAL_EXPIRED；
2. 用户响应先提交则终态固定，之后的 timeout/abort/cancel 不得覆盖；
3. timeout/abort/cancel 先提交则后续响应不能 allow；
4. run 终态前必须将该 run 所有 pending 变为 invalidated，并先发 permission.resolved，再发 run.completed；
5. 已 approved_once 后收到 run.cancel 不把审批改成 denied；工具可能已开始，取消结果由 run/tool 事件表达；
6. 同一 approvalId 的新 commandId 再次响应：expired 返回 APPROVAL_EXPIRED，其余终态返回 APPROVAL_ALREADY_RESOLVED；
7. 同一 commandId 重试仍按 S02 返回首次 command.result，不执行第二次决策。

## 9. Permission Broker 流程

### 9.1 创建与重复回调

1. 若 signal 已 aborted，直接返回 deny，不创建手机卡片，只记录无正文安全审计；
2. 校验 run 仍活跃且非 cancelling、workspace 当前为 allow_once、设备未吊销；cancelling 后新 callback 立即 deny，不创建卡片；
3. 以 runId+requestId 查重并比较 requestFingerprint：
   - 首次 callback 仍 pending：相同 fingerprint 共享原 resultPromise；
   - 首次 callback 已 completed 且结果为 denied/expired/invalidated：返回相同 deny；
   - 首次 callback 已 completed 且结果为 approved_once：**不再返回 allow**，对重入返回 deny，发 APPROVAL_DUPLICATE_AFTER_RESOLUTION 安全错误，防止丢失 control_response 或重连导致工具第二次执行；原审批历史保持 approved_once，不伪造第二次 permission.resolved；
   - fingerprint 不同：返回 deny 并记录内部冲突；
4. 校验 pending 每 run <8、全局 <16；超限返回 deny，发送 APPROVAL_CAPACITY_EXCEEDED 安全错误，不创建 pending；
5. 生成完整 ApprovalContent；无法 JSON 序列化或超过 1 MiB 时返回 deny，发送 APPROVAL_CONTENT_TOO_LARGE/UNAVAILABLE，不创建可批准卡片；
6. 创建 approvalId、content、originalInput、resultPromise 和 120 秒 monotonic deadline；
7. 在同一同步调用栈先把 pending 注册到 approvalsById/requestId 索引和内容读取路由，再 append permission.requested；这样 App 收到事件后内容立即可读。append 失败则移除注册并 deny，不能留下 phantom pending；
8. 更新 activeRun.pendingApprovalCount 和 session.status；
9. 等待响应、超时或失效，最后返回第 7.3 节结果。

已完成 allow 后重入而 deny 是保守失败：如果首次 allow 实际未送达 Runtime，本次工具可能不会执行，App 会保留 approved_once 历史并显示后续 denied/错误，需要用户明确发起新操作，不能为恢复体验自动再次 allow。

同一 toolUseID 但不同 requestId 可以是模型再次请求，必须创建独立审批，不能用工具名或 toolUseID 全局去重。

### 9.2 超时、断线与重连

- Broker 使用 Mac monotonic deadline 判断 120 秒，expiresAt 仅用于协议展示，系统墙上时钟变化不能延长审批；
- App 断线不取消 run、不立即 deny，也不暂停 TTL；Mac pending 继续等待直到响应或超时；
- App 本地倒计时只作提示，离线时显示“可能已过期，重连确认”，不能本地伪造 resolved；
- 同一 agentInstanceId 重连后，目标会话快照包含最新 pendingApprovals；已 resolved 的卡片以事件/快照为准；
- App 被杀后无完整内容缓存，重新打开时重新加载摘要和内容；
- agentInstanceId 改变后，旧 approvalId 不可重试响应，旧内容清除，UI 显示“Mac 已重启，旧审批失效，执行结果未知”。

### 9.3 run.cancel 与 AbortSignal

- RunController 先通过同步状态迁移将 run 置为 cancelling，并向 Broker 标记 `acceptingApprovals=false`；
- Broker 在同一同步边界把该 run 当前全部 pending 变为 invalidated/run_cancelled、append permission.resolved 并 resolve 对应 callback deny；完成这些同步动作后 RunController 才调用 handle.interrupt；
- 不等待 deny 的异步投递才调用 interrupt，也不依赖 AbortSignal 一定会触发。cancelling 标记后到 interrupt 返回之间的新 canUseTool 都因第 9.1 步 2 立即 deny，不产生新卡片；
- AbortSignal 可能在 interrupt 内同步或异步触发，Broker 的 terminal reducer 幂等吸收它，只发一次 permission.resolved；若 signal 独立先到，则状态为 invalidated/sdk_aborted，之后响应不能 allow；
- run 终态或 close 时再次 invalidate 剩余 pending 作为幂等兜底，全部 resolved 事件先于 run.completed；
- run.cancel 仍不清空 queued run，后续调度沿用 S02；
- waiting_approval/cancelling 都占执行槽，审批清理和 Adapter close 未完成前不释放。

### 9.4 策略、设备与进程失效

- set-approval deny：pending → invalidated/policy_disabled；
- revoke 或 pair --replace：属于旧 deviceId 的 pending → invalidated/device_revoked，run 不自动取消；
- Agent 优雅关闭：pending → invalidated/agent_shutdown，先 resolve callback，再关闭 Adapter；
- Agent 被强杀时无法补发事件，新实例不得恢复旧 pending；App 通过新 agentInstanceId 将本地旧审批标为失效/结果未知；
- 任何失效都不能自动 allow，也不能把未观察到 SDK 终态的 run 写成成功。

## 10. 协议与完整内容通道

### 10.1 permission.requested

```json
{
  "protocolVersion": 1,
  "messageId": "msg_01...",
  "eventId": "evt_01...",
  "desktopId": "desktop_01...",
  "workspaceId": "ws_01...",
  "sessionId": "session_01...",
  "runId": "run_01...",
  "approvalId": "approval_01...",
  "seq": 42,
  "timestamp": 1762432800000,
  "type": "permission.requested",
  "payload": {
    "toolUseID": "toolu_01...",
    "toolName": "Edit",
    "agentID": null,
    "createdAt": 1762432800000,
    "expiresAt": 1762432920000,
    "defaultToNo": false,
    "hasDecisionReason": true,
    "hasBlockedPath": false,
    "content": {
      "encoding": "json-utf8",
      "byteLength": 18342,
      "sha256": "<base64url-sha256>",
      "chunkCount": 1
    }
  }
}
```

requested 不包含 input、command、file_path、workingDirectory、decisionReason、blockedPath 或 change preview 正文。它占用目标 session seq，可以安全进入普通 Journal/快照摘要。

### 10.2 完整内容 HTTPS 读取

```http
GET /v1/approvals/{approvalId}/content?chunkIndex=0
Authorization: Bearer <deviceId>.<deviceToken>
```

成功 `200`：

```json
{
  "approvalId": "approval_01...",
  "chunkIndex": 0,
  "chunkCount": 1,
  "encoding": "json-utf8",
  "byteLength": 18342,
  "sha256": "<base64url-sha256>",
  "text": "<该 UTF-8 安全块的 JSON 文本>"
}
```

完整 JSON 重组后的结构：

```json
{
  "toolName": "Edit",
  "workingDirectory": "/absolute/real/path/alpha",
  "input": {
    "file_path": "/absolute/real/path/alpha/example.ts",
    "old_string": "before",
    "new_string": "after"
  },
  "context": {
    "agentID": null,
    "decisionReason": "Edit requires approval",
    "defaultToNo": false,
    "blockedPath": null,
    "mcpServer": null
  }
}
```

规则：

- 只监听既有 localhost 手机接口，经 Tailscale Serve 标准 TLS；token 只在 Authorization header，不在 URL；
- 仅 pending、approval.deviceId 与认证设备一致时可读；响应 `Cache-Control:no-store`；
- 每块 UTF-8 最多 32 KiB，不切断多字节字符；1 MiB 最多 32 块；
- App 按顺序读取全部 chunk，核对 chunkCount/byteLength/SHA-256 一致后才启用允许一次；
- 每设备每分钟最多 120 次内容读取，超限 RATE_LIMITED；不能按 Serve 后 localhost IP 计数；
- 内容 GET 是安全只读操作，不进入 commandId 幂等表、不占 seq、不写 EventJournal；
- 终态后 Mac 删除内容并返回 APPROVAL_EXPIRED 或 APPROVAL_ALREADY_RESOLVED；App 不得继续拉取旧内容；
- 访问日志不记录响应 body、Authorization 或完整 URL query 之外的敏感信息。

**路径与工具事件边界：**审批 requested/resolved 不重复携带原始 input，完整审查内容只经上述认证 endpoint 读取。但 S01 已有的 `tool.started(input)`、tool.output 和其快照预览仍按原协议工作，可能包含 Bash 命令、绝对路径或 Write/Edit 参数预览；S03 不承诺对这些既有时间线事件做路径清洗，也不把内容 endpoint 描述成对已配对设备的绝对保密边界。S02 的“协议不包含 rootPath”在此明确修订为：Agent 配置元数据不得公开 rootPath，但真实工具输入/输出沿用 S01，完整审批工作目录只在上述 endpoint 返回。日志、命令幂等结果和 App 持久缓存仍不得保存完整审批正文。

PERM-00 必须记录 tool_use 与 canUseTool 的实际顺序。如果 tool.started 在审批前到达，其 S01 预览可能在用户打开审批详情前已经显示；本 spec 不通过伪造延迟或回滚时间线改变该顺序。若未来要求“审批前工具输入完全不可见”，需要另行设计 Normalizer 缓冲协议，不能在本实现中偷偷假设。

### 10.3 permission.respond

信封必须包含 desktopId/workspaceId/sessionId/runId/approvalId、commandId/traceId 和 sourceDeviceId：

```json
{
  "type": "permission.respond",
  "payload": {"decision": "allow_once"}
}
```

`decision = allow_once | deny`。成功结果：

```json
{
  "status": "ok",
  "duplicate": false,
  "data": {
    "approvalId": "approval_01...",
    "status": "approved_once",
    "resolvedAt": 1762432860000
  }
}
```

- Broker 同时校验所有关联 ID 和当前认证设备，不允许只凭 approvalId 决策；
- 关联不一致返回 APPROVAL_SESSION_MISMATCH 或 FORBIDDEN，不能按全局 ID 猜测目标；
- App 不回传 input、updatedInput、updatedPermissions、文本建议或 content hash 作为授权依据；
- allow_once 和 deny 都是明确点击，离线、内容未完整加载或 hash 不匹配时不能提交 allow_once；
- deny 可在内容未加载时提交，但不能因为加载失败自动允许。

### 10.4 permission.resolved

```json
{
  "type": "permission.resolved",
  "approvalId": "approval_01...",
  "sessionId": "session_01...",
  "runId": "run_01...",
  "payload": {
    "status": "approved_once",
    "resolvedAt": 1762432860000,
    "resolutionReason": "user_allow_once",
    "responseCommandId": "cmd_01..."
  }
}
```

- resolved 占用目标 session seq，不包含完整内容；
- responseCommandId 只在用户响应时携带，timeout/abort 等为空；
- resolved 后 App 清除完整内容缓存，保留安全状态卡片；
- Normalizer 只在实际观察到 SDK tool_use 时发 tool.started，不因 permission.requested/approved_once 伪造工具开始；
- 若 PERM-00 证明 tool.started 可早于审批，则 denied/expired/invalidated 时必须补且只补一次 tool.completed(denied/cancelled)；若该请求没有已观察到的 tool.started，则不创建空工具卡片，permission.resolved 已足够表达结果；
- approved_once 后不伪造 tool.output/completed，继续等待真实 SDK 工具事件；Journal seq 按实际观察顺序分配，App 同时兼容“工具卡片先于审批”和“审批先于工具卡片”两种证据形态。

### 10.5 新增错误码

- `APPROVAL_NOT_FOUND`：当前进程没有该审批；
- `APPROVAL_EXPIRED`：已超时；
- `APPROVAL_ALREADY_RESOLVED`：已有其他终态；
- `APPROVAL_SESSION_MISMATCH`：workspace/session/run 关联不一致；
- `APPROVAL_CONTENT_TOO_LARGE`：完整内容超过 1 MiB，未创建可批准请求；
- `APPROVAL_CONTENT_UNAVAILABLE`：内容无法安全序列化或已不可读；
- `APPROVAL_CAPACITY_EXCEEDED`：每 run 8/global 16 pending 上限；
- `UNSUPPORTED_USER_INTERACTION`：AskUserQuestion、MCP/connector 或结构化交互在 S03 不支持；
- `APPROVAL_TOOL_UNSUPPORTED`：不在 S03 固定普通工具集合中的权限请求；
- `APPROVAL_DUPLICATE_AFTER_RESOLUTION`：已 completed 的 allow 回调重入，为防止二次执行已 deny。

`CONTENT_INTEGRITY_ERROR` 是 App 本地加载校验状态，不是 Mac 审批终态。

## 11. Run、队列与快照集成

### 11.1 Run 状态扩展

```text
starting/running → waiting_approval（首个 pending）
waiting_approval → running（pendingCount 回到 0 且 run 未取消）
starting/running/waiting_approval → cancelling
waiting_approval → succeeded/failed（仅在所有 pending 已清理且 SDK 有终态后）
```

- RunStatus 新增 waiting_approval；starting/running/waiting_approval/cancelling 都占全局执行槽；
- 同一 run 可有多个 pending，pendingApprovalCount 是准确计数，不是单个布尔值；
- SessionSummary 新增 pendingApprovalCount；公开 SessionStatus 在 activeRun waiting_approval 时显示 waiting_approval；
- 某会话 waiting_approval 时，其 queued run 不能开始，另一会话仍可使用剩余执行槽并提出自己的审批；
- prompt.send 继续按 S02 入队，queue.remove 不影响已有审批；
- run.cancel 不清队列，session.archive/workspace remove 在 waiting_approval 时仍返回 SESSION_BUSY/WORKSPACE_BUSY。

### 11.2 快照扩展

`session.snapshot` 新增：

```json
{
  "activeRun": {
    "runId": "run_01...",
    "status": "waiting_approval",
    "pendingApprovalCount": 2
  },
  "pendingApprovals": [
    {
      "approvalId": "approval_01...",
      "toolUseID": "toolu_01...",
      "toolName": "Bash",
      "createdAt": 1762432800000,
      "expiresAt": 1762432920000,
      "defaultToNo": true,
      "content": {
        "byteLength": 18342,
        "sha256": "<base64url-sha256>",
        "chunkCount": 1
      }
    }
  ]
}
```

- pendingApprovals 只含 requested 同等安全摘要，不含 workingDirectory/input/context 正文；
- 一个活跃 run 最多 8 条，计入原有 48 KiB payload/64 KiB 总消息预算；不得为保留大事件而删除 pending 安全状态；
- workspace.list 的 SchedulerSummary 新增 pendingApprovalCount，供 App 找到其他会话等待状态；
- permission.content 不经快照提供，App 必须在打开审批时重新获取；
- resolved 审批只保留最近时间线摘要，不能通过快照重新读取正文。

## 12. iOS App 设计

### 12.1 审批入口与状态

Riverpod 增加：

- `pendingApprovalsById`：安全摘要，按 approvalId 不可变保存；
- `approvalIdsBySessionId`：各会话 pending 顺序和 badge；
- `approvalContentCache`：仅内存、按 approvalId 保存加载中的 chunk 和已校验完整 JSON；
- `approvalActionState`：loading_content/ready/submitting/resolved/error；
- session/workspace summary 的 pendingApprovalCount 和 waiting_approval。

当前聊天页内显示审批卡片，其他会话通过等待 badge 提示。打开卡片进入独立详情页，不改变 selectedSessionId，也不取消其他 run。

### 12.2 审批详情页

```text
┌─────────────────────────────┐
│ Fixture Alpha / 修复测试      │
│ Edit · 子代理（如有）          │
│ 剩余 01:42（仅提示）           │
├─────────────────────────────┤
│ 工作目录（完整内容加载后）      │
│ 完整参数 / 完整命令             │
│ 变更预览（由请求参数生成）       │
│ 触发原因 / blockedPath（如有）  │
├─────────────────────────────┤
│ 内容 hash 已校验               │
│ [拒绝]          [允许一次]      │
└─────────────────────────────┘
```

- 初始只显示工具名、会话和过期时间，自动加载全部内容；
- 内容未完整加载、chunk 不一致、byteLength/hash 不匹配或审批已 terminal 时，允许一次禁用；
- Bash 显示完整 command/description/timeout；Write 显示 file_path 和完整 content；Edit 显示 file_path、old_string、new_string；
- Edit/Write 可在 App 根据参数生成行级变更预览，固定标注“由请求参数生成，不是实际文件 Diff 或执行结果”；
- 其他普通权限工具显示完整 JSON，不因无法定制 UI 而隐藏字段；
- defaultToNo=true 时显示显著警告，允许一次需额外确认；任何请求都不预勾选允许；
- AskUserQuestion、MCP/connector 和未知工具不显示可批准卡片，只显示不支持且已 deny 的安全状态。

### 12.3 响应与跨会话路由

- 点击时捕获 approvalId/workspaceId/sessionId/runId/deviceId 和 decision，切换页面不改变目标；
- allow_once 只有在当前 App 已校验同一份 content.sha256 时可点击，但 Mac 不依赖 App 回传 hash 决定授权；
- submitting 禁用两个按钮，超时只重试同一 commandId；新点击不得生成第二个决策命令；
- resolved 到达后立即禁用按钮、清除正文缓存并显示最终审批状态；APPROVAL_DUPLICATE_AFTER_RESOLUTION 是后续工具/Runtime 安全错误，不把 approved_once 审批历史改成 denied，也不自动重试；
- 一个会话的审批不会插入另一个会话时间线；两个会话同时 pending 可分别处理；
- 不提供“全部允许”“以后都允许”或修改命令按钮。

### 12.4 断线、后台与隐私

- 断线时禁止提交新响应，Mac TTL 继续；恢复后先快照再决定是否重试未确认 commandId；
- App 退后台立即用遮罩覆盖审批详情并清除已加载正文和 chunk；回前台按当前 pending 状态重新加载；
- 完整正文不写 Keychain、NSUserDefaults、普通文件、日志、崩溃上下文或分析事件；
- 系统日志和 Widget test 使用假数据，不能打印真实 content；
- agentInstanceId 改变时清除所有旧审批正文和自动重试，显示旧审批失效/执行结果未知；
- revoked/device 替换后删除本地凭证沿用 S01，旧审批不能由旧 token 继续读取或响应。

## 13. 审计、日志与安全边界

- 基础审计记录 approvalId、workspaceId/sessionId/runId、deviceId、toolName、toolUseID、requestFingerprint、状态、created/resolvedAt、resolutionReason、contentByteLength 和 contentSha256；
- 审计和日志不记录完整 input、command、file content、workingDirectory、blockedPath、suggestions、Authorization、token 或完整环境变量；
- requestId 如需日志关联只保存 SHA-256 摘要，requestFingerprint 不包含可逆正文；
- 内容 HTTPS 响应明确 no-store，Fastify access/error log 不序列化 body；
- Broker 持有的完整内容只存在 Mac pending 内存和 App 已打开页面内存，终态/后台/重启按各自规则清除；Runtime 自身消息生命周期不以该句作额外保证；
- 允许一次不扩大后续请求、其他 toolUseID、子代理、会话或项目权限；
- 本机 allow 规则的自动执行仍是 S00–S02 既有边界，S03 不声称所有工具都经过手机；
- 不开启 Funnel，不关闭 TLS 校验，不新增公网下载地址；
- 核心 TypeScript 与 Dart 业务逻辑覆盖率均不低于 80%，Mock 不替代 PERM-00 和真机审批。

## 14. 测试策略

### 14.1 Mac 单元与集成测试

| ID | 场景 | 通过标准 |
|---|---|---|
| POL-01 | V2→V3 与逐项目 enable/disable | 迁移全部 deny；只影响目标项目；disable 立即使 pending 失效且不取消 run |
| BROKER-01 | 同 runId+requestId 重发 | pending 同 fingerprint 共享原 Promise，只一张卡片；completed allow 重入 deny 防二次执行；冲突 fingerprint fail closed |
| BROKER-02 | 同 toolUseID 不同 requestId、多工具并行 | 独立 approvalId；每 run 8/global 16，超限 deny 且无卡片 |
| BROKER-03 | 无法序列化、超过 1 MiB、非法 chunk | 不创建可批准请求；deny/安全错误，无内容泄漏 |
| TIME-01 | 119.999s 响应与 120s 响应/timeout 竞争 | 先到者唯一获胜；边界 expired 优先；无 allow/deny 双结果 |
| TIME-02 | 断线、系统时钟变化、重连 | TTL 不暂停，monotonic deadline 不受墙钟影响，快照状态准确 |
| CANCEL-01 | waiting_approval 中 run.cancel/AbortSignal | pending invalidated，只一次 resolved，interrupt:false deny，RunController 单独 interrupt |
| CANCEL-02 | 响应先 allow 后 cancel、cancel 后响应 | 前者不改审批历史且 run/tool 按 SDK；后者不能 allow |
| ADAPTER-01 | allow once 与第二次相同工具 | updatedInput 为原快照，无 updatedPermissions；第二次重新审批 |
| ADAPTER-02 | deny/expire 后模型继续或结束 | interrupt:false，工具未执行，run 终态只取 SDK result |
| ADAPTER-03 | AskUserQuestion、MCP/connector、未知工具 | 不创建普通审批，按固定工具规则 deny，不伪装已回答或用 decisionReason 猜测 |
| ADAPTER-04 | tool_use 与 canUseTool 两种相对顺序 | 只为真实 tool_use 发 started；有 started 的 deny 补一次 completed，无 started 不创建空卡片 |
| CONTENT-01 | 32 KiB 边界、全中文、32 块、hash | 不切断 UTF-8，完整重组一致，错误设备/终态不可读，no-store |
| CONTENT-02 | 内容清理与日志扫描 | 终态 originalInput/content/resultPromise=null，requested/resolved/pendingApprovals、幂等表和日志无审批正文；S01 工具预览按单独投影规则 |
| RUN-01 | 单 run 多 pending、双会话 pending | waiting_approval 占槽，计数准确，另一会话可运行且不串线 |
| RUN-02 | run 终态、queued、archive/remove | pending 先 resolved 后 run.completed；queue 语义不变；忙碌禁止归档/移除 |
| SNAP-01 | 8 pending + 大事件快照 | pending 安全摘要保留，总消息 <=64 KiB，不含正文 |
| SEC-01 | revoke/replace、错误设备、旧 approvalId | 旧设备不能读取/响应，pending 失效，不自动 allow |

### 14.2 Flutter 单元与 Widget 测试

- requested/resolved 去重、跨 session 路由、pendingCount 和 waiting_approval；
- 分块加载、UTF-8、chunkCount/byteLength/hash 校验和 CONTENT_INTEGRITY_ERROR；
- 内容未加载/加载失败/已过期时 allow 禁用，deny 可用；
- Bash/Write/Edit/通用 JSON 完整展示，变更预览有“非实际 Diff”标记；
- defaultToNo 额外确认，无始终允许/批量允许/输入编辑；
- 点击后切换会话不改变 approval 目标，同 commandId 重试，resolved 后按钮禁用；
- 双会话 pending、后台清正文和遮罩、断线倒计时提示、重连快照；
- agentInstanceId 改变清正文/重试并显示结果未知；
- Widget/log/普通存储不包含完整命令、文件正文、rootPath 或 token。

### 14.3 Mock SDK 与真实 SDK 分工

Mock 用于确定性覆盖 requestId 重发、多 pending、timeout/response/abort 竞争、Adapter 失败和迟到事件。PERM-00 与以下真机测试必须使用固定版本真实 SDK；不得通过 Mock 宣称权限行为已经验证。

### 14.4 真机端到端验收

| ID | 操作 | 通过标准 |
|---|---|---|
| E2E-01 | V2 配置升级后查看两个 fixture | 两个项目默认 deny；只开启 A 后 B 仍 deny |
| E2E-02 | A 中触发需审批 Bash，完整查看并允许一次 | 完整命令/工作目录可见，固定无害命令只执行一次 |
| E2E-03 | 再次触发相同 Bash | 再次请求审批，无永久规则或 settings.local.json 变化 |
| E2E-04 | 拒绝一次 Bash | 命令未执行，deny message 给模型，run 状态以 SDK 为准 |
| E2E-05 | 审批 Edit 并查看变更预览 | old/new 完整可见，预览标记非实际 Diff，只允许 fixture 内目标修改 |
| E2E-06 | 不操作等待 120 秒 | expired、工具未执行、App 不能补允许，run 不自动取消 |
| E2E-07 | pending 时断网，分别在过期前后恢复 | 过期前可处理；过期后只能看到 expired，无本地假状态 |
| E2E-08 | pending 时 run.cancel | 审批 invalidated、工具未因迟到响应执行；queue 其他项按 S02 处理 |
| E2E-09 | 两个会话同时 pending | 卡片和响应不串线，两个 run 都占槽，可分别 allow/deny |
| E2E-10 | 重复 commandId、新 commandId 重复响应、错 runId | 首次决策唯一；后续 ALREADY/EXPIRED/MISMATCH，不覆盖状态 |
| E2E-11 | pending 时 Mac set-approval deny / revoke | pending 失效，旧响应无效，run 不被隐式取消 |
| E2E-12 | pending 时强杀并重启 Agent | 不自动 allow/replay；新实例无旧 pending，App 显示失效和结果未知 |

## 15. 完成标准

S03 只有同时满足以下条件才能通过：

- S00–S02 验收仍有效，PERM-00 真实 SDK 证据完整；
- Mac、协议和 Flutter 核心测试通过，核心 TypeScript/Dart 覆盖率均不低于 80%；
- E2E-01–12 在真实 iPhone、Mac、Tailscale、Agent SDK 和隔离 fixture 中通过；
- 只有 Mac 明确 allow_once 的项目能产生手机审批，其余项目保持 deny；
- 所有 allow 都经过完整内容加载/校验，且 updatedInput 只来自 Mac 原回调快照；
- 无 updatedPermissions、永久规则、bypassPermissions、dontAsk、批量允许或输入修改；
- 重复回调、超时/响应/abort 竞争和多会话并发均只有一个确定审批终态；
- waiting_approval 不破坏 S02 FIFO、双槽、取消和队列语义；
- 断线、revoke、策略关闭和 Agent 重启均不会错误放行；
- 完整审批正文不出现在 requested/resolved/pendingApprovals、幂等表、日志或 App 磁盘；既有 S01 工具事件预览按已修订的路径边界执行；
- 文档明确记录 1 MiB 内容上限、无真实 Diff 保证、不支持 AskUserQuestion/MCP/未知工具、无持久审批和无推送。

## 16. 回滚与兼容

- S03 对协议 V1 新增 approvalId 条件字段、permission.requested/resolved/respond 和内容 HTTPS endpoint，不改变 prompt/run/event 基础语义；
- App 与 Mac 作为同一版本组合升级，旧 App 不解析新审批事件时不能继续执行需要审批的 run；
- 回滚前先将所有 workspace 设为 deny，处理/失效所有 pending，并停止或等待活跃 run 结束；不能只回滚 UI 而让旧 callback 永远等待；
- 配置回滚使用 `agent.json.v2.bak`，V3 未迁移项目不得被静默改成 allow_once；
- S03 审批和审计仍是内存状态，回滚/重启后不可恢复，不宣称旧工具已 deny 或 run 已成功；
- 当前目录不是 Git 仓库，不因本 spec 自动初始化、提交或回滚 Git。

## 17. 留给实现者的事项

以下可由实现者决定：

- PermissionBroker、ApprovalContentController 和内存索引的内部文件拆分；
- 规范化 JSON、UTF-8 安全分块、monotonic clock 和深拷贝的具体实现库；
- Flutter Edit/Write 参数预览组件和行级 preview 库，只要明确非实际 Diff；
- 审批详情页视觉样式、通用 JSON 折叠方式和 defaultToNo 确认组件；
- fake clock、Mock SDK 回调和无害 fixture 的具体内容；
- 安全审计索引和内存清理的函数命名。

不得自行改变：

- 逐项目默认 deny、120 秒、每 run 8/global 16、单份内容 1 MiB；
- permissionMode=default、原 updatedInput、interrupt:false、无 updatedPermissions；
- 完整内容未加载/校验不得 allow，内容只经认证 no-store HTTPS 读取；
- 单审批原子终态、断线 TTL 继续、waiting_approval 占槽；
- 取消/策略/设备/重启 fail closed，旧响应不得覆盖；
- 无始终允许、无批量、无结构化交互、无真实 Diff 承诺和无持久恢复。

## 18. 后续接口预留

- S04 将 ApprovalRecord、AuditRecord、permission.respond 首次结果和事件写入 SQLite 事务，定义重启后 pending 默认 invalidated 的修复；
- S04 持久化后仍不得自动重放旧审批；完整正文是否持久化必须重新做隐私决策，不能因加数据库而默认保存；
- S05 语音只生成普通 prompt，不提供语音审批；
- S06 增加审批诊断、launchd 和统一故障注入，不提前引入推送或多设备审批；
- 未来若支持 AskUserQuestion、永久规则或真实 Diff，必须另开 spec，不能复用 allow_once 暗中扩展语义。
