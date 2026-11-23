# Cloud Relay 接口契约 v1

**日期：** 2026-11-23
**状态：** 待评审
**性质：** 规范性契约（normative）。App 与 Desktop Agent 对接云端**只依赖本文档**。
云端可用任何语言实现；满足本契约即视为兼容。配套黑盒契约测试是本文档的可执行形式。

本文档中「必须/禁止/应/可」按 RFC 2119 语义使用。

---

## 1. 模型与术语

- **账号（account）**：管理员内部创建的用户，含用户名与口令。不开放注册。
- **设备（device）**：一次成功登录产生一条设备记录，角色为 `phone` 或 `desktop`。
  设备有 `deviceId` 与 `deviceToken`；令牌可吊销，吊销后永久失效。
- **desktopId**：即角色为 `desktop` 的设备的 `deviceId`。不存在独立的电脑身份。
- **桌面连接**：Agent 向云端建立的一条出站 WSS，承载该电脑的全部流量。
- **通道（channel）**：手机的一条 WS 连接在桌面连接上的逻辑映射。
  种类：`control`（协议 v1 控制消息）与 `asr`（语音）。
- **拼接（splice）**：云端把通道两端的帧原样双向转发，**不解析帧内容**。

会话、事件、审批等业务语义全部由 protocol v1 端到端定义，云端对其透明。
事件事实源在各电脑的 Agent 本地；云端**禁止持久化任何转发内容**。

## 2. 通用约定

- 传输：生产环境必须 TLS（可由反向代理终止）；开发环境允许明文 ws/http。
- 编码：JSON 均为 UTF-8；二进制一律 base64（标准字母表，含 padding）。
- 鉴权：`Authorization: Bearer <deviceId>.<deviceToken>`。
  **禁止**通过 query string、子协议或 URL 其他部分携带凭证。
  登录与版本查询之外的所有端点都必须鉴权。
- 错误响应体（所有 HTTP 错误与 WS error 消息统一）：

  ```json
  { "error": { "code": "STABLE_CODE", "message": "STABLE_CODE" } }
  ```

  `code` 为稳定错误码（大写下划线）；`message` 不得泄漏内部细节或
  账号/设备是否存在。
- 时间戳：Unix 毫秒。
- 所有列表为空时返回 `[]`，不返回 null。

### 2.1 大小与频率上限（规范性）

| 项 | 上限 |
|---|---|
| 登录尝试 | 每（用户名, 来源 IP）每分钟 10 次，超出返回 429 |
| 每账号设备记录数 | 20，超出登录返回 409 |
| `control` 通道单帧文本 | 64 KiB |
| `asr` 通道单帧（二进制解码后） | 256 KiB |
| HTTP 代答请求体/响应体（解码后） | 12 MiB |
| 桌面连接单条 JSON 消息 | 16 MiB |
| HTTP 代答超时 | 30 s |
| 握手（首条消息）超时 | 10 s |
| 物理链路心跳 | 服务端每 15 s ping；45 s 无 pong 断开 |

超限处置：WS 帧超限关闭对应通道（close 4003）；HTTP 体超限返回 413。

## 3. REST 端点

### 3.1 POST /v1/auth/login（免鉴权）

登录并注册一台设备。每次成功登录产生**新的**设备记录。

请求：

```json
{
  "username": "alice",
  "password": "…",
  "clientType": "phone",
  "deviceName": "iPhone 17e",
  "platform": "ios",
  "appVersion": "1.3.0"
}
```

- `clientType`：`"phone"` | `"desktop"`（必填）。
- `platform`：`"ios"` | `"android"` | `"macos"` | `"linux"`（必填）。
- `deviceName`、`appVersion`：非空字符串（必填）。

200 响应：

```json
{
  "accountId": "acc_…",
  "deviceId": "dev_…",
  "deviceToken": "…",
  "role": "phone",
  "contractVersion": 1
}
```

`deviceToken` 为至少 32 字节随机熵的 base64url 字符串，**只在登录响应中出现一次**；
服务端只存其哈希。客户端必须安全保存。

错误：400 `INVALID_REQUEST`；401 `INVALID_CREDENTIALS`；403 `ACCOUNT_DISABLED`；
409 `DEVICE_LIMIT_REACHED`；429 `RATE_LIMITED`。
用户名不存在与口令错误必须返回同一个 401 码。

### 3.2 GET /v1/desktops

列出本账号下角色为 `desktop` 的设备（手机选择控制目标用）。

200 响应：

```json
{
  "desktops": [
    {
      "desktopId": "dev_…",
      "desktopName": "MacBook Pro",
      "platform": "macos",
      "appVersion": "1.3.0",
      "online": true,
      "lastSeenAt": 1763890000000
    }
  ]
}
```

`online` 以是否存在存活的已握手桌面连接为准；`lastSeenAt` 为最近一次断开时间，
从未连接过为 null。

### 3.3 GET /v1/devices

列出本账号全部设备（含手机），字段同上并增加 `role`、`createdAt`。

### 3.4 DELETE /v1/devices/{deviceId}

吊销本账号下一台设备（含自己）。成功返回 204。
吊销立即生效：令牌失效、该设备存活连接与通道全部关闭（close 4004）；
吊销桌面会连带关闭其全部通道（手机端表现为 close 4010）。
吊销不中断电脑上正在执行的 run。
非本账号设备一律返回 404 `DEVICE_NOT_FOUND`。

### 3.5 GET /v1/version（免鉴权）

```json
{ "contractVersion": 1, "relayVersion": "0.1.0" }
```

### 3.6 手机代理 HTTP 端点

以下端点与 Agent 直连模式的同名接口语义、请求/响应体**完全一致**
（由 protocol v1 与 Agent 接口定义），云端只做鉴权与代答：

| 方法与路径 | 说明 |
|---|---|
| `POST /v1/attachments` | 图片附件上传 |
| `GET /v1/approvals/{approvalId}/content` | 审批内容读取 |
| `GET /v1/runs/{runId}/prompt` | run prompt 读取 |

- 必须携带 `desktopId` query 参数指定目标电脑；设备必须属于同一账号。
- 云端将其封装为 `http.request`（§5.4）经桌面连接发给 Agent，
  并把 `http.response` 原样映射为 HTTP 响应（状态码、Content-Type、体）。
- 上表之外的路径一律 404 `ROUTE_NOT_FOUND`，**不得**到达 Agent。
- 附加错误：400 `INVALID_REQUEST`（缺 desktopId）；404 `DESKTOP_NOT_FOUND`；
  503 `DESKTOP_OFFLINE`；504 `GATEWAY_TIMEOUT`（30 s 无响应）。
- Agent 返回的业务错误（如 `APPROVAL_NOT_FOUND`）原样透传。

## 4. 手机 WebSocket 端点

### 4.1 升级

- `GET /ws?desktopId=<id>`：控制通道（protocol v1，纯文本 JSON 帧）。
- `GET /ws/asr?desktopId=<id>`：语音通道（文本控制帧 + 二进制音频帧）。
- 鉴权：Bearer 头（§2）；`desktopId` 必填且属于同一账号、角色为 desktop。

升级失败（HTTP 响应，不完成升级）：400 `INVALID_REQUEST`；401 `UNAUTHENTICATED`；
404 `DESKTOP_NOT_FOUND`；503 `DESKTOP_OFFLINE`。

升级成功后，云端在目标桌面连接上开通道（`channel.open`），随后两端帧
**原样双向拼接**（文本与二进制均不改动、不解析）。首条 `connection.hello`、
版本协商、`connection.ready` 均由手机与 Agent 端到端完成，云端不参与。

### 4.2 生命周期与关闭码

| close code | 含义 |
|---|---|
| 4000 | 同 deviceId 新连接取代旧连接（superseded） |
| 4003 | 慢消费者 / 帧超限 |
| 4004 | 设备被吊销或账号被禁用 |
| 4010 | 目标电脑离线或桌面连接被取代（desktop gone） |

- 同一手机设备重复升级：旧连接立即以 4000 关闭，通道随之关闭。
- 桌面连接断开/被取代：其全部通道关闭，对应手机连接以 4010 关闭。
- 手机连接断开：云端向 Agent 发 `channel.close`，透传 close code。
- 云端对手机链路执行 §2.1 心跳；客户端必须按 WS 标准回应 pong。
- 断线重连由客户端负责（建议指数退避）；重连后业务补同步走 protocol v1
  `session.sync`（`afterSeq`），云端不参与、不缓存事件。

## 5. 桌面 WebSocket 端点

### 5.1 升级与握手

`GET /v1/desktop/ws`，Bearer 头鉴权，设备角色必须为 `desktop`。
升级失败：401 `UNAUTHENTICATED`；403 `FORBIDDEN`（角色不符）。

升级后 10 s 内 Agent 必须发送：

```json
{
  "type": "desktop.hello",
  "payload": {
    "supportedContractVersions": [1],
    "appVersion": "1.3.0",
    "desktopName": "MacBook Pro",
    "platform": "macos",
    "handshakeId": "hs_…"
  }
}
```

云端回应：

```json
{
  "type": "desktop.ready",
  "payload": { "handshakeId": "hs_…", "contractVersion": 1, "connectionEpoch": 3 }
}
```

- `connectionEpoch` 对该 desktopId 单调递增，每次新连接 +1。
- 新连接完成握手后，旧连接立即以 4000 关闭；云端只接受最新代次连接的消息。
- 版本无交集：云端发 `error`（`VERSION_INCOMPATIBLE`）后以 4002 关闭。
- 首条非 `desktop.hello`、超时或畸形：4001 关闭。
- 握手后云端执行 §2.1 心跳。

### 5.2 通道消息（双向，握手后）

`channelId` 由云端生成，桌面连接内唯一。以下消息均为
`{"type": …, "payload": …}` 信封：

**云端 → Agent**

```json
{ "type": "channel.open",
  "payload": { "channelId": "ch_…", "kind": "control", "deviceId": "dev_手机" } }
```

```json
{ "type": "channel.data",
  "payload": { "channelId": "ch_…", "binary": false, "data": "<原始文本帧>" } }
```

二进制帧：`"binary": true`，`"data"` 为帧字节的 base64。

```json
{ "type": "channel.close",
  "payload": { "channelId": "ch_…", "code": 1000, "reason": "client closed" } }
```

**Agent → 云端**：同名 `channel.data` / `channel.close`，方向相反。
Agent 不得发送 `channel.open`。

规则：

- 每通道内帧必须保序（FIFO）；通道之间无顺序保证。
- 向未知/已关闭通道发数据：接收方忽略并记日志（不视为致命错误）。
- `channel.close` 后该 channelId 永久作废；云端把 close code 透传给手机连接。
- Agent 关闭虚拟连接（如业务层判定慢消费者）也通过 `channel.close` 表达。
- 帧内容对云端不透明；大小按 §2.1 依 kind 校验。

### 5.3 通道背压

云端每通道待发送缓冲上限 2 MiB、桌面连接总缓冲上限 8 MiB；
超限时云端应关闭最慢通道（4003）而非无限缓冲。机制细节由实现决定，
上限与关闭码为规范性要求。

### 5.4 HTTP 代答消息

**云端 → Agent**

```json
{ "type": "http.request",
  "payload": {
    "requestId": "req_…",
    "deviceId": "dev_手机",
    "method": "POST",
    "path": "/v1/attachments",
    "contentType": "application/json",
    "bodyBase64": "…"
  } }
```

- `deviceId` 是云端已鉴权的手机设备 ID；Agent **必须信任**该身份
  （云端已完成鉴权），并保留其用于租约、ASR 归属等按设备语义。
- 只会出现 §3.6 白名单内的 method/path；`contentType` 可缺省；
  GET 请求无 `bodyBase64`。

**Agent → 云端**

```json
{ "type": "http.response",
  "payload": {
    "requestId": "req_…",
    "status": 200,
    "contentType": "application/json",
    "bodyBase64": "…"
  } }
```

- `requestId` 原样回显；30 s 内未响应，云端向手机返回 504 并丢弃迟到响应。
- 响应体上限 12 MiB；超限云端返回 502 `GATEWAY_ERROR`。

### 5.5 桌面链路错误与关闭码

| close code | 含义 |
|---|---|
| 4000 | 被同 desktopId 新连接取代 |
| 4001 | 握手失败/超时/畸形消息 |
| 4002 | 契约版本不兼容 |
| 4003 | 慢消费者 / 帧超限 |
| 4004 | 设备被吊销或账号被禁用 |

未知 `type`：云端发 `error`（`INVALID_MESSAGE`）并以 4001 关闭。
Agent 断线后必须自动重连（建议指数退避），重连获得新 `connectionEpoch`。

## 6. 路由与一致性（规范性）

1. **账号隔离**：一切 REST 访问与通道开通都必须校验请求设备与目标资源
   属于同一账号；跨账号一律表现为「不存在」（404）。
2. **手机取代**：同 deviceId 新手机连接使旧连接失效（4000）。
3. **桌面取代**：同 desktopId 新桌面连接握手完成后旧连接失效（4000），
   旧连接全部通道关闭，手机端以 4010 感知并重连补同步。
4. **无广播逻辑**：事件多播由 Agent 业务层对其虚拟连接逐一发送完成；
   云端只做逐通道拼接。
5. **不缓存**：云端不得缓存/持久化通道帧与代答体；断线期间事件由
   Agent 本地事件库兜底，手机重连后经 `afterSeq` 补拉。

## 7. 安全要求（规范性）

- 口令必须以加盐慢哈希（scrypt/argon2 级）存储；令牌只存 SHA-256 哈希。
- 令牌熵 ≥ 32 字节，base64url 编码；只在登录响应出现一次。
- 生产必须 TLS；禁止明文公网部署。
- 登录限流、设备数上限、帧/体上限、慢消费者断开按 §2.1 执行。
- 吊销与账号禁用必须立即断开存活连接与通道（4004）。
- 日志只允许元数据（deviceId、channelId、type、字节数、close code）；
  禁止记录口令、令牌、帧内容、代答体。
- 错误响应不得区分「用户名不存在」与「口令错误」，不得泄漏他账号资源存在性。

## 8. 版本演进

- 本契约版本为 1；`GET /v1/version` 与握手中的 `contractVersion` 用于协商。
- 向后兼容的增量（新可选字段、新消息 type）不升版本；接收方必须忽略未知可选字段。
- 破坏性变更升主版本并更换路径前缀（/v2）；云端应同时支持在线客户端的旧主版本
  至少一个发布周期。
- protocol v1 自身的演进与本契约无关（云端透明）。

## 9. 运维接口（非线上契约，资料性）

云端实现必须提供管理员本地操作能力（形态不限，参考实现为 CLI）：
创建账号、重置口令、禁用/启用账号、列出账号与设备、吊销设备。
管理操作直接作用于注册表，不经网络暴露。

## 10. 一致性验证

配套黑盒契约测试套件只经本文档定义的 HTTP/WS 端点访问云端，
覆盖：登录与限流、账号隔离、通道拼接保序、HTTP 代答与超时、
手机/桌面取代、吊销即时生效、大小上限、版本协商。
任何语言的实现通过该套件即视为符合契约 v1。