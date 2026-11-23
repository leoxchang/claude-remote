# Cloud Relay 计划二：Agent 出站连接器

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 `apps/agent` 主动向云端 Relay 建立出站 WSS，把手机通道映射为虚拟 socket 注入现有 `ConnectionManager`/`AsrGateway`，经 `http.request/response` 代答三个 HTTP 接口；新增 `relay login` CLI 与配置 v5。直连模式行为不变。

**Architecture:** 新增 `src/relay/` 子系统：`RelayLink`（出站连接/握手/重连/编解码）、`VirtualPhoneSocket`（ws 兼容子集）、`relay-connector`（通道分发与信任设备登记）、`http-dispatch`（复用现有处理器）。云端手机不在本地 device store，审批 broker 与 run prompt 的设备校验经「信任设备叠加」放行；身份归属仍按云端已鉴权的 deviceId。

**Tech Stack:** Node ≥22、TypeScript（tsx，noEmit）、ws 8.22.2、commander 15.1.0、vitest 5.1.0（root `apps/agent`）。

**Spec:** `docs/superpowers/specs/2026-11-23-cloud-relay-design.md`（§7.2）
**Contract（连接行为依据）:** `protocol/v1/relay-contract.md`（§5 桌面端）
**前置:** 计划一已合入 master（`apps/relay` + `contract-tests/relay` 可作真实 relay 用于 e2e）。

## Global Constraints

- 遵循 `apps/agent` 现有规范：ESM + NodeNext（导入带 `.js`）；strict；测试 `npx vitest run --root apps/agent`；覆盖率门槛 80%（`src/**/*.ts`）。
- 生产代码禁止 `console.log`；用 `AgentLogger`（只记元数据，不记令牌/帧内容/正文）。
- relay 凭证写 `agent.json`（模式 0600，复用 `writeFileAtomicSync`/`CONFIG_FILE_MODE`）；日志与 `relay status` 不得输出 `deviceToken`。
- 连接参数按契约：握手超时 10 s；重连指数退避 500 ms 起、上限 30 s、±20% 抖动；握手后由 relay 负责心跳（手机/桌面物理链路），虚拟 socket 的 `ping()` 本地即时应答 `pong`。
- 直连模式（phone-server、配对、Tailscale/LAN）零行为变化；`config.relay` 缺省时不得建立任何出站连接。
- 提交信息 `<type>: <description>`；每任务提交一次；无归因尾行。

## Review Focus

 spec 隐含、最可能咬到真实用户的五类状态（已在对应任务中落测试）：

1. **relay 不可达或中途断链**：agent 照常启动、对外直连接口可用；退避重连；链路断开时所有虚拟通道收到 close（ConnectionManager 清理，不留幽灵在线设备），重连后重新接受通道（Task 4/6）。
2. **凭证被吊销（close 4004）/ 账号禁用**：停止重连并记录致命错误，不做无限 401 重试；`relay status` 可见（Task 4）。
3. **云端手机执行审批响应与 run prompt 读取**：本地 device store 中不存在该设备也必须放行（信任叠加），且不得放宽其他设备（Task 5/8）。
4. **重连后同一 deviceId 的重复 `channel.open`**：ConnectionManager 按 deviceId 取代旧连接；信任集合登记幂等、关闭时清理（Task 6）。
5. **HTTP 代答身份透传**：`http.request.payload.deviceId` 作为处理器入参，附件归属、审批归属、`FORBIDDEN` 语义与直连一致（Task 8）。

---

### Task 1: 配置 v5（relay 段与 v4→v5 迁移）

**Files:**
- Create: `apps/agent/src/config/config-v5.ts`
- Modify: `apps/agent/src/app/runtime.ts`（`ensureV4Config` → `ensureV5Config`；返回类型 `AgentConfigV5`；`wireDurableAgent` 入参类型同步）
- Test: `apps/agent/test/config-v5.test.ts`

**Interfaces:**
- Consumes: `AgentConfigV4`/`parseAgentConfigV4`（`config-v4.ts`）、`writeFileAtomicSync`、`CONFIG_FILE_MODE`、`resolveAgentPaths`。
- Produces:
  - `interface RelayConfig { baseUrl: string; deviceId: string; deviceToken: string; desktopName: string }`
  - `interface AgentConfigV5 { version: 5; desktopId: string; database: { file: string }; listen: { host: ListenHost; port: 8787 }; tailscale: { baseUrl: string }; relay?: RelayConfig }`
  - `parseAgentConfigV5(input: unknown): AgentConfigV5`（relay 缺省合法；存在时四个字段均非空，baseUrl 必须是 http/https URL，其余字段沿用 v4 校验；拒绝未知顶层键不强制，但 `workspaces`/`devices` 仍拒绝）
  - `readConfigV5IfExists(configDir: string): AgentConfigV5 | null`
  - `writeConfigV5AtomicSync(configDir: string, config: AgentConfigV5): void`（0600）
  - `migrateV4ToV5(config: AgentConfigV4): AgentConfigV5`（保留全部字段，relay 缺省）
  - `DurableWireOptions.config` 类型改为 `AgentConfigV5`

- [ ] **Step 1: 写失败测试**

```ts
// apps/agent/test/config-v5.test.ts
it('v4 迁移为 v5：字段保留、relay 缺省', () => { /* 构造合法 v4 → migrateV4ToV5 → version 5、无 relay */
});
it('write/read 往返：带 relay 段原样保留', () => { /* 临时 configDir；relay = {baseUrl:'http://127.0.0.1:8788', deviceId:'dev_x', deviceToken:'t', desktopName:'Mac'} */
});
it('relay 段非法：缺 deviceToken / baseUrl 非 http(s) → INVALID_CONFIG', () => {});
it('v4 文件在无 v5 时经 readConfigV5IfExists 返回 null（交由迁移）', () => {});
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run --root apps/agent test/config-v5.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现**

新建 config-v5.ts（与 config-v4.ts 同构：parse/read/write/migrate）。runtime.ts：`createDurableAgentRuntime` 里 `existingV4` 读取后改走 `ensureV5Config(configDir, existingV4, database)`——v5 已存在直接用；否则执行原 v4 逻辑并 `migrateV4ToV5` + `writeConfigV5AtomicSync` 落盘后返回。范围只限 durable 路径；遗留的 `createAgentRuntime`/`wireAgent`（v1–v3 旧装配）不动。

- [ ] **Step 4: 运行确认通过**

Run: `npx vitest run --root apps/agent && npx tsc -p apps/agent`
Expected: PASS（既有 661 用例无回归）

- [ ] **Step 5: 提交**

```bash
git add apps/agent
git commit -m "feat: add agent config v5 with relay section"
```

---

### Task 2: `relay login/status/logout` CLI 与凭证写入

**Files:**
- Create: `apps/agent/src/relay/login.ts`
- Modify: `apps/agent/src/cli.ts`（新增 `relay` 命令组）、`apps/agent/src/app/versions.ts`（复用 `AGENT_VERSION` 作为 `appVersion`）
- Test: `apps/agent/test/relay-login.test.ts`

**Interfaces:**
- Consumes: `readConfigV5IfExists`/`writeConfigV5AtomicSync`/`migrateV4ToV5`（Task 1）、`readConfigV4IfExists`（迁移入口）。
- Produces:
  - `relayLogin(options: { configDir: string; baseUrl: string; username: string; password: string; desktopName: string; fetchImpl?: typeof fetch }): Promise<{ deviceId: string; accountId: string }>`
  - 行为：POST `{baseUrl}/v1/auth/login`，body `{ username, password, clientType: 'desktop', deviceName: desktopName, platform: 'macos', appVersion: AGENT_VERSION }`；200 时把 `{baseUrl, deviceId, deviceToken, desktopName}` 写入 config v5（保留其余字段；v5 不存在时先由 v4 迁移，v4 也不存在则抛 `Error('AGENT_NOT_INITIALIZED')`）；非 200 抛 `Error(code)`（取 body `error.code`，取不到用 HTTP 状态）
  - `readRelayConfig(configDir: string): RelayConfig | null`（status 用）
  - `removeRelayConfig(configDir: string): void`（logout；无 relay 段时幂等）
  - CLI：`relay login --url <baseUrl> --username <u> --password <pw> [--name <desktopName，默认取首项目 displayName 或 hostname>]`；`relay status`（输出 `{enabled, baseUrl, desktopId, desktopName}`，不含 token）；`relay logout`

- [ ] **Step 1: 写失败测试**

```ts
// apps/agent/test/relay-login.test.ts —— fetchImpl 注入，不触网
it('登录成功：config v5 写入完整 relay 段且其余字段保留', () => { /* fetch 返回 200 合约响应；断言 readRelayConfig */
});
it('401 INVALID_CREDENTIALS 抛同码错误且不写配置', () => {});
it('429 RATE_LIMITED 抛同码错误', () => {});
it('未 init 的 configDir 抛 AGENT_NOT_INITIALIZED', () => {});
it('logout 移除 relay 段且幂等', () => {});
it('status 输出不含 deviceToken', () => { /* readRelayConfig + 序列化断言 */ });
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run --root apps/agent test/relay-login.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现**

`fetchImpl` 默认 `globalThis.fetch`；响应体解析失败时抛 `Error('INVALID_RESPONSE')`。CLI 命令组与既有 `service`/`workspace` 风格一致；密码只经 argv（已知折中，不打印）。

- [ ] **Step 4: 运行确认通过**

Run: `npx vitest run --root apps/agent && npx tsc -p apps/agent`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add apps/agent
git commit -m "feat: add agent relay login and credential commands"
```

---

### Task 3: VirtualPhoneSocket（ws 兼容子集）

**Files:**
- Create: `apps/agent/src/relay/virtual-socket.ts`
- Test: `apps/agent/test/relay/virtual-socket.test.ts`

**Interfaces:**
- Consumes: 无（纯类）。
- Produces:
  - `interface VirtualSocketTransport { sendText(data: string): void; sendBinary(data: Uint8Array): void; sendClose(code: number, reason: string): void }`
  - `class VirtualPhoneSocket`：
    - `constructor(transport: VirtualSocketTransport)`
    - `readyState: number`（OPEN=1 / CLOSING=2 / CLOSED=3，常量导出自 ws 语义）
    - `bufferedAmount: number`（恒 0——发送交给 relay 缓冲）
    - `on(event: 'message', listener: (data: string | Buffer, isBinary: boolean) => void): this`、`on(event: 'pong' | 'close' | 'error', listener: (...args: unknown[]) => void): this`
    - `send(data: string | Uint8Array): void`（文本走 sendText，Uint8Array 走 sendBinary；关闭后丢弃）
    - `ping(): void`（`queueMicrotask` 触发 `pong`，供 ConnectionManager 心跳）
    - `close(code?: number, reason?: string): void`（发 sendClose 一次，转 CLOSING 并触发本地 `close` 事件一次）
    - `terminate(): void`（同 close 但本地以 1006 触发、不发 sendClose）
    - `receive(data: string | Buffer, isBinary: boolean): void`（relay 下行 → `message` 事件）
    - `remoteClose(code: number, reason: string): void`（relay 上行 channel.close → 本地 `close` 事件，不再外发）

- [ ] **Step 1: 写失败测试**

```ts
// apps/agent/test/relay/virtual-socket.test.ts
it('receive 文本 → message 事件 isBinary=false；二进制 → Buffer + true', () => {});
it('ping 立即触发 pong（本地，不经过 relay）', async () => {});
it('send 文本/二进制分别走 sendText/sendBinary；关闭后丢弃', () => {});
it('close(code) 外发一次 sendClose 并本地 close 一次；重复 close 不重复触发', () => {});
it('remoteClose 不外发、本地 close 事件携带 code', () => {});
it('terminate 本地 1006 且不发 sendClose', () => {});
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run --root apps/agent test/relay/virtual-socket.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现**

事件监听表 `Map<string, Array<Listener>>`；`emit` 遍历复制数组；`close` 与 `remoteClose` 共用 `finalize(code, reason)`。

- [ ] **Step 4: 运行确认通过**

Run: `npx vitest run --root apps/agent && npx tsc -p apps/agent`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add apps/agent
git commit -m "feat: add virtual phone socket for relay channels"
```

---

### Task 4: RelayLink 出站连接（握手、重连、编解码）

**Files:**
- Create: `apps/agent/src/relay/link.ts`
- Test: `apps/agent/test/relay/link.test.ts`、`apps/agent/test/relay/fake-relay.ts`（测试用 ws 服务器，实现契约 §5 桌面端最小子集：Bearer 校验、hello→ready（可注入 epoch/版本行为）、记录下行消息、可主动下发 channel.open/data/close 与 http.request、可强制断开）

**Interfaces:**
- Consumes: `ws`、`AgentLogger`、契约 §5 消息结构。
- Produces:
  - `interface RelayLinkHandlers { onReady(info: { epoch: number }): void; onChannelOpen(input: { channelId: string; kind: 'control' | 'asr'; deviceId: string; appVersion?: string }): void; onChannelData(input: { channelId: string; data: string; binary: boolean }): void; onChannelClose(input: { channelId: string; code: number; reason: string }): void; onHttpRequest(input: { requestId: string; deviceId: string; method: string; path: string; contentType?: string; body: Buffer }): void }`
  - `startRelayLink(options: { baseUrl: string; credential: { deviceId: string; deviceToken: string }; hello: { appVersion: string; desktopName: string; platform: string; supportedContractVersions: number[] }; handlers: RelayLinkHandlers; logger: AgentLogger; backoff?: { baseMs?: number; maxMs?: number; jitter?: number }; webSocketFactory?: (url: string, headers: Record<string, string>) => WebSocket }): RelayLink`
  - `interface RelayLink { channelData(channelId: string, data: string | Uint8Array): void; channelClose(channelId: string, code: number, reason: string): void; httpResponse(requestId: string, response: { status: number; contentType?: string; body: Buffer }): void; state(): { status: 'connecting' | 'ready' | 'stopped'; lastEpoch: number | null; lastError: string | null }; stop(): void }`
  - 行为：连接 `ws(s)://<baseUrl>/v1/desktop/ws`，Bearer 头；升级后 10 s 内发 `desktop.hello`（`handshakeId` 随机 `hs_` 前缀）；收 `desktop.ready` → `onReady` 并重置退避；收 `error` 消息记日志（`VERSION_INCOMPATIBLE`）；close 4002/4004 → 致命停止（`state().status='stopped'`、`lastError` 记录 code），其他断开按退避重连；`stop()` 关闭 socket 与定时器

- [ ] **Step 1: 写失败测试**

```ts
// apps/agent/test/relay/link.test.ts —— 用 test/relay/fake-relay.ts
it('携带 Bearer 升级，发送合法 hello 并收到 ready 后 state=ready、epoch 记录', async () => {});
it('入站 channel.open/data/close 与 http.request 分发到 handlers', async () => {});
it('channelData/channelClose/httpResponse 出站编码符合契约 §5.2/§5.4', async () => {});
it('服务器断开后按退避重连（backoff.baseMs=20）并在 ready 后重置', async () => {});
it('close 4002/4004 → 停止重连、state 记录 lastError', async () => {});
it('stop() 后不再重连', async () => {});
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run --root apps/agent test/relay/link.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现**

`webSocketFactory` 便于测试注入；退避 `baseMs * 2^n` 封顶 `maxMs`，抖动 `±jitter`（默认 0.2）；所有入站 JSON 解析失败即记日志并忽略（不崩）。出站 `channel.data`：文本 `{ channelId, binary: false, data: <原文> }`；二进制 `{ channelId, binary: true, data: <base64 字符串> }`（契约 §5.2 字段名为 `data`）。

- [ ] **Step 4: 运行确认通过**

Run: `npx vitest run --root apps/agent && npx tsc -p apps/agent`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add apps/agent
git commit -m "feat: add relay outbound link with handshake and reconnect"
```

---

### Task 5: ASR 直连接入点与云端信任设备叠加

**Files:**
- Modify: `apps/agent/src/asr/asr-gateway.ts`（导出 `GatewaySocket`；抽出 `acceptAuthenticated(socket, deviceId)` 公共方法，路由 `handleConnection` 鉴权后调用）、`apps/agent/src/app/durable-wire.ts`（信任设备集合：`trustedRelayDevices: Set<string>`；`deviceActive` 与 `RunPromptController` 设备校验叠加）、`apps/agent/src/run/run-prompt-controller.ts`（`RunPromptControllerDeps` 增加可选 `isActiveDevice?: (deviceId: string) => boolean`，缺省维持现有 `devices.list()` 检查）
- Test: `apps/agent/test/relay/trust-overlay.test.ts`、`apps/agent/test/asr-gateway-accept.test.ts`

**Interfaces:**
- Consumes: `AsrGateway`（现有）、`DurablePermissionBroker` 的 `ports.deviceActive`、`RunPromptController`。
- Produces:
  - `AsrGateway.acceptAuthenticated(socket: GatewaySocket, deviceId: string): void`（鉴权前逻辑行为不变：连接登记、待定帧冲刷、限流入口一致）
  - `createTrustedDevices(isLocallyActive: (deviceId: string) => boolean): TrustedDevices`；`interface TrustedDevices { activate(deviceId: string): void; deactivate(deviceId: string): void; isActive(deviceId: string): boolean }`
  - `DurableWiring.relayDevices: TrustedDevices`
  - broker `deviceActive` = 本地 store 检查 **或** `relayDevices.isActive(deviceId)`；`RunPromptController` 装配时同样传入 `isActiveDevice` 叠加
  - `RunPromptControllerDeps.isActiveDevice?: (deviceId: string) => boolean`（缺省维持现有检查）

- [ ] **Step 1: 写失败测试**

```ts
// apps/agent/test/relay/trust-overlay.test.ts —— wireDurableAgent 太重时抽出纯函数：
// 将叠加逻辑实现为 `src/relay/trusted-devices.ts` 的 `createTrustedDevices(local: (id)=>boolean)`，
// durable-wire 直接使用该工厂（计划接口以工厂为准）。
it('activate 后 isActive=true；deactivate 后回落本地判定', () => {});
it('重复 activate 幂等；deactivate 未知设备不报错', () => {});

// apps/agent/test/asr-gateway-accept.test.ts —— fake manager（记录 start/cancel）+ 假 socket
it('acceptAuthenticated 接收 asr 控制消息并把 deviceId 传给 manager.start', async () => {});
it('同一连接第二个 start → ASR_STREAM_CONFLICT 错误事件（既有语义回归）', async () => {});
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run --root apps/agent test/relay/trust-overlay.test.ts test/asr-gateway-accept.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现**

新建 `src/relay/trusted-devices.ts`；asr-gateway 重构为 `handleConnection` = authenticate → `acceptAuthenticated`；durable-wire 内 `broker` 与 `RunPromptController` 均改用叠加判定，并在 `DurableWiring` 上暴露 `relayDevices`。

- [ ] **Step 4: 运行确认通过**

Run: `npx vitest run --root apps/agent && npx tsc -p apps/agent`
Expected: PASS（ASR 既有测试全绿）

- [ ] **Step 5: 提交**

```bash
git add apps/agent
git commit -m "feat: add asr accept entry and trusted relay device overlay"
```

---

### Task 6: Connector 控制通道与 durable-wire 装配

**Files:**
- Create: `apps/agent/src/relay/connector.ts`
- Modify: `apps/agent/src/app/durable-wire.ts`（`start()` 末尾当 `config.relay` 存在时创建 connector；`close()` 先停 connector；`DurableWiring` 暴露 `relay: { state(): RelayConnectorState } | null`）
- Test: `apps/agent/test/relay/connector.test.ts`、`apps/agent/test/relay/connector-wiring.test.ts`

**Interfaces:**
- Consumes: `startRelayLink`/`RelayLink`（Task 4）、`VirtualPhoneSocket`（Task 3）、`ConnectionManager`、`relayDevices`（Task 5）、`AgentLogger`。
- Produces:
  - 代答分发类型（Task 8 实现，本任务先定义并使用 404 占位）：
    `interface RelayHttpDispatchRequest { deviceId: string; method: string; path: string; contentType?: string; body: Buffer }`
    `interface RelayHttpDispatchResult { status: number; contentType: string; body: Buffer }`
    `type RelayHttpDispatch = (request: RelayHttpDispatchRequest) => RelayHttpDispatchResult`
  - `createRelayConnector(options: { link: RelayLink; connections: ConnectionManager; relayDevices: TrustedDevices; asrAccept: (socket: GatewaySocket, deviceId: string) => void; httpDispatch: RelayHttpDispatch; logger: AgentLogger }): void`（把 link handlers 接到各子系统；控制通道 device 合成：`{ deviceId, deviceName: 'relay:<deviceId>', tokenHash: '', createdAt: new Date().toISOString(), revokedAt: null }`）
  - `startRelayFromConfig(options: { config: AgentConfigV5; connections: ConnectionManager; relayDevices: TrustedDevices; asrAccept: ...; httpDispatch: RelayHttpDispatch; logger: AgentLogger }): RelayLink | null`（config.relay 缺省返回 null；hello 用 `appVersion: AGENT_VERSION`、`desktopName: relay.desktopName`、`platform: 'macos'`、`supportedContractVersions: [1]`）
  - `RelayConnectorState = RelayLink['state']`
  - 断开联动：link 停止/断开时对所有已打开通道调用虚拟 socket `remoteClose(1006,'link down')` 并 `relayDevices.deactivate`；`channel.close` 上行 → `remoteClose(code, reason)` + deactivate（幂等）

- [ ] **Step 1: 写失败测试**

```ts
// apps/agent/test/relay/connector-wiring.test.ts —— fake-relay + 真实 ConnectionManager（不启 HTTP 服务）
it('channel.open(control) → 手机 VirtualPhoneSocket 完成 protocol v1 hello/ready 往返', async () => {
  // fake relay 下发 channel.open；测试扮演手机在 channel.data 发 connection.hello；
  // 断言收到 connection.ready 且 desktopId 与 agent 配置一致（Review Focus 4 之外的主路径）
});
it('relay 下发 channel.close → 虚拟连接关闭，同 deviceId 再 channel.open 不残留旧状态（Review Focus 4）', async () => {});
it('relay 断链 → 打开中的虚拟连接全部 close(1006)，relayDevices 清空；重连后新通道正常', async () => {});
it('config.relay 缺省时 startRelayFromConfig 返回 null 且无连接副作用', async () => {});
```

```ts
// apps/agent/test/relay/connector.test.ts —— 纯分发单元（fake link handlers 捕获）
it('httpDispatch 仅处理 http.request；未知 path 记录日志并丢弃', async () => {});
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run --root apps/agent test/relay/connector-wiring.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现**

按 Interfaces。connector 维护 `channels: Map<string, { socket: VirtualPhoneSocket; deviceId: string }>`；link `onChannelData` 按 channelId 转发 `socket.receive(data, binary)`；虚拟 socket 的 transport 回调走 `link.channelData/channelClose`。durable-wire `start()`：`this.relayLink = startRelayFromConfig(...)`；`close()` 先 `relayLink?.stop()`。

- [ ] **Step 4: 运行确认通过**

Run: `npx vitest run --root apps/agent && npx tsc -p apps/agent`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add apps/agent
git commit -m "feat: wire relay connector control channels into agent"
```

---

### Task 7: ASR 通道经 connector 接入 + 真实 relay e2e

**Files:**
- Modify: `apps/agent/src/relay/connector.ts`（kind='asr' 分发到 `asrAccept`）
- Create: `apps/agent/test/relay/e2e-relay.ts`（测试助手：spawn 真实 `apps/relay/src/main.ts`，`RELAY_PORT=0`+临时 `RELAY_DATA_DIR`，解析 `relay.started`；提供 `login()`/`rawDesktop()`/`rawPhone()` 原始 ws 客户端，供 e2e 扮演手机）
- Test: `apps/agent/test/relay/e2e.test.ts`

**Interfaces:**
- Consumes: 真实 relay（计划一）、Task 6 connector。
- Produces: e2e 助手 `startRealRelay(): Promise<{ baseUrl: string; dataDir: string; stop(): Promise<void> }>`；本任务断言 ASR 通道在无 `DOUBAO_ASR_API_KEY` 环境下收到 `ASR_NOT_CONFIGURED` 错误事件（真实 `createAsrRuntime` 行为），证明通道与网关接线正确。

- [ ] **Step 1: 写失败测试**

```ts
// apps/agent/test/relay/e2e.test.ts
it('e2e：手机经真实 relay 完成 protocol hello/ready（控制通道）', async () => { /* startRealRelay → admin create-user（spawn CLI）→ desktop 登录写入 config → 启动 wiring → 手机 raw ws 连接 → hello/ready */ });
it('e2e：asr 通道未配置密钥时回传 ASR_NOT_CONFIGURED 错误事件', async () => {
  // 手机开 /ws/asr；发送合法 asr start 控制消息；断言收到 payload.error.code === 'ASR_NOT_CONFIGURED'
});
```

（e2e 中 agent 用 `wireDurableAgent` + 测试 driver 的最小装配，参考 `apps/agent/test/live/` 既有模式；若该模式不可复用，则在测试内只装配 `ConnectionManager` + `AsrGateway` + connector（不含 SDK），连接行为与生产一致。）

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run --root apps/agent test/relay/e2e.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现**

connector `channel.open(kind='asr')` → `asrAccept(virtualSocket, deviceId)`；e2e 助手按计划一的 spawn 约定实现（自包含，不 import `apps/relay/src`）。

- [ ] **Step 4: 运行确认通过**

Run: `npx vitest run --root apps/agent && npx tsc -p apps/agent`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add apps/agent
git commit -m "feat: route relay asr channels to gateway with e2e coverage"
```

---

### Task 8: HTTP 代答分发（处理器抽取 + connector 接入）

**Files:**
- Create: `apps/agent/src/transport/http-handlers.ts`、`apps/agent/src/relay/http-dispatch.ts`
- Modify: `apps/agent/src/transport/phone-server.ts`（三个路由改为调用抽取后的处理器，鉴权与 query/params 校验留在路由层）、`apps/agent/src/relay/connector.ts`（`onHttpRequest` → `httpDispatch` → `link.httpResponse`）
- Test: `apps/agent/test/transport/http-handlers.test.ts`

**Interfaces:**
- Consumes: `ApprovalContentController`、`AttachmentStore`、`RunPromptController`、`AgentError`；connector 的 `RelayHttpDispatch` 类型（Task 6）。
- Produces:
  - `interface HttpHandlerResult { status: number; contentType: string; body: Buffer }`
  - `handleAttachmentUpload(deps: { attachments?: AttachmentStore }, input: { deviceId: string; contentType?: string; body: Buffer }): HttpHandlerResult`（contentType 必须 `application/json`，否则 415 `INVALID_MESSAGE`；体解析失败/超限沿用既有 400 `INVALID_MESSAGE`；成功 201 JSON）
  - `handleApprovalContentRead(deps: { approvalContent?: ApprovalContentController }, input: { deviceId: string; approvalId: string; query: Record<string, unknown> }): HttpHandlerResult`（chunkIndex 解析与错误映射同既有路由）
  - `handleRunPromptRead(deps: { runPrompt?: RunPromptController }, input: { deviceId: string; runId: string }): HttpHandlerResult`（错误映射：FORBIDDEN→403、RUN_NOT_RECOVERABLE→409、其他→404）
  - `createRelayHttpDispatch(deps: { attachments?; approvalContent?; runPrompt? }): (request: { deviceId; method; path; contentType?; body: Buffer }) => HttpHandlerResult`（method/path 白名单精确匹配；未知 → 404 `ROUTE_NOT_FOUND`）

- [ ] **Step 1: 写失败测试**

```ts
// apps/agent/test/transport/http-handlers.test.ts —— 用真实 AttachmentStore（临时目录）与 stub controllers
it('附件上传：合法 JSON → 201；非 JSON contentType → 415；坏体 → 400', () => {});
it('审批内容：chunkIndex 非法 → 400；controller 错误映射保持既有状态码', () => {});
it('run prompt：FORBIDDEN→403、RUN_NOT_RECOVERABLE→409、缺失→404', () => {});
it('dispatch 白名单：GET /v1/approvals/a1/content 命中；其他路径 404 ROUTE_NOT_FOUND', () => {});
it('dispatch 端到端：附件经 relay 形态（raw Buffer + contentType）保存后可读回', () => {});
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run --root apps/agent test/transport/http-handlers.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现**

从 phone-server 抽取既有逻辑（错误码/状态映射逐字保留）；phone-server 路由改为：鉴权 → 组 input → 调处理器 → `reply.code(result.status).header('content-type', result.contentType).send(result.body)`。connector `onHttpRequest` 调 dispatch 并把结果编码为 `http.response`（`bodyBase64`）。

- [ ] **Step 4: 运行确认通过**

Run: `npx vitest run --root apps/agent && npx vitest run --root apps/relay && npx tsc -p apps/agent`
Expected: PASS（既有 phone-server 集成测试即回归证明）

- [ ] **Step 5: 提交**

```bash
git add apps/agent
git commit -m "feat: share http handlers with relay tunnel dispatch"
```

---

### Task 9: 状态、诊断与文档

**Files:**
- Modify: `apps/agent/src/app/durable-wire.ts`（admin `getStatus` 增加 `relay` 字段）、`apps/agent/src/diagnostics/doctor.ts`（增加 relay 检查项）
- Create: `docs/relay-agent-usage.md`（≤60 行：relay 部署 → admin create-user → agent relay login → start → 手机登录同账号；直连模式共存说明；故障排查：status 的 relay 字段含义）
- Test: `apps/agent/test/relay/status.test.ts`

**Interfaces:**
- Consumes: `DurableWiring.relay`（Task 6）、`readRelayConfig`（Task 2）。
- Produces:
  - admin `status` 输出增加：`relay: { enabled: boolean; baseUrl?: string; state: 'connecting'|'ready'|'stopped'|null; lastEpoch: number | null; lastError: string | null }`（不含 token）
  - doctor 增加 `relay` 项：未配置 → `{configured:false}`；已配置 → `{configured:true, state, protocol: 1}`（不主动探测网络）

- [ ] **Step 1: 写失败测试**

```ts
// apps/agent/test/relay/status.test.ts
it('未配置 relay 时 status.relay = {enabled:false, state:null}', async () => {});
it('配置 relay 且 link ready 时 status.relay 暴露 baseUrl/state/lastEpoch 且不含 deviceToken', async () => {});
it('doctor 输出 relay 项：未配置/已配置两种形态', async () => {});
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run --root apps/agent test/relay/status.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现**

`DurableWiring` 暴露 `relayState()`；admin server `getStatus` 组装时包含；doctor 按现有条目结构追加。

- [ ] **Step 4: 运行确认通过**

Run: `npx vitest run --root apps/agent && npx tsc -p apps/agent`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add apps/agent docs
git commit -m "feat: expose relay state in status and doctor with usage doc"
```

---

### Task 10: 全量验收

**Files:** 无新文件；修正验收中发现的问题。

- [ ] **Step 1: 全量测试与覆盖率**

Run: `npx vitest run --root apps/agent --coverage`
Expected: 全绿；statements/branches/functions/lines ≥ 80%

- [ ] **Step 2: 交叉回归**

Run: `npx vitest run --root apps/relay && npx vitest run --config vitest.relay-contract.config.ts && npx tsc -p apps/agent && npx tsc -p apps/relay`
Expected: 全绿（计划一不回归）

- [ ] **Step 3: 手工冒烟（本机 relay + 真 agent）**

```bash
RELAY_PORT=8899 RELAY_DATA_DIR=/tmp/relay-smoke node --import tsx apps/relay/src/main.ts serve   # 终端 A
RELAY_DATA_DIR=/tmp/relay-smoke node apps/relay/bin/claude-remote-relay.js admin create-user alice --password pw-123456
node apps/agent/bin/claude-remote-agent.js relay login --url http://127.0.0.1:8899 --username alice --password pw-123456 --name "Smoke Mac"
node apps/agent/bin/claude-remote-agent.js start   # 终端 B
node apps/agent/bin/claude-remote-agent.js status  # 终端 C：relay.state=ready，lastEpoch ≥ 1
```

Expected: `status` 输出 `relay.state: "ready"` 且不含 token；直连 `pair` 仍可用（直连模式回归）。

- [ ] **Step 4: 提交收尾**

```bash
git add apps/agent docs
git commit -m "test: complete relay agent connector acceptance"
```

---

## 验收（计划二完成的定义）

1. `npx vitest run --root apps/agent`、`--coverage` 全绿且 ≥80%；计划一的 relay 单元与契约套件全绿；双端 `tsc` 干净。
2. e2e（真实 relay）：控制通道 hello/ready、ASR `ASR_NOT_CONFIGURED` 事件、HTTP 代答三个端点全部经云端往返成功。
3. 直连模式回归：既有 661 用例全绿，手工 `pair` 冒烟可用。
4. `relay status`/`doctor` 暴露连接状态不含凭证；`docs/relay-agent-usage.md` 可独立指导部署。