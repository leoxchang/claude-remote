# Relay Web 管理页 设计（short design）

日期：2026-11-24
状态：待批准

## 意图

relay 目前只能通过 `claude-remote-relay.js admin` CLI 管理账号与设备（走 unix socket）。本设计给 relay 增加一个自带的管理 web 页面：浏览器打开即可查看账号/设备、创建账号、禁用/启用、重置口令、吊销设备，方便云端部署后远程管理。

## 目标

- relay 自带管理页（单文件静态 HTML + 原生 JS，无构建步骤、无新依赖），由 relay 进程直接托管
- 管理 HTTP API 与 CLI 现有 7 个操作完全对齐（同一进程内逻辑，含吊销/禁用即时断开存活连接）
- 主从布局（浏览器线框图方案 B）：左侧账号列表，右侧选中账号详情 + 设备表
- 破坏性操作（吊销、禁用、重置口令）需二次确认
- 令牌鉴权：`RELAY_ADMIN_TOKEN` 环境变量注入；未设置时管理页与接口一律关闭（fail-closed），启动日志提示

## 非目标 / 反目标

- 不做在线状态展示（内存态，留待后续）
- 不做角色/多管理员/审计日志
- 不改动 `protocol/v1/relay-contract.md`（手机/电脑契约不变）；admin API 在本设计文档单独记录，不进契约
- 反目标：设备凭据（Bearer `<deviceId>.<deviceToken>`）不能访问任何 admin 接口；admin 令牌与设备凭据完全隔离

## 方案取舍

- **A. relay 内置接口 + 自带页面（已选）**：单一部署单元，复用进程内 store/断连逻辑，改动最小。代价：公网端口多一个令牌保护的管理面。
- B. 独立管理网关进程（读 unix socket）：relay 攻击面不变，但多一个部署单元，运维更重——否决。
- C. 仅 loopback 无鉴权：云端无法远程管理，与场景不符——否决。

## 设计

### 鉴权

- 启动时读 `RELAY_ADMIN_TOKEN`；未设置或长度 < 16 → 不注册 admin 路由，日志 warn
- 所有 admin 请求校验 `Authorization: Bearer <token>`，常量时间比较；失败返回 `{error:{code:'UNAUTHORIZED',...}}`（401）
- 令牌不写入任何日志；admin 接口走现有全局限流

### API（全部挂 `/admin/api` 下，页面本体挂 `/admin`）

| 方法 | 路径 | 作用 |
|---|---|---|
| GET | `/admin` | 管理页 HTML（设置令牌后浏览器存 localStorage） |
| GET | `/admin/api/accounts` | 账号列表（含 disabled） |
| POST | `/admin/api/accounts` | 创建账号 `{username, password}` |
| POST | `/admin/api/accounts/:username/disable` | 禁用并断开 |
| POST | `/admin/api/accounts/:username/enable` | 启用 |
| POST | `/admin/api/accounts/:username/reset-password` | `{password}` 重置 |
| GET | `/admin/api/accounts/:username/devices` | 账号下设备列表 |
| DELETE | `/admin/api/devices/:deviceId` | 吊销设备并断开 |

- 复用 `admin-socket.ts` 的 store 操作与 `onAccountDisabled` / `onDeviceRevoked` 回调（同一接线，不复制逻辑）
- 错误码沿用 CLI 语义：`ACCOUNT_NOT_FOUND` / `DEVICE_NOT_FOUND` / `USERNAME_TAKEN` 等

### 页面（布局 B）

- 单文件 `admin.html`（原生 JS + fetch，内联 CSS），`GET /admin` 返回；无 token 时页面只显示令牌输入框
- 左列账号（用户名、状态、设备数、禁用/启用、重置口令）；右侧选中账号详情 + 设备表（设备名/ID/平台 + 吊销）；顶部「创建账号」
- 所有写操作后刷新列表；失败显示接口错误码

## 留给实现者的

- 文件落点：`apps/relay/src/admin/admin-http.ts`（路由）+ `apps/relay/public/admin.html`（或内嵌字符串，实现者定）
- 测试：vitest 覆盖 fail-closed、令牌校验、每个 op 的成功/错误分支、断连回调触发；页面本身以服务端测试为准（HTML 可获取、无 JS 单测）
