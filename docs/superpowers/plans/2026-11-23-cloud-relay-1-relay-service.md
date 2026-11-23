# Cloud Relay 计划一：Relay 服务与黑盒契约测试套件

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 实现 `apps/relay` 云端中转服务（鉴权 + 通道拼接 + HTTP 代答）与可跨语言复用的黑盒契约测试套件，满足 `protocol/v1/relay-contract.md` v1 全部规范性要求。

**Architecture:** 单进程 Fastify + ws + better-sqlite3(WAL)。手机每条 WS 映射为电脑出站 WSS 上的逻辑通道，帧原样双向拼接，云端不解析 protocol v1；三个 HTTP 白名单路由经 `http.request/response` 消息代答。账号/设备/代次持久化于 SQLite，连接与通道表在内存；管理操作经 unix socket IPC。

**Tech Stack:** Node ≥22、TypeScript（tsx 直跑，noEmit）、Fastify 5.12.8、@fastify/websocket 11.3.7、ws 8.22.2、better-sqlite3 13.0.3、commander 15.1.0、zod 4（`npm install zod@4 --save-exact`）、vitest 5.1.0。

**Spec:** `docs/superpowers/specs/2026-11-23-cloud-relay-design.md`
**Contract（唯一线上行为依据）:** `protocol/v1/relay-contract.md`

**后续计划（本计划不含）：** 计划二 Agent 出站连接器（`apps/agent`）；计划三手机云端模式（`apps/mobile`）。两者只依赖契约文档与本计划交付的黑盒套件。

## Global Constraints

- Node ≥22；ESM（`"type": "module"`）；tsconfig 与 `apps/agent/tsconfig.json` 相同（NodeNext、strict、noUncheckedIndexedAccess、noEmit）；相对导入带 `.js` 后缀。
- 依赖版本与 `apps/agent/package.json` 完全一致（fastify 5.12.8、@fastify/websocket 11.3.7、ws 8.22.2、better-sqlite3 13.0.3、commander 15.1.0）；zod 用 `npm install zod@4 --save-exact` 解析锁定。
- 契约 §2.1 全部上限为默认值（`DEFAULT_LIMITS`）；测试可经 `RelayAppOptions.limits` 覆盖，生产代码路径不得绕过默认值。
- 错误响应体一律 `{ error: { code, message } }`；code 为大写下划线稳定码；message 不泄漏内部细节。
- 口令 scrypt 加盐哈希；令牌 SHA-256 哈希落盘；令牌熵 32 字节 base64url，只在登录响应出现一次。
- 日志只记元数据（deviceId/channelId/type/字节数/close code），禁止记录口令、令牌、帧内容、代答体；生产代码禁止 `console.log`（启动事件行用 `process.stdout.write`，属运维输出协议）。
- TS 规范：禁止 `any`/`import type`/默认导出/`forEach`/`for...in`/`==`；对象类型用 `interface`；外部输入用 zod 校验；导出函数标注参数与返回类型。
- 覆盖率门槛：`apps/relay/src/**` statements/branches/functions/lines ≥ 80%。
- 提交信息 `<type>: <description>`；每个任务结束提交一次；无归因尾行。
- ID 前缀：账号 `acc_`、设备 `dev_`、通道 `ch_`、代答请求 `req_`，后缀 `randomBytes(9).toString('base64url')`。
- 默认监听 `127.0.0.1:8788`；`RELAY_HOST`/`RELAY_PORT`/`RELAY_DATA_DIR` 环境变量覆盖；`RELAY_PORT=0` 时启动后向 stdout 写一行 `{"event":"relay.started","host":…,"port":…}`（实际端口）。

## Review Focus

 spec 隐含、最可能咬到真实用户的五类输入/状态（已在对应任务中落测试）：

1. **Relay 重启后**：已发令牌仍有效、`connectionEpoch` 不回退（Task 2 持久化测试 + Task 6 重启契约测试）。
2. **跨账号访问**：拿 A 账号令牌指定 B 账号的 desktopId（WS 升级、HTTP 代答、DELETE 设备）一律 404，不泄漏存在性（Task 4/7/9）。
3. **帧大小边界**：恰好 64 KiB 的 control 帧必须通过，64 KiB+1 必须关闭通道 4003（Task 7）。
4. **桌面被取代/重连时手机仍挂着**：手机收到 4010、旧桌面连接收到全部 `channel.close`，新代次不接收旧连接消息（Task 6/7）。
5. **超时后迟到的 `http.response` / 未知 requestId**：丢弃、不崩溃、不重复回复（Task 9）。

---

### Task 1: 包脚手架与版本端点

**Files:**
- Create: `apps/relay/package.json`、`apps/relay/tsconfig.json`、`apps/relay/vitest.config.ts`、`apps/relay/bin/claude-remote-relay.js`、`apps/relay/src/config.ts`、`apps/relay/src/limits.ts`、`apps/relay/src/app.ts`、`apps/relay/src/main.ts`
- Modify: `package.json`（root：workspaces 加 `"apps/relay"`；scripts 加 `"test:relay": "vitest run --root apps/relay"`、`"coverage:relay": "vitest run --root apps/relay --coverage"`）
- Test: `apps/relay/test/version.test.ts`

**Interfaces:**
- Produces:
  - `loadConfig(env: Record<string, string | undefined>): RelayConfig`，`interface RelayConfig { host: string; port: number; dataDir: string }`（默认 `127.0.0.1` / `8788` / `./data`；非法端口抛 `Error('INVALID_CONFIG')`）
  - `interface RelayLimits { loginPerMinute: number; maxDevicesPerAccount: number; controlFrameBytes: number; asrFrameBytes: number; httpBodyBytes: number; desktopMessageBytes: number; httpTimeoutMs: number; handshakeTimeoutMs: number; pingIntervalMs: number; pongTimeoutMs: number; channelBufferBytes: number; desktopBufferBytes: number }` 与 `DEFAULT_LIMITS: RelayLimits`（值 = 契约 §2.1/§5.3：10、20、65536、262144、12582912、16777216、30000、10000、15000、45000、2097152、8388608）
  - `createRelayApp(options: RelayAppOptions): Promise<FastifyInstance>`，`interface RelayAppOptions { store: RelayStore; limits?: Partial<RelayLimits>; logger?: boolean }`（本任务 store 尚未存在，先以 `store?: RelayStore` 可选传入，Task 3 收紧为必填）
  - bin 包装器与 `apps/agent/bin/claude-remote-agent.js` 同构（spawnSync `--import tsx src/main.ts`）

- [ ] **Step 1: 写失败测试**

```ts
// apps/relay/test/version.test.ts
import { describe, expect, it } from 'vitest';
import { createRelayApp } from '../src/app.js';
import { DEFAULT_LIMITS } from '../src/limits.js';
import { loadConfig } from '../src/config.js';

describe('GET /v1/version', () => {
  it('免鉴权返回契约版本', async () => {
    const app = await createRelayApp({ logger: false });
    const response = await app.inject({ method: 'GET', url: '/v1/version' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ contractVersion: 1 });
    await app.close();
  });
});

describe('loadConfig', () => {
  it('默认值与环境变量覆盖', () => {
    expect(loadConfig({})).toEqual({ host: '127.0.0.1', port: 8788, dataDir: './data' });
    expect(loadConfig({ RELAY_PORT: '0' }).port).toBe(0);
    expect(() => loadConfig({ RELAY_PORT: 'abc' })).toThrow('INVALID_CONFIG');
  });
});

it('DEFAULT_LIMITS 与契约 §2.1 一致', () => {
  expect(DEFAULT_LIMITS.controlFrameBytes).toBe(65536);
  expect(DEFAULT_LIMITS.maxDevicesPerAccount).toBe(20);
  expect(DEFAULT_LIMITS.httpTimeoutMs).toBe(30000);
});
```

- [ ] **Step 2: 建包声明并运行确认失败**

先创建 `apps/relay/package.json`（name `@claude-remote/relay`，依赖按 Global Constraints 锁版）并在 root `package.json` workspaces 加入 `"apps/relay"`，然后：
Run: `npm install && npm install zod@4 --save-exact -w apps/relay`
Run: `npx vitest run --root apps/relay`
Expected: FAIL（src 模块不存在）

- [ ] **Step 3: 实现脚手架**

按 Files 清单创建其余文件。`app.ts` 注册 `GET /v1/version` 返回 `{ contractVersion: 1, relayVersion: '0.1.0' }`，并设置 `setNotFoundHandler` 返回 404 `{ error: { code: 'ROUTE_NOT_FOUND', message: 'ROUTE_NOT_FOUND' } }`。`main.ts`：loadConfig → createRelayApp({logger:true}) → listen → `process.stdout.write` 启动事件行（端口取 `app.server.address()`）。vitest.config.ts 复制 agent 的（coverage include `src/**/*.ts`，门槛 80）。

- [ ] **Step 4: 运行确认通过**

Run: `npx vitest run --root apps/relay && npx tsc -p apps/relay`
Expected: PASS；tsc 无输出

- [ ] **Step 5: 提交**

```bash
git add package.json package-lock.json apps/relay
git commit -m "feat: scaffold relay package with version endpoint"
```

---

### Task 2: 存储层（账号/设备/代次持久化）

**Files:**
- Create: `apps/relay/src/storage/store.ts`（Port 与记录类型）、`apps/relay/src/storage/sqlite-store.ts`、`apps/relay/src/security/credentials.ts`
- Test: `apps/relay/test/store.test.ts`

**Interfaces:**
- Consumes: Task 1 的包结构。
- Produces:
  - `interface AccountRecord { accountId: string; username: string; disabled: boolean; createdAt: number }`
  - `interface DeviceRecord { deviceId: string; accountId: string; role: 'phone' | 'desktop'; deviceName: string; platform: string; appVersion: string; revoked: boolean; createdAt: number; lastSeenAt: number | null; connectionEpoch: number }`
  - `interface CreateDeviceInput { accountId: string; role: 'phone' | 'desktop'; deviceName: string; platform: string; appVersion: string }`
  - `interface RelayStore { createAccount(username: string, password: string): AccountRecord; findAccountByUsername(username: string): AccountRecord | null; verifyPassword(username: string, password: string): AccountRecord | null; setPassword(username: string, password: string): void; setAccountDisabled(username: string, disabled: boolean): void; listAccounts(): AccountRecord[]; createDevice(input: CreateDeviceInput): { device: DeviceRecord; deviceToken: string }; verifyDevice(deviceId: string, token: string): DeviceRecord | null; findDevice(deviceId: string): DeviceRecord | null; listDevices(accountId: string): DeviceRecord[]; revokeDevice(accountId: string, deviceId: string): boolean; nextConnectionEpoch(deviceId: string): number; touchLastSeen(deviceId: string): void; close(): void }`
  - `openRelayStore(dataDir: string): RelayStore`（建 `<dataDir>/relay.sqlite`，WAL，schema 迁移用 `PRAGMA user_version`）
  - `hashPassword(password: string): string`（格式 `scrypt:<saltHex>:<hashHex>`，`scryptSync(password, salt, 64)`，salt 16 字节）、`verifyPasswordHash(password: string, stored: string): boolean`（`timingSafeEqual`）、`newDeviceToken(): string`（32 字节 base64url）、`hashToken(token: string): string`（SHA-256 hex）
  - 错误：`StoreError` 带 `code: 'USERNAME_TAKEN' | 'ACCOUNT_NOT_FOUND' | 'DEVICE_LIMIT_REACHED'`；`verifyPassword` 对不存在用户名与错误口令都返回 null；禁用账号仍返回记录（由路由判 403）；`verifyDevice` 对无效/已吊销/账号禁用一律 null；`createDevice` 在未吊销设备数 ≥ `maxDevicesPerAccount` 时抛 `DEVICE_LIMIT_REACHED`（上限经 `openRelayStore(dataDir, maxDevices?: number)` 第二参数注入，默认 `DEFAULT_LIMITS.maxDevicesPerAccount`）

- [ ] **Step 1: 写失败测试**

```ts
// apps/relay/test/store.test.ts —— 每个用例用 mkdtempSync 临时目录，afterEach close+rm
it('创建账号并校验口令；错误口令与不存在用户名同样返回 null', () => {
  const store = openRelayStore(dir);
  store.createAccount('alice', 'pw-123456');
  expect(store.verifyPassword('alice', 'pw-123456')?.username).toBe('alice');
  expect(store.verifyPassword('alice', 'wrong')).toBeNull();
  expect(store.verifyPassword('nobody', 'pw-123456')).toBeNull();
  expect(() => store.createAccount('alice', 'x')).toThrow('USERNAME_TAKEN');
});

it('设备令牌只出现一次且可校验；吊销后失效', () => {
  const store = openRelayStore(dir);
  const acc = store.createAccount('alice', 'pw-123456');
  const { device, deviceToken } = store.createDevice({ accountId: acc.accountId, role: 'desktop', deviceName: 'Mac', platform: 'macos', appVersion: '1.0.0' });
  expect(store.verifyDevice(device.deviceId, deviceToken)?.deviceId).toBe(device.deviceId);
  expect(store.verifyDevice(device.deviceId, 'bad')).toBeNull();
  store.revokeDevice(acc.accountId, device.deviceId);
  expect(store.verifyDevice(device.deviceId, deviceToken)).toBeNull();
});

it('账号禁用后 verifyDevice 返回 null，启用后恢复', () => { /* setAccountDisabled 往返断言 */ });

it('未吊销设备数达上限抛 DEVICE_LIMIT_REACHED；吊销释放名额', () => {
  const store = openRelayStore(dir, 2);
  /* 建 2 台 → 第 3 台抛错 → revoke 1 台 → 第 3 台成功 */
});

it('connectionEpoch 持久化：重开库后继续递增（Review Focus 1）', () => {
  const store = openRelayStore(dir);
  const acc = store.createAccount('alice', 'pw-123456');
  const { device } = store.createDevice({ accountId: acc.accountId, role: 'desktop', deviceName: 'Mac', platform: 'macos', appVersion: '1.0.0' });
  expect(store.nextConnectionEpoch(device.deviceId)).toBe(1);
  expect(store.nextConnectionEpoch(device.deviceId)).toBe(2);
  store.close();
  const reopened = openRelayStore(dir);
  expect(reopened.nextConnectionEpoch(device.deviceId)).toBe(3);
  reopened.close();
});

it('跨账号 revokeDevice 返回 false 且不生效', () => { /* 两个账号，A revoke B 的设备 */ });
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run --root apps/relay test/store.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现**

schema：`accounts(account_id TEXT PK, username TEXT UNIQUE, password_hash TEXT, disabled INTEGER, created_at INTEGER)`；`devices(device_id TEXT PK, account_id TEXT, role TEXT, device_name TEXT, platform TEXT, app_version TEXT, token_hash TEXT, revoked INTEGER, created_at INTEGER, last_seen_at INTEGER NULL, connection_epoch INTEGER DEFAULT 0)`。`nextConnectionEpoch` 用 `UPDATE devices SET connection_epoch = connection_epoch + 1 WHERE device_id = ? RETURNING connection_epoch`。令牌比较用 `timingSafeEqual` 比较哈希。

- [ ] **Step 4: 运行确认通过**

Run: `npx vitest run --root apps/relay && npx tsc -p apps/relay`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add apps/relay
git commit -m "feat: add relay account/device store with persistent connection epochs"
```

---

### Task 3: 登录端点与限流

**Files:**
- Create: `apps/relay/src/auth/login-route.ts`、`apps/relay/src/auth/authenticate.ts`、`apps/relay/src/auth/rate-limiter.ts`
- Modify: `apps/relay/src/app.ts`（`RelayAppOptions.store` 收紧为必填；注册登录路由与全局鉴权辅助）
- Test: `apps/relay/test/login.test.ts`

**Interfaces:**
- Consumes: `RelayStore`（Task 2）、`createRelayApp`/`DEFAULT_LIMITS`（Task 1）。
- Produces:
  - `authenticateBearer(store: RelayStore, headers: Record<string, unknown>): DeviceRecord`（解析 `Authorization: Bearer <deviceId>.<token>`，失败抛 `AuthError` code `'UNAUTHENTICATED'`；与 agent `authenticate.ts` 同规则：拒绝 query/子协议携带凭证）
  - `SlidingWindowLimiter`：`constructor(maxPerWindow: number, windowMs: number)`，`allow(key: string): boolean`
  - 登录请求 zod schema：`{ username, password, clientType: 'phone'|'desktop', deviceName, platform: 'ios'|'android'|'macos'|'linux', appVersion }` 全部必填非空
  - 200 响应：`{ accountId, deviceId, deviceToken, role, contractVersion: 1 }`

- [ ] **Step 1: 写失败测试**

```ts
// apps/relay/test/login.test.ts —— createRelayApp({store, logger:false}) + app.inject
it('desktop 登录返回设备凭证，role=desktop', async () => {
  store.createAccount('alice', 'pw-123456');
  const res = await app.inject({ method: 'POST', url: '/v1/auth/login', payload: { username: 'alice', password: 'pw-123456', clientType: 'desktop', deviceName: 'Mac', platform: 'macos', appVersion: '1.0.0' } });
  expect(res.statusCode).toBe(200);
  const body = res.json();
  expect(body.role).toBe('desktop');
  expect(body.deviceId).toMatch(/^dev_/);
  expect(store.verifyDevice(body.deviceId, body.deviceToken)).not.toBeNull();
});

it('用户名不存在与口令错误返回同一 401 INVALID_CREDENTIALS', async () => { /* 两次 inject，断言 statusCode 与 body 完全一致 */ });
it('禁用账号返回 403 ACCOUNT_DISABLED', async () => { /* setAccountDisabled(true) */ });
it('缺字段返回 400 INVALID_REQUEST', async () => { /* 缺 deviceName */ });
it('第 11 次登录尝试返回 429 RATE_LIMITED', async () => {
  // limits: { loginPerMinute: 10 }；同一 username+IP 连续 11 次错误口令
});
it('设备数达上限返回 409 DEVICE_LIMIT_REACHED', async () => { /* limits: { maxDevicesPerAccount: 1 }，第二次登录 409 */ });
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run --root apps/relay test/login.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现**

限流 key = `${username}|${request.ip}`，窗口 60s，先判限流再验口令（失败尝试也计数）。登录成功调 `store.createDevice`。错误体统一 `{ error: { code, message: code } }`。

- [ ] **Step 4: 运行确认通过**

Run: `npx vitest run --root apps/relay && npx tsc -p apps/relay`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add apps/relay
git commit -m "feat: add relay login endpoint with rate limiting and device caps"
```

---

### Task 4: 设备列表与吊销端点

**Files:**
- Create: `apps/relay/src/devices/device-routes.ts`
- Modify: `apps/relay/src/app.ts`（注册路由）
- Test: `apps/relay/test/devices.test.ts`

**Interfaces:**
- Consumes: `authenticateBearer`（Task 3）、`RelayStore`（Task 2）。
- Produces:
  - `GET /v1/desktops` → `{ desktops: [{ desktopId, desktopName, platform, appVersion, online, lastSeenAt }] }`（本任务 `online` 恒为 false、`lastSeenAt` 取库值；Task 6 接入注册表后为真实在线状态——本任务在 app 内以 `isOnline(deviceId): boolean` 回调注入，默认 `() => false`）
  - `GET /v1/devices` → `{ devices: [DeviceRecord 去掉 token 相关字段 + online] }`
  - `DELETE /v1/devices/{deviceId}` → 204；非本账号/不存在 → 404 `DEVICE_NOT_FOUND`
  - `DeviceRoutesDeps { store: RelayStore; isOnline(deviceId: string): boolean; onRevoke?(device: DeviceRecord): void }`（`onRevoke` 本任务不接线，Task 10 用于即时断开）

- [ ] **Step 1: 写失败测试**

```ts
// apps/relay/test/devices.test.ts
it('desktops 只列本账号 desktop 角色设备', async () => { /* alice 1 desktop + 1 phone，bob 1 desktop；alice GET 只见 1 条 */ });
it('未鉴权返回 401 UNAUTHENTICATED', async () => { /* 无 Authorization 头 */ });
it('DELETE 本账号设备返回 204 且令牌立即失效', async () => { /* DELETE 后 store.verifyDevice 为 null */ });
it('DELETE 他账号设备返回 404 DEVICE_NOT_FOUND（Review Focus 2）', async () => { /* alice 令牌 DELETE bob 的 deviceId；断言 bob 设备仍可用 */ });
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run --root apps/relay test/devices.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现**

路由内统一 `authenticateBearer`；列表过滤 `role` 与 `accountId`；响应字段按契约 §3.2/§3.3，空列表 `[]`。

- [ ] **Step 4: 运行确认通过**

Run: `npx vitest run --root apps/relay && npx tsc -p apps/relay`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add apps/relay
git commit -m "feat: add relay device listing and revocation endpoints"
```

---

### Task 5: 管理 IPC 与 admin CLI

**Files:**
- Create: `apps/relay/src/admin/admin-socket.ts`、`apps/relay/src/admin/client.ts`、`apps/relay/src/cli.ts`
- Modify: `apps/relay/src/main.ts`（改为经 `cli.ts` 入口：默认 `serve`，`admin` 子命令）、`apps/relay/package.json`（bin 已指向包装器，无需改）
- Test: `apps/relay/test/admin.test.ts`

**Interfaces:**
- Consumes: `RelayStore`、`createRelayApp`、`loadConfig`。
- Produces:
  - `startAdminSocket(deps: AdminDeps): Promise<Server>`，监听 `<dataDir>/relay-admin.sock`（启动前清理残留 socket 文件）；`interface AdminDeps { store: RelayStore; onAccountDisabled?(accountId: string): void; onDeviceRevoked?(device: DeviceRecord): void }`（两个回调 Task 10 接线）
  - IPC 协议：每连接一条 JSON 请求 `{ op: 'create-user' | 'reset-password' | 'disable-user' | 'enable-user' | 'list-accounts' | 'list-devices' | 'revoke-device', username?, password?, deviceId? }` → 一条 JSON 响应 `{ ok: true, result?: unknown } | { ok: false, error: { code, message } }`
  - `sendAdminRequest(dataDir: string, request: AdminRequest): Promise<AdminResponse>`
  - CLI（commander）：`claude-remote-relay serve`（默认）；`admin create-user <username> --password <pw>`、`admin reset-password <username> --password <pw>`、`admin disable-user <username>`、`admin enable-user <username>`、`admin list-accounts`、`admin list-devices <username>`、`admin revoke-device <deviceId>`；成功输出 JSON 到 stdout，失败输出错误 JSON 到 stderr 并退出码 1

- [ ] **Step 1: 写失败测试**

```ts
// apps/relay/test/admin.test.ts —— 临时目录起 admin socket（不起 HTTP）
it('create-user 后可登录校验；重复创建返回 USERNAME_TAKEN', async () => {
  const response = await sendAdminRequest(dir, { op: 'create-user', username: 'alice', password: 'pw-123456' });
  expect(response.ok).toBe(true);
  expect(store.verifyPassword('alice', 'pw-123456')).not.toBeNull();
  const again = await sendAdminRequest(dir, { op: 'create-user', username: 'alice', password: 'x' });
  expect(again).toMatchObject({ ok: false, error: { code: 'USERNAME_TAKEN' } });
});
it('disable-user 使 verifyDevice 失效并触发 onAccountDisabled 回调', async () => { /* vi.fn() 断言收到 accountId */ });
it('revoke-device 触发 onDeviceRevoked 回调', async () => { /* vi.fn() 断言收到 device */ });
it('未知 op 返回 INVALID_REQUEST', async () => { /* socket 手写 JSON */ });
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run --root apps/relay test/admin.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现**

admin socket 用 `node:net`；请求用 zod 判别联合校验；`revoke-device` 按 deviceId 全局查找（管理员视角，无账号归属限制）。CLI 的 `serve` 分支：`openRelayStore(config.dataDir)` → `createRelayApp({ store, logger: true })` → listen → 启动事件行 → `startAdminSocket`。socket 文件权限 `0600`。

- [ ] **Step 4: 运行确认通过**

Run: `npx vitest run --root apps/relay && npx tsc -p apps/relay`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add apps/relay
git commit -m "feat: add relay admin unix socket and CLI"
```

---

### Task 6: 桌面 WSS 握手、代次与黑盒测试 harness

**Files:**
- Create: `apps/relay/src/routing/desktop-link.ts`、`apps/relay/src/routing/registry.ts`、`contract-tests/relay/helpers/harness.ts`、`contract-tests/relay/helpers/clients.ts`、`contract-tests/relay/README.md`、`vitest.relay-contract.config.ts`（root）
- Modify: `apps/relay/src/app.ts`（注册 `/v1/desktop/ws`；`isOnline` 接注册表）、`apps/relay/src/main.ts`（装配注册表）、root `package.json`（scripts 加 `"test:relay:contract": "vitest run --config vitest.relay-contract.config.ts"`）
- Test: `apps/relay/test/desktop-link.test.ts`（单元，limits 覆盖）、`contract-tests/relay/desktop-handshake.test.ts`（黑盒）

**Interfaces:**
- Consumes: `authenticateBearer`、`RelayStore.nextConnectionEpoch/touchLastSeen`、`DEFAULT_LIMITS`。
- Produces:
  - `ConnectionRegistry`：`attachDesktop(device: DeviceRecord, socket: WebSocket, epoch: number): DesktopLink`（取代旧连接：旧 socket close 4000）；`desktopFor(desktopId: string): DesktopLink | undefined`；`isOnline(desktopId: string): boolean`；`closeDevice(deviceId: string, code: number): void`；`closeAccount(accountId: string, code: number): void`（Task 7 扩展 phone 侧方法）
  - `DesktopLink { desktopId: string; accountId: string; epoch: number; socket: WebSocket; channels: Map<string, PhoneLink>; send(message: DesktopOutboundMessage): void }`（`PhoneLink` Task 7 定义；本任务 channels 恒空）
  - 桌面握手消息 zod schema：`desktop.hello`（契约 §5.1 字段）；出站 `desktop.ready`、`error`
  - **黑盒 harness（后续所有契约测试与计划二/三复用）**：
    - `startRelay(): Promise<RelayHandle>`，`interface RelayHandle { baseUrl: string; dataDir: string; stop(): Promise<void> }`。`RELAY_BASE_URL` 环境变量存在时直接复用该地址（跨语言验收模式，dataDir 取 `RELAY_DATA_DIR`）；否则 spawn `node --import tsx apps/relay/src/main.ts`（cwd=repo root，env `RELAY_PORT=0`、`RELAY_DATA_DIR=mkdtemp`），解析 stdout `relay.started` 行取端口；stop 杀进程并清理临时目录
    - `createAccount(handle: RelayHandle, username: string, password: string): Promise<void>`（spawn admin CLI；跨语言模式下要求实现提供等价 admin 入口，README 说明）
    - `login(baseUrl: string, request: LoginRequest): Promise<LoginResponse>`（fetch）
    - `openDesktop(baseUrl: string, credential: Credential, overrides?: Partial<HelloPayload>): Promise<DesktopClient>`，`interface Credential { deviceId: string; deviceToken: string }`；`interface DesktopClient { epoch: number; socket: WebSocket; nextMessage(timeoutMs?: number): Promise<Record<string, unknown>>; send(message: Record<string, unknown>): void; close(): void }`（完成 hello/ready，暴露 epoch）
    - `openPhone(baseUrl: string, credential: Credential, desktopId: string, kind: 'control' | 'asr'): Promise<WebSocket>`（Task 7 起使用；本任务先实现升级与错误分支）
    - `expectClose(socket: WebSocket, code: number): Promise<void>`
  - 契约测试运行约定：`vitest.relay-contract.config.ts` include `contract-tests/relay/**/*.test.ts`，testTimeout/hookTimeout 30000；套件**禁止 import `apps/relay/src`**（README 写明：这是跨语言验收套件，只许走网络与 admin CLI）

- [ ] **Step 1: 写失败测试**

```ts
// apps/relay/test/desktop-link.test.ts —— 真实 listen port 0 + ws 客户端；limits 覆盖握手/心跳超时为 100ms 级
it('hello → ready 携带递增 epoch；再次连接 epoch+1 且旧连接收 4000', async () => { /* 两次 openDesktop 断言 */ });
it('首条非 hello / 超时 / 畸形 JSON → close 4001', async () => { /* 三个子用例 */ });
it('版本无交集 → error VERSION_INCOMPATIBLE + close 4002', async () => { /* supportedContractVersions: [99] */ });
it('phone 角色设备连桌面端点 → 升级失败 403', async () => { /* fetch 升级或 ws 握手 unexpected-response 断言 403 */ });
it('pong 超时断开（limits.pongTimeoutMs=100, pingIntervalMs=20）', async () => { /* 客户端不应答 ping：ws 库自动回 pong，需 hook socket.pong 禁用 */ });

// contract-tests/relay/desktop-handshake.test.ts —— 只经 harness
it('契约 §5.1：握手、代次递增、取代旧连接', async () => { /* startRelay → createAccount → login(desktop) → openDesktop ×2 */ });
it('契约 §5.1：重启后代次不回退（Review Focus 1）', async () => {
  // openDesktop 得 epoch N → handle.stop() → 以同一 dataDir 重启（startRelay 接受可选 dataDir 参数）→ 再连得 epoch > N
});
it('契约 §3.2：desktops.online 反映真实连接状态', async () => { /* 连接前后 GET /v1/desktops */ });
```

（`startRelay` 增加可选参数 `options?: { dataDir?: string }` 以支持重启用例——与上方签名合并为 `startRelay(options?: { dataDir?: string }): Promise<RelayHandle>`。）

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run --root apps/relay test/desktop-link.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现**

`/v1/desktop/ws` 用 `@fastify/websocket`，preValidation 钩子鉴权（401/403 在完成升级前返回）。握手状态机：10s 定时器 → hello zod 校验 → 版本交集 → `store.nextConnectionEpoch` → registry.attachDesktop（旧连接 4000）→ 发 ready → 启动 ping 15s/pong 45s。握手后未知 `type` → `error INVALID_MESSAGE` + close 4001。断开时 `touchLastSeen`。harness/clients 按 Interfaces 实现。

- [ ] **Step 4: 运行确认通过**

Run: `npx vitest run --root apps/relay && npx vitest run --config vitest.relay-contract.config.ts && npx tsc -p apps/relay`
Expected: 全部 PASS

- [ ] **Step 5: 提交**

```bash
git add apps/relay contract-tests vitest.relay-contract.config.ts package.json
git commit -m "feat: add relay desktop WSS handshake with epochs and black-box test harness"
```

---

### Task 7: 控制通道拼接（手机 /ws）

**Files:**
- Create: `apps/relay/src/routing/phone-link.ts`、`apps/relay/src/routing/splice.ts`
- Modify: `apps/relay/src/routing/registry.ts`（phone 侧：`attachPhone(device: DeviceRecord, desktopId: string, kind: 'control' | 'asr', socket: WebSocket): PhoneLink`、按 (deviceId, kind) 取代、桌面断开联动）、`apps/relay/src/app.ts`（注册 `/ws`）
- Test: `apps/relay/test/splice.test.ts`（单元，小 limits）、`contract-tests/relay/control-channel.test.ts`（黑盒）

**Interfaces:**
- Consumes: `ConnectionRegistry`/`DesktopLink`（Task 6）、harness（Task 6）。
- Produces:
  - `interface PhoneLink { channelId: string; deviceId: string; accountId: string; desktopId: string; kind: 'control' | 'asr'; socket: WebSocket; pendingBytes: number }`
  - `splicePhoneToDesktop(link: PhoneLink, desktop: DesktopLink, data: Buffer, isBinary: boolean, limits: RelayLimits): void`（校验 kind 对应帧上限；control 通道拒绝二进制帧→close 4003；封装 `channel.data`）
  - `spliceDesktopToPhone(link: PhoneLink, message: ChannelDataPayload): void`（base64 解码回二进制帧；文本原样）
  - 手机升级校验顺序：Bearer → desktopId 存在且同账号且 role=desktop（否则 404）→ 在线（否则 503）→ 升级 → `channel.open`
  - 桌面连接断开/被取代：其全部 PhoneLink close 4010；手机断开：向桌面发 `channel.close`（透传 code）；`channel.close` 后 channelId 作废，后续 data 忽略

- [ ] **Step 1: 写失败测试**

```ts
// contract-tests/relay/control-channel.test.ts
it('契约 §4/§5.2：control 帧双向原样拼接且保序', async () => {
  const desktop = await openDesktop(...); const phone = await openPhone(..., 'control');
  const open = await desktop.nextMessage();
  expect(open).toMatchObject({ type: 'channel.open', payload: { kind: 'control', deviceId: phoneCred.deviceId } });
  const frames = Array.from({ length: 50 }, (_, i) => JSON.stringify({ type: 'connection.hello', payload: { n: i } }));
  for (const f of frames) phone.send(f);
  for (const f of frames) {
    const msg = await desktop.nextMessage();
    expect(msg).toMatchObject({ type: 'channel.data', payload: { binary: false, data: f } });
  }
  // 反向：desktop.send channel.data → phone 收到原文本
});
it('契约 §6：跨账号 desktopId 升级返回 404（Review Focus 2）', async () => { /* bob 的手机令牌 + alice 的 desktopId */ });
it('契约 §4.1：目标离线 503 DESKTOP_OFFLINE；缺 desktopId 400', async () => { /* ws unexpected-response 断言状态码 */ });
it('契约 §4.2：同设备同种类新连接取代旧连接 4000；asr 与 control 并存互不影响', async () => { /* 先开 control+asr 两条，再开第二条 control：仅旧 control 收 4000 */ });
it('契约 §4.2：桌面断开 → 手机 4010；桌面重连后手机可重连（Review Focus 4）', async () => { /* desktop.close() → expectClose(phone, 4010)；重连后 channel.open 的 channelId 为新值 */ });
it('契约 §2.1：恰好 64KiB 文本帧通过，64KiB+1 → 手机连接 4003（Review Focus 3）', async () => { /* 'a'.repeat(65536) 与 65537 */ });
it('手机断开 → 桌面收到 channel.close 且 channelId 作废', async () => { /* close 后再向该 channelId 发 data，桌面端无转发、连接不崩 */ });
```

```ts
// apps/relay/test/splice.test.ts —— 单元
it('control 通道收到二进制帧 → close 4003', () => { /* 直接调 splicePhoneToDesktop */ });
it('channel.data base64 解码逐字节还原', () => { /* 随机 Buffer 往返 */ });
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run --config vitest.relay-contract.config.ts contract-tests/relay/control-channel.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现**

registry 手机表 key = `${deviceId}:${kind}`；`channelId` 生成 `ch_` 前缀；拼接路径不做任何 JSON.parse（帧内容透明）。帧上限按**解码后字节数**判定（UTF-8 字节长，不是字符数）。

- [ ] **Step 4: 运行确认通过**

Run: `npx vitest run --root apps/relay && npx vitest run --config vitest.relay-contract.config.ts && npx tsc -p apps/relay`
Expected: 全部 PASS

- [ ] **Step 5: 提交**

```bash
git add apps/relay contract-tests
git commit -m "feat: add relay control channel splicing with supersession and size caps"
```

---

### Task 8: 语音通道（/ws/asr 二进制拼接）

**Files:**
- Modify: `apps/relay/src/app.ts`（注册 `/ws/asr`，复用 Task 7 全部机制，kind='asr'）、`apps/relay/src/routing/splice.ts`（asr 上限与二进制许可）
- Test: `contract-tests/relay/asr-channel.test.ts`

**Interfaces:**
- Consumes: Task 7 全部；无新导出（复用 `openPhone(..., 'asr')`）。
- Produces: 契约 §4.1 asr 行为：文本与二进制帧均拼接；二进制经 base64 封装，单帧解码后 ≤256 KiB。

- [ ] **Step 1: 写失败测试**

```ts
// contract-tests/relay/asr-channel.test.ts
it('契约 §5.2：二进制音频帧 base64 往返逐字节一致', async () => {
  const pcm = randomBytes(3200); // 100ms 16kHz PCM16
  phone.send(pcm);
  const msg = await desktop.nextMessage();
  expect(msg.payload.binary).toBe(true);
  expect(Buffer.from(msg.payload.data, 'base64').equals(pcm)).toBe(true);
  // 反向：desktop → phone 二进制帧，phone 以 binary 事件收到原字节
});
it('asr 文本控制帧原样拼接', async () => { /* JSON 文本帧往返 */ });
it('256KiB+1 二进制帧 → 4003；恰好 256KiB 通过', async () => { /* 边界 */ });
it('同一手机 control 与 asr 通道并行互不干扰', async () => { /* 两通道各自收发，channelId 不同 */ });
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run --config vitest.relay-contract.config.ts contract-tests/relay/asr-channel.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现**

`/ws/asr` 与 `/ws` 共用升级校验与拼接函数，仅 kind 与上限不同；ws 消息事件保留 `isBinary` 标志透传。

- [ ] **Step 4: 运行确认通过**

Run: `npx vitest run --root apps/relay && npx vitest run --config vitest.relay-contract.config.ts && npx tsc -p apps/relay`
Expected: 全部 PASS

- [ ] **Step 5: 提交**

```bash
git add apps/relay contract-tests
git commit -m "feat: add relay ASR channel with binary frame splicing"
```

---

### Task 9: HTTP 代答

**Files:**
- Create: `apps/relay/src/tunnel/http-proxy.ts`
- Modify: `apps/relay/src/app.ts`（注册三个白名单路由 + 原始 body 解析）、`apps/relay/src/routing/desktop-link.ts`（`http.response` 分发到 pending 表）
- Test: `apps/relay/test/http-proxy.test.ts`（单元，短超时）、`contract-tests/relay/http-tunnel.test.ts`（黑盒）

**Interfaces:**
- Consumes: `ConnectionRegistry`/`DesktopLink`、`authenticateBearer`、harness。
- Produces:
  - `HttpTunnel`：`request(desktop: DesktopLink, input: { deviceId: string; method: string; path: string; contentType?: string; body?: Buffer }): Promise<{ status: number; contentType?: string; body: Buffer }>`；内部 pending `Map<requestId, { resolve, timer }`；超时 reject `TunnelError('GATEWAY_TIMEOUT')`；桌面断开 reject 全部 pending `TunnelError('DESKTOP_OFFLINE')`；迟到/未知 requestId 的 `http.response` 丢弃并记元数据日志
  - 白名单路由（精确匹配）：`POST /v1/attachments`、`GET /v1/approvals/:approvalId/content`、`GET /v1/runs/:runId/prompt`；参数字符集 `[A-Za-z0-9_-]+`，不符 → 404 `ROUTE_NOT_FOUND`
  - 代理路由 body 以 Buffer 原样转发（fastify `addContentTypeParser('*', …)` 收集原始字节，bodyLimit = `httpBodyBytes`）；超限 413 `{ error: { code: 'BODY_TOO_LARGE', … } }`
  - 错误映射：缺 desktopId 400 `INVALID_REQUEST`；非本账号/不存在 404 `DESKTOP_NOT_FOUND`；离线 503 `DESKTOP_OFFLINE`；超时 504 `GATEWAY_TIMEOUT`；响应体超 12 MiB 502 `GATEWAY_ERROR`

- [ ] **Step 1: 写失败测试**

```ts
// contract-tests/relay/http-tunnel.test.ts —— 假桌面：收到 http.request 后按脚本回 http.response
it('契约 §5.4：POST attachments 代答，请求体/响应体逐字节一致', async () => {
  const body = randomBytes(1024 * 1024);
  const pending = fetch(`${baseUrl}/v1/attachments?desktopId=${desktopId}`, { method: 'POST', headers: { authorization: `Bearer ${phoneCred.deviceId}.${phoneCred.deviceToken}`, 'content-type': 'application/json' }, body });
  const req = await desktop.nextMessage();
  expect(req).toMatchObject({ type: 'http.request', payload: { method: 'POST', path: '/v1/attachments', deviceId: phoneCred.deviceId } });
  expect(Buffer.from(req.payload.bodyBase64, 'base64').equals(body)).toBe(true);
  desktop.send({ type: 'http.response', payload: { requestId: req.payload.requestId, status: 200, contentType: 'application/json', bodyBase64: Buffer.from('{"attachmentId":"att_1"}').toString('base64') } });
  const res = await pending;
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ attachmentId: 'att_1' });
});
it('GET 审批内容路径参数原样转发', async () => { /* path === '/v1/approvals/ap_1/content'，无 bodyBase64 */ });
it('白名单外路径 404 ROUTE_NOT_FOUND 且不产生 http.request', async () => { /* GET /v1/pairings；desktop.nextMessage 超时断言无消息 */ });
it('桌面离线 503；跨账号 desktopId 404（Review Focus 2）', async () => {});
it('超时 504 后迟到响应被丢弃（Review Focus 5）', async () => {
  // 单元层用 limits.httpTimeoutMs=50 触发；黑盒层发未知 requestId 的 http.response，断言桌面连接存活且后续代答正常
});
```

```ts
// apps/relay/test/http-proxy.test.ts
it('httpTimeoutMs=50：超时 reject GATEWAY_TIMEOUT；迟到 resolve 不抛错', async () => {});
it('桌面断开时全部 pending reject DESKTOP_OFFLINE', async () => {});
it('响应体超 httpBodyBytes → GATEWAY_ERROR', async () => {});
it('桌面入站单条消息超 desktopMessageBytes（覆盖为 1KiB）→ close 4003', async () => {});
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run --root apps/relay test/http-proxy.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现**

按 Interfaces；`http.request` 的 `path` 含原始路径（不含 query，desktopId 参数不透传）；`requestId` 前缀 `req_`。

- [ ] **Step 4: 运行确认通过**

Run: `npx vitest run --root apps/relay && npx vitest run --config vitest.relay-contract.config.ts && npx tsc -p apps/relay`
Expected: 全部 PASS

- [ ] **Step 5: 提交**

```bash
git add apps/relay contract-tests
git commit -m "feat: add relay HTTP tunneling with whitelist and timeouts"
```

---

### Task 10: 即时吊销/禁用、背压与验收收尾

**Files:**
- Modify: `apps/relay/src/app.ts`（`onRevoke`/`onAccountDisabled`/`onDeviceRevoked` 接线到 registry）、`apps/relay/src/main.ts`、`apps/relay/src/routing/registry.ts`（背压计数）、`apps/relay/src/routing/splice.ts`（超限关闭最慢通道）、`contract-tests/relay/README.md`（运行方式与跨语言验收说明）
- Test: `contract-tests/relay/revocation.test.ts`、`apps/relay/test/backpressure.test.ts`

**Interfaces:**
- Consumes: 前九个任务全部。
- Produces: 契约 §6/§7 完整生效：DELETE 设备、admin revoke/disable 立即以 4004 关闭存活连接与通道（吊销桌面连带其手机 4010）；§5.3 背压（每通道 2 MiB / 桌面总 8 MiB，超限关最慢通道 4003）。

- [ ] **Step 1: 写失败测试**

```ts
// contract-tests/relay/revocation.test.ts
it('契约 §3.4：DELETE 手机设备 → 其 control+asr 连接立即 4004，令牌失效', async () => {});
it('契约 §3.4：吊销桌面 → 桌面 4004、挂载手机 4010；吊销不中断后续新登录', async () => {});
it('契约 §7：admin disable-user → 该账号全部存活连接 4004，新登录 403', async () => {});
it('契约 §7：admin revoke-device 与 REST DELETE 效果一致', async () => {});

// apps/relay/test/backpressure.test.ts —— limits 覆盖 channelBufferBytes=64KiB, desktopBufferBytes=256KiB
it('桌面 socket 不读时持续灌帧 → 最慢通道 4003，其余通道存活', async () => {
  // 假桌面 ws 客户端 pause()；两条手机通道，一条灌帧超限；断言该通道 4003、另一条仍可往返
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run --config vitest.relay-contract.config.ts contract-tests/relay/revocation.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现**

splice 路径维护 `PhoneLink.pendingBytes`（桌面 socket `bufferedAmount` 高于阈值时累加，drain 后清零）；超 `channelBufferBytes` 或桌面总缓冲超 `desktopBufferBytes` 时关闭 pendingBytes 最大的通道 4003。registry 的 `closeDevice`/`closeAccount` 遍历两类连接。README：套件运行命令、`RELAY_BASE_URL`/`RELAY_DATA_DIR` 跨语言验收模式、admin 入口约定。

- [ ] **Step 4: 全量验证**

Run: `npx vitest run --root apps/relay --coverage && npx vitest run --config vitest.relay-contract.config.ts && npx tsc -p apps/relay`
Expected: 全部 PASS；coverage 四项 ≥80%；若不足，补分支测试后重跑

- [ ] **Step 5: 提交**

```bash
git add apps/relay contract-tests
git commit -m "feat: enforce live revocation and backpressure, complete relay contract suite"
```

---

## 验收（计划一完成的定义）

1. `npm run test:relay`、`npm run test:relay:contract`、`npx tsc -p apps/relay` 全绿；`npm run coverage:relay` 四项 ≥80%。
2. 黑盒套件覆盖契约 §10 清单：登录与限流、账号隔离、通道拼接保序、HTTP 代答与超时、手机/桌面取代、吊销即时生效、大小上限、版本协商、重启代次单调。
3. `contract-tests/relay` 不 import `apps/relay/src`（`grep -rn "apps/relay/src" contract-tests/` 仅命中 spawn 路径字符串）。
4. 手工冒烟：`node apps/relay/bin/claude-remote-relay.js serve` 起服务 → `admin create-user` → curl 登录 → curl `/v1/desktops` 返回 `[]`。