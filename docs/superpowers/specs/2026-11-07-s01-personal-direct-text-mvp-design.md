# S01 详细 Spec：个人直连文字 MVP

**版本：** V1.0  
**日期：** 2026-11-07  
**状态：** 设计评审稿  
**上游文档：**
- `claude-code-mobile-control-architecture.md`
- `docs/superpowers/specs/2026-11-07-personal-mobile-claude-control-spec-breakdown-design.md`
- `docs/superpowers/specs/2026-11-07-s00-technical-validation-protocol-design.md`

## 1. 目的与成功结果

S01 交付第一条真实可用的端到端闭环：用户的一部 iPhone 通过 Tailscale 连接自己的 Mac，在一个 Mac 端预先授权的固定项目中创建一个受管 Claude Code 会话，发送文字 prompt，查看流式助手回复和工具事件，停止当前 run，并在断线重连后获得当前内存快照。

S01 验证的是“手机交互 + Mac 受管执行”的完整产品路径，而不是继续验证 SDK 基础能力。S00 已负责技术验证，S01 将其结论落实为最小产品。

成功时，用户能够完成以下操作：

1. 在 Mac 上初始化固定项目并启动 Agent；
2. 使用 Tailscale Serve 提供 tailnet 内的标准 HTTPS/WSS；
3. 在 Mac 终端显示一次性配对二维码，用 iPhone 扫码绑定；
4. 在 App 中创建或重新附着到唯一受管会话；
5. 发送文字并看到连续的助手文本、工具卡片和最终状态；
6. 在忙碌时得到明确 `SESSION_BUSY`，而不是并发执行；
7. 停止指定 run；
8. 锁屏、退后台或网络断开后重连，任务未被主动取消，时间线通过快照恢复；
9. 未绑定或已吊销设备无法发送命令。

## 2. 入口条件

开始 S01 前必须满足：

- S00 Core gate 为 PASS；
- Agent SDK、Claude Code Runtime 和 Node.js 版本组合已固定，并有兼容性记录；
- `settings.json`、自定义模型网关、Streaming Input、partial events、`canUseTool`、interrupt 和 resume 已有 S00 证据；
- 协议 V1 schema、示例和 PROTO-01–11 全部通过；
- iPhone 和 Mac 已登录同一 tailnet；
- tailnet 已开启 MagicDNS 和 HTTPS Certificates；
- Mac 的 Tailscale 机器名不包含敏感信息，因为机器名和 tailnet 名会进入公开证书透明度日志；
- 开发者持有可用于真机调试的 iPhone 和 Apple 开发环境。

如果 SDK/Runtime 实际行为与 S00 证据不一致，先回到 S00 修复基线，不在 S01 内悄悄改变 SDK 语义。

## 3. 目标、非目标与反目标

### 3.1 目标

- 单用户、一部 iPhone、一台 Mac、一个固定项目、一个受管会话。
- Tailscale Serve 提供标准 TLS，Mac Agent 只监听 `127.0.0.1`。
- 一次性二维码配对，设备凭证可吊销，未认证连接不能调用业务命令。
- 文字 prompt、流式文本、工具开始/结果/完成、停止和 run 最终状态。
- 单会话单活跃 run；忙碌时拒绝新 prompt，不排队。
- App 重连通过完整内存快照恢复，不实现增量事件同步。
- 遇到需要人工决策的工具权限时明确拒绝并展示原因，不默认放行。
- Mac 配置与设备凭证可跨进程重启保留；会话、run、事件和命令幂等记录只保存在内存。

### 3.2 非目标

S01 不包含：

- 多项目、多会话、创建新会话按钮、会话归档和排队；
- SQLite、事件持久化、`afterSeq` 增量同步和 Agent 重启恢复；
- 手机工具审批、“始终允许”和永久权限规则；
- 语音、推送、Relay、公网 Funnel、多用户和多手机控制；
- 桌面 UI、launchd、自动更新和完整诊断平台；
- 远程桌面、终端抓屏、任意 shell、任意 cwd 和文件下载接口；
- 完整 Diff 审查、工具输出全文下载和实时终端 stdout 保证；
- App 进程被杀后的未确认命令恢复。

### 3.3 反目标

以下结果视为失败：

- 使用 `badCertificateCallback` 全局接受证书、关闭 TLS 校验或开启 Tailscale Funnel；
- 把长期设备令牌、模型密钥或网关密钥放进二维码、URL、日志或 App 普通存储；
- App 能提交任意路径，或 Mac 通过手机开启 `bypassPermissions`；
- 为避免等待而默认批准 `canUseTool`；
- 同一会话出现两个并发 run，或取消操作影响其他 run；
- App 断线导致 Mac 自动取消 run；
- 重连后旧连接事件覆盖新快照，或重复事件造成重复消息；
- Agent 重启后宣称已恢复原会话；
- 把工具最终结果包装成“实时终端输出”的能力承诺。

## 4. 方案比较与选择

### 4.1 方案 A：Tailscale Serve + 标准 WSS（选定）

Mac Agent 只监听 localhost，Tailscale Serve 在 tailnet 内终止 TLS 并转发 HTTP/WebSocket。iOS 使用系统默认 CA 校验，二维码只携带一次性配对信息。

优点：无自签名证书管理、无自定义证书信任、Agent 不直接暴露网络端口。  
代价：依赖 MagicDNS、HTTPS Certificates 和 Tailscale 的 `ts.net` 域名。

### 4.2 方案 B：Agent 自签名 WSS + 证书指纹

Agent 自己生成证书，App 通过二维码获取 SHA-256 指纹并只接受匹配证书。

优点：不依赖 Tailscale HTTPS 证书功能。  
代价：证书 SAN、轮换、存储和 Flutter pinning 明显增加 S01 复杂度，容易诱导实现者关闭证书校验。

### 4.3 方案 C：Tailscale 上使用明文 WS

优点：代码最少。  
代价：不符合既定 WSS 和默认安全约束，认证与应用层加密边界不清晰。

**结论：**采用方案 A。Serve 与 Funnel 是不同能力，S01 只启用 Serve，不启用 Funnel。配对二维码使用 Tailscale 分配的 `ts.net` 主机名，不使用 `100.x.x.x` IP，也不需要用户购买域名。

## 5. 总体结构

```text
iPhone Flutter App
  ├─ PairingView
  ├─ ChatView
  ├─ Riverpod Controllers
  ├─ WSS Client + Snapshot Reducer
  └─ Keychain Device Credential
                 │
                 │ HTTPS/WSS，系统 CA 校验
                 ▼
Tailscale Serve（仅 tailnet）
                 │
                 │ HTTP/WS → 127.0.0.1:8787
                 ▼
Mac Node.js Agent
  ├─ CLI / Local Config
  ├─ Pairing & Device Auth
  ├─ Connection Manager
  ├─ Command Router + In-memory Idempotency
  ├─ Session Controller + Run Controller
  ├─ Agent SDK Adapter
  ├─ Event Normalizer + Event Journal
  └─ Snapshot / Outgoing Queue
                 │
                 ▼
Claude Agent SDK → Claude Code Runtime
                 ├─ 固定项目 cwd
                 └─ 当前 settings.json / 模型网关
```

Mac 是会话、run 和事件的唯一事实源。App 不直接读取 Claude 会话文件，不直接执行工具，也不持有模型凭据。

## 6. Mac Agent 设计

### 6.1 技术边界

- Node.js 22+、TypeScript，版本组合沿用 S00。
- Fastify 提供本地 HTTP，`@fastify/websocket`/`ws` 提供 `/ws`。
- 协议消息使用 S00 JSON Schema/Ajv 校验。
- Agent SDK 类型只能出现在 `AgentSdkAdapter` 及其测试中。
- 其他模块使用内部 `SessionController`、`RunController`、`NormalizedEvent` 接口。
- 服务以当前普通用户运行，不使用 root。

### 6.2 CLI

提供以下命令：

```text
claude-remote-agent init --workspace <absolute-path> --name <display-name>
claude-remote-agent start
claude-remote-agent status
claude-remote-agent pair
claude-remote-agent pair --replace
claude-remote-agent devices
claude-remote-agent revoke <deviceId>
```

规则：

- `init` 只能在本机执行，解析并保存真实路径；目录不存在或不是目录时 fail fast。
- 重复 `init` 不静默覆盖配置，需用户明确确认。
- `start` 校验配置、设备文件权限、SDK/Runtime 版本和 localhost 监听地址。
- `start` 不自动执行 Tailscale 命令；`status` 显示 Serve 检查结果和人工配置指引。
- `pair` 需要 Agent 正在运行；已有绑定设备时拒绝，`pair --replace` 是本机明确替换操作。
- `revoke` 立即使凭证失效并关闭对应连接，不影响当前 Mac run。

### 6.3 本机管理通道

`status`、`pair`、`devices` 和 `revoke` 通过独立的本机管理接口操作运行中的 Agent：

```text
~/.claude-remote/agent.sock
```

- Agent `start` 同时监听 Unix domain socket 和 `127.0.0.1:8787`；CLI 通过 socket 上的 `/admin/v1/*` HTTP 接口调用。
- `~/.claude-remote/` 目录权限为 `0700`，socket 权限为 `0600`；其他系统用户不能访问。
- 管理接口不监听 TCP、不经 Tailscale Serve 暴露，手机协议中不存在 pair/revoke 管理命令。
- 不另设 admin token：同一 macOS 用户下的进程本就拥有该用户配置和进程权限，S01 的威胁边界是其他系统用户、未配对 tailnet 设备和远端客户端，而不是隔离同一用户下的恶意进程。
- CLI 遇到 stale socket 时先执行健康检查；只有连接被拒绝且对应 Agent 进程已不存在时才允许清理，不能删除活跃 socket。
- `init` 和 `start` 直接在本机执行，其余运行中管理操作统一走 socket，避免 CLI 与 Agent 各自修改内存状态。

### 6.4 本地配置

配置目录：

```text
~/.claude-remote/
  agent.json
  devices.json
  agent.sock
  agent.log
```

`agent.json`：

```json
{
  "version": 1,
  "desktopId": "desktop_01...",
  "workspace": {
    "workspaceId": "default",
    "displayName": "S01 Fixture",
    "rootPath": "/absolute/real/path"
  },
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

- `baseUrl` 必须为 `https:`，真机配对只接受 Tailscale DNS 主机名；不保存 Tailscale 认证密钥。
- `devices.json` 权限为 `0600`，内容只有设备元数据和令牌哈希。
- `agent.json` 不复制 `settings.json` 的 env、token、API key 或网关密钥。
- App 只获得 `workspaceId` 和 `displayName`，不获得 `rootPath`。
- Agent 重启可重读配置和设备，但不得据此恢复旧会话/run。

### 6.5 模块职责

| 模块 | 职责 |
|---|---|
| `PairingService` | 一次性配对、设备绑定、替换和吊销 |
| `DeviceAuthenticator` | Bearer 校验、令牌哈希比较、lastSeen 更新 |
| `ConnectionManager` | WSS upgrade、hello/ready、心跳、连接代次、发送队列 |
| `CommandRouter` | schema、鉴权、命令幂等、错误映射 |
| `SessionController` | 唯一本地会话、Claude session 映射、快照 |
| `RunController` | 单活跃 run、取消、最终状态 |
| `AgentSdkAdapter` | query、Streaming Input、interrupt、canUseTool、SDK 消息 |
| `EventNormalizer` | SDK 消息到统一事件、delta 合并、工具结果分块 |
| `EventJournal` | 内存 eventId/seq、查询最近事件、重复检测 |
| `SnapshotFactory` | 会话、活跃 run、lastSeq 和最近 200 条事件 |

## 7. Tailscale 与传输安全

### 7.1 网络约束

- Agent 默认监听 `127.0.0.1:8787`，不能配置为 `0.0.0.0`。
- Tailscale Serve 将 `https://<machine>.<tailnet>.ts.net` 转发到本地 Agent。
- `/v1/pairings` 和 `/ws` 使用同一受信 HTTPS 主机。
- S01 不启用 Funnel，不配置公网 DNS，不购买域名。
- iOS 使用系统 TLS 校验；证书错误直接连接失败，不能提供“仍然继续”按钮。
- Tailscale ACL 是额外网络层保护，不替代应用层设备认证。

### 7.2 连接认证

WSS 地址：

```text
wss://<machine>.<tailnet>.ts.net/ws
```

认证头：

```text
Authorization: Bearer <deviceId>.<deviceToken>
```

规则：

- 凭证不得放在 query string、Subprotocol、URL 或日志中。
- upgrade 前验证设备存在、未吊销且令牌哈希匹配；失败返回 HTTP 401。
- 已绑定设备在连接后被吊销时，关闭其 WSS；后续请求返回 `DEVICE_REVOKED`。
- 同一 deviceId 建立新连接时递增 `connectionEpoch` 并关闭旧连接，避免重连后的旧连接继续写入。
- S01 只允许一个已绑定设备，不实现多设备列表 UI 或控制租约。

## 8. 一次性配对设计

### 8.1 二维码内容

```json
{
  "v": 1,
  "baseUrl": "https://macbook.example-tailnet.ts.net",
  "pairingId": "pair_01...",
  "code": "<32-byte-random-base64url>",
  "expiresAt": 1762433100000
}
```

二维码不包含长期设备令牌、工作目录、模型名、网关地址或任何模型密钥。

### 8.2 配对流程

1. 本机用户执行 `pair` 或 `pair --replace`。
2. Agent 生成 `pairingId` 和至少 256 位随机 code，只在内存保存配对请求，5 分钟后过期。
3. 终端显示二维码和过期时间，不打印未来签发的 deviceToken。
4. App 校验 QR 字段、HTTPS 地址和过期时间，请求：

```http
POST /v1/pairings
Content-Type: application/json

{
  "pairingId": "pair_01...",
  "code": "...",
  "deviceName": "User iPhone",
  "appVersion": "0.1.0",
  "supportedProtocolVersions": [1]
}
```

5. Agent 原子消费配对请求，生成新的 `deviceId` 和至少 256 位随机 deviceToken。
6. Agent 只保存 `SHA-256(deviceToken)`、deviceId、设备名和创建/吊销时间。
7. 响应 `201`：

```json
{
  "deviceId": "device_01...",
  "deviceToken": "...",
  "desktopId": "desktop_01...",
  "workspace": {
    "workspaceId": "default",
    "displayName": "S01 Fixture"
  },
  "protocolVersion": 1
}
```

8. App 将 `deviceId + deviceToken + baseUrl` 存入 Keychain，然后建立 WSS。

### 8.3 配对失败与重试

- code 错误或 pairingId 不存在：统一 `PAIRING_FAILED`，不泄露哪一项错误。
- 已使用或过期：`PAIRING_EXPIRED`，必须回 Mac 重新生成。
- 连续 5 次失败：当前配对请求作废。
- 配对尝试采用 Agent 级全局限流：每分钟最多 10 次，超限返回 `RATE_LIMITED`。Tailscale Serve 代理后来源通常都是 localhost，因此不得按 socket peer IP、deviceName 或可伪造的代理身份头计数。
- 已有绑定设备：`DEVICE_ALREADY_PAIRED`，App 不提供强制替换。
- 配对接口响应不得写入访问日志 body；deviceToken 只在响应中出现一次。
- App 解除绑定只删除本机 Keychain；要阻断未来连接，必须在 Mac 执行 revoke。

## 9. 协议在 S01 的应用

S01 直接使用协议 V1，不创建 S01 私有信封。

### 9.1 握手与心跳

- WSS 建立后 10 秒内，App 首条消息必须为 `connection.hello`。
- `supportedProtocolVersions` 包含 1；Agent 返回 `connection.ready`。
- 不支持共同版本时返回 `VERSION_INCOMPATIBLE` 并关闭，不能创建 session/run。
- `connection.ready` 包含 desktopId、Agent/SDK/Runtime 版本、connectionEpoch 和能力。
- 使用 WebSocket ping/pong：Agent 每 15 秒 ping，45 秒无 pong 判定失效。
- App 重连间隔为 1、2、4、8、15 秒并加随机抖动，之后保持 15 秒上限。
- 握手与控制消息不占用会话 seq。

### 9.2 命令

| 命令 | Payload | 成功结果 | 主要错误 |
|---|---|---|---|
| `session.start` | `{workspaceId:'default'}` | 本地 sessionId、当前 claudeSessionId 或 null、会话状态 | `WORKSPACE_NOT_ALLOWED`、`VERSION_INCOMPATIBLE` |
| `prompt.send` | `{text:string}` | `{sessionId,runId,status:'starting'}` | `SESSION_NOT_FOUND`、`SESSION_BUSY`、`INVALID_MESSAGE` |
| `run.cancel` | `{}`，信封含 sessionId/runId | `{sessionId,runId,status:'cancelling'}` | `SESSION_NOT_FOUND`、`RUN_NOT_ACTIVE` |
| `session.snapshot` | `{sessionId}` | `{sessionId,lastSeq}` | `SESSION_NOT_FOUND` |

补充规则：

- `session.start` 是附着语义：当前进程已有会话时返回同一会话，不能清空历史或新建第二个会话。
- 本地 session 在 `session.start` 时创建；Claude query 可在首次 prompt 时懒启动，因此初始 `claudeSessionId` 允许为 null，SDK init 后通过快照和 `session.status` 更新。
- prompt 只拒绝全空白文本，不擅自 trim 或改写其他内容；UTF-8 编码后必须为 1–16,384 字节。
- 每条业务消息仍受 64 KiB 总限制。
- `session.snapshot` 对应快照事件发送完成后才返回 command.result，避免 App 把“命令成功”误认为快照已应用。
- 所有命令结果进入内存幂等表；相同 commandId 返回首次结果，`duplicate:true`，不重复执行。

### 9.3 事件

| 事件 | Payload 关键字段 | 是否进入时间线/占用 seq |
|---|---|---|
| `session.snapshot` | session、activeRun、recentEvents、lastSeq、oldestIncludedSeq、snapshotTruncated | 否；是覆盖式控制快照 |
| `session.status` | status、claudeSessionId、activeRunId、lastRunStatus | 是 |
| `message.delta` | assistantMessageId、contentBlockIndex、deltaSeq、text | 是 |
| `message.completed` | assistantMessageId、content、stopReason、可选 contentTruncated | 是 |
| `tool.started` | toolUseId、toolName、input、可选 inputTruncated/inputOmittedInSnapshot | 是 |
| `tool.output` | toolUseId、chunkSeq、text、truncated | 是 |
| `tool.completed` | toolUseId、status、isError、summary | 是 |
| `run.completed` | runId、status、errorSummary | 是 |
| `desktop.status` | Agent/SDK/Runtime 版本和状态 | 否 |
| `command.result` | status、duplicate、data/error | 否 |
| `error` | code、safeMessage、sessionId/runId（如适用） | 仅会话业务错误需要 |

`run.completed.status`：`succeeded | failed | cancelled | interrupted`。  
`tool.completed.status`：`succeeded | failed | denied | cancelled`。

S01 不使用 `run.queued`、`permission.requested/resolved` 或 `session.sync`。

### 9.4 S01 新增错误码

- `SESSION_NOT_FOUND`：当前进程没有指定会话；
- `PERMISSION_REQUIRED`：工具需要人工审批，S01 已拒绝；
- `DEVICE_REVOKED`：设备已吊销；
- `PAIRING_FAILED`、`PAIRING_EXPIRED`、`DEVICE_ALREADY_PAIRED`：仅配对 HTTP 使用。

`DESKTOP_OFFLINE` 是 App 本地连接状态，不是 Mac 在离线时还能发送的事件。

## 10. 会话与 Run 生命周期

### 10.1 会话

- 同一 Agent 进程最多一个本地受管会话。
- `session.start` 可重复附着，不创建第二个 Claude session。
- **一次 run 对应一次新的 `query()`**，不保留跨 run 的闲置 SDK query。
- 首次 run 不传 resume；后续 run 使用当前内存 `claudeSessionId` 作为 `resume`，从而保持同一会话上下文。
- 为支持 run 中途 `interrupt()`，每次 query 使用只包含当前 prompt 的 AsyncIterable Streaming Input；当前 run 终态处理完成后调用 `close()`。
- query 使用固定 cwd、S00 确定的 settings/system prompt/tool preset 和权限模式。
- Claude session ID 从 S00 已验证的 SDK init/result 字段获取并保存到内存映射；收到新 ID 时不得覆盖成另一个会话。
- 不调用 CLI 与 App 并行控制同一会话；S01 不提供终端附着功能。

### 10.2 Run 状态

```text
starting → running → succeeded
starting → running → failed
starting → running → cancelling → cancelled
starting/running → interrupted（当前进程可观察的异常中断）
```

- `starting`、`running`、`cancelling` 都视为忙碌，新的 prompt 返回 `SESSION_BUSY`。
- 取消只针对信封中的 runId；已完成 run 返回 `RUN_NOT_ACTIVE`。
- `run.cancel` 接受后先进入 cancelling，再调用 SDK `interrupt()`；Promise resolve 只表示中断请求已确认，不能直接当作 run 已结束。
- RunController 按 S00 实测的 interrupt 后续事件序列等待终态；收到对应终态后发出 `run.completed(cancelled)` 并关闭 query。
- interrupt 后 10 秒仍无可判定终态时，关闭 query，发出 `run.completed(interrupted)` 和安全错误摘要；不能永远停留在 cancelling。
- 如果 interrupt 调用本身失败，记录安全错误并进入 failed/interrupted，具体映射以 S00 证据为准。
- 工具 deny 不直接决定 run 失败；Claude 可继续回复，最终状态以 SDK result 为准。
- App 断线不改变 run 状态。

### 10.3 权限边界

- 本机 Claude Code 规则已经允许的只读工具可正常执行。
- `canUseTool` 被调用时，S01 立即返回：
  ```text
  behavior: deny
  interrupt: false
  message: Mobile approval is not available in S01
  ```
- 同时发送 `PERMISSION_REQUIRED` 安全错误，展示工具名和“需要在后续版本支持审批”。
- 如果已发出对应 tool.started，必须补 tool.completed(denied)；不得留下永远运行中的工具卡片。
- 不返回 updatedPermissions，不写 `.claude/settings.local.json`，不启用 bypassPermissions。

### 10.4 Agent 重启

- 内存 session、run、事件和命令幂等表全部丢弃。
- App 可能短暂显示 desktop offline，重连后收到 `SESSION_NOT_FOUND` 或需要重新 session.start。
- UI 必须明确提示“Mac 服务已重启，已建立新的内存会话”，不能把空快照显示成旧会话恢复。
- 配置和设备绑定仍有效，无需因 Agent 重启重新配对。
- 不自动重放重启前 prompt，不自动恢复旧 run。

## 11. SDK 事件归一化

### 11.1 S00 证据映射输入

Adapter 和 RunController 实现前必须从 `docs/s00/` 提取并冻结一张映射表，至少包括：

| S00 证据 | S01 用途 |
|---|---|
| init/result 中 Claude session ID 的准确字段 | 首次保存与后续 resume |
| message_start/content block 的稳定标识 | assistantMessageId/contentBlockIndex |
| text_delta、assistant、result 的实际顺序 | delta/completed 合并 |
| success、error、deny 后的 result subtype | succeeded/failed 映射 |
| interrupt() 的响应及后续 result/error/静默行为 | cancelling/cancelled/interrupted 状态机 |
| query.close() 的清理行为 | 每 run 资源释放 |
| tool_use/tool_result 的关联字段和输出时机 | 工具卡片与 output 事件 |

如果 S00 文档尚未产生或证据不足，S01 的 Adapter/RunController/Normalizer 实施计划必须标记 BLOCKED，不能用猜测补齐。Mock 可以先行，但不能据此通过真实 E2E。

### 11.2 助手消息

- 以 SDK stream message/content block 的稳定标识建立 `assistantMessageId + contentBlockIndex`。
- `text_delta` 归一化为 message.delta；不得为每个 delta 随机生成新的 assistantMessageId。
- 相邻且属于同一内容块的 delta 可按 50 ms 或 16 KiB 上限合并，先到者触发发送。
- message.completed 在完整文本可放入 32 KiB 正文预算时携带完整内容，App 用它校正/替换对应临时消息，不能追加成第二条消息。
- 完整正文超过 32 KiB 时，completed 的 content 置为空数组并设置 `contentTruncated:true`；完整正文由已经发送的 delta 表达，App 必须保留累计文本，不能用空 content 清空。
- 无法识别的 SDK 事件记录类型和安全元数据，不直接抛给 App，也不阻塞其他事件。

### 11.3 工具事件

- tool_use 内容块映射 tool.started，保留 toolUseId、工具名和可展示输入；输入 JSON 预览最多 16 KiB，超出或无法安全序列化时只保留安全摘要并设置 `inputTruncated:true`，不能突破总消息上限。
- SDK 可提供的 tool_result/输出映射 tool.output 和 tool.completed；completed summary 最多 4 KiB。
- S01 不承诺 Bash stdout 的实时流；如果 SDK 只在工具结束时提供结果，则 UI 显示“执行中”后一次展示结果。
- 单块 UTF-8 不超过 32 KiB，分块不能切断多字节字符；App 单工具预览最多保留 256 KiB，超出时明确标记 truncated。
- 完整输出只保留在当前 Mac 内存事件日志中，S01 无全文下载接口。

### 11.4 EventJournal 与发送顺序

- 时间线事件先分配 eventId 和连续 seq，再进入内存 Journal，再进入连接发送队列。
- command.result、握手、desktop.status 和按需 snapshot 不消耗 seq。
- 每连接发送队列上限为 2 MiB 或 1,000 条，优先合并 delta；仍超限时关闭慢连接，Mac run 和 Journal 继续。
- 不根据 timestamp 或网络到达顺序排序。

## 12. 快照、断线与幂等

### 12.1 快照内容

```json
{
  "session": {
    "sessionId": "session_01...",
    "claudeSessionId": "claude_01...",
    "workspaceId": "default",
    "status": "running"
  },
  "activeRun": {
    "runId": "run_01...",
    "status": "running",
    "commandId": "cmd_01..."
  },
  "recentEvents": [],
  "lastSeq": 128,
  "oldestIncludedSeq": 100,
  "snapshotTruncated": true
}
```

- `recentEvents` 最多 200 条、按 seq 升序；`lastSeq` 始终是 Journal 当前最大值，`oldestIncludedSeq` 是实际纳入的最小 seq，没有事件时为 null。
- **序列化后的整个 session.snapshot 消息不得超过 64 KiB，payload 预算为 48 KiB**。SnapshotFactory 从最新事件向前选择，直到数量或字节预算耗尽；不能因 200 条 32 KiB 工具输出生成数 MiB 快照。
- 快照是最近摘要而不是完整日志。只要丢弃旧事件或压缩了事件内容，`snapshotTruncated` 必须为 true；App 显示“仅保留最近摘要，完整记录暂不可下载”。
- 快照内的事件按以下规则投影，实时发送的原始事件不受这些预览限制：
  1. 同一 assistantMessageId 已有 message.completed 时，省略它之前的 message.delta；
  2. message.completed 的文本预览每个助手消息最多 8 KiB，超出时设置 `contentTruncated:true`；
  3. 每个 toolUseId 最多保留最新一个 tool.output 预览，文本最多 4 KiB，并设置 `truncated:true`；
  4. tool.started 保留 toolUseId/toolName，但 input 置为空对象并设置 `inputOmittedInSnapshot:true`；
  5. 活跃且尚未 completed 的助手消息，每个最多保留 8 KiB 最新 delta，确保可以看到当前进度。
- 若预算不足，继续丢弃最旧事件，但 session、activeRun、lastSeq 和截断标记必须保留；不能通过突破 64 KiB 或 2 MiB 队列来“恢复完整”。
- activeRun 为 null 时仍返回 lastRunStatus。
- 快照包含当前权限拒绝等错误状态，但不包含任何 Mac 密钥或真实工作路径。

### 12.2 重连流程

1. App 重新建立 WSS 并完成 hello/ready，获得新 connectionEpoch。
2. 已存在本地 sessionId 时发送 session.snapshot；不存在时发送 session.start。
3. Agent 在同一 Journal 临界区生成快照并排队，之后的新事件按顺序排在其后。
4. App 清空当前易失会话/run/timeline，应用快照，再应用快照之后的事件。
5. 忽略旧 connectionEpoch 的回调；同 eventId 的重复事件去重，冲突按协议错误处理。
6. 快照完成后 composer 才恢复可用。

S01 不使用 afterSeq；App 冷启动没有可靠本地时间线，因此总是请求快照。

### 12.3 未确认命令

- App 点击发送后生成并保存 commandId，直到收到明确结果前不允许重复创建新命令。
- 命令等待 10 秒无结果时显示“结果未知”，提供“重试同一命令”，不是再次生成 prompt。
- Agent 内存幂等表覆盖同一进程内的重试。
- App 被杀或 Agent 重启后，该保证失效，属于 S01 已知限制；完整持久幂等由 S04 实现。

## 13. iOS App 设计

### 13.1 页面

仅包含两页：

**配对页**

- 扫码按钮、相机权限说明、Mac 地址脱敏摘要；
- 配对中、失败、过期和已绑定状态；
- 不显示 deviceToken，不提供免费输入任意 cwd；
- 调试构建可提供开发配对入口，但不得关闭 TLS 校验，真机验收只使用二维码。

**聊天页**

```text
┌─────────────────────────────┐
│ MacBook · 已连接             │
│ S01 Fixture                 │
├─────────────────────────────┤
│ 用户消息                     │
│ Claude 流式消息              │
│ ┌─ Read · 已完成 ─────────┐ │
│ │ 输入摘要 / 输出预览      │ │
│ └─────────────────────────┘ │
│ 需要权限：S01 已拒绝（如有） │
├─────────────────────────────┤
│ 正在执行…            [停止] │
│ [输入消息]            [发送] │
└─────────────────────────────┘
```

不包含项目列表、会话列表、设置后台、语音按钮和审批按钮。

### 13.2 Riverpod 状态

- `pairingState`：unpaired、scanning、pairing、paired、failed；
- `connectionState`：connecting、handshaking、syncing、online、reconnecting、offline、revoked、incompatible；
- `sessionState`：未创建、ready、当前 Claude 映射和最近 run 状态；
- `timelineState`：按 sessionId+seq 归并的消息和工具卡片；
- `composerState`：文本、发送中、结果未知、可重试 commandId；
- `runControlState`：无活跃 run、starting、running、cancelling。

连接状态、会话状态和 run 状态分开，不能用“已连接”推断“任务完成”。

### 13.3 交互规则

- 空白 prompt、超过 16 KiB、非 online、快照同步中或忙碌时禁止发送，并显示原因。
- 忙碌时发送不会本地排队；若因竞态收到 SESSION_BUSY，保留输入文本供用户稍后重试。
- 只有活跃 run 显示停止；cancelling 时停止按钮禁用并显示状态。
- message.completed 合并临时 delta；工具卡片按 toolUseId 更新；带 contentTruncated 的快照预览不得覆盖本地已有的更长正文。
- snapshotTruncated 时显示固定摘要提示，不把 oldestIncludedSeq 之前的缺失当作需要重复请求的错误。
- run.completed 后显示成功、失败、取消或中断，不自动发送下一条。
- 所有错误显示安全摘要和可复制 traceId，不展示敏感堆栈或密钥。

### 13.4 后台与安全存储

- deviceToken 和 baseUrl 使用 `flutter_secure_storage`/Keychain。
- 时间线和 pairing code 不写入 Keychain；pairing code 消费后立即从内存清除。
- App 退后台不保证维持 WSS，不请求后台持续运行权限。
- 退后台或断网不发送 run.cancel。
- 回前台执行重连和快照；无推送通知。

## 14. 日志、限制与隐私

- Mac 使用结构化 JSON 日志，包含 traceId、commandId、sessionId、runId、deviceId 和 connectionEpoch。
- 默认不记录 prompt 正文、完整模型回复、工具完整输入、deviceToken、pairing code、Authorization header 或模型密钥。
- prompt 只记录字节长度；配对日志只记录 pairingId 和结果。
- `status` 可显示监听地址、Tailscale Serve 状态、设备绑定状态和版本，不打印 rootPath 给 App。
- 单条控制消息最大 64 KiB；prompt 最大 16 KiB；工具输出单块最大 32 KiB。
- 快照最多最近 200 条，payload 预算 48 KiB、完整消息上限 64 KiB；发送队列 2 MiB/1,000 条；配对 5 分钟、单配对请求失败 5 次、全局每分钟 10 次；命令结果等待 10 秒。
- 首版不做用量统计、远程遥测或诊断自动上传。

## 15. 测试策略

### 15.1 Mac 单元与集成测试

| ID | 场景 | 通过标准 |
|---|---|---|
| CFG-01 | 非绝对路径、不存在目录、符号链接配置 | fail fast，保存规范化真实路径 |
| CFG-02 | 配置含未知 App cwd/rootPath 请求 | 忽略或拒绝，不能改变固定 workspace |
| PAIR-01 | 正常扫码配对 | code 只能消费一次，token 只响应一次，Mac 只存哈希 |
| PAIR-02 | 错误/过期/重复/五次失败/全局每分钟十次 | 不签发凭证，按配对请求和全局窗口限流，不依赖代理来源 IP |
| PAIR-03 | replace/revoke | 仅本机明确操作生效，旧连接关闭，run 不停止 |
| ADMIN-01 | 非本机用户、TCP/Tailscale 管理路径、活跃/stale socket | 管理接口只走 0700 目录下的 0600 Unix socket，不能远程调用或误删活跃 socket |
| AUTH-01 | 无 token、错 token、URL token、吊销设备 | 全部拒绝，日志无 token |
| CONN-01 | hello/ready、版本不兼容、心跳超时 | 不兼容不能 start，死连接被清理 |
| CONN-02 | 同设备重连代次 | 旧连接关闭，旧事件回调不能写入 |
| CMD-01 | 相同 commandId 重试 | 返回首次结果，只有一个业务副作用 |
| CMD-02 | 空白/超长/非法 schema | 边界拒绝，不启动 run |
| SESS-01 | 重复 session.start | 返回同一 session，不清空 Journal |
| RUN-01 | 忙碌 prompt | 返回 SESSION_BUSY，无第二个 run |
| RUN-02 | 正常/失败/取消/interrupt 失败 | 状态机无悬挂，cancel 只影响指定 run |
| RUN-03 | App 断线 | SDK run 和 Journal 继续 |
| PERM-01 | canUseTool | deny、PERMISSION_REQUIRED、工具卡片不悬挂、无永久规则 |
| EVENT-01 | delta 合并和 completed | assistantMessageId 稳定，文本不重复 |
| EVENT-02 | 工具结果分块/截断 | UTF-8 安全、顺序正确、truncated 明确 |
| EVENT-03 | 重复/乱序/冲突事件 | 去重排序，冲突不静默覆盖 |
| SNAP-01 | 快照期间新事件 | 快照后事件不丢失，lastSeq 正确 |
| SNAP-02 | 200 条 32 KiB 工具输出与慢连接 | 快照仍不超过 64 KiB、payload 不超过 48 KiB，截断标记正确，关闭慢连接不停止 run |
| SNAP-03 | completed/delta、长文本、工具输入和活跃 delta 投影 | 按预览规则省略/截断，oldestIncludedSeq 正确，App 不用截断正文覆盖更长正文 |
| SEC-01 | 日志扫描 | 无 token、code、密钥、Authorization 或个人绝对路径 |

### 15.2 Flutter 单元与 Widget 测试

- QR 缺失字段、非 HTTPS、非 Tailscale 主机、过期和伪造版本；
- Keychain 读写与删除，token 不出现在 widget/log；
- connection/session/run/composer 状态互斥；
- SESSION_BUSY 保留输入，取消后按钮状态正确；
- message.delta/completed 合并，toolUseId 卡片更新；
- 快照覆盖、快照后事件、旧 epoch 回调和 eventId 去重；
- 断线/后台/回前台不触发 cancel；
- revoked/incompatible/offline 的错误文案与重连路径；
- 发送超时只重试原 commandId。

### 15.3 Mock SDK 集成测试

使用可控 Mock Adapter 覆盖成功、工具输出、权限拒绝、取消、异常和慢事件流。Mock 测试不得宣称验证真实模型或真实 SDK；真实能力依赖 S00 和以下真机测试。

### 15.4 真机端到端验收

| ID | 操作 | 通过标准 |
|---|---|---|
| E2E-01 | Tailscale Serve 配置检查 | 系统 CA 校验通过，无 Funnel，无关闭 TLS 校验 |
| E2E-02 | Mac pair，iPhone 扫码 | 配对成功；未绑定测试客户端不能执行命令 |
| E2E-03 | session.start + 只读代码问答 | 流式文本和 Read/Glob 工具事件顺序正确 |
| E2E-04 | 长回复中发送第二条 prompt | 收到 SESSION_BUSY，无第二个 run，输入保留 |
| E2E-05 | 长回复中点击停止 | 只取消当前 run，最终 cancelled，会话可继续使用 |
| E2E-06 | 执行中退后台再回前台 | Mac run 继续，回前台快照恢复且无重复消息 |
| E2E-07 | 执行中断网再恢复 | 状态从 offline/reconnecting 到 syncing/online，无自动取消 |
| E2E-08 | 测试客户端重复发送同 commandId | 只有一个 run，第二次 duplicate:true |
| E2E-09 | 触发需审批 Bash | 命令未执行，App 显示 PERMISSION_REQUIRED，无默认放行 |
| E2E-10 | Mac revoke | 当前连接失效，旧 token 不能重连 |
| E2E-11 | Agent 重启 | 绑定仍在；明确建立新会话，不声称恢复旧 run |
| E2E-12 | 连续完成两个独立 prompt | 第二轮在第一轮完成后执行，两个 run 独立且上下文属于同一受管会话 |

## 16. 完成标准

S01 只有同时满足以下条件才能通过：

- S00 Core 仍为 PASS，S01 未修改协议 V1 基础语义；
- Mac、协议和 Flutter 核心测试全部通过，核心 TypeScript 与 Dart 业务逻辑覆盖率均不低于 80%；
- E2E-01–12 在真实 iPhone、Mac、Tailscale 和固定测试项目中通过；
- 未绑定设备、错误 token、吊销设备和版本不兼容均无法创建 run；
- 单会话无并发 run，取消和权限拒绝路径无悬挂；
- App 断线/退后台不停止任务，重连快照无重复或旧连接覆盖；
- Agent 重启行为被明确标识为新内存会话，没有虚假恢复承诺；
- 二维码、日志、App 包、App 日志和 Mac 配置中没有模型密钥、长期 token 明文（Keychain/一次性配对响应除外）或配对 code 持久化；
- Tailscale Serve 仅 tailnet 可用，Funnel 未开启；
- 文档明确记录 S01 的内存限制、无实时 stdout 保证、无手机审批和无持久幂等。

## 17. 留给实现者的事项

以下可由实现者决定，不需要新的产品决策：

- Flutter/Dart 与 Node 依赖的精确兼容版本和 lockfile；
- `mobile_scanner`、QR 终端渲染、测试和 JSON 序列化库；
- UI 颜色、字体、间距、空状态插画和工具卡片展开样式；
- Dart 模型使用代码生成还是手写，只要共享协议样例测试通过；
- 内部文件拆分和 Riverpod Provider 命名，只要模块边界与状态语义不变；
- 配置文件原子写入与文件锁实现；
- Tailscale CLI 的具体安装/检查命令，以执行时官方版本文档为准；
- 测试 fixture 的无害源码内容，只要 Read/Glob 可自动允许、Bash 必触发审批。

不得自行改变：

- Tailscale Serve + 标准 TLS，不得启用 Funnel或关闭证书校验；
- 单固定项目、单会话、单活跃 run、忙碌拒绝；
- 一次性 QR 配对、Keychain、Mac 令牌哈希和设备吊销；
- canUseTool 默认拒绝，不得默认批准或写永久规则；
- 内存会话与快照恢复边界，不得宣称 S04 的持久恢复能力。

## 18. 后续接口预留

- S02 在现有 SessionController 外增加 Workspace Manager、多 Session Map 和每会话队列，不改变 App 的 event reducer 基本语义。
- S03 将当前立即 deny 的 Permission Handler 替换为 Permission Broker，新增审批事件，不复用 PERMISSION_REQUIRED 作为审批请求。
- S04 用 SQLite Journal 替换内存 Journal，并增加 afterSeq；S01 快照结构保留。
- S05 只向 composer 增加语音识别文本，不改变 prompt.send。
- S06 再增加 launchd、诊断和统一交付，不在 S01 提前建设。
