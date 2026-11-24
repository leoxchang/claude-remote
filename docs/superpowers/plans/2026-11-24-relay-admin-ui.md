# Relay Web 管理页 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 给 relay 增加令牌鉴权的 admin HTTP API 与自带的管理 web 页面，浏览器可远程管理账号与设备。

**Architecture:** 提取 `admin-socket.ts` 的 `handleRequest` 为共享核心 `handleAdminRequest`，新增 `admin-http.ts` 注册 `/admin` 页面与 `/admin/api/*` 路由，`createRelayApp` 新增 `admin` 选项；页面为内嵌 HTML 字符串（`admin-page.ts`），无构建、无新依赖。

**Tech Stack:** TypeScript / Fastify / vitest；页面为单文件原生 JS + 内联 CSS。

**Spec:** `docs/superpowers/specs/2026-11-24-relay-admin-ui-design.md`

## Global Constraints

- 无新 npm 依赖；页面单文件原生 JS + 内联 CSS，无构建步骤
- 错误体统一 `{error:{code,message}}`，经 `sendError(reply, status, code)`（`src/http/send-error.ts`）
- admin 令牌与设备凭据完全隔离：设备 Bearer（`authenticateBearer`）不得访问 `/admin/api/*`
- `RELAY_ADMIN_TOKEN` 未设置或长度 < 16 → admin 路由不注册（fail-closed），启动日志 warn
- 常量时间令牌比较（`crypto.timingSafeEqual`，长度不同直接 401）
- 错误码→HTTP 映射：`INVALID_REQUEST→400`、`ACCOUNT_NOT_FOUND→404`、`DEVICE_NOT_FOUND→404`、`USERNAME_TAKEN→409`、其余→500 `INTERNAL_ERROR`
- 令牌不写入任何日志
- TS 规范：具名导出、禁 any、`===`、显式分号、导出函数标注参数与返回类型

## Review Focus

按「一个使用本软件的普通人会遇到什么」排序，每条已钉进所属任务的测试：

1. **令牌弱值**：`RELAY_ADMIN_TOKEN` 为 "short"（<16 字符）时管理面必须整体不存在——不是报错，是不注册；`adminTokenFromEnv` 测试钉住（Task 2）。
2. **设备凭据越权**：真实设备 Bearer 打 `/admin/api/accounts` 必须 401；测试钉住（Task 3）。
3. **破坏性操作误触**：吊销/禁用/重置是页面按钮；确认对话框用原生 `confirm()`，Task 5 页面走查人工核对。
4. **`result` 缺省**：`AdminResponse` 无 `result` 字段（如 `{ok:true}`）时 HTTP 层不得崩——200 体钉死为 `{ok:true}`；测试钉住（Task 4）。
5. **错误码漂移**：store 错误码未映射（如 `USERNAME_TAKEN` 非 409）会让页面显示退化成 500；每个 op 错误分支测试钉住（Task 4）。

---

### Task 1: 提取 `handleAdminRequest` 共享核心

**Files:**
- Modify: `apps/relay/src/admin/admin-socket.ts`
- Test: `apps/relay/test/admin.test.ts`

**Interfaces:**
- Consumes: `admin-socket.ts` 现有内部函数 `handleRequest(deps, line)`（JSON.parse + zod safeParse 后的 switch）
- Produces: `export interface AdminCoreDeps { store: RelayStore; onAccountDisabled?(accountId: string): void; onDeviceRevoked?(device: DeviceRecord): void; }` 与 `export function handleAdminRequest(deps: AdminCoreDeps, request: AdminRequest): AdminResponse`（`admin-socket.ts`）——现有 `AdminDeps` 改为 `AdminCoreDeps` 加 `dataDir: string` 扩展，switch 只用 store 与回调；Task 3/4 与本任务测试共用

- [ ] **Step 1: 写失败测试**

在 `apps/relay/test/admin.test.ts` 顶部 import 合并进现有导入；文件末尾追加 describe：

```ts
describe('handleAdminRequest 导出', () => {
  it('与 socket 入口行为一致（list-accounts）', () => {
    const store = openRelayStore({ fileName: ':memory:' });
    const deps: AdminCoreDeps = { store };
    const response = handleAdminRequest(deps, { op: 'list-accounts' });
    expect(response).toEqual({ ok: true, result: [] });
  });

  it('非法请求对象返回 INVALID_REQUEST', () => {
    const store = openRelayStore({ fileName: ':memory:' });
    const deps: AdminCoreDeps = { store };
    const response = handleAdminRequest(deps, { op: 'no-such-op' } as never);
    expect(response).toEqual({
      ok: false,
      error: { code: 'INVALID_REQUEST', message: 'INVALID_REQUEST' },
    });
  });
});
```

（`AdminCoreDeps` 只需 `{ store }`；若既有用例有公用 helper，直接用。）

- [ ] **Step 2: 运行确认失败**

Run: `npm run test:relay -- admin`
Expected: FAIL —— `handleAdminRequest` 未导出（导入/编译错误）

- [ ] **Step 3: 外科手术式重构**

把 `handleRequest(deps, line)` 拆成两层，行为不变：`handleRequest` 只保留「JSON.parse + `requestSchema.safeParse`」，解析失败返回 `failure('INVALID_REQUEST')`，解析成功调 `handleAdminRequest(deps, request)`；`handleAdminRequest` 收下已解析的 `AdminRequest`，原样搬入 switch（含未知 op 的 `return failure('INVALID_REQUEST')` 与 StoreError 捕获），加 `export`。

- [ ] **Step 4: 运行确认通过**

Run: `npm run test:relay -- admin`
Expected: PASS（含既有 socket 用例全绿）

- [ ] **Step 5: Commit**

```bash
git add apps/relay/src/admin/admin-socket.ts apps/relay/test/admin.test.ts
git commit -m "refactor: extract handleAdminRequest core from admin socket handler"
```

---

### Task 2: `createRelayApp` admin 选项 + fail-closed 注册 + 页面路由

**Files:**
- Modify: `apps/relay/src/app.ts`（`RelayAppOptions`、`createRelayApp`）
- Modify: `apps/relay/src/cli.ts`（读 `RELAY_ADMIN_TOKEN` + warn 日志）
- Create: `apps/relay/src/admin/admin-http.ts`
- Create: `apps/relay/src/admin/admin-page.ts`
- Test: `apps/relay/test/admin-http.test.ts`（新建）

**Interfaces:**
- Consumes: Task 1 的 `handleAdminRequest`（本任务尚未调用）
- Produces:
  - `export interface AdminHttpOptions { store: RelayStore; token: string; onAccountDisabled?(accountId: string): void; onDeviceRevoked?(device: DeviceRecord): void; }`（`admin-http.ts`）
  - `export function registerAdminRoutes(app: FastifyInstance, options: AdminHttpOptions): void`（`admin-http.ts`；本任务先只注册 `GET /admin`）
  - `export const ADMIN_PAGE_HTML: string`（`admin-page.ts`；本任务为占位 HTML，Task 5 补全）
  - `export function adminTokenFromEnv(value: string | undefined): string | undefined`（`admin-http.ts`）
  - `RelayAppOptions` 新增 `admin?: AdminHttpOptions`

- [ ] **Step 1: 写失败测试（adminTokenFromEnv）**

新建 `apps/relay/test/admin-http.test.ts`，先写：

```ts
import { describe, expect, it } from 'vitest';

import { adminTokenFromEnv } from '../src/admin/admin-http.js';

describe('adminTokenFromEnv', () => {
  it('未设置返回 undefined', () => {
    expect(adminTokenFromEnv(undefined)).toBeUndefined();
  });

  it('长度不足 16 返回 undefined', () => {
    expect(adminTokenFromEnv('short-token')).toBeUndefined();
  });

  it('长度恰 16 原样返回', () => {
    const token = 'a'.repeat(16);
    expect(adminTokenFromEnv(token)).toBe(token);
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npm run test:relay -- admin-http`
Expected: FAIL —— `admin-http.ts` 不存在

- [ ] **Step 3: 实现 `admin-http.ts` 骨架**

实现 `adminTokenFromEnv`（trim 后判长度）、`AdminHttpOptions`、`registerAdminRoutes`（先只注册 `GET /admin`：`reply.header('content-type', 'text/html; charset=utf-8').send(ADMIN_PAGE_HTML)`）、`admin-page.ts` 占位字符串（含 "Claude Remote 管理" 字样即可）。

- [ ] **Step 4: 运行确认通过**

Run: `npm run test:relay -- admin-http`
Expected: PASS

- [ ] **Step 5: 写失败测试（路由注册 + fail-closed）**

`admin-http.test.ts` 追加：

```ts
import { createRelayApp } from '../src/app.js';
import { openRelayStore } from '../src/storage/sqlite-store.js';

const TOKEN = 'admin-token-for-tests-0123456789';

async function buildApp(admin?: AdminHttpOptions): Promise<FastifyInstance> {
  const store = openRelayStore({ fileName: ':memory:' });
  return createRelayApp({ store, admin });
}

describe('admin 路由 fail-closed', () => {
  it('无 admin 选项时 GET /admin 404', async () => {
    const app = await buildApp(undefined);
    const res = await app.inject({ method: 'GET', url: '/admin' });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({
      error: { code: 'ROUTE_NOT_FOUND', message: 'ROUTE_NOT_FOUND' },
    });
  });

  it('有 admin 选项时 GET /admin 200 text/html', async () => {
    const app = await buildApp({ store: null as never, token: TOKEN });
    const res = await app.inject({ method: 'GET', url: '/admin' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/html');
    expect(res.body).toContain('Claude Remote 管理');
  });
});
```

（`buildApp` 里 store 以共享实例传入——用例按文件内实际组织调整；`null as never` 处改为真实 store 变量。）

- [ ] **Step 6: 运行确认失败**

Run: `npm run test:relay -- admin-http`
Expected: FAIL —— `createRelayApp` 不识别 `admin` 选项（`GET /admin` 404）

- [ ] **Step 7: 实现 app.ts 接线**

`RelayAppOptions` 加 `admin?: AdminHttpOptions`；`createRelayApp` 中 `if (options.admin) registerAdminRoutes(app, options.admin)`。占位页 store 未用到——`registerAdminRoutes` 签名收整个 options，store 暂存备用（Task 3 起使用）。

- [ ] **Step 8: 运行确认通过**

Run: `npm run test:relay -- admin-http`
Expected: PASS

- [ ] **Step 9: cli.ts 接线（无独立测试，smoke 验证）**

```ts
const adminToken = adminTokenFromEnv(process.env.RELAY_ADMIN_TOKEN);
if (adminToken === undefined) {
  logger.warn('RELAY_ADMIN_TOKEN 未设置或长度不足 16，管理页未启用');
}
```

`createRelayApp` 调用处传 `admin: adminToken === undefined ? undefined : { store, token: adminToken, onAccountDisabled: ..., onDeviceRevoked: ... }`（回调与 `startAdminSocket` 现有接线一致：`registry.closeAccount(accountId, CLOSE_REVOKED)` / `registry.closeDevice(device.deviceId, CLOSE_REVOKED)`）。

- [ ] **Step 10: smoke 验证**

```bash
RELAY_PORT=18799 RELAY_DATA_DIR=$(mktemp -d) RELAY_ADMIN_TOKEN=local-admin-token-0123456789 \
  node apps/relay/bin/claude-remote-relay.js serve
```

后台起（避开正在跑的开发 relay 8788），然后：
`curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:18799/admin` → `200`

- [ ] **Step 11: 全套件 + Commit**

Run: `npm run test:relay`
Expected: 全绿

```bash
git add apps/relay/src/admin/admin-http.ts apps/relay/src/admin/admin-page.ts \
  apps/relay/src/app.ts apps/relay/src/cli.ts apps/relay/test/admin-http.test.ts
git commit -m "feat: wire admin routes into relay app with fail-closed token gating"
```

---

### Task 3: Bearer 令牌校验 + GET /admin/api/accounts

**Files:**
- Modify: `apps/relay/src/admin/admin-http.ts`
- Test: `apps/relay/test/admin-http.test.ts`

**Interfaces:**
- Consumes: `registerAdminRoutes`（Task 2）、`handleAdminRequest`（Task 1）
- Produces: API 鉴权语义（401 UNAUTHORIZED）与 AdminResponse→HTTP 映射函数（内部实现即可）

- [ ] **Step 1: 写失败测试**

`admin-http.test.ts` 追加（`TOKEN`/`buildApp` 沿用 Task 2）：

```ts
describe('admin api 鉴权', () => {
  it('无 Authorization → 401 UNAUTHORIZED', async () => {
    const app = await buildApp(makeAdmin());
    const res = await app.inject({ method: 'GET', url: '/admin/api/accounts' });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({
      error: { code: 'UNAUTHORIZED', message: 'UNAUTHORIZED' },
    });
  });

  it('错误令牌 → 401 UNAUTHORIZED', async () => {
    const app = await buildApp(makeAdmin());
    const res = await app.inject({
      method: 'GET',
      url: '/admin/api/accounts',
      headers: { authorization: 'Bearer wrong-token-aaaaaaaaaaaa' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('设备凭据不得访问 admin api', async () => {
    const app = await buildApp(makeAdmin());
    // makeAdmin 的 store 里先造账号+设备：
    // store.createAccount('dev', 'dev-password-1') → createDevice({accountId, role:'phone', ...})
    // headers.authorization = `Bearer ${deviceId}.${deviceToken}`
    expect(res.statusCode).toBe(401);
  });

  it('正确令牌 → 200 {ok:true, result:[...]}', async () => {
    const app = await buildApp(makeAdmin());
    // 先 store.createAccount('dev', 'dev-password-1')
    const res = await app.inject({
      method: 'GET',
      url: '/admin/api/accounts',
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ok).toBe(true);
    expect(body.result).toHaveLength(1);
    expect(body.result[0].username).toBe('dev');
    expect(body.result[0]).not.toHaveProperty('passwordHash');
  });
});
```

（`makeAdmin()` helper：建 store + 返回 `AdminHttpOptions`，store 句柄留给造数。注释处实现者按既有 store API 补全调用。）

- [ ] **Step 2: 运行确认失败**

Run: `npm run test:relay -- admin-http`
Expected: FAIL —— `/admin/api/accounts` 404

- [ ] **Step 3: 实现**

- `assertAdminToken`（内部）：取 `request.headers.authorization`，scheme 大小写不敏感须为 `Bearer`，令牌部分用 `crypto.timingSafeEqual` 比较（长度不等直接 401）；失败 `sendError(reply, 401, 'UNAUTHORIZED')`
- GET `/admin/api/accounts`：鉴权通过后调 `handleAdminRequest(options, { op: 'list-accounts' })`，经共用映射函数转 HTTP——`{ok:true, result}` → 200 原样体；`{ok:true}`（无 result）→ 200 `{ok:true}`；`{ok:false, error:{code}}` → 按映射表 `sendError`。映射表以常量记录（400/404/404/409/500，见 Global Constraints）。
- 设备凭据越权用例无需特殊实现：admin 鉴权只认 admin 令牌，设备凭据天然 401。

- [ ] **Step 4: 运行确认通过**

Run: `npm run test:relay -- admin-http`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/relay/src/admin/admin-http.ts apps/relay/test/admin-http.test.ts
git commit -m "feat: admin api bearer auth and account listing"
```

---

### Task 4: 其余 6 个 op 路由 + 断连回调

**Files:**
- Modify: `apps/relay/src/admin/admin-http.ts`
- Test: `apps/relay/test/admin-http.test.ts`

**Interfaces:**
- Consumes: `handleAdminRequest`（Task 1）、Task 3 的鉴权与映射函数
- Produces: 完整 8 条路由；`onAccountDisabled`/`onDeviceRevoked` 经 `AdminHttpOptions` 传入并由测试用 spy 验证

- [ ] **Step 1: 写失败测试**

`admin-http.test.ts` 追加（`makeAdmin` 支持 `vi.fn()` 回调）：

- create-user：200，`body.result` 含 `accountId/username/disabled:false/createdAt`；重复用户名 → 409 `USERNAME_TAKEN`
- reset-password：成功 200 `{ok:true}`（无 result——钉住 Review Focus 4）；未知用户名 → 404 `ACCOUNT_NOT_FOUND`
- disable-user：200，`onAccountDisabled` 以该账号 accountId 被调一次
- enable-user：200，回调**不**被调
- revoke-device：`DELETE /admin/api/devices/:deviceId` 200，`onDeviceRevoked` 以 DeviceRecord 被调一次；未知 deviceId → 404 `DEVICE_NOT_FOUND`
- 非对象 body（如 JSON 数组）→ 400 `INVALID_REQUEST`

- [ ] **Step 2: 运行确认失败**

Run: `npm run test:relay -- admin-http`
Expected: FAIL —— 路由不存在（404）

- [ ] **Step 3: 实现**

- `POST /admin/api/accounts`、`POST /admin/api/accounts/:username/disable|enable|reset-password`、`GET /admin/api/accounts/:username/devices`、`DELETE /admin/api/devices/:deviceId`
- HTTP 层不做独立 zod：构造 `AdminRequest` 候选对象交给 `handleAdminRequest`（其内部 `requestSchema.safeParse` 是唯一校验点），返回 `INVALID_REQUEST` → 400；仅「body 非对象」（数组/字符串/null）在 HTTP 层直接 400
- 错误映射与断连回调复用 Task 3 函数；`AdminHttpOptions` 的回调在 `handleAdminRequest` 的 `AdminDeps` 形状下天然可用（`AdminHttpOptions` 即 `AdminDeps` 的 HTTP 子集：store + token + 两个可选回调）

- [ ] **Step 4: 运行确认通过**

Run: `npm run test:relay -- admin-http`
Expected: PASS

- [ ] **Step 5: 全套件 + Commit**

Run: `npm run test:relay`
Expected: 全绿

```bash
git add apps/relay/src/admin/admin-http.ts apps/relay/test/admin-http.test.ts
git commit -m "feat: remaining admin api operations and disconnect callbacks"
```

---

### Task 5: 完整管理页 + 端到端走查 + 收尾

**Files:**
- Modify: `apps/relay/src/admin/admin-page.ts`（替换占位字符串为完整页面）

**Interfaces:**
- Consumes: Task 3/4 的完整 API
- Produces: 布局 B 主从管理页（对照浏览器线框图：左列账号列表，右侧选中账号详情 + 设备表）

- [ ] **Step 1: 实现完整页面（admin-page.ts 内嵌 HTML 字符串）**

页面行为钉死：

- 未授权态：仅显示令牌输入框 + 「进入」按钮；令牌存 `localStorage`，fetch 带 `Authorization: Bearer <token>`
- 任意 API 返回 401 → 清除 localStorage 令牌并回到输入态
- 主从布局：左列账号列表（用户名、状态正常/已禁用、设备数需点选后加载、禁用/启用、重置口令按钮）；右侧选中账号详情 + 设备表（设备名、deviceId、平台、吊销按钮）；顶部「创建账号」（用户名 + 口令两个输入框）
- 所有写操作后刷新列表；失败显示接口返回的 `error.code`
- 破坏性操作（吊销、禁用、重置口令）先 `confirm()`，取消则不发请求
- 原生 JS + 内联 CSS，无外部资源引用（无 CDN、无字体、无图标库）

- [ ] **Step 2: 服务端测试（页面可达性）**

在 `admin-http.test.ts` 追加一条：

```ts
it('GET /admin 返回完整页面（含令牌输入与账号列表容器）', async () => {
  const app = await buildApp(makeAdmin());
  const res = await app.inject({ method: 'GET', url: '/admin' });
  expect(res.body).toContain('localStorage');
  expect(res.body).toContain('/admin/api/accounts');
});
```

先看它对占位页失败（RED），再替换为完整页面转绿（GREEN）。

- [ ] **Step 3: 端到端走查（agent-browser）**

后台起带令牌 relay（`RELAY_PORT=18799`、临时数据目录，避开开发 relay 8788），agent-browser 打开 `http://127.0.0.1:18799/admin`：

- 令牌输入 → 账号列表加载
- 创建账号 demo / demo-password-1 → 列表出现
- 禁用 → 状态变已禁用；启用 → 恢复
- 重置口令（confirm 后成功）
- 点选账号 → 设备表加载（可先用手机/电脑登录造一台设备，或断言空表）
- 吊销（confirm 后从列表消失）
- 401 路径：改坏 localStorage 令牌刷新 → 回输入态

- [ ] **Step 4: 全套件收尾**

```bash
npm run test:relay          # 全绿
npm run test:agent          # 733 全绿（agent 未动，回归确认）
npm run test:relay:contract # 33 全绿（契约不变）
git status --short          # 干净
```

- [ ] **Step 5: Commit**

```bash
git add apps/relay/src/admin/admin-page.ts apps/relay/test/admin-http.test.ts
git commit -m "feat: complete relay admin page with master-detail layout"
```

（若 Task 2 的 smoke relay 仍在跑，收尾时停掉；开发 relay 8788 保持运行。）
