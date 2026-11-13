# S05 实施预检

**日期：** 2026-11-13
**计划：** `docs/superpowers/plans/2026-11-08-s05-doubao-voice-input.md`
**Spec：** `docs/superpowers/specs/2026-11-08-s05-doubao-voice-input-design.md`

## 1. 入口门禁结果

| 门禁 | 结果 | 说明 |
|---|---|---|
| `npm run s00:gate` | **PASS** | Core PASS；ASR Contract PASS（fake 契约，非真实豆包证据） |
| `npm run verify:s01` | **FAIL** | 仅 E2E-01–12 NOT_RUN |
| `npm run verify:s02` | **FAIL** | E2E-01–12 NOT_RUN + realDevice 缺失 |
| `npm run verify:s03` | **FAIL** | E2E-01–12 NOT_RUN + realDevice 缺失 + S02 门禁 FAIL |
| `npm run verify:s04` | **FAIL** | STORE-00 iPhone BLOCKED、Data Protection 缺失、E2E-01–15 NOT_RUN |
| 豆包服务与凭证 | **BLOCKED** | 环境中无 `DOUBAO_ASR_API_KEY`；未开通/未注入 |
| 物理 iPhone | **BLOCKED** | 无可用真机 |

**结论：计划要求的"全部 PASS + ASR-00 真实通过"不成立。** 用户在实现前明确选择继续（与 S03/S04 相同处理）：Task 0 记录 BLOCKED，Task 1 记录 ASR-00 BLOCKED，Task 2–13 以 fake Provider 与合成音频实现并通过自动化测试；真实豆包、Tailscale 与物理 iPhone 证据保持 BLOCKED，S05 不得宣称验收通过。该决定已写入 SDD ledger。

## 2. 环境基线

- 系统默认 Node 为 **v22.23.2**；计划要求 **24.15.0**，已用 fnm 安装。Agent 的构建/测试需 `fnm exec --using=24.15.0 -- npm ...`。
- TypeScript 7.0.2、Vitest 5.1.0、tsx 4.23.15、fastify 5.x、`@fastify/websocket`。
- `@types/ws` 已安装；运行时 `ws` **未安装**，Task 3 添加 `ws 8.22.1`。
- Flutter 3.47.9 / Dart 3.13.7；`record` **未加入依赖**，Task 8 添加 `record 7.1.2`。
- Tailscale HTTPS Certificates/Serve 未配置；不能作为 S05 的真实链路证据。

## 3. 实际接口与计划差异

| 计划假设 | 仓库实际 | 处理 |
|---|---|---|
| `/ws` 升级鉴权可复用为通用钩子 | `createPhoneServer` 在 `@fastify/websocket` 的全局 `verifyClient` 中调用 `authenticateUpgrade(headers, deviceStore)`，鉴权结果存在 `WeakMap<IncomingMessage, DeviceRecord>`，不对外暴露 | Task 6 的 `AsrGateway` 在同一 Fastify 实例上注册 `/ws/asr`，升级仍受同一 `verifyClient` 保护；route handler 再通过注入的 `authenticate(request)` 获取 `deviceId`。不新增第二套鉴权规则 |
| `onRevoke(listener)` 注册钩子 | 实际在 `durable-wire.ts` 的 `onDeviceReplaced`、admin `onRevoke`、pairing replace 三处内联调用 `connections.revoke` 与 `broker.invalidateDevice` | Task 7 在这三处直接调用 `asrRuntime.close('device_revoked')`，不引入监听器注册表 |
| `RecoveryDatabase.open()` 已有 `onUpgrade` | v1 只有 `onCreate`，`recoverySchemaVersion = 1` | Task 9 改为 2，并新增仅创建 `voice_drafts` 与索引的 `onUpgrade` |
| 已有 per-session 草稿持久化读写 | `RecoveryStore.readDraft/saveDraft/clearDraft` 存在但聊天层未使用；`ChatController.draft` 只在内存 | Task 10/11 通过 `VoiceDraftAccess` 把 origin session 草稿写入 `drafts` 表并与 `voice_drafts` 同事务；不重构既有聊天草稿 |
| `PersistentCommandCoordinator.send(CommandRequest, {withinTransaction})` | 实际签名是命名参数 `send({commandId, sessionId, type, payload})`，返回 `Future<JsonMap>`，内部已做同 session 门控与 outbox | Task 11 只增加可选命名参数 `withinTransaction`（`FutureOr<void> Function(Transaction)?`），在 outbox 插入的同一事务内执行；不改调用方 |
| `ConnectionController` 暴露 URL/token | 只暴露 `agentInstanceId` 等；URL/token 来自 `DeviceCredential`（`baseUrl` + `deviceToken`），`IoAgentSocket.connect` 拼 `wss://host/ws` | Task 10 的 `VoiceAsrClientFactory` 用同一 `DeviceCredential` 拼 `wss://host/ws/asr`，Bearer 只放 Authorization 头 |
| `record 7.1.2` 的 `startStream` | 依赖未安装，无法在本阶段核对真实签名 | Task 8 安装 `record 7.1.2` 后以其实际 API 封装；真机行为由 ASR-00 BLOCKED 记录 |
| S00 ASR 字段 | `docs/s00/asr-contract.md` 的 `APP_ID/ACCESS_TOKEN/ENDPOINT/MODEL` 为占位 | 本阶段退役：真实配置只有 `DOUBAO_ASR_API_KEY` 与 `DOUBAO_ASR_RESOURCE_ID`，endpoint 固定；S00 fake 契约（ASR-01–08）不再作为 S05 回归门禁 |

## 4. 隔离夹具与路径

- Agent 测试使用 `apps/agent/test/fixtures/s05/{audio,doubao}`；所有临时目录用 `mkdtemp` 创建，不读取真实 `~/.claude-remote`、真实项目路径、环境变量或凭证。
- 合成音频由 `scripts/s05/make-audio-fixtures.sh` 用系统 `say` + `afconvert` 生成；禁止使用个人录音。
- 脱敏 framing 向量只保留 header/sequence/消息类型等字段，不含 API Key、Authorization、请求头或完整识别文本。
- Flutter 测试使用 `sqflite_common_ffi` 临时库；真机录音探针不写音频文件。

## 5. ASR-00 当前状态

`ASR-00: BLOCKED` — 无豆包服务凭证、无物理 iPhone、无 Tailscale HTTPS 链路。真实鉴权、PCM 可识别性、partial/final 语义、错误码映射与 `record` 真机行为均 **NOT_RUN**。Task 2–13 的 fake Provider 测试只证明内部契约，不构成 ASR-00 证据。

## 6. 执行顺序

Task 0 → Task 1（ASR-00：BLOCKED，仅落地探针与夹具骨架）→ Task 2–13（Mac + Flutter 自动化）。