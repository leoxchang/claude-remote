# App 端选择模型 设计

日期：2026-11-27
状态：待批准

## 意图

目前手机 App 无法选模型：每个会话实际用哪个模型，完全取决于 Mac 上 Claude Code 自己的默认设置（`settingSources` 里的 user/project/local）。用户想在不碰 Mac 的情况下，在 App 里为某个会话切换模型。

模型清单不写死在 App 里，而是由 Mac 端 Agent 从 SDK 拿到后传给 App；App 不选时，会话跟随 Mac 默认模型。

## 目标

- App 聊天页能看到当前会话用的模型，并能切换
- 模型选择的作用域是**会话**：切换后该会话后续 run 都用它，其他会话不受影响
- 模型清单由 Mac 端动态提供（`supportedModels()`），按 workspace 取，App 不硬编码
- 选择持久化在 Agent 的会话记录里，Agent 重启后保留；同一会话的其他设备能同步看到
- 可选"默认（跟随 Mac）"：`model = null` 时不向 SDK 传 `model`，沿用 Mac 的默认模型

## 非目标 / 反目标

- 不做按消息选择（已被否决：模型是会话属性）
- 不做 effort / fast mode / thinking 等其他模型参数
- 不在时间线上展示"这条回答用了哪个模型"（`run.started` 不新增 `model`）
- 不改 relay（消息原样透传）
- 不做 App 全局默认模型（只做会话级）
- 反目标：App 不得内置模型 ID 列表；也不得绕过 workspace 的 `availableModels` 限制

## 方案取舍

- **A. 会话存模型字段 + 新增 `models.list` / `session.set-model` 两个命令（已选）**：语义干净，不发消息也能切；多设备通过 `session.status` 同步；代价是协议加两个命令、Agent 加一次迁移。
- B. 模型挂在 `prompt.send` 上，Agent 记住最后一次：少一条命令，但选模型必须绑着发一条消息，且其他设备要等下一次 run 才知道模型变了——否决。

模型目录的传输方式也定了：走新的 `models.list` 命令按 workspace 懒请求，不用 `connection.ready` 携带。原因：SDK 的模型清单受该工作目录的 `availableModels` 收窄，不是全局一份；握手刻意保持"只交换版本与展示能力"。

## 约束

- 协议 v1 向后兼容：新增命令类型对旧 Agent 是未知类型。新 App 连旧 Agent 时，`models.list` / `session.set-model` 会得到 `UNKNOWN_MESSAGE_TYPE`，App 需提示"请升级 Mac 端"。
- 旧 App 连新 Agent 不受影响：新字段是可选的，旧 App 忽略。
- 会话模型只影响**后续 run**；正在跑或已排队的 run 不变。排队中的 run 在真正启动时读取当时会话的模型。
- `models.list` 可能每次启动一个短生命周期 SDK 进程，需缓存（见下）。

## 设计

### 协议（`protocol/v1`）

新增两个命令：

- `models.list`
  - payload：`{ workspaceId }`
  - `command.result.data`：`{ models: [{ value, displayName, description, resolvedModel? }] }`
  - `value` 为 SDK 的别名或完整 ID，Agent 原样透传，不做枚举校验以外的改写
- `session.set-model`
  - envelope 带 `sessionId`
  - payload：`{ model: string | null }`，`null` = 跟随 Mac 默认
  - `command.result.data`：更新后的 `SessionSummary`（与 `session.rename` 返回同形）

`session.status` 事件的 payload 新增可选 `model`（`string | null`），模型变更时广播。

广播的 payload 必须如实反映会话当前状态，不能照搬 `renameSession` 的硬编码 `state: 'idle'`（那会在 run 运行中切模型时把其他设备误降级为 idle）。写法对齐调度器的广播：同时带 `state`、`status`（派生状态，见 `computeSessionStatus`，可为 `queued`）以及 `model`；`state` 只取 schema 枚举兼容值——排队或空闲时为 `idle`，运行中为 `running`，等审批为 `waiting_approval`。App 端的 reducer 优先读 `status`，所以 `queued` 等枚举外状态不会丢。

`session.list` / `session.snapshot` 返回的会话摘要增加 `model` 字段。

错误沿用既有码：`WORKSPACE_NOT_FOUND`、`SESSION_NOT_FOUND`、`SESSION_ARCHIVED`、`INVALID_MESSAGE`（模型值不在当前 workspace 的目录内）。

### Agent

**存储**
- 新迁移 `apps/agent/src/storage/migrations/002_session_model.sql`：`ALTER TABLE sessions ADD COLUMN model TEXT NULL`
- `StoredSession` / `SessionRecord` 增加 `model: string | null`
- `SessionRepository` 的读、写、建表 SQL 都带上 `model`
- `SessionSummary` 增加 `model`

**操作层**（durable 与 legacy 两条实现都要有，legacy 只存内存）
- `listModels(workspaceId): Promise<ModelCatalog>`
  - 校验 workspace 存在 → 取 `rootPath` → 调 `ModelCatalogService`
  - 目录获取失败 → `INTERNAL_ERROR`，`retryable: true`
- `setSessionModel(sessionId, model): Promise<SessionSummary>`
  - 允许在 run 运行中或排队时切换（只影响后续 run，见约束）
  - 归档会话 → `SESSION_ARCHIVED`
  - 非 `null` 时校验值存在于该会话所属 workspace 的目录（目录缺失时先取一次），否则 `INVALID_MESSAGE`
  - 目录获取失败（SDK 起不来、登录过期等）→ `INTERNAL_ERROR`，`retryable: true`；不把这种情况报成 `INVALID_MESSAGE`
  - 写会话记录 + journal commit + append `session.status`，payload 带 `model`、`title`、`state`、`status`（见协议节）
- `createSession` 初始化 `model = null`
- `DurableRunScheduler.startOne` 组装 `ManagedRunStart` 时带上 `model: context.session.model`

**SDK 边界**
- `ManagedRunStart` 增加 `model: string | null`
- `AgentSdkAdapter.startRun`：仅当 `model !== null` 时设置 `Options.model`；若该值已不在当前目录（workspace 设置改了），不做静默回退，照常传下去，由 SDK 失败经既有 `run.completed: failed` 暴露，用户在 App 里换一个模型即可恢复
- 把 `startRun` 里的 `Options` 组装抽成共享函数（`cwd`、`settingSources: ['user','project','local']`、`permissionMode: 'default'`、preset system prompt/tools 等），run 与目录查询都用它——目录查询必须带同样的 setting sources，否则拿到的清单不会被该目录的 `availableModels` 收窄，等于绕过了限制
- 新增 `ModelCatalogService`（接口可注入，测试用假实现）：
  - 实现方式：用 `query()` 配一个永不 yield 的 `AsyncIterable` 和同一套 Options 启动会话、拿到 `supportedModels()` 后立即 `close()`，不发起任何模型调用
  - 缓存：按 `cwd` 缓存，TTL 10 分钟（本项目决定；目录随 workspace 设置变化，重启或过期后刷新）
  - 映射为 `{ value, displayName, description, resolvedModel? }`；SDK 若返回 `value === 'default'` 的行则丢弃，由 App 自己的"默认（跟随 Mac）"行代表它

**路由**
- `apps/agent/src/command/router.ts`：命令白名单加两个类型并分发；`session.set-model` 必须有 `sessionId`

### App（Flutter）

**数据**
- `SessionSummary` 增加 `model`（`fromWire` 解析，缺失即 `null`）
- `SessionState` 增加 `model`，在 `session.status` reducer 中更新；`session.list` 刷新时以摘要为准
- `S02Commands` 增加 `modelsList(workspaceId)` 与 `sessionSetModel(sessionId, model)` 两个构造器
- 新增 `ModelOption`（value/displayName/description）与目录缓存（内存内按 workspace，一次会话内有效）

**界面**
- 聊天页 AppBar 右侧加一个模型 chip：`model === null` 显示"默认"；非空时若目录里有对应行则显示 `displayName`，否则原样显示 `model` 值；归档会话只显示、不可点
- 点 chip 打开底部选择面板：第一项"默认（跟随 Mac）"，其余为目录行（显示 `displayName` + `description`）
- 选择后发送 `session.set-model`；以命令返回的摘要和随后的 `session.status` 更新界面；失败在页面上给出错误
- 目录在**进入聊天页时**请求一次 `models.list`，缓存在 App 进程内按 workspace 复用；面板直接用缓存，不每次打开都请求。失败时 chip 仍可用（显示原始值），但面板提示"模型清单获取失败"并允许重试；`UNKNOWN_MESSAGE_TYPE` 提示升级 Mac 端

## 测试要点

- 协议：新增两个命令与 `session.status.model` 的 schema 校验（合法/非法样例）
- Agent：迁移升级旧库；`setSessionModel` 的持久化、广播、归档拒绝、非法值拒绝；运行中切模型的广播不会把其他设备降级为 idle；目录缓存命中与过期；目录失败返回 `INTERNAL_ERROR`；`startOne` 把 `model` 传进 `ManagedRunStart`；adapter 在 `null` 时不设置 `Options.model`、非 `null` 时设置；目录查询的 Options 与 run 共用同一组装（含 `settingSources`）
- App：`session.status` 带 model 的 reducer；两条命令的构造与结果解码；chip 在有/无目录时的显示；选择面板交互；`UNKNOWN_MESSAGE_TYPE` 与目录失败的提示
- 混合版本：新 App + 旧 Agent 的错误路径

## 留给实现者

- 目录服务在真实 SDK 上验证"永不 yield 的流 + `supportedModels()`"确实可用（必要时做一次短 spike）；若不可用，退回方案：用一个极短的内部 prompt 初始化（不产生用户可见内容）
- 底部面板的具体视觉与动画
- 会话列表是否显示模型徽标（本设计不做，除非实现时发现很自然）
- 缓存 TTL 与刷新策略的微调
