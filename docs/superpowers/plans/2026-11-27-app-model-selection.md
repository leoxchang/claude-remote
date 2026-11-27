# App 端选择模型 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让手机 App 能按会话查看并切换 Claude 模型；清单由 Mac 端 Agent 动态提供，未选择时沿用 Mac 默认模型。

**Architecture:** 新增 `models.list` 与 `session.set-model` 两个协议命令；模型值持久化在 Agent 的 `sessions` 表并随 `session.status` 广播；Agent 起 run 时把会话的模型透传进 SDK `Options.model`；App 在聊天页顶部显示模型 chip 并提供选择面板。

**Tech Stack:** TypeScript + Node（Agent，vitest）、JSON Schema（`protocol/v1`）、Flutter + Riverpod（App）。

**Spec:** `docs/superpowers/specs/2026-11-27-app-model-selection-design.md`

## Global Constraints

- 协议 v1 只做向后兼容扩展：新增命令与可选字段，不改已有命令的必填语义。
- App 不得内置模型清单；清单只能来自 `models.list`。
- 模型作用域是会话；切换只影响后续 run，排队中的 run 在真正启动时读取当时的值。
- `model === null` 表示跟随 Mac 默认：不向 SDK 传 `Options.model`。
- 目录缓存按 `cwd` 隔离，TTL 10 分钟。
- 目录获取失败 = `INTERNAL_ERROR`（`retryable: true`）；未知/非法模型值 = `INVALID_MESSAGE`；归档会话 = `SESSION_ARCHIVED`。
- 不改 relay。
- 提交信息格式 `<type>: <description>`，type ∈ feat/fix/refactor/docs/test/chore/perf/ci。
- 遵守仓库语言规范：TS 具名导出、禁止 `any`；Dart 显式类型、不用 `forEach`。

## Review Focus

1. **运行中/排队时改模型**：`session.status` 广播必须同时带 `status`（真实派生状态）与 schema 兼容的 `state`，其他设备不得被降级为 idle。
2. **新 App + 旧 Agent**：两个新命令会得到 `UNKNOWN_MESSAGE_TYPE`，App 必须给出"请升级 Mac 端"的可见提示。
3. **目录按 workspace 隔离**：不同 `cwd` 的 `availableModels` 不同，缓存不得串用。
4. **归档会话**：Agent 返回 `SESSION_ARCHIVED`；App 的 chip 只读不可点。
5. **模型值失效 / 目录取不到**：目录失败报 `INTERNAL_ERROR`；已失效的模型不静默回退，run 失败要可见。

---

### Task 1: 协议契约

**Files:**
- Modify: `protocol/v1/examples/valid.json`
- Modify: `protocol/v1/examples/invalid.json`
- Modify: `protocol/v1/commands.schema.json`
- Modify: `protocol/v1/events.schema.json`
- Modify: `protocol/v1/src/validator.ts`
- Test: `protocol/v1/tests/core.test.ts`（既有，遍历 examples）

**Interfaces:**
- Consumes: 无
- Produces:
  - 命令 `models.list`：payload `{ workspaceId: string }`
  - 命令 `session.set-model`：envelope 带 `sessionId`，payload `{ model: string | null }`
  - `session.status` payload 可选 `model: string | null`
  - `session.snapshot` 的 `session` 对象可选 `model: string | null`

- [ ] **Step 1: 先加样例，确认现有校验会拒绝**

在 `protocol/v1/examples/valid.json` 追加两项（`timestamp` 用相邻示例的同一量级）：

```json
{
  "name": "models.list",
  "message": {
    "protocolVersion": 1,
    "messageId": "msg_models_list",
    "commandId": "cmd_models_list",
    "traceId": "trace_models_list",
    "sourceDeviceId": "device_phone_01",
    "timestamp": 1762432800019,
    "type": "models.list",
    "payload": { "workspaceId": "ws_default" }
  }
},
{
  "name": "session.set-model",
  "message": {
    "protocolVersion": 1,
    "messageId": "msg_set_model",
    "commandId": "cmd_set_model",
    "traceId": "trace_set_model",
    "sourceDeviceId": "device_phone_01",
    "sessionId": "session_01",
    "timestamp": 1762432800020,
    "type": "session.set-model",
    "payload": { "model": "opus" }
  }
}
```

同时把既有 `session.status` 样例的 payload 加上 `"model": null`；在 `invalid.json` 追加一项：

```json
{
  "name": "session.set-model.model-number",
  "reason": "model 必须是字符串或 null",
  "expectedKeyword": "type",
  "message": {
    "protocolVersion": 1,
    "messageId": "msg_set_model_bad",
    "commandId": "cmd_set_model_bad",
    "traceId": "trace_set_model_bad",
    "sourceDeviceId": "device_phone_01",
    "sessionId": "session_01",
    "timestamp": 1762432800021,
    "type": "session.set-model",
    "payload": { "model": 42 }
  }
}
```

- [ ] **Step 2: 运行，确认失败**

Run: `npx vitest run protocol/v1/tests/core.test.ts`
Expected: FAIL —— 两个新命令被当成 `UNKNOWN_MESSAGE_TYPE` 拒绝。

- [ ] **Step 3: 补 schema 与校验表**

- `commands.schema.json` 的 `$defs` 增加 `models.list`（payload 必填 `workspaceId`，`minLength: 1`）与 `session.set-model`（必填 `sessionId`（envelope 层）与 payload 的 `model`，`"type": ["string", "null"]`、`"minLength": 1`）。
- `events.schema.json` 的 `session.status` payload 增加可选 `model`（同上类型）；`session.snapshot` 的 `session` 对象增加可选 `model`（同上）。
- `src/validator.ts` 的 `MESSAGE_TYPE_REFS` 增加两条：`models.list` → `#/$defs/models.list`，`session.set-model` → `#/$defs/session.set-model`。

- [ ] **Step 4: 运行，确认通过**

Run: `npx vitest run protocol/v1/tests/core.test.ts`
Expected: PASS（含新增合法/非法样例）。

- [ ] **Step 5: 提交**

```bash
git add protocol/v1
git commit -m "feat: add model selection protocol commands"
```

---

### Task 2: Agent 存储与会话摘要携带 model

**Files:**
- Create: `apps/agent/src/storage/migrations/002_session_model.sql`
- Modify: `apps/agent/src/storage/database.ts`
- Modify: `apps/agent/src/storage/repositories/session-repository.ts`
- Modify: `apps/agent/src/domain/types.ts`
- Modify: `apps/agent/src/session/session-registry.ts`
- Modify: `apps/agent/src/session/session-summary.ts`
- Modify: `apps/agent/src/sync/snapshot-service.ts`
- Modify: `apps/agent/src/app/durable-agent-operations.ts`（`summary()`）
- Test: `apps/agent/test/storage/session-model-storage.test.ts`（新建）
- Test: `apps/agent/test/storage/schema.test.ts`（版本号改为 2）

**Interfaces:**
- Consumes: Task 1 的 wire 字段名 `model`
- Produces:
  - `StoredSession.model?: string | null`、`SessionRecord.model?: string | null`
  - `SessionSummary.model: string | null`
  - `sessions` 表新增可空列 `model`

- [ ] **Step 1: 写失败测试**

新建 `apps/agent/test/storage/session-model-storage.test.ts`，覆盖：

```ts
it('creates the model column and schema version 2 on a fresh database', ...)
// 断言 PRAGMA table_info(sessions) 含 model；user_version === 2

it('upgrades a version 1 database in place', ...)
// 用 better-sqlite3 裸建库：exec migrations/001_initial.sql，设置 user_version = 1，
// 关闭后用 AgentDatabase.open 重新打开；断言出现 model 列且 user_version === 2

it('round-trips the session model through SessionRepository', ...)
// create({..., model: null}) → update({...model: 'opus'}) → get()?.model === 'opus'

it('exposes the model in SessionSummary', ...)
// toSessionSummary(record).model === 'opus'
```

同时把 `schema.test.ts` 中期望的 `user_version` 与 `schema_meta.schemaVersion` 由 `1` 改为 `2`。

- [ ] **Step 2: 运行，确认失败**

Run: `npx vitest run --root apps/agent test/storage/session-model-storage.test.ts test/storage/schema.test.ts`
Expected: FAIL —— 列不存在、版本仍是 1、类型缺字段。

- [ ] **Step 3: 改迁移链与持久化**

- `002_session_model.sql`：`ALTER TABLE sessions ADD COLUMN model TEXT;`
- `database.ts`：把单一 `SCHEMA_PATH` 换成 `MIGRATIONS: { version: number; url: URL }[]`（001、002），`SCHEMA_VERSION = 2`；`migrate()` 按 `user_version` 顺序应用未执行的迁移，每条迁移后把 `schema_meta.schemaVersion` 更新为当前版本——用幂等 UPSERT（`INSERT ... ON CONFLICT(id) DO UPDATE`，`migrationState` 保持 `absent`、`desktopId` 保持 NULL），这样新库与从 v1 升级的库都能正确落行。
- `session-repository.ts`：`StoredSession` 增加 `model?: string | null`；`SELECT/INSERT/UPDATE` 都带上 `model`（写入 `record.model ?? null`，读取 `model: row.model ?? null`）。
- `domain/types.ts`：`SessionRecord` 增加 `model?: string | null`；`session-registry.ts` 的 `create` 设 `model: null`。
- `session-summary.ts`：`SessionSummary.model: string | null`，`toSessionSummary` 返回 `record.model ?? null`。
- `durable-agent-operations.ts` 的 `summary()` 返回 `model: session.model ?? null`。
- `snapshot-service.ts` 的 `session:` 对象加 `model: session.model ?? null`。

- [ ] **Step 4: 运行，确认通过**

Run: `npx vitest run --root apps/agent test/storage/session-model-storage.test.ts test/storage/schema.test.ts`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add apps/agent
git commit -m "feat: persist session model in agent storage"
```

---

### Task 3: SDK 模型目录服务与 adapter 透传

**Files:**
- Create: `apps/agent/src/model/model-catalog.ts`
- Create: `apps/agent/src/model/sdk-model-catalog.ts`
- Create: `apps/agent/src/adapter/query-options.ts`
- Modify: `apps/agent/src/adapter/managed-run-driver.ts`
- Modify: `apps/agent/src/adapter/agent-sdk-adapter.ts`
- Test: `apps/agent/test/model/sdk-model-catalog.test.ts`（新建）
- Test: `apps/agent/test/agent-sdk-adapter.test.ts`（追加用例）

**Interfaces:**
- Consumes: 无
- Produces:
  - `ModelOption { value: string; displayName: string; description: string; resolvedModel?: string }`
  - `ModelCatalogService { list(cwd: string): Promise<ModelOption[]> }`
  - `SdkModelCatalog`：`new SdkModelCatalog({ queryFactory?, now?, ttlMs? })`，默认 `ttlMs = 10 * 60 * 1000`
  - `ModelQueryHandle { supportedModels(): Promise<ModelOption[]>; close(): void }`、`ModelQueryFactory = (cwd: string) => ModelQueryHandle`
  - `baseQueryOptions(cwd: string): Options`（`settingSources: ['user','project','local']`、`permissionMode: 'default'`、`systemPrompt`/`tools` preset）
  - `ManagedRunStart.model?: string`

- [ ] **Step 1: 写目录服务失败测试**

`apps/agent/test/model/sdk-model-catalog.test.ts`：

```ts
it('drops the default row and keeps the SDK rows', ...)
// fake factory 返回 [{value:'default',...},{value:'opus',displayName:'Opus',...}]
// list(cwd) 结果为 [{value:'opus',...}]，且 handle.close() 被调用一次

it('caches per cwd', ...)
// 同一 cwd 调两次，factory 只被调用一次

it('keeps different cwds isolated', ...)
// list('/ws/a') 与 list('/ws/b') 各自命中不同 factory 调用，结果不串

it('refetches after the ttl', ...)
// now 注入：ttl 后再调 list，factory 被再次调用

it('propagates factory failures', ...)
// factory 抛错时 list 拒绝（错误交由操作层映射）
```

- [ ] **Step 2: 写 adapter 失败测试**

在 `agent-sdk-adapter.test.ts` 的 `adapterWith(...)` 基础上追加：

```ts
it('passes model to the SDK options only when set', ...)
// input.model = 'opus' → calls[0].options.model === 'opus'
// 另一例不传 model → expect('model' in calls[0].options).toBe(false)
```

- [ ] **Step 3: 运行，确认失败**

Run: `npx vitest run --root apps/agent test/model/sdk-model-catalog.test.ts test/agent-sdk-adapter.test.ts`
Expected: FAIL（模块/字段不存在）。

- [ ] **Step 4: 实现**

- `model-catalog.ts`：上面的两个类型 + 接口。
- `sdk-model-catalog.ts`：
  - 内部 `Map<string, { at: number; models: ModelOption[] }>`。
  - `list(cwd)`：命中且未过期直接返回；否则 `const handle = factory(cwd)`，`await handle.supportedModels()`，过滤 `value === 'default'`，只保留 `value/displayName/description/resolvedModel`，`handle.close()`，写缓存。
  - 默认 `queryFactory`：`query({ prompt: idleInput(), options: baseQueryOptions(cwd) })`；`idleInput()` 是一个永不 resolve、永不 yield 的 `AsyncGenerator<SDKUserMessage>`。2026-11-27 已实测该方式能在不发送任何 prompt 的情况下返回清单。
- `query-options.ts`：从 `AgentSdkAdapter.startRun` 抽出静态 options（`cwd`、`permissionMode: 'default'`、`settingSources`、`systemPrompt`、`tools`），adapter 在此之上追加 `persistSession`、`includePartialMessages`、`canUseTool`、`resume`。
- `managed-run-driver.ts`：`ManagedRunStart.model?: string`。
- `agent-sdk-adapter.ts`：`...(input.model === undefined ? {} : { model: input.model })`。

- [ ] **Step 5: 运行，确认通过**

Run: `npx vitest run --root apps/agent test/model/sdk-model-catalog.test.ts test/agent-sdk-adapter.test.ts`
Expected: PASS。

- [ ] **Step 6: 提交**

```bash
git add apps/agent
git commit -m "feat: add sdk model catalog service and model option passthrough"
```

---

### Task 4: 操作层与命令路由

**Files:**
- Modify: `apps/agent/src/app/agent-operations.ts`
- Modify: `apps/agent/src/app/durable-agent-operations.ts`
- Modify: `apps/agent/src/app/wire.ts`
- Modify: `apps/agent/src/app/durable-wire.ts`
- Modify: `apps/agent/src/command/router.ts`
- Modify: `apps/agent/test/protocol-s03.test.ts`（`StubOperations` 补齐新方法）
- Test: `apps/agent/test/session-model-operations.test.ts`（新建）
- Test: `apps/agent/test/command-router.test.ts`（追加用例）

**Interfaces:**
- Consumes: Task 2 的 `StoredSession.model`、`SessionSummary.model`；Task 3 的 `ModelCatalogService` / `SdkModelCatalog`
- Produces:
  - `AgentOperations.listModels(workspaceId: string): Promise<ModelOption[]>`
  - `AgentOperations.setSessionModel(sessionId: string, model: string | null): Promise<SessionSummary>`
  - 两个依赖对象新增 `models: ModelCatalogService`
  - 路由返回形状：`models.list` → `{ models: ModelOption[] }`；`session.set-model` → `SessionSummary`

- [ ] **Step 1: 写操作层失败测试**

`apps/agent/test/session-model-operations.test.ts`：用真实 `AgentDatabase` + `SessionRepository` + `DurableEventJournal`，其余依赖用最小 stub（`{} as unknown as ...`），构造 `DurableAgentOperations`，`models` 注入假目录服务。覆盖：

```ts
it('persists the model and returns it in the summary', ...)
it('broadcasts a truthful status while a run is active', ...)
// 会话 status 为 'running' 时 setSessionModel('opus')：
// 最后一条 session.status payload 为 { state: 'running', status: 'running', title, model: 'opus' }
it('rejects archived sessions with SESSION_ARCHIVED', ...)
it('rejects values outside the catalog with INVALID_MESSAGE', ...)
it('maps catalog failures to retryable INTERNAL_ERROR', ...)
// 假目录服务抛普通 Error → AgentError code 'INTERNAL_ERROR'、retryable true
it('lists models for a workspace and rejects unknown workspaces', ...)
```

- [ ] **Step 2: 写路由失败测试**

在 `command-router.test.ts` 追加：以假 `AgentOperations`（在 `operations` 对象上补 `listModels`/`setSessionModel`）：

```ts
it('routes models.list and returns the catalog', ...)
// payload {workspaceId:'default'} → result.data.models 为假目录
it('rejects session.set-model without a sessionId', ...)
// 返回 error.code === 'SESSION_NOT_FOUND'
it('passes model null through session.set-model', ...)
```

- [ ] **Step 3: 运行，确认失败**

Run: `npx vitest run --root apps/agent test/session-model-operations.test.ts test/command-router.test.ts`
Expected: FAIL。

- [ ] **Step 4: 实现操作层**

在 `agent-operations.ts` 的接口与 `AgentOperationsDependencies` 增加上述两个方法与 `models` 依赖；`AgentOperationsImpl` 实现：

```ts
async listModels(workspaceId): Promise<ModelOption[]> {
  const workspace = this.deps.workspaces.assertUsable(workspaceId);
  return this.catalog(workspace.rootPath);
}

async setSessionModel(sessionId, model): Promise<SessionSummary> {
  const record = this.deps.sessions.get(sessionId); // 未知抛 SESSION_NOT_FOUND
  if (record.lifecycle === 'archived') throw new AgentError('SESSION_ARCHIVED');
  const workspace = this.deps.workspaces.assertUsable(record.workspaceId);
  if (model !== null) {
    const catalog = await this.catalog(workspace.rootPath);
    if (!catalog.some((entry) => entry.value === model)) throw new AgentError('INVALID_MESSAGE');
  }
  const updated = this.deps.sessions.update(sessionId, (current) => ({ ...current, model }));
  return toSessionSummary(updated);
}
```

`catalog(cwd)` 私有方法：`try { return await this.deps.models.list(cwd) } catch (error) { throw new AgentError('INTERNAL_ERROR', 'INTERNAL_ERROR', true); }`（`AgentError` 原样重抛）。

`DurableAgentOperations` 同形：`requireSession`、`this.deps.sessions.update({...session, model})`，并在 `journal.commit` 中 `append({ sessionId, type: 'session.status', payload: { state, status: session.status, title: session.title, model } })`；`state` 映射：`waiting_approval` → `'waiting_approval'`，`running` → `'running'`，其余 → `'idle'`。

`wire.ts` / `durable-wire.ts` 构造 `new SdkModelCatalog()` 并传入 `models`。

- [ ] **Step 5: 实现路由**

`COMMAND_TYPES` 增加 `'models.list'`、`'session.set-model'`；`dispatch` 增加两个 case：

```ts
case 'models.list': {
  const workspaceId = requirePayloadString(command.payload, 'workspaceId');
  return ok({ models: await this.operations.listModels(workspaceId) });
}
case 'session.set-model': {
  const sessionId = requireString(command.sessionId, 'SESSION_NOT_FOUND');
  const model = readModelValue(command.payload); // 缺失/非法 → INVALID_MESSAGE；null 原样返回
  return ok(await this.operations.setSessionModel(sessionId, model));
}
```

`StubOperations`（`protocol-s03.test.ts`）补上两个方法：`listModels` 返回 `[]`，`setSessionModel` 抛 `SESSION_NOT_FOUND` 或返回最小摘要（取测试中已有会话即可）。

- [ ] **Step 6: 运行，确认通过**

Run: `npx vitest run --root apps/agent test/session-model-operations.test.ts test/command-router.test.ts test/protocol-s03.test.ts`
Expected: PASS。

- [ ] **Step 7: 提交**

```bash
git add apps/agent
git commit -m "feat: add model listing and session model commands"
```

---

### Task 5: run 启动时透传会话模型

**Files:**
- Modify: `apps/agent/src/run/durable-run-scheduler.ts`
- Modify: `apps/agent/src/run/run-scheduler.ts`
- Test: `apps/agent/test/storage/durable-scheduler.test.ts`（追加用例）
- Test: `apps/agent/test/run-scheduler-s03.test.ts`（若该文件构造 legacy 调度器，追加同形用例；没有则跳过本项）

**Interfaces:**
- Consumes: `ManagedRunStart.model?: string`（Task 3）、`StoredSession.model` / `SessionRecord.model`（Task 2）
- Produces: 无新接口

- [ ] **Step 1: 写失败测试**

在 `durable-scheduler.test.ts` 追加：

```ts
it('passes the session model to the driver', () => {
  const context = setup();
  try {
    const session = context.sessions.get('s1')!;
    context.sessions.update({ ...session, model: 'opus' });
    context.insertQueued('s1');
    context.scheduler.drain();
    expect(context.driver.starts[0]?.model).toBe('opus');
  } finally { context.db.close(); }
});

it('passes a stale model value through unchanged', () => {
  const context = setup();
  try {
    const session = context.sessions.get('s1')!;
    context.sessions.update({ ...session, model: 'model-not-in-catalog' });
    context.insertQueued('s1');
    context.scheduler.drain();
    expect(context.driver.starts[0]?.model).toBe('model-not-in-catalog');
  } finally { context.db.close(); }
});
```

- [ ] **Step 2: 运行，确认失败**

Run: `npx vitest run --root apps/agent test/storage/durable-scheduler.test.ts`
Expected: FAIL（`starts[0].model` 为 undefined）。

- [ ] **Step 3: 实现**

- `durable-run-scheduler.ts` 的 `startRun({...})` 加 `...(context.session.model == null ? {} : { model: context.session.model })`。
- `run-scheduler.ts` 的 `startRun({...})` 用同样的写法读取 legacy 会话的 `model`。

- [ ] **Step 4: 运行，确认通过**

Run: `npx vitest run --root apps/agent test/storage/durable-scheduler.test.ts`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add apps/agent
git commit -m "feat: start runs with the session model"
```

---

### Task 6: App 协议、领域模型与 reducer

**Files:**
- Create: `apps/mobile/lib/domain/model_option.dart`
- Modify: `apps/mobile/lib/protocol/s02_messages.dart`
- Modify: `apps/mobile/lib/domain/session.dart`
- Modify: `apps/mobile/lib/domain/session_state.dart`
- Modify: `apps/mobile/lib/domain/app_state.dart`
- Test: `apps/mobile/test/protocol/s02_model_commands_test.dart`（新建）
- Test: `apps/mobile/test/domain/session_state_test.dart`（追加用例）

**Interfaces:**
- Consumes: Task 1 的 wire 形状
- Produces:
  - `ModelOption { value, displayName, description, resolvedModel? }` + `fromWire`
  - `ModelCatalog { List<ModelOption> models }` + `fromWire`（读 `data['models']`）
  - `S02Commands.modelsList({commandId, traceId, workspaceId})` → `CommandRequest<ModelCatalog>`
  - `S02Commands.sessionSetModel({commandId, traceId, sessionId, model})` → `CommandRequest<SessionSummary>`（`model` 为 `String?`，序列化为 `null` 或字符串）
  - `SessionSummary.model`、`SessionSnapshot.model`、`SessionState.model`

- [ ] **Step 1: 写失败测试**

`apps/mobile/test/protocol/s02_model_commands_test.dart`：

```dart
test('modelsList builds the workspace payload', () {
  final request = S02Commands.modelsList(commandId: 'cmd', traceId: 'trace', workspaceId: 'ws_a');
  expect(request.type, 'models.list');
  expect(request.payload, {'workspaceId': 'ws_a'});
});

test('sessionSetModel serializes null and a value', () {
  final clear = S02Commands.sessionSetModel(commandId: 'c', traceId: 't', sessionId: 's', model: null);
  expect(clear.payload, {'model': null});
  final set = S02Commands.sessionSetModel(commandId: 'c', traceId: 't', sessionId: 's', model: 'opus');
  expect(set.payload, {'model': 'opus'});
});

test('ModelCatalog.fromWire reads rows', ...);
```

`session_state_test.dart` 追加：

```dart
test('session.status with model updates the session model', () {
  final next = applyEventToSession(
    base(),
    event(type: 'session.status', payload: {'state': 'idle', 'model': 'opus'}),
  );
  expect(next.model, 'opus');
});

test('session.status without model keeps the previous model', ...);
```

另外在 `session_state_test.dart` 里补充两条：`SessionSummary.fromWire` 解析 `model`；`SessionSummary.copyWith(model: 'x')` 与显式清空都正确。

- [ ] **Step 2: 运行，确认失败**

Run: `cd apps/mobile && flutter test test/protocol/s02_model_commands_test.dart test/domain/session_state_test.dart`
Expected: FAIL（类型/字段不存在）。

- [ ] **Step 3: 实现**

- `model_option.dart`：`ModelOption.fromWire`（缺 `value`/`displayName` 时跳过该行）、`ModelCatalog.fromWire`。
- `s02_messages.dart`：两个命令构造器，`decode` 分别用 `ModelCatalog.fromWire` 与 `SessionSummary.fromWire`。
- `session.dart`：`SessionSummary.model`（`String?`）+ `fromWire` 解析 + `copyWith` 增加 `model`（用 `bool clearModel` 或 sentinel 保留"显式置 null"语义）；`SessionSnapshot.model` + `fromPayload` 读 `session['model']`。
- `session_state.dart`：`SessionState.model`、`fromSummary`、`copyWith`（同样处理显式 null）、`applySnapshotToSession`、`applyEventToSession` 的 `session.status` 分支（`payload['model']` 是 String → 设置；显式 `null` → 清空；缺失 → 保留）。
- `app_state.dart` 的 `_summaryFromState` 传 `model: state.model`。

- [ ] **Step 4: 运行，确认通过**

Run: `cd apps/mobile && flutter test test/protocol/s02_model_commands_test.dart test/domain/session_state_test.dart test/domain/app_state_test.dart`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add apps/mobile
git commit -m "feat: add model protocol commands and session model state"
```

---

### Task 7: 聊天状态与切换命令

**Files:**
- Modify: `apps/mobile/lib/features/chat/chat_controller.dart`
- Modify: `apps/mobile/lib/features/sessions/session_page.dart`
- Test: `apps/mobile/test/features/chat/chat_controller_test.dart`（追加用例）

**Interfaces:**
- Consumes: Task 6 的 `SessionSummary.model`、`S02Commands.sessionSetModel`、`SessionSnapshot.model`
- Produces:
  - `ChatState.model`（`String?`）、`ChatState.workspaceId`（`String?`）
  - `ChatController.attachSession(String sessionId, {String? workspaceId, String? model})`
  - `ChatController.setSessionModel(String? model)`

- [ ] **Step 1: 写失败测试**

在 `chat_controller_test.dart` 追加：

```dart
test('attachSession seeds model and workspace from the summary', ...);
// attachSession('session_01', workspaceId: 'ws_a', model: 'opus') → state.model/workspaceId

test('session.status updates the model', ...);
// mergeEvent(session.status payload {state:'idle', model:'sonnet'}) → model 'sonnet'

test('setSessionModel sends session.set-model and adopts the returned summary', ...);
// FakeAgentSocket 收到 type 'session.set-model'；随后回包 command.result data {model:'opus'}
// → state.model === 'opus'

test('setSessionModel surfaces UNKNOWN_MESSAGE_TYPE', ...);
// 回包 error code UNKNOWN_MESSAGE_TYPE → state.error 含 '升级'
```

- [ ] **Step 2: 运行，确认失败**

Run: `cd apps/mobile && flutter test test/features/chat/chat_controller_test.dart`
Expected: FAIL。

- [ ] **Step 3: 实现**

- `ChatState`：增加 `model`、`workspaceId`（`copyWith` 用现有 `_unset` sentinel）。
- `attachSession`：签名加两个可选参数；切换会话时 `ChatState(connection: state.connection, model: model, workspaceId: workspaceId)`。
- `mergeSnapshot`：`snapshot.model != null` 时更新、`snapshot.workspaceId` 若为空则不动；`session.status` 分支：`payload['model']` 为 String → 设置，显式 null → 清空，缺失 → 保留。
- `setSessionModel`：读 `commandClientProvider`，`client.execute(S02Commands.sessionSetModel(...))`；成功用返回摘要更新 `model`；`CommandFailure('UNKNOWN_MESSAGE_TYPE')` → 错误文案"Mac 端版本过旧，请升级后重试"，其余错误用 code；`CommandTimeout` → "切换模型超时，请重试"。
- `session_page.dart` 的 `_openChat`：`attachSession(summary.sessionId, workspaceId: summary.workspaceId, model: summary.model)`。

- [ ] **Step 4: 运行，确认通过**

Run: `cd apps/mobile && flutter test test/features/chat/chat_controller_test.dart test/features/sessions`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add apps/mobile
git commit -m "feat: chat state carries the session model"
```

---

### Task 8: 目录 provider 与聊天页选择器

**Files:**
- Modify: `apps/mobile/lib/data/providers.dart`
- Create: `apps/mobile/lib/features/chat/widgets/model_picker_sheet.dart`
- Modify: `apps/mobile/lib/features/chat/chat_page.dart`
- Test: `apps/mobile/test/features/chat/model_picker_test.dart`（新建）

**Interfaces:**
- Consumes: Task 6 的 `ModelCatalog`、Task 7 的 `ChatState.model/workspaceId` 与 `setSessionModel`
- Produces:
  - `modelCatalogProvider = FutureProvider.family<ModelCatalog, String>((ref, workspaceId) async { ... })`
  - `ModelPickerSheet`：`ModelPickerSheet({required List<ModelOption> models, String? selected, required void Function(String?) onSelect})`

- [ ] **Step 1: 写失败测试**

`model_picker_test.dart`：沿用 `chat_page_test.dart` 的 `pumpChat` 方式，额外 override `modelCatalogProvider.overrideWith((ref, workspaceId) async => ModelCatalog(models: [...]))`。

```ts
it('chip shows 默认 when the session follows the Mac default', ...);
// state.model == null → 找到文本 '默认'

testWidgets('chip shows the catalog display name', ...);
// model 'opus' 且目录里 displayName 'Opus 5' → chip 文本 'Opus 5'

testWidgets('archived sessions do not open the picker', ...);
// state.archived == true 时点 chip 不出现面板

testWidgets('selecting a model sends session.set-model', ...);
// attachSession(model:'opus', workspaceId:'ws_a')，点 chip → 面板出现
// 点 '默认（跟随 Mac）' → FakeAgentSocket 收到 'session.set-model' 且 payload model null
```

- [ ] **Step 2: 运行，确认失败**

Run: `cd apps/mobile && flutter test test/features/chat/model_picker_test.dart`
Expected: FAIL。

- [ ] **Step 3: 实现**

- `providers.dart`：`modelCatalogProvider` family 读 `commandClientProvider`，`client.execute(S02Commands.modelsList(workspaceId: ...))`；client 为 null 时抛 `StateError`（调用方走 `AsyncValue.error`）。
- `model_picker_sheet.dart`：底部面板，首行"默认（跟随 Mac）"（`value == null`），其余行显示 `displayName` 与 `description`；选中即回调并关闭。
- `chat_page.dart` AppBar `actions` 最前加 chip：进入页面且 `workspaceId != null` 时 `ref.watch(modelCatalogProvider(workspaceId))`（触发一次清单拉取）；chip 文案 `state.model == null ? '默认' : (目录行 displayName ?? state.model)`；会话归档（`state.archived`）时不响应点击；点击时若 `workspaceId == null` 或目录失败，面板显示"模型清单获取失败"并提供重试（`ref.invalidate(modelCatalogProvider(workspaceId))`）。

- [ ] **Step 4: 运行，确认通过**

Run: `cd apps/mobile && flutter test test/features/chat/model_picker_test.dart test/features/chat/chat_page_test.dart`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add apps/mobile
git commit -m "feat: add model picker to chat page"
```

---

### Task 9: 全量验证

**Files:** 无新增

- [ ] **Step 1: 协议测试**

Run: `npm test`
Expected: PASS（含 protocol/v1/tests）。

- [ ] **Step 2: Agent 测试**

Run: `npm run test:agent`
Expected: PASS。

- [ ] **Step 3: App 测试**

Run: `npm run test:mobile`
Expected: PASS。

- [ ] **Step 4: 冒烟（手动）**

1. 启动 Agent 与模拟器 App 的连接；
2. 进入会话，chip 显示"默认"或已选模型；
3. 切到列表中另一项，再发一条消息，Mac 端日志/时间线确认使用该模型；
4. 另一台设备（或重开 App）进入同一会话，chip 与切换结果一致；
5. 归档会话里 chip 不可点。

- [ ] **Step 5: 提交（如有零散修正）**

只暂存你实际改动的文件；仓库里有未跟踪的 `apps/relay/data/`，禁止 `git add -A`。

```bash
git add <实际改动文件>
git commit -m "chore: verify model selection end to end"
```
