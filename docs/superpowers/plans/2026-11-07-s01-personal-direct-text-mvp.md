# S01 个人直连文字 MVP Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 交付一部 iPhone 通过 Tailscale Serve 控制一台 Mac 上固定项目、单 Claude 会话的文字聊天、流式工具事件、取消与断线快照 MVP。

**Architecture:** Mac Agent 以 Fastify 同时提供仅 localhost 的手机接口和独立 Unix socket 管理接口，一次 run 对应一次 SDK query，后续 run 通过 Claude session ID resume。Flutter 只保留配对页和聊天页；会话、run、命令幂等和事件均在内存中，重连用不超过 64 KiB 的摘要快照恢复。

**Tech Stack:** Node.js 24.15.0（22+）、TypeScript 7.0.2、Agent SDK 0.3.319、Claude Code 2.1.319、Fastify 5.12.8、`@fastify/websocket` 11.3.7、Vitest 5.1.0、Flutter 3.47.9 stable、Dart 3.13.7、Riverpod 3.5.0、web_socket_channel 3.0.3、flutter_secure_storage 11.2.0、mobile_scanner 7.5.0、http 1.6.0。

**Spec:** `docs/superpowers/specs/2026-11-07-s01-personal-direct-text-mvp-design.md`

## Global Constraints

- **当前入口为 BLOCKED：**仓库尚无 `docs/s00/` 通过证据。Task 0 未确认 S00 Core PASS 前，不得执行 Task 1–15。
- 固定 Agent SDK `0.3.319`、Claude Code `2.1.319`；沿用 S00 的 `claude_code` system/tool presets、完整 settingSources 和权限配置。
- Mac Agent 只监听 `127.0.0.1:8787`；管理接口只监听 `~/.claude-remote/agent.sock`，目录 `0700`、socket/devices 文件 `0600`。
- 仅 Tailscale Serve，不启用 Funnel；iOS 使用系统 TLS 校验，不得使用 `badCertificateCallback` 接受错误证书。
- 单用户、一部 iPhone、一个固定项目、一个受管会话、一个活跃 run；忙碌返回 `SESSION_BUSY`，不排队。
- 一次 run 对应一次新的 `query()`；首次无 resume，后续使用内存 claudeSessionId resume；interrupt Promise resolve 不等于 run 终态。
- `canUseTool` 在 S01 立即 deny、`interrupt:false`，不得写永久规则或启用 `bypassPermissions`。
- 设备 token 至少 256 位随机值，只存入 iPhone Keychain；Mac 只保存 SHA-256 哈希，token/code 不放 URL、QR 长期载荷或日志。
- 单条协议消息最大 64 KiB；prompt UTF-8 为 1–16,384 字节；工具输出单块 32 KiB；快照 payload 48 KiB、总消息 64 KiB、最多 200 条摘要事件。
- 会话、run、事件和命令幂等只保存在内存；Agent 重启不得宣称恢复，配置和设备绑定可以保留。
- 核心 TypeScript 与 Dart 业务逻辑覆盖率均不低于 80%；真实 SDK、Tailscale 和 iPhone E2E 不得被 Mock 结果替代。
- 当前目录已是 Git 仓库（若执行时不是，先记录并与用户确认）。只有用户明确授权提交后才执行 Commit 步骤，否则标记 SKIPPED，不得自行 `git init` 或提交。

## Review Focus

1. **200 条 32 KiB 工具输出和 Unicode 截断：**快照仍必须低于 64 KiB，UTF-8 不能截断字符；Task 8 用 worst-case 与多字节测试锁定。
2. **同 commandId 并发重试：**两个同时到达的请求只能执行一次副作用，第二个等待并返回 duplicate；Task 6 用并发测试锁定。
3. **interrupt 后没有任何 SDK 终态：**10 秒后必须 close 并进入 interrupted，不能永久 cancelling；Task 9 用可控 driver 锁定。
4. **旧 connectionEpoch 的迟到事件和快照后事件：**旧回调被丢弃，新事件不能覆盖刚应用的快照；Task 5 与 Task 13 分别锁定 Mac/App 两侧。
5. **代理后来源 IP 都是 localhost：**配对限流只能使用 pairingId 失败次数和 Agent 级窗口，不能信任 IP/deviceName/代理身份头；Task 3 用全局限流测试锁定。

## File Structure

```text
apps/agent/
  package.json / tsconfig.json       # Agent 独立 workspace 与测试入口
  src/cli.ts                         # init/start/status/pair/devices/revoke
  src/domain/types.ts                # SessionRecord、RunRecord、配置与错误
  src/config/                        # init/load、真实路径、原子文件
  src/security/                      # 随机 token、SHA-256、日志脱敏
  src/store/device-store.ts          # 0600 设备凭证存储
  src/pairing/                       # 一次性 QR、过期与全局限流
  src/admin/                         # Unix socket server/client
  src/transport/                     # 手机 HTTP、WSS 鉴权、握手与发送队列
  src/command/                       # 路由与并发幂等
  src/session/                       # 单会话附着
  src/run/                           # 单 run 状态机与取消
  src/adapter/                       # AgentDriver、SDK Adapter、MockDriver
  src/events/                        # AdapterEvent、Journal、Normalizer、Snapshot
  src/app/                           # AgentOperations 与完整 wiring
  test/                              # 单元/Mock/真实 WSS 集成测试

apps/mobile/
  pubspec.yaml                       # iOS-only Flutter 依赖
  lib/protocol/                      # 信封、消息、共享样例校验
  lib/domain/                        # Session/Run/Timeline 不可变模型
  lib/data/                          # Keychain、Pairing API、AgentSocket
  lib/features/pairing/              # QR 配对页和 Controller
  lib/features/chat/                 # 聊天页、Composer、工具卡片、run 控制
  lib/connection/                    # WSS、重连、epoch、命令客户端
  test/                              # Dart/Widget/共享协议测试

docs/s01/
  preflight.md                       # S00/Flutter/Tailscale 入口证据
  sdk-mapping.md                     # 从 docs/s00 提取的固定映射
  tailscale-setup.md                 # Serve、无 Funnel、真机配置
  e2e-checklist.md                   # E2E-01–12 实测记录
  exit-report.md                     # 覆盖率、限制与最终结论
```

---

### Task 0: 入口证据与环境预检

**Files:**
- Create: `docs/s01/preflight.md`, `docs/s01/sdk-mapping.md`, `docs/s01/tailscale-setup.md`
- Read: `docs/s00/exit-report.md`, `docs/s00/agent-sdk-evidence.md`, `docs/s00/session-interoperability.md`

**Interfaces:**
- Produces: S01 Adapter 所需的七项 SDK 映射证据；未完成前所有后续任务保持 BLOCKED。

- [ ] **Step 1: Verify the S00 Core gate**

Run: `npm run s00:gate`  
Expected: Core PASS、ASR Contract PASS、ASR Live DEFERRED。当前没有 `docs/s00/` 输出时应失败；记录 BLOCKED 并停止，不能创建产品 scaffold。

- [ ] **Step 2: Freeze the SDK mapping table**

从 S00 证据逐项填写 session ID 字段、content block 标识、delta/result 顺序、result subtype、interrupt 后续事件、close 清理和 tool_use/tool_result 关联；每一项链接原证据，缺失项标 BLOCKED。

- [ ] **Step 3: Verify device and toolchain prerequisites**

安装/核对 Flutter 3.47.9、Dart 3.13.7、兼容 Xcode、真机签名环境；确认 iPhone/Mac 同 tailnet、MagicDNS、HTTPS Certificates。Tailscale CLI 可位于 `/Applications/Tailscale.app/Contents/MacOS/Tailscale`，PATH 不存在不等于 App 未安装。

- [ ] **Step 4: Verify Serve without Funnel**

用当前 Tailscale 官方命令配置 HTTPS 到 `127.0.0.1:8787`，保存脱敏 `ts.net` 主机名、Serve 状态和系统证书检查结果；明确 Funnel 未开启。具体命令记录在 `tailscale-setup.md`，不猜写过时 CLI 参数。

- [ ] **Step 5: Commit**

```bash
git add docs/s01
git commit -m "docs: record S01 implementation prerequisites"
```

### Task 1: Agent/Flutter workspace 与测试骨架

**Files:**
- Modify: `package.json`, `package-lock.json`
- Create: `apps/agent/package.json`, `apps/agent/tsconfig.json`, `apps/agent/src/domain/types.ts`, `apps/agent/src/cli.ts`
- Create: `apps/agent/test/bootstrap.test.ts`
- Create: `apps/mobile/pubspec.yaml`, `apps/mobile/lib/main.dart`, `apps/mobile/test/bootstrap_test.dart`

**Interfaces:**
- Produces: `RunStatus = 'starting'|'running'|'cancelling'|'succeeded'|'failed'|'cancelled'|'interrupted'`。
- Produces: `SessionRecord`、`RunRecord`、`AgentConfig`、`DeviceRecord` 的共享不可变 TypeScript 类型，以及 `JsonValue`、`JsonObject = Record<string,JsonValue>`。
- Produces: `npm run test:agent`、`npm run coverage:agent`、`npm run test:mobile`。

- [ ] **Step 1: Create minimal workspace manifests and failing smoke tests**

先创建根 workspace 配置、Agent/mobile package manifests 与测试文件，再写断言：

Agent 断言包名 `@claude-remote/agent`、Node `>=22`、SDK 精确版本和 RunStatus；Flutter 断言 Riverpod 3.5.0、web_socket_channel 3.0.3、secure_storage 11.2.0、mobile_scanner 7.5.0，首页只含 Pairing/Chat 路由之一。

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm install && npm run test:agent -- test/bootstrap.test.ts`  
Expected: 测试因 domain types 或入口尚不存在而 FAIL，而不是因 workspace/test script 不存在而失败。

- [ ] **Step 3: Create the remaining domain types and app skeletons**

根 package 已在 Step 1 增加 `apps/agent` workspace，Agent 固定 Fastify 5.12.8、websocket 11.3.7、commander 15.1.0、qrcode 1.5.4。补齐共享类型和 CLI；使用 `flutter create --platforms=ios --project-name claude_remote apps/mobile` 补齐 iOS 工程，仅保留两页骨架；deployment target 取 Flutter 与插件要求的最大值并记录。

- [ ] **Step 4: Run both smoke tests**

Run: `npm install && npm run test:agent -- test/bootstrap.test.ts`  
Run: `cd apps/mobile && flutter pub get && flutter test test/bootstrap_test.dart`  
Expected: 两者 PASS，无 Android/Web/macOS 目录或额外产品页面。

- [ ] **Step 5: Commit**

```bash
git add package.json package-lock.json apps/agent apps/mobile
git commit -m "chore: scaffold S01 agent and iOS app"
```

### Task 2: 固定项目配置与安全设备存储

**Files:**
- Create: `apps/agent/src/config/paths.ts`, `initialize.ts`, `load.ts`, `atomic-file.ts`
- Create: `apps/agent/src/security/random.ts`, `apps/agent/src/store/device-store.ts`
- Test: `apps/agent/test/config.test.ts`, `device-store.test.ts`

**Interfaces:**
- Produces: `initializeConfig(input:{configDir:string;workspacePath:string;displayName:string;tailscaleBaseUrl:string}):Promise<AgentConfig>`。
- Produces: `loadConfig(configDir:string):Promise<AgentConfig>`。
- Produces: `randomBase64Url(bytes?:number):string`（默认 32）、`sha256Base64Url(value:string):string`。
- Produces: `DeviceStore.create(deviceId,deviceName,tokenHash):Promise<DeviceRecord>`、`verify(deviceId,token):Promise<DeviceRecord|null>`、`revoke(deviceId):Promise<DeviceRecord>`、`active():DeviceRecord|null`。

- [ ] **Step 1: Write failing config and credential tests**

覆盖相对路径、不存在目录、真实路径解析、非 HTTPS/非 ts.net baseUrl、重复 init 不覆盖；断言目录 0700、devices 0600、明文 token 不出现在 devices.json。verify 错误 token 返回 null，revoke 后失效，写入不修改输入对象。

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm run test:agent -- test/config.test.ts test/device-store.test.ts`  
Expected: FAIL with missing config/store modules。

- [ ] **Step 3: Implement validated config and atomic device persistence**

默认目录为 `~/.claude-remote`，测试必须注入临时 configDir。listen 固定 `127.0.0.1:8787`，workspaceId 固定 `default`；原子写入并校验文件权限，Mac 只保存 token 哈希。

- [ ] **Step 4: Run tests and permission checks**

Run: `npm run test:agent -- test/config.test.ts test/device-store.test.ts`  
Expected: PASS，临时目录中无明文 token。

- [ ] **Step 5: Commit**

```bash
git add apps/agent
git commit -m "feat: add secure S01 config and device store"
```

### Task 3: 一次性配对与本机管理 socket

**Files:**
- Create: `apps/agent/src/pairing/pairing-service.ts`, `qr.ts`
- Create: `apps/agent/src/admin/server.ts`, `client.ts`, `routes.ts`
- Modify: `apps/agent/src/cli.ts`
- Test: `apps/agent/test/pairing.test.ts`, `admin.test.ts`

**Interfaces:**
- Produces: `PairingInput = {pairingId:string;code:string;deviceName:string;appVersion:string;supportedProtocolVersions:number[]}`。
- Produces: `PairingService.begin(replace?:boolean):PairingQrPayload`。
- Produces: `PairingService.consume(input:PairingInput):Promise<{deviceId:string;deviceToken:string;desktopId:string;protocolVersion:1}>`。
- Produces: `AdminDependencies = {socketPath:string;pairingService:PairingService;deviceStore:DeviceStore;getStatus:()=>AdminStatus;onRevoke:(deviceId:string)=>void}`。
- Produces: `createAdminServer(deps:AdminDependencies):Promise<FastifyInstance>`，只 listen `{path:socketPath}`。
- Produces: `AdminClient.status()/devices()/pair(replace)/revoke(deviceId)`。
- Produces: `AdminDependencies.onRevoke(deviceId:string):void`，后续由 ConnectionManager 提供。

- [ ] **Step 1: Write failing pairing and admin tests**

用 fake clock/random 覆盖 5 分钟过期、一次性消费、同 pairingId 五次失败、全局每分钟十次、已有设备需 replace。断言限流不读取 IP/deviceName/代理头，token 只出现一次且 Mac 存哈希。管理测试断言 `/admin/v1/*` 只存在 Unix socket，pair/revoke 走运行中 Agent，revoke 调用 onRevoke。

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm run test:agent -- test/pairing.test.ts test/admin.test.ts`  
Expected: FAIL with missing pairing/admin modules。

- [ ] **Step 3: Implement in-memory pairing and local-only admin transport**

PairingService 原子消费 code，全局窗口只按时间计数；PairingQrPayload 只含 v、baseUrl、pairingId、code、expiresAt。Fastify 管理实例 listen Unix socket，启动前健康检查 stale socket，不能误删活跃 socket；CLI 通过 AdminClient 渲染 QR，不直接改内存。

- [ ] **Step 4: Run tests and inspect socket modes**

Run: `npm run test:agent -- test/pairing.test.ts test/admin.test.ts`  
Expected: PASS，socket 0600、目录 0700，无 TCP admin listener。

- [ ] **Step 5: Commit**

```bash
git add apps/agent
git commit -m "feat: add one-time pairing and local admin socket"
```

### Task 4: 手机 HTTP 配对入口与 WSS 鉴权

**Files:**
- Create: `apps/agent/src/transport/authenticate.ts`, `phone-server.ts`, `tailscale-preflight.ts`
- Test: `apps/agent/test/phone-auth.test.ts`, `tailscale-preflight.test.ts`

**Interfaces:**
- Produces: `authenticateUpgrade(headers:Record<string,unknown>,store:DeviceStore):Promise<DeviceRecord>`。
- Produces: `createPhoneServer(deps:PhoneServerDependencies):Promise<FastifyInstance>`，listen 仅 `{host:'127.0.0.1',port:8787}`。
- Produces: `POST /v1/pairings` 和 `/ws`；`/ws` 交给 Task 5 的 `ConnectionManager.accept(socket,device)`。
- Produces: `checkTailscaleServe(exec:ExecFile):Promise<{https:boolean;funnel:boolean;host:string}>`。

- [ ] **Step 1: Write failing HTTP/auth/preflight tests**

覆盖合法 Bearer、无/错 token、URL token、吊销设备、配对错误不泄露 code 项。使用 `inject()` 测 pairing、`injectWS('/ws',{headers})`/真实 upgrade 测鉴权；Serve 测试含 HTTPS、无 Funnel 和发现 Funnel 时失败。

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm run test:agent -- test/phone-auth.test.ts test/tailscale-preflight.test.ts`  
Expected: FAIL with missing phone transport。

- [ ] **Step 3: Implement pre-upgrade authentication and localhost routes**

使用 websocket `verifyClient` 在 101 前异步校验 Bearer；拒绝时 HTTP 401，不记录 Authorization。WebSocket `maxPayload` 设为 64 KiB。Tailscale 检查通过注入 execFile，生产代码只读 Serve 状态，不自动开启 Funnel。

- [ ] **Step 4: Run transport tests**

Run: `npm run test:agent -- test/phone-auth.test.ts test/tailscale-preflight.test.ts`  
Expected: PASS，外部地址和 0.0.0.0 listener 均不存在。

- [ ] **Step 5: Commit**

```bash
git add apps/agent
git commit -m "feat: add authenticated phone transport"
```

### Task 5: 握手、心跳、连接代次与有界发送

**Files:**
- Create: `apps/agent/src/transport/connection-manager.ts`, `bounded-sender.ts`, `handshake.ts`
- Test: `apps/agent/test/connection-manager.test.ts`, `bounded-sender.test.ts`

**Interfaces:**
- Produces: `ConnectionManager.accept(socket:WebSocket,device:DeviceRecord):Promise<void>`。
- Produces: `publish(event:ProtocolMessage):void`、`revoke(deviceId:string):void`、`currentEpoch(deviceId:string):number`。
- Produces: `BoundedSender(onPressure:()=>void,maxBytes=2*1024*1024,maxMessages=1000)`、`send(message:ProtocolMessage):'sent'|'queued'|'closed'`。

- [ ] **Step 1: Write failing lifecycle and pressure tests**

覆盖首条非 hello、10 秒握手超时、协议不兼容、15 秒 ping/45 秒失效、新 epoch 关闭旧连接、revoke 关闭但 run 回调继续。队列达到 2 MiB/1,000 条时先触发 normalizer 的 delta flush/coalesce 回调，仍超限则关闭慢连接；Journal 不得被修改。

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm run test:agent -- test/connection-manager.test.ts test/bounded-sender.test.ts`  
Expected: FAIL with missing connection modules。

- [ ] **Step 3: Implement explicit connection state and bounded output**

hello/ready 使用协议 V1，connectionEpoch 单调递增；旧 socket 回调先检查 epoch。发送队列只管理协议消息，delta 合并在进入 Journal 前完成，不能拼接不同 eventId/seq 的已持久事件。

- [ ] **Step 4: Run lifecycle tests**

Run: `npm run test:agent -- test/connection-manager.test.ts test/bounded-sender.test.ts`  
Expected: PASS，慢连接关闭不调用 run.cancel。

- [ ] **Step 5: Commit**

```bash
git add apps/agent
git commit -m "feat: add resilient S01 connection lifecycle"
```

### Task 6: 命令路由、并发幂等与单会话附着

**Files:**
- Create: `apps/agent/src/command/idempotency.ts`, `router.ts`, `errors.ts`
- Create: `apps/agent/src/session/session-controller.ts`
- Test: `apps/agent/test/idempotency.test.ts`, `session-controller.test.ts`, `command-router.test.ts`

**Interfaces:**
- Produces: `SessionStartResult = {sessionId:string;claudeSessionId:string|null;status:string}`、`RunAccepted = {sessionId:string;runId:string;status:'starting'|'cancelling'}`。
- Produces: `AgentOperations.startSession(workspaceId:string):Promise<SessionStartResult>`、`sendPrompt(sessionId:string,text:string,commandId:string):Promise<RunAccepted>`、`cancelRun(sessionId:string,runId:string):Promise<RunAccepted>`、`snapshot(sessionId:string):Promise<SessionSnapshotEvent>`。
- Produces: `CommandRouter.route(message:unknown,device:DeviceRecord):Promise<CommandResultMessage>`。
- Produces: `SessionController.start(workspaceId:'default'):Promise<SessionRecord>`、`get(sessionId):SessionRecord`。
- Produces: `InMemoryIdempotency.execute<T>(commandId:string,handler:()=>Promise<T>):Promise<{value:T;duplicate:boolean}>`。

- [ ] **Step 1: Write failing routing and concurrent-idempotency tests**

两个同 commandId 请求同时进入，handler 计数必须为 1，第二个等待同一 Promise 且 duplicate=true。覆盖重复 session.start 返回同 ID/Journal 不清空、错误 workspace、空白/16,385 字节 prompt、无 session、忙碌和 RUN_NOT_ACTIVE 的安全错误。

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm run test:agent -- test/idempotency.test.ts test/session-controller.test.ts test/command-router.test.ts`  
Expected: FAIL with missing command/session modules。

- [ ] **Step 3: Implement schema-first command execution and attach semantics**

先校验信封和 payload，再鉴权/路由；幂等表保存首次 Promise/result，异步失败也返回同一首次错误。SessionController 只持有固定 workspace 的一个 SessionRecord，不启动 SDK query。

- [ ] **Step 4: Run command/session tests**

Run: `npm run test:agent -- test/idempotency.test.ts test/session-controller.test.ts test/command-router.test.ts`  
Expected: PASS，无重复副作用。

- [ ] **Step 5: Commit**

```bash
git add apps/agent
git commit -m "feat: add idempotent commands and single session"
```

### Task 7: EventJournal 与 SDK 中立事件归一化

**Files:**
- Create: `apps/agent/src/events/adapter-events.ts`, `journal.ts`, `normalizer.ts`, `utf8.ts`
- Test: `apps/agent/test/journal.test.ts`, `normalizer.test.ts`

**Interfaces:**
- Produces: `AdapterEvent` 的精确 union：

```ts
type AdapterEvent =
  | {kind:'init';sessionId:string;runId:string;claudeSessionId:string}
  | {kind:'textDelta';sessionId:string;runId:string;assistantMessageId:string;contentBlockIndex:number;text:string}
  | {kind:'assistantCompleted';sessionId:string;runId:string;assistantMessageId:string;content:Array<{type:'text';text:string}>;stopReason?:string}
  | {kind:'toolStarted';sessionId:string;runId:string;toolUseId:string;toolName:string;input:Record<string,unknown>}
  | {kind:'toolOutput';sessionId:string;runId:string;toolUseId:string;text:string}
  | {kind:'toolCompleted';sessionId:string;runId:string;toolUseId:string;status:'succeeded'|'failed'|'denied'|'cancelled';isError:boolean;summary:string}
  | {kind:'permissionDenied';sessionId:string;runId:string;toolUseId?:string;toolName:string}
  | {kind:'runResult';sessionId:string;runId:string;status:'succeeded'|'failed'|'cancelled'|'interrupted';claudeSessionId?:string;errorSummary?:string};
```
- Produces: `EventJournal.append(input:{sessionId:string;type:string;payload:JsonObject;eventId?:string}):TimelineEvent`、`recent(sessionId:string,limit:number):TimelineEvent[]`、`subscribe(listener:(event:TimelineEvent)=>void):()=>void`、`lastSeq(sessionId:string):number`。
- Produces: `EventNormalizer.consume(event:AdapterEvent):void`、`flush():void`。
- Produces: `truncateUtf8(text:string,maxBytes:number):{text:string;truncated:boolean}`。

- [ ] **Step 1: Write failing ordering and normalization tests**

覆盖连续 seq、eventId 重传、同 ID 冲突、50 ms delta flush、16 KiB 提前 flush、completed >32 KiB 时 content 空且 contentTruncated、tool input >16 KiB、tool output >32 KiB 和中文多字节边界。

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm run test:agent -- test/journal.test.ts test/normalizer.test.ts`  
Expected: FAIL with missing event modules。

- [ ] **Step 3: Implement append-first Journal and bounded normalization**

事件先分配 eventId/seq 再发布；相邻同 assistant/content block delta 才可合并。所有截断返回新对象，保持输入不可变；permissionDenied 对已经 started 的工具补 denied completed。

- [ ] **Step 4: Run event tests**

Run: `npm run test:agent -- test/journal.test.ts test/normalizer.test.ts`  
Expected: PASS，所有实时消息低于 64 KiB。

- [ ] **Step 5: Commit**

```bash
git add apps/agent
git commit -m "feat: add bounded S01 event normalization"
```

### Task 8: 有界摘要快照与重连临界区

**Files:**
- Create: `apps/agent/src/events/snapshot-factory.ts`, `snapshot-coordinator.ts`
- Test: `apps/agent/test/snapshot-factory.test.ts`, `snapshot-coordinator.test.ts`

**Interfaces:**
- Produces: `SnapshotFactory.create(input:{session:SessionRecord;activeRun:RunRecord|null;journal:EventJournal}):SessionSnapshotEvent`。
- Produces: `SnapshotCoordinator.captureAndSend(sessionId,connectionEpoch):Promise<{lastSeq:number}>`，在 Journal 临界区捕获并排入快照后再允许后续事件。

- [ ] **Step 1: Write failing byte-budget and ordering tests**

生成 200 条 32 KiB tool.output、长 completed、工具输入和活跃 delta；断言总消息 <=65,536 字节、payload <=49,152 字节、最多 200 条、oldestIncludedSeq/lastSeq/snapshotTruncated 正确。快照生成期间追加事件必须出现在快照之后，不能进入旧快照或丢失。

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm run test:agent -- test/snapshot-factory.test.ts test/snapshot-coordinator.test.ts`  
Expected: FAIL with missing snapshot modules。

- [ ] **Step 3: Implement newest-first projection under two budgets**

按 spec 省略 completed 前 delta、限制 completed 8 KiB/tool output 4 KiB、清空 snapshot 工具 input、保留活跃消息最新 8 KiB；从最新向最旧选择，始终保留 session/run/lastSeq/截断元数据。

- [ ] **Step 4: Run worst-case snapshot tests**

Run: `npm run test:agent -- test/snapshot-factory.test.ts test/snapshot-coordinator.test.ts`  
Expected: PASS，包括全中文截断和零 recentEvents。

- [ ] **Step 5: Commit**

```bash
git add apps/agent
git commit -m "feat: add bounded reconnect snapshots"
```

### Task 9: RunController、权限拒绝与 Agent SDK Adapter

**Files:**
- Create: `apps/agent/src/adapter/agent-driver.ts`, `mock-driver.ts`, `agent-sdk-adapter.ts`
- Create: `apps/agent/src/run/run-controller.ts`
- Test: `apps/agent/test/run-controller.test.ts`, `agent-sdk-adapter.test.ts`

**Interfaces:**
- Produces: `AgentDriver.startRun(input:{sessionId:string;claudeSessionId:string|null;runId:string;text:string;cwd:string;onEvent:(event:AdapterEvent)=>void}):Promise<AgentRunHandle>`。
- Produces: `AgentRunHandle.interrupt():Promise<void>`、`close():void`。
- Produces: `RunController.sendPrompt(sessionId:string,text:string,commandId:string):Promise<RunAccepted>`、`cancel(sessionId:string,runId:string):Promise<RunAccepted>`、`activeRun(sessionId:string):RunRecord|null`，实现 Task 6 对应操作。
- Produces: `AgentSdkAdapter implements AgentDriver`，真实 SDK 被限定在该文件。

- [ ] **Step 1: Write failing state-machine and SDK-option tests**

MockDriver 覆盖成功、失败、忙碌、指定 run 取消、interrupt 无终态 10 秒、App 断线继续、deny 后成功和第二次 run resume。Adapter 注入 queryFactory，断言单 prompt AsyncIterable、首次无 resume/后续有 resume、S00 presets/settings/cwd、canUseTool deny 无 updatedPermissions、终态 close。

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm run test:agent -- test/run-controller.test.ts test/agent-sdk-adapter.test.ts`  
Expected: FAIL with missing driver/run modules。

- [ ] **Step 3: Implement one-query-per-run lifecycle**

RunController 在 starting/running/cancelling 拒绝新 prompt；只有 SDK 终态触发 run.completed。cancel 只设置 cancelling 并 interrupt，10 秒无终态 close+interrupted。Adapter 严格按 `docs/s01/sdk-mapping.md` 将 SDKMessage 转为 AdapterEvent，禁止其他模块 import SDK。

- [ ] **Step 4: Run all run/adapter tests**

Run: `npm run test:agent -- test/run-controller.test.ts test/agent-sdk-adapter.test.ts`  
Expected: PASS，无永久 running/cancelling，第二个 run 使用同一 claudeSessionId。

- [ ] **Step 5: Commit**

```bash
git add apps/agent docs/s01/sdk-mapping.md
git commit -m "feat: add managed SDK run lifecycle"
```

### Task 10: Mac 端完整 wiring 与真实 WSS 集成

**Files:**
- Create: `apps/agent/src/app/agent-operations.ts`, `runtime.ts`, `wire.ts`
- Modify: `apps/agent/src/cli.ts`
- Test: `apps/agent/test/integration/agent-flow.test.ts`, `restart.test.ts`, `logging.test.ts`

**Interfaces:**
- Produces: `createAgentRuntime(config:AgentConfig,driver:AgentDriver):Promise<AgentRuntime>`。
- Produces: `AgentRuntime.start():Promise<void>`、`close():Promise<void>`、`operations:AgentOperations`。
- Produces: CLI start/status/pair/devices/revoke 的完整可运行路径。

- [ ] **Step 1: Write failing end-to-end in-process tests**

使用 MockDriver 和真实 Fastify/WSS：配对→hello→session.start→prompt→delta/tool→第二个 prompt busy→cancel→最终事件→断线→重连 snapshot。另测 revoke、Agent 重启新 session、慢连接、权限拒绝和日志 secret 扫描。

- [ ] **Step 2: Run integration tests to verify they fail**

Run: `npm run test:agent -- test/integration`  
Expected: FAIL with missing runtime wiring。

- [ ] **Step 3: Wire config/store/admin/transport/session/run/events without alternate paths**

所有命令只能经 CommandRouter；所有时间线事件只能经 Journal；snapshot 先发送再 command.result；close 显式关闭 WebSocket、admin/phone server 和 driver，不自动取消因 App 断线仍在执行的 run。

- [ ] **Step 4: Run the complete Mac integration suite**

Run: `npm run test:agent -- test/integration && npm run coverage:agent`  
Expected: PASS，核心 Agent statements/branches/functions/lines >=80%。

- [ ] **Step 5: Commit**

```bash
git add apps/agent
git commit -m "test: verify complete S01 agent flow"
```

### Task 11: Flutter 协议模型与不可变时间线 reducer

**Files:**
- Create: `apps/mobile/lib/protocol/envelope.dart`, `messages.dart`, `decoder.dart`
- Create: `apps/mobile/lib/domain/session.dart`, `run.dart`, `timeline.dart`
- Test: `apps/mobile/test/protocol/decoder_test.dart`, `domain/timeline_test.dart`

**Interfaces:**
- Produces: `ProtocolDecoder.decode(String json):ProtocolMessage`。
- Produces: `TimelineState applySnapshot(TimelineState previous,SessionSnapshot snapshot)`。
- Produces: `TimelineState applyEvent(TimelineState previous,TimelineEvent event)`。
- Produces: `ProtocolConflictException`，冲突或混入不同 sessionId 时抛出。

- [ ] **Step 1: Write failing shared-example and reducer tests**

读取 `../../protocol/v1/examples/` 的 S01 合法/非法样例；覆盖 delta/completed 合并、contentTruncated 不清空长正文、toolUseId 更新、同 eventId 去重、冲突拒绝、快照清空易失状态及 snapshotTruncated 标记。

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd apps/mobile && flutter test test/protocol test/domain`  
Expected: FAIL with missing protocol/domain classes。

- [ ] **Step 3: Implement manual immutable models driven by shared examples**

使用 sealed classes 和 copyWith，不引入代码生成框架；reducer 返回新 List/Map，不修改 previous。解码错误只保留安全 path/code，不回显输入 secret。

- [ ] **Step 4: Run shared protocol tests**

Run: `cd apps/mobile && flutter test test/protocol test/domain`  
Expected: PASS，与 Mac schema 对同样例结论一致。

- [ ] **Step 5: Commit**

```bash
git add apps/mobile
git commit -m "feat: add Flutter protocol and timeline reducers"
```

### Task 12: QR 配对、Keychain 与配对页

**Files:**
- Create: `apps/mobile/lib/data/device_credential.dart`, `credential_store.dart`, `pairing_api.dart`
- Create: `apps/mobile/lib/features/pairing/qr_payload.dart`, `pairing_controller.dart`, `pairing_page.dart`
- Modify: `apps/mobile/lib/main.dart`, `apps/mobile/ios/Runner/Info.plist`
- Test: `apps/mobile/test/features/pairing/qr_payload_test.dart`, `pairing_controller_test.dart`, `pairing_page_test.dart`

**Interfaces:**
- Produces: `PairingQrPayload.parse(String raw)`。
- Produces: `Future<DeviceCredential?> CredentialStore.read()`、`Future<void> save(DeviceCredential credential)`、`Future<void> clear()`。
- Produces: `Future<DeviceCredential> PairingApi.pair(PairingQrPayload payload,String deviceName)`。
- Produces: `pairingControllerProvider: NotifierProvider<PairingController,PairingState>`。

- [ ] **Step 1: Write failing QR/API/store/widget tests**

覆盖非 HTTPS、非 ts.net、过期、v !=1、缺 code、配对失败/五次失败/已有设备；断言 token 只在 API 响应和 Keychain fake 中，不出现在 QR、Widget、日志或普通 storage。扫描器通过接口注入，不在单测打开相机。

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd apps/mobile && flutter test test/features/pairing`  
Expected: FAIL with missing pairing classes。

- [ ] **Step 3: Implement validated pairing flow and Keychain persistence**

使用 package:http 默认 TLS 校验 POST `/v1/pairings`；deviceToken 不写日志。Info.plist 添加相机用途说明，PairingPage 仅含扫码、状态和错误重试，成功配对后进入 Chat 路由。

- [ ] **Step 4: Run pairing and widget tests**

Run: `cd apps/mobile && flutter test test/features/pairing`  
Expected: PASS，无任意 cwd/token 输入框。

- [ ] **Step 5: Commit**

```bash
git add apps/mobile
git commit -m "feat: add secure iPhone pairing flow"
```

### Task 13: Flutter WSS、命令客户端与快照重连

**Files:**
- Create: `apps/mobile/lib/data/agent_socket.dart`, `io_agent_socket.dart`
- Create: `apps/mobile/lib/connection/command_client.dart`, `connection_controller.dart`
- Create: `apps/mobile/lib/features/chat/session_controller.dart`
- Test: `apps/mobile/test/connection/command_client_test.dart`, `connection_controller_test.dart`

**Interfaces:**
- Produces: `AgentSocket.messages:Stream<String>`、`send(ProtocolMessage):Future<void>`、`close():Future<void>`。
- Produces: `typedef JsonMap = Map<String,dynamic>`；`CommandRequest<T>` 固定字段 `String commandId/traceId/type`、`String? sessionId/runId`、`JsonMap payload`、`T Function(JsonMap) decode`。
- Produces: `Future<T> CommandClient.execute<T>(CommandRequest<T> request,{Duration timeout=const Duration(seconds:10)})`；重试时再次传入同一 request。
- Produces: `Future<void> ConnectionController.connect()`、`onLifecycle(AppLifecycleState state)`。
- Produces: `Future<SessionRecord> SessionController.startOrAttach()`、`Future<void> refreshSnapshot()`。

- [ ] **Step 1: Write failing reconnect and unknown-command tests**

FakeSocket 覆盖 hello/ready、旧 epoch 丢弃、1/2/4/8/15 秒退避、断线后 snapshot、快照后事件、退后台不 cancel。发送超时保留同一 commandId，retry 不创建新 ID；App dispose 后无未关闭 stream。

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd apps/mobile && flutter test test/connection`  
Expected: FAIL with missing socket/command classes。

- [ ] **Step 3: Implement authenticated IOWebSocketChannel and ordered synchronization**

`IOWebSocketChannel.connect` 使用 `wss` URL、Bearer header、15 秒 pingInterval、10 秒 connectTimeout，不设置 customClient/badCertificateCallback。重连先 ready 再 snapshot/start，composer 在 syncing 完成前禁用。

- [ ] **Step 4: Run connection tests**

Run: `cd apps/mobile && flutter test test/connection`  
Expected: PASS，无 URL token、无断线 cancel、无新 commandId 重试。

- [ ] **Step 5: Commit**

```bash
git add apps/mobile
git commit -m "feat: add resilient iPhone session synchronization"
```

### Task 14: 聊天页、Composer、工具卡片与停止控制

**Files:**
- Create: `apps/mobile/lib/features/chat/chat_controller.dart`, `chat_page.dart`
- Create: `apps/mobile/lib/features/chat/widgets/message_list.dart`, `tool_card.dart`, `composer.dart`, `run_controls.dart`
- Modify: `apps/mobile/lib/main.dart`
- Test: `apps/mobile/test/features/chat/chat_controller_test.dart`, `chat_page_test.dart`

**Interfaces:**
- Consumes: Task 11 reducer、Task 13 CommandClient/SessionController。
- Produces: `ChatController.sendText()`、`retryUnknownCommand()`、`cancelActiveRun()`。
- Produces: 完整两页 App：已有凭证进 Chat，否则 Pairing。

- [ ] **Step 1: Write failing controller and widget tests**

覆盖空白/16,385 UTF-8 字节、offline/syncing/busy 禁止发送、SESSION_BUSY 保留输入、活跃 run 显示停止、cancelling 禁用、成功/失败/取消状态、权限拒绝卡片、snapshotTruncated 横幅和工具输出 256 KiB 预览截断。

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd apps/mobile && flutter test test/features/chat`  
Expected: FAIL with missing chat controller/widgets。

- [ ] **Step 3: Implement the single chat page without adding S02+ controls**

ChatController 组合 connection/session/run/composer 状态；发送使用原 commandId 直到明确结果，cancel 只传当前 runId。UI 不含项目列表、会话列表、语音、审批或设置后台。

- [ ] **Step 4: Run all Flutter tests and coverage**

Run: `cd apps/mobile && flutter test --coverage`  
Expected: PASS，核心 Dart 业务逻辑覆盖率 >=80%。

- [ ] **Step 5: Commit**

```bash
git add apps/mobile
git commit -m "feat: add S01 iPhone chat experience"
```

### Task 15: 真实 SDK、Tailscale 与 iPhone 验收

**Files:**
- Create: `apps/agent/test/live/s01-real-sdk.test.ts`
- Create: `scripts/s01/check-secrets.ts`, `scripts/s01/verify-gate.ts`, `scripts/s01/verify-gate.test.ts`, `scripts/s01/check-secrets.test.ts`
- Modify: `package.json`, `docs/s01/e2e-checklist.md`, `docs/s01/exit-report.md`

**Interfaces:**
- Produces: `npm run test:s01`、`npm run test:s01:live`、`npm run verify:s01`。
- Produces: E2E-01–12 的 PASS/FAIL/BLOCKED 实测台账；无真实证据不得写 PASS。

- [ ] **Step 1: Write the failing real-SDK smoke test and gate checks**

真实 SDK 测试只使用固定 fixture 和本机已允许 Read/Glob，验证两个顺序 run 的 resume、流式文本和取消；Bash ask 必须 deny 且不执行。Gate 测试缺失任一 E2E、Mock 替代真机、Funnel、secret 或覆盖率不足时失败。

- [ ] **Step 2: Run real-SDK test before wiring is accepted**

Run: `S01_LIVE=1 npm run test:s01:live`  
Expected: 全部可执行且结果真实；FAIL 时修复集成问题，缺少真实设备、Serve 或网关证据时标 BLOCKED 并停止，不得改 marker、默认放行工具或将环境缺失误写成 PASS。

- [ ] **Step 3: Execute E2E-01–12 on the physical iPhone**

按 `e2e-checklist.md` 逐项记录时间、版本、traceId 和结果：扫码、未认证拒绝、只读问答、busy、cancel、后台、断网、同 commandId、权限拒绝、revoke、Agent 重启和两个顺序 run。每项必须有真实证据。

- [ ] **Step 4: Run the full verification suite**

Run: `npm run test:s01 && npm run coverage:agent && cd apps/mobile && flutter test --coverage && cd ../.. && S01_LIVE=1 npm run test:s01:live && npm run verify:s01`  
Expected: 全部 PASS，Agent/Dart 覆盖率 >=80%，无 secret，无 Funnel，E2E-01–12 全 PASS。

- [ ] **Step 5: Write the exit report**

记录真实结果、已知内存限制、无手机审批、无实时 stdout 保证、App 被杀/Agent 重启的幂等限制；任何 FAIL/BLOCKED 都停止 S01 验收，不进入 S02。

- [ ] **Step 6: Commit**

```bash
git add apps scripts/s01 docs/s01 package.json
git commit -m "test: verify S01 on Mac and iPhone"
```
