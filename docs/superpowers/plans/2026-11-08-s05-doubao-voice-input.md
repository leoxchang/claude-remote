# S05 豆包语音输入 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 iPhone 对话页交付按住说话、可编辑且绝不自动执行的豆包语音草稿，由 Mac 独立 `/ws/asr` 代理持有长期凭证并转发 PCM 音频。

**Architecture:** Mac 新增与主控制 WSS 隔离的认证音频通道、单一活跃流管理器和唯一豆包 Provider 边界；原始音频只在有界内存中转发，partial 只展示，final 只追加到开始录音时的原 session 草稿。Flutter 用 `record 7.1.2` 采集 PCM16、独立连接 `/ws/asr`，以 RecoveryStore schema v2 保存 voice_drafts，最终仍由普通 Composer 经 S04 PersistentCommandCoordinator 产生唯一 `prompt.send`。

**Tech Stack:** Node.js 24.15.0、TypeScript 7.0.2、Fastify 5.12.8、`ws 8.22.1`、`@types/ws 8.18.2`、Vitest 5.1.0；Flutter 3.47.9、Dart 3.13.7、Riverpod 3.5.0、`record 7.1.2`、`sqflite 2.4.5`、`sqflite_common_ffi 2.4.5`、`path_provider 2.1.6`、`path 1.9.1`。

**Spec:** `docs/superpowers/specs/2026-11-08-s05-doubao-voice-input-design.md`

## Global Constraints

- **当前入口为 BLOCKED：**Task 0 未确认 S00 Core、S01、S02、S03、S04 全部 PASS 前，不得执行 Task 1–13；Task 1 的 ASR-00 未以真实豆包服务、真实凭证和物理 iPhone 通过前，不得执行 Task 2–13。
- 当前只有 spec-to-spec 文档基线；Task 0 必须核对届时真实 Fastify/WSS 鉴权、revoke、RecoveryStore、PersistentCommandCoordinator 和 Composer 接口，不假设今天已有这些类。
- 固定 endpoint `wss://openspeech.bytedance.com/api/v3/sauc/bigmodel_async`；resourceId 只允许 `volc.seedasr.sauc.duration`（默认）或 `volc.seedasr.sauc.concurrent`。
- API Key 只从 Mac 进程启动时的 `DOUBAO_ASR_API_KEY` 环境变量读取，禁止命令行参数、App、SQLite、协议、日志和示例；S05 不实现 Keychain/秘密服务，轮换需重启。
- 固定音频：16 kHz、mono、signed PCM16 little-endian、无 WAV header；标准包 200 ms / 6,400 bytes，最后一包非空且偶数字节。
- 固定限制：Provider connect 10 秒、finalize 等 final 10 秒、单次录音 60 秒、App 待发送 20 包、Provider bufferedAmount 256 KiB、Mac→App 文本队列 4 条、全局 1 个活跃流、每设备 10 次 start/分钟。
- `partial.text` 是当前识别快照而非 delta；utterance definite 不等于 final；final 只在 finalizing 中接受且每流最多一次；cancel 后迟到 partial/final 全部丢弃。
- 音频只在内存中转发；不写文件、SQLite、日志、崩溃上下文或诊断导出。ASR 事件不进入主控制 WSS、session seq、Journal、commands、audit_logs 或时间线。
- final 只追加到 origin session 草稿；普通 Composer 是唯一执行入口，语音不创建 commandId/run/审批，不提供语音直接执行或语音审批。
- `voice_drafts` 以增量 schema v2 迁移加入，必须保留既有 outbox_commands、sync_cursors、cached_events、cached_sessions 和 drafts，不清库重建。
- 后台、锁屏、电话打断、音频断线、Agent 重启都停止当前流，不自动恢复、不自动重录、不自动重试已发送音频。
- 不启用 Tailscale Funnel、不关闭 TLS 校验、不使用 `badCertificateCallback`、不修改全局 `settings.json`、不开启 `bypassPermissions`；device token 只在 iPhone Keychain，Mac 只存 SHA-256。
- 核心 TypeScript 与 Dart 业务逻辑覆盖率均不低于 80%；fake Provider、桌面测试或模拟器不得替代 ASR-00、真实豆包、Tailscale 和物理 iPhone E2E。
- 当前目录不是 Git 仓库。只有用户明确授权初始化/提交后才执行 Commit 步骤，否则标记 SKIPPED，不得自行 `git init` 或提交。

## Review Focus

1. **松手发生在权限或 connecting 阶段，而 `asr.started` 迟到：**取消必须优先，麦克风不启动、不产生空 final、迟到 started 不改变状态；Task 10、Task 12 固定测试。
2. **`asr.start` 尚未 ready 或流已 terminal 时收到二进制帧/finish：**未 ready 不得写 Provider，finish 在 started 前按 cancel 处理，terminal 后帧忽略；Task 5、Task 6 固定测试。
3. **同一音频连接重复/重放 `asr.start`，或断线后自动重连：**每连接只允许一个流，重复 start 返回冲突并关闭，不自动重连或恢复旧流；Task 6、Task 10 固定测试。
4. **录音回调不是 200 ms 或出现奇数字节：**分包器必须缓存残余半样本，任何时刻都不得发送奇数长度或超过 6,400 bytes 的帧；Task 8 固定测试。
5. **final 已到但草稿事务未提交/已提交后 App 被杀：**不得出现半写草稿；重开后 pending voice_draft 可恢复，确认发送只产生一个 prompt；Task 9、Task 11、Task 13 固定测试。

## File Structure

```text
protocol/v1/
  asr-messages.schema.json                 # App→Mac 控制消息与服务端事件 schema
  examples/s05/                            # Mac/Dart 共用合法与非法样例

apps/agent/
  src/asr/asr-protocol.ts                  # ASR 类型、错误码、schema 校验入口
  src/asr/asr-config.ts                    # 环境变量读取、endpoint/resourceId 固定值
  src/asr/doubao/doubao-frame.ts           # 官方二进制 framing 编解码
  src/asr/doubao/doubao-asr-provider.ts    # 唯一豆包协议/密钥边界
  src/asr/asr-event-normalizer.ts          # partial 快照、唯一 final、安全错误
  src/asr/asr-stream-manager.ts            # 单流、超时、背压、幂等清理
  src/asr/asr-gateway.ts                   # /ws/asr 鉴权、控制消息、限流、事件队列
  src/asr/asr-runtime.ts                   # 配置存在性与 Fastify 唯一 wiring
  test/asr/                                # 单元测试
  test/integration/s05-agent-flow.test.ts  # 真实 Fastify/WSS + fake Provider
  test/live/s05-asr00-probe.ts             # ASR-00 真实豆包探针
  test/fixtures/s05/                       # 合成音频、脱敏 framing 向量

apps/mobile/
  lib/voice/pcm_packetizer.dart            # 200 ms、6,400 bytes、奇数字节缓存
  lib/voice/audio_level.dart               # PCM16 RMS/dBFS
  lib/voice/speech_vad.dart                # 静音辅助与自动 finish
  lib/voice/voice_audio_capture.dart       # record 7.1.2 startStream 封装
  lib/voice/voice_asr_client.dart          # 独立 /ws/asr 客户端与 Dart 事件模型
  lib/voice/voice_input_controller.dart    # 按住/松手/取消/中断状态机
  lib/voice/voice_ui_state.dart            # 不可变 UI 状态
  lib/voice/voice_draft.dart               # voice_drafts 模型
  lib/voice/voice_draft_repository.dart    # final 草稿与元数据同事务
  lib/voice/voice_send_coordinator.dart    # outbox enqueue 与 voice_draft 删除同事务
  lib/features/chat/voice_input_button.dart
  lib/features/chat/voice_recording_panel.dart
  lib/features/chat/voice_draft_banner.dart
  lib/voice/voice_interruption_bridge.dart
  ios/Runner/AudioInterruptionBridge.swift  # AVAudioSession 中断通知
  integration_test/s05_record_probe_test.dart
  test/voice/                              # 单元与 Widget 测试

scripts/s05/
  make-audio-fixtures.sh                   # 系统 TTS 生成无隐私中文 PCM
  verify-gate.ts / check-secrets.ts        # 退出门禁与密钥扫描
docs/s05/
  preflight.md / asr00-evidence.md
  e2e-checklist.md / rollback.md / exit-report.md
```

---

### Task 0: S00–S04 入口与真实接口预检

**Files:**
- Create: `docs/s05/preflight.md`
- Read: `docs/s00/exit-report.md`, `docs/s01/exit-report.md`, `docs/s02/exit-report.md`, `docs/s03/exit-report.md`, `docs/s04/exit-report.md`, `apps/agent/src/app/runtime.ts`, `apps/mobile/lib/recovery/recovery_database.dart`, `apps/mobile/lib/recovery/recovery_store.dart`, `apps/mobile/lib/connection/persistent_command_coordinator.dart`, `apps/mobile/lib/connection/connection_controller.dart`

**Interfaces:**
- Consumes: S01 主 WSS 鉴权与 revoke 钩子、S04 `RecoveryDatabase`/`RecoveryStore`/`PersistentCommandCoordinator.send`、S02/S03 Composer 与 session 草稿状态。
- Produces: 真实接口/配置差异表、ASR-00 入口和 Task 1–13 的明确前置结论。

- [ ] **Step 1: Verify all upstream gates**

Run: `npm run s00:gate && npm run verify:s01 && npm run verify:s02 && npm run verify:s03 && npm run verify:s04`  
Expected: 全部 PASS，CONC-01、PERM-00、STORE-00、E2E 和覆盖率证据完整。任何缺失都记录 BLOCKED 并停止，不能创建 ASR 产品代码。

- [ ] **Step 2: Record real interfaces and drift**

核对 `/ws` 的 Fastify WSS 插件与 Bearer 鉴权函数、revoke/pair replace 通知、`RecoveryDatabase.open()` 的 schemaVersion/onUpgrade、drafts 表、`PersistentCommandCoordinator.send` 签名、ConnectionController 的 token/URL、Composer 的 session 草稿读写，以及 `record 7.1.2` 的 `AudioRecorder.startStream(RecordConfig(...))` 实际签名。差异写入 `preflight.md`，实现者不得猜测。

- [ ] **Step 3: Prepare isolated fixtures and paths**

创建 `apps/agent/test/fixtures/s05/{audio,doubao}` 与临时 configDir；确认不复制真实项目、个人路径、环境变量或凭证。记录届时 Node/Flutter/Tailscale 版本和脱敏标签。

- [ ] **Step 4: Commit**

```bash
git add docs/s05/preflight.md
git commit -m "docs: record S05 implementation prerequisites"
```

### Task 1: ASR-00 真实豆包与 iPhone 录音门禁

**Files:**
- Create: `apps/agent/test/live/s05-asr00-probe.ts`, `apps/agent/test/live/s05-asr00-probe.test.ts`
- Create: `apps/mobile/integration_test/s05_record_probe_test.dart`
- Create: `scripts/s05/make-audio-fixtures.sh`, `docs/s05/asr00-evidence.md`
- Modify: `package.json`

**Interfaces:**
- Produces: `npm run test:s05:asr00`；ASR-00 的 PASS/BLOCKED 证据。
- Produces: 脱敏 framing 向量 `apps/agent/test/fixtures/s05/doubao/*.bin` 与事件样例，供 Task 3 使用；合成 PCM 供 Task 3–7 和后续 E2E 使用。

- [ ] **Step 1: Verify service and credential prerequisites**

确认火山引擎语音服务已开通、`DOUBAO_ASR_API_KEY` 仅存在于 Mac 进程环境、用户已选定 resourceId，且 ASR-00 只使用合成或明确授权中文音频。缺服务/凭证/计费资源时写入 `asr00-evidence.md` 为 BLOCKED 并停止 Task 2–13；不得用 fake 冒充。

- [ ] **Step 2: Generate non-private audio fixtures**

`make-audio-fixtures.sh` 用 macOS `say` 合成中文单句、多句和中英混合文本，经 `afconvert` 转为 16 kHz/mono/signed PCM16，并去掉 WAV header。Run: `bash scripts/s05/make-audio-fixtures.sh`  
Expected: 生成偶数长度、无 header 的 `.pcm`；脚本和 fixture 不含个人录音、路径或密钥。

- [ ] **Step 3: Write the live ASR-00 probe**

探针按官方文档实现最小二进制 framing，覆盖 spec ASR-00 1–7、9、10：TLS 与 `X-Api-Key`/`X-Api-Resource-Id`/`X-Api-Request-Id` 鉴权；16 kHz PCM16 200 ms 可识别；单句/多句/中英混合的 partial、utterance definite、整流 final/is_last_package；`result.text` 与 utterances 的快照/增量语义；finish 最后一包与 10 秒无 final；cancel（有官方帧用帧，否则关闭 socket）；无效凭证、错误 resourceId、空音频、8 秒无音频、过载和限流的真实错误；官方是否出现 iOS 短期凭证。

- [ ] **Step 4: Run ASR-00 against the real service**

在 `package.json` 注册 `test:s05:asr00`（仅 `ASR00_LIVE=1` 时执行真实调用）。  
Run: `ASR00_LIVE=1 npm run test:s05:asr00`  
Expected: 全部真实 PASS，输出只含脱敏 code/log_id/时序；任何 BLOCKED/FAIL 停止，不得调整断言掩盖官方行为。

- [ ] **Step 5: Save sanitized framing vectors**

根据真实响应保存可复用的脱敏 `.bin` 帧和事件 JSON：不含 API Key、Authorization、请求头、真实个人音频或完整识别文本。记录每个字段的官方依据和 10 秒/60 秒实测结果。

- [ ] **Step 6: Verify record on the physical iPhone**

`integration_test/s05_record_probe_test.dart` 在物理 iPhone 上请求麦克风、`startStream` 采集约 2 秒，断言 chunk 为偶数字节、累计速率约 32,000 B/s（±15%）、无录音文件写入；按清单人工记录电话打断行为及是否需要原生监听。

- [ ] **Step 7: Write evidence and commit**

`asr00-evidence.md` 逐项记录 PASS/FAIL/BLOCKED、版本、时间、resourceId、脱敏证据和限制；不得保存密钥或音频正文。  
Run: `git add apps/agent/test/live apps/agent/test/fixtures/s05 apps/mobile/integration_test scripts/s05 docs/s05 package.json && git commit -m "test: validate Doubao ASR prerequisites"`

### Task 2: S05 共享 ASR 协议、错误码与样例

**Files:**
- Create: `protocol/v1/asr-messages.schema.json`, `protocol/v1/examples/s05/*.json`
- Create: `apps/agent/src/asr/asr-protocol.ts`
- Test: `apps/agent/test/asr/asr-protocol.test.ts`

**Interfaces:**
- Produces: `AsrControlMessage`、`AsrServerEvent`、`AsrProviderEvent`、`AsrErrorCode`、`AsrError` 和 `validateAsrControlMessage(value: unknown): AsrControlMessage`。
- Consumes: S00–S02 既有 JSON Schema 校验方式；若已有 Ajv 配置则复用，不新增第二套校验器。

```ts
type AsrControlMessage =
  | { protocolVersion: 1; messageId: string; timestamp: number; type: 'asr.start'; asrStreamId: string; payload: { audio: { format: 'pcm-s16le'; sampleRate: 16000; channels: 1 } } }
  | { protocolVersion: 1; messageId: string; timestamp: number; type: 'asr.finish'; asrStreamId: string; payload: Record<string, never> }
  | { protocolVersion: 1; messageId: string; timestamp: number; type: 'asr.cancel'; asrStreamId: string; payload: Record<string, never> }

type AsrProviderEvent =
  | { type: 'partial'; text: string }
  | { type: 'utteranceDefinite'; text: string }
  | { type: 'final'; text: string }
  | { type: 'error'; code: AsrErrorCode; retryable: boolean }
  | { type: 'closed'; reason: string }

type AsrClientEvent =
  | { type: 'asr.started'; asrStreamId: string }
  | { type: 'asr.partial'; asrStreamId: string; sequence: number; text: string }
  | { type: 'asr.final'; asrStreamId: string; sequence: number; text: string }
  | { type: 'asr.error'; asrStreamId: string; code: AsrErrorCode; retryable: boolean; safeMessage: string }
  | { type: 'asr.cancelled'; asrStreamId: string; reason: string }
  | { type: 'asr.closed'; asrStreamId: string; reason: string }

type AsrErrorCode =
  | 'ASR_NOT_CONFIGURED' | 'ASR_CONNECTION_FAILED' | 'ASR_PROVIDER_UNAUTHENTICATED'
  | 'ASR_PROVIDER_ERROR' | 'ASR_BUSY' | 'ASR_RATE_LIMITED' | 'ASR_BACKPRESSURE'
  | 'ASR_INVALID_AUDIO' | 'ASR_STREAM_CONFLICT' | 'ASR_RESULT_TOO_LARGE'
  | 'ASR_FINAL_TIMEOUT' | 'ASR_EMPTY_RESULT' | 'ASR_PROVIDER_ENDED'
  | 'ASR_PROVIDER_OVERLOADED' | 'INVALID_MESSAGE'
```

- [ ] **Step 1: Write failing schema and example tests**

读取 `examples/s05` 全部样例：接受合法 start/finish/cancel 和六类服务端事件；拒绝缺少 protocolVersion/messageId/asrStreamId、payload 带 endpoint/API Key/resourceId/sessionId/runId/commandId、错误音频格式、控制消息超过 4 KiB、非法 sequence 和未知 type。

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run apps/agent/test/asr/asr-protocol.test.ts`  
Expected: FAIL with missing schema/validator。

- [ ] **Step 3: Implement schema, types and validator**

schema 只固定 spec 允许的字段；`validateAsrControlMessage` 失败抛出 `AsrError('INVALID_MESSAGE')`，错误消息不含原始完整 payload。`AsrError` 只携带 `code`、`retryable`、`safeMessage`。

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run apps/agent/test/asr/asr-protocol.test.ts`  
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add protocol/v1 apps/agent/src/asr/asr-protocol.ts apps/agent/test/asr/asr-protocol.test.ts
git commit -m "feat: define shared ASR protocol and error model"
```

### Task 3: DoubaoAsrProvider 二进制边界

**Files:**
- Create: `apps/agent/src/asr/asr-config.ts`, `apps/agent/src/asr/doubao/doubao-frame.ts`, `apps/agent/src/asr/doubao/doubao-asr-provider.ts`
- Test: `apps/agent/test/asr/asr-config.test.ts`, `apps/agent/test/asr/doubao-frame.test.ts`, `apps/agent/test/asr/doubao-asr-provider.test.ts`

**Interfaces:**
- Consumes: Task 1 的脱敏 framing 向量；Task 2 的 `AsrProviderEvent`/`AsrErrorCode`。
- Produces:

```ts
type AsrConfig = {
  provider: 'doubao'
  apiKey: string
  resourceId: 'volc.seedasr.sauc.duration' | 'volc.seedasr.sauc.concurrent'
}
loadAsrConfig(env: NodeJS.ProcessEnv): AsrConfig | null

type AsrProviderStart = {
  asrStreamId: string
  audio: { format: 'pcm-s16le'; sampleRate: 16000; channels: 1 }
}
type AsrProviderHandle = {
  asrStreamId: string
  events: AsyncIterable<AsrProviderEvent>
}
type AsrProvider = {
  start(input: AsrProviderStart): Promise<AsrProviderHandle>
  write(handle: AsrProviderHandle, audio: Uint8Array): void
  finalize(handle: AsrProviderHandle): void
  cancel(handle: AsrProviderHandle): void
}

type WebSocketLike = {
  send(data: Uint8Array | string): void
  close(code?: number, reason?: string): void
  on(event: 'open' | 'message' | 'error' | 'close', listener: (...args: any[]) => void): void
  bufferedAmount: number
}

class DoubaoAsrProvider implements AsrProvider {
  constructor(input: {
    config: AsrConfig
    openSocket: (url: string, headers: Record<string, string>) => WebSocketLike
    requestId?: () => string
  })
  start(input: AsrProviderStart): Promise<AsrProviderHandle>
  write(handle: AsrProviderHandle, audio: Uint8Array): void
  finalize(handle: AsrProviderHandle): void
  cancel(handle: AsrProviderHandle): void
}

encodeAudioFrame(input: { sequence: number; audio: Uint8Array; final: boolean }): Uint8Array
encodeJsonFrame(input: { sequence: number; json: unknown }): Uint8Array
decodeServerFrame(frame: Uint8Array): DoubaoServerMessage
createDoubaoAsrProvider(config: AsrConfig, openSocket?: (url: string, headers: Record<string, string>) => WebSocketLike): DoubaoAsrProvider
```

- [ ] **Step 1: Write failing config tests**

`loadAsrConfig` 只读 `DOUBAO_ASR_API_KEY`、`DOUBAO_ASR_RESOURCE_ID`；缺 Key 返回 null，非法 resourceId 抛出 `ASR_NOT_CONFIGURED`；endpoint 是常量；返回对象和错误字符串都不含 Key 以外的进程环境。

- [ ] **Step 2: Write failing framing tests**

用 Task 1 的 `.bin` 向量断言 audio/json 帧的 header、sequence、final 标志；解析 partial、utterance definite、整流 final、服务端 error/close；拒绝截断、未知 message type 和超大帧；测试不包含真实 Key 或 Authorization。

- [ ] **Step 3: Run tests to verify they fail**

Run: `npx vitest run apps/agent/test/asr/asr-config.test.ts apps/agent/test/asr/doubao-frame.test.ts`  
Expected: FAIL with missing config/frame functions。

- [ ] **Step 4: Implement config and framing from verified evidence**

`asr-config.ts` 在模块加载时不读取环境；`doubao-frame.ts` 只实现 ASR-00 已证实字段，不添加未证实的 cancel 帧或模型参数。

- [ ] **Step 5: Write failing provider lifecycle tests**

fake `WebSocketLike` 覆盖：start 10 秒超时 → `ASR_CONNECTION_FAILED`；非 2xx/鉴权 → `ASR_PROVIDER_UNAUTHENTICATED`；start 后事件按序映射；write 在 ready 前抛 `ASR_STREAM_CONFLICT`；bufferedAmount 超过 256 KiB → `ASR_BACKPRESSURE` 并终止；finalize 只发送一包终帧；cancel 关闭 socket 且迟到事件丢弃；重复 cancel/close 幂等；日志不含 Key、headers、PCM 或识别文本。

- [ ] **Step 6: Run tests to verify they fail**

Run: `npx vitest run apps/agent/test/asr/doubao-asr-provider.test.ts`  
Expected: FAIL with missing provider。

- [ ] **Step 7: Implement the provider**

每次 start 生成独立 `X-Api-Request-Id`，请求头只用 `X-Api-Key`、`X-Api-Resource-Id`、`X-Api-Request-Id`；官方 `log_id` 只作为脱敏诊断元数据；所有 socket/terminal 状态封装在 handle 内存中；Provider 原始 payload 不写日志。

- [ ] **Step 8: Run all provider tests and commit**

Run: `npx vitest run apps/agent/test/asr`  
Expected: PASS。  
Run: `git add apps/agent/src/asr apps/agent/test/asr && git commit -m "feat: add Doubao ASR provider boundary"`

### Task 4: AsrEventNormalizer 唯一 final 与安全文本

**Files:**
- Create: `apps/agent/src/asr/asr-event-normalizer.ts`
- Test: `apps/agent/test/asr/asr-event-normalizer.test.ts`

**Interfaces:**
- Consumes: Task 2 `AsrProviderEvent`/`AsrClientEvent`/`AsrErrorCode`。
- Produces:

```ts
class AsrEventNormalizer {
  constructor(input: { asrStreamId: string; maxFinalBytes?: number })
  markFinalizing(): void
  accept(event: AsrProviderEvent): AsrClientEvent | null
  cancel(reason: string): AsrClientEvent[]
  fail(code: AsrErrorCode, retryable: boolean): AsrClientEvent[]
  close(reason: string): AsrClientEvent[]
  get isTerminal(): boolean
}
```

- [ ] **Step 1: Write failing normalization tests**

partial 每流 sequence 从 1 递增且后到快照替换前一快照；`utteranceDefinite` 返回 null 且不结束录音；final 只在 `markFinalizing()` 后接受、最多一次，重复 final 返回 null；finalizing 前的 provider final 映射 `ASR_PROVIDER_ENDED`；全空白 final → `ASR_EMPTY_RESULT`；超过 16,384 UTF-8 bytes → `ASR_RESULT_TOO_LARGE`；terminal 后所有 provider 事件返回 null；cancel/fail/close 各只发一次且 error/cancelled 后紧跟 closed。

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run apps/agent/test/asr/asr-event-normalizer.test.ts`  
Expected: FAIL with missing normalizer。

- [ ] **Step 3: Implement the normalizer**

sequence 只用于 partial/final；final 以 UTF-8 byteLength 校验；错误使用固定安全文案，绝不回传 Provider 原文或识别全文。

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run apps/agent/test/asr/asr-event-normalizer.test.ts`  
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add apps/agent/src/asr/asr-event-normalizer.ts apps/agent/test/asr/asr-event-normalizer.test.ts
git commit -m "feat: normalize ASR snapshots and final results"
```

### Task 5: AsrStreamManager 生命周期、超时与背压

**Files:**
- Create: `apps/agent/src/asr/asr-stream-manager.ts`
- Test: `apps/agent/test/asr/asr-stream-manager.test.ts`

**Interfaces:**
- Consumes: Task 3 `AsrProvider`、Task 4 `AsrEventNormalizer`、Task 2 `AsrError`。
- Produces:

```ts
class AsrStreamManager {
  constructor(input: {
    provider: AsrProvider
    onEvent: (event: AsrClientEvent) => void
    connectTimeoutMs?: number   // 10_000
    finalTimeoutMs?: number     // 10_000
    maxRecordingMs?: number     // 60_000
  })
  start(input: { deviceId: string; asrStreamId: string }): Promise<void>
  write(asrStreamId: string, audio: Uint8Array): void
  finish(asrStreamId: string): void
  cancel(asrStreamId: string, reason: string): void
  cancelAll(reason: string): void
  get activeStreamId(): string | null
}
```

- [ ] **Step 1: Write failing lifecycle tests**

全局已有活跃流时第二次 start 抛 `ASR_BUSY` 且不创建第二 handle；Provider connect 超过 10 秒 → `ASR_CONNECTION_FAILED`；finalize 后 10 秒无 final → `ASR_FINAL_TIMEOUT` 并 cancel Provider；60 秒自动 finalize；write 在 finish 后忽略；Provider error 立即 terminal；cancel 后迟到 final/partial 不转发；cancel、error、timeout、close 的 cleanup 幂等且释放 handle；`cancelAll` 只影响当前流。

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run apps/agent/test/asr/asr-stream-manager.test.ts`  
Expected: FAIL with missing manager。

- [ ] **Step 3: Implement the manager**

用单流索引、generation 和统一 `cleanup(streamId, outcome)`；所有定时器在 terminal 清除；Provider 写入先检查 ready 状态；不缓存音频，不写临时文件。

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run apps/agent/test/asr/asr-stream-manager.test.ts`  
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add apps/agent/src/asr/asr-stream-manager.ts apps/agent/test/asr/asr-stream-manager.test.ts
git commit -m "feat: manage single ASR stream lifecycle"
```

### Task 6: AsrGateway `/ws/asr` 鉴权、限流与连接状态

**Files:**
- Create: `apps/agent/src/asr/asr-gateway.ts`
- Test: `apps/agent/test/asr/asr-gateway.test.ts`

**Interfaces:**
- Consumes: Task 2 `validateAsrControlMessage`、Task 5 `AsrStreamManager`、S01 设备鉴权。
- Produces:

```ts
type AsrGatewayOptions = {
  authenticate: (request: FastifyRequest) => Promise<{ deviceId: string } | null>
  manager: AsrStreamManager
  now?: () => number
}
class AsrGateway {
  constructor(options: AsrGatewayOptions)
  attach(app: FastifyInstance): void
  closeAll(reason: string): void
}
```

- [ ] **Step 1: Write failing handshake and frame tests**

无/错 token 在发送任何消息前关闭；首条必须是合法 `asr.start`（≤4 KiB）；带 endpoint/Key/resourceId/sessionId 等额外字段拒绝；同一连接第二个 start → `ASR_STREAM_CONFLICT` 并关闭；start 前或 terminal 后二进制忽略；奇数字节、空帧、超过 6,400 bytes → `ASR_INVALID_AUDIO` 并终止；finish 在 connecting 中按 cancel 处理；cancel 立即终止；第 11 次 start/分钟 → `ASR_RATE_LIMITED`；重复/replay messageId 不创建新流。

- [ ] **Step 2: Write failing event queue tests**

Mac→App 队列最多 4 条：partial 只保留最新；final/error 清除旧 partial 并优先发送；超限以 `ASR_BACKPRESSURE` 取消流；closed 是最后一条；fake journal/seq 从未被调用；音频断开且未 finish 一律 cancel。

- [ ] **Step 3: Run tests to verify they fail**

Run: `npx vitest run apps/agent/test/asr/asr-gateway.test.ts`  
Expected: FAIL with missing gateway。

- [ ] **Step 4: Implement the gateway**

`attach` 在既有 WSS server 上注册独立 `/ws/asr`；每条连接持有单一 streamId、generation 和事件队列；所有终止路径调用 manager 的幂等 cancel/close；错误只发送安全 code/retryable/safeMessage。

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run apps/agent/test/asr/asr-gateway.test.ts`  
Expected: PASS。

- [ ] **Step 6: Commit**

```bash
git add apps/agent/src/asr/asr-gateway.ts apps/agent/test/asr/asr-gateway.test.ts
git commit -m "feat: add authenticated ASR audio gateway"
```

### Task 7: Mac wiring、独立路由与集成回归

**Files:**
- Create: `apps/agent/src/asr/asr-runtime.ts`
- Modify: `apps/agent/src/app/runtime.ts`
- Test: `apps/agent/test/integration/s05-agent-flow.test.ts`

**Interfaces:**
- Consumes: Task 3 `loadAsrConfig`/`createDoubaoAsrProvider`、Task 6 `AsrGateway`、S01 revoke/pair replace 钩子。
- Produces:

```ts
type AsrRuntime = {
  gateway: AsrGateway | null
  status: 'configured' | 'not_configured'
  close(reason: string): void
}
createAsrRuntime(input: {
  app: FastifyInstance
  env: NodeJS.ProcessEnv
  authenticate: AsrGatewayOptions['authenticate']
  onRevoke: (listener: (reason: string) => void) => void
}): AsrRuntime
```

- [ ] **Step 1: Write failing integration tests**

真实 Fastify/WSS + fake Provider 覆盖：start→binary→finish→final→closed；cancel；Provider error；文本队列背压；缺 API Key 时 start 返回 `ASR_NOT_CONFIGURED` 且主控制与文字输入正常；revoke/pair replace 关闭音频并取消 Provider；主控制 WSS 断开不影响独立音频流；ASR 事件不进入 EventJournal、session seq、commands 或 audit_logs。

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run apps/agent/test/integration/s05-agent-flow.test.ts`  
Expected: FAIL with missing asr runtime/route。

- [ ] **Step 3: Implement the single wiring**

`asr-runtime.ts` 只在 API Key 存在时创建 Provider/Manager/Gateway；缺 Key 保留可识别错误而不阻止 Agent 启动；`runtime.ts` 只调用一次 `attach`，不建立第二条广播路径或 ASR 持久队列。

- [ ] **Step 4: Run integration tests and coverage**

Run: `npx vitest run apps/agent/test/integration/s05-agent-flow.test.ts && npm run coverage:agent`  
Expected: PASS；核心 TypeScript 业务逻辑覆盖率 ≥80%，S01–S04 回归不失败。

- [ ] **Step 5: Commit**

```bash
git add apps/agent/src/asr/asr-runtime.ts apps/agent/src/app/runtime.ts apps/agent/test/integration/s05-agent-flow.test.ts
git commit -m "feat: wire isolated ASR runtime into Mac agent"
```

### Task 8: Flutter PCM 采集、分包与 VAD

**Files:**
- Create: `apps/mobile/lib/voice/pcm_packetizer.dart`, `apps/mobile/lib/voice/audio_level.dart`, `apps/mobile/lib/voice/speech_vad.dart`, `apps/mobile/lib/voice/voice_audio_capture.dart`
- Test: `apps/mobile/test/voice/pcm_packetizer_test.dart`, `audio_level_test.dart`, `speech_vad_test.dart`, `voice_audio_capture_test.dart`

**Interfaces:**
- Produces:

```dart
class PcmPacketizer {
  PcmPacketizer({int packetBytes = 6400});
  List<Uint8List> add(Uint8List chunk);
  Uint8List? flush();
}

double rmsDbfsPcm16(Uint8List pcm);

enum VadAction { none, autoFinish }
class SpeechVad {
  SpeechVad({
    double speechThresholdDbfs = -40,
    double silenceThresholdDbfs = -45,
    Duration minSpeech = const Duration(milliseconds: 500),
    Duration silenceToFinish = const Duration(milliseconds: 1500),
  });
  VadAction addSample({required double rmsDbfs, required Duration at});
}

abstract interface class VoiceAudioCapture {
  Future<bool> hasPermission();
  Future<Stream<Uint8List>> start();
  Future<void> stop();
  Future<void> dispose();
}
class RecordVoiceAudioCapture implements VoiceAudioCapture { ... }
```

- [ ] **Step 1: Write failing packetizer and level tests**

任意 chunk 组合都只输出 6,400-byte 帧；10-byte 小包累积；奇数输入残留 1 byte 并在下一块补齐；`flush()` 返回非空偶数包或 null；任何输出都不是奇数长度且不超过 6,400；RMS 对静音、满幅和半幅 PCM16 返回预期 dBFS。

- [ ] **Step 2: Write failing capture and VAD tests**

`RecordVoiceAudioCapture` 使用 `AudioEncoder.pcm16bits`、16,000 Hz、单声道且不创建文件；权限拒绝返回 false。VAD 先累计 500 ms 高于 -40 dBFS 才进入语音，之后连续 1,500 ms 低于 -45 dBFS 才 autoFinish；语音前静音永不 autoFinish；中途恢复语音重置静音计时。

- [ ] **Step 3: Run tests to verify they fail**

Run: `cd apps/mobile && flutter test test/voice/pcm_packetizer_test.dart test/voice/audio_level_test.dart test/voice/speech_vad_test.dart test/voice/voice_audio_capture_test.dart`  
Expected: FAIL with missing packetizer/VAD/capture。

- [ ] **Step 4: Implement packetization and VAD**

分包器在内存中保留不足一帧的字节，不拆分 16-bit sample；VAD 只产生辅助提示和 autoFinish，不是安全边界；capture 封装 `record 7.1.2` 的 `AudioRecorder.startStream`，停止后释放 recorder。

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd apps/mobile && flutter test test/voice`  
Expected: PASS。

- [ ] **Step 6: Commit**

```bash
git add apps/mobile/lib/voice apps/mobile/test/voice
git commit -m "feat: capture and packetize PCM audio on iPhone"
```

### Task 9: RecoveryStore v2 与 voice_drafts

**Files:**
- Create: `apps/mobile/lib/voice/voice_draft.dart`, `apps/mobile/lib/voice/voice_draft_repository.dart`
- Modify: `apps/mobile/lib/recovery/recovery_database.dart`, `apps/mobile/lib/recovery/recovery_store.dart`
- Test: `apps/mobile/test/voice/voice_draft_repository_test.dart`, `apps/mobile/test/recovery/recovery_migration_v2_test.dart`

**Interfaces:**
- Consumes: S04 `RecoveryDatabase`、drafts 表与 `sqflite` FFI 测试方式。
- Produces:

```dart
class VoiceDraft {
  final String voiceDraftId;
  final String asrStreamId;
  final String originSessionId;
  final String originalDraft;
  final String combinedDraft;
  final String status; // 'pending'
  final DateTime createdAt;
}

class VoiceDraftRepository {
  VoiceDraftRepository(this._db);
  final Database _db;
  Future<VoiceDraft> commitFinal({
    required String voiceDraftId,
    required String asrStreamId,
    required String originSessionId,
    required String originalDraft,
    required String finalText,
  });
  Future<List<VoiceDraft>> pendingForSession(String sessionId);
  Future<VoiceDraft?> find(String voiceDraftId);
  Future<void> restoreOriginal(String voiceDraftId);
  Future<void> deleteWithin(Transaction txn, String voiceDraftId);
}
```

- [ ] **Step 1: Write failing v1→v2 migration tests**

用 v1 测试库写入 outbox_commands、sync_cursors、cached_events、cached_sessions 和 drafts 后重开 v2：五类旧数据逐行保留，仅新增 `voice_drafts`；表列严格为 voiceDraftId/asrStreamId/originSessionId/originalDraft/combinedDraft/status/createdAt，无 partial/audio/API Key 列；status 只允许 pending。

- [ ] **Step 2: Write failing commit and cancel tests**

原草稿非空时以单个换行追加 final，空时只用 final；录音后当前草稿被外部改变时仍追加而非覆盖；`commitFinal` 的 drafts 更新与 voice_drafts 插入同事务，注入失败后两者都不存在；`restoreOriginal` 恢复 originalDraft 并删除行，同事务；重开 App 后 pending 仍可读；合并超过 16 KiB 仍保存且可编辑；S04 `RecoveryStore.clearAll()`/unpair/replace 后 voice_drafts 为空。

- [ ] **Step 3: Run tests to verify they fail**

Run: `cd apps/mobile && flutter test test/voice/voice_draft_repository_test.dart test/recovery/recovery_migration_v2_test.dart`  
Expected: FAIL with missing schema v2/repository。

- [ ] **Step 4: Implement incremental migration and repository**

`RecoveryDatabase` schemaVersion 改为 2，`onUpgrade` 只执行 `CREATE TABLE IF NOT EXISTS voice_drafts` 和索引；`commitFinal`/`restoreOriginal` 都通过 `RecoveryDatabase.transaction` 同时修改 drafts 与 voice_drafts，不重建数据库。

- [ ] **Step 5: Run tests and S04 recovery regressions**

Run: `cd apps/mobile && flutter test test/voice/voice_draft_repository_test.dart test/recovery`  
Expected: PASS；S04 outbox/cursor/cache/drafts 回归不失败。

- [ ] **Step 6: Commit**

```bash
git add apps/mobile/lib/voice/voice_draft.dart apps/mobile/lib/voice/voice_draft_repository.dart apps/mobile/lib/recovery apps/mobile/test/voice apps/mobile/test/recovery
git commit -m "feat: persist voice drafts with schema v2"
```

### Task 10: VoiceAsrClient 与 VoiceInputController 状态机

**Files:**
- Create: `apps/mobile/lib/voice/voice_asr_client.dart`, `apps/mobile/lib/voice/voice_ui_state.dart`, `apps/mobile/lib/voice/voice_input_controller.dart`
- Test: `apps/mobile/test/voice/voice_asr_client_test.dart`, `voice_input_controller_test.dart`

**Interfaces:**
- Consumes: Task 2 消息 schema；Task 8 `VoiceAudioCapture`/`SpeechVad`/`PcmPacketizer`；Task 9 `VoiceDraftRepository`；S01 ConnectionController 的 URL/token。
- Produces:

```dart
sealed class AsrServerEvent {}
final class AsrStarted extends AsrServerEvent { final String asrStreamId; }
final class AsrPartial extends AsrServerEvent { final String asrStreamId; final int sequence; final String text; }
final class AsrFinal extends AsrServerEvent { final String asrStreamId; final int sequence; final String text; }
final class AsrServerError extends AsrServerEvent { final String asrStreamId; final String code; final bool retryable; final String safeMessage; }
final class AsrCancelled extends AsrServerEvent { final String asrStreamId; final String reason; }
final class AsrClosed extends AsrServerEvent { final String asrStreamId; final String reason; }

abstract interface class VoiceAsrConnection {
  Stream<AsrServerEvent> get events;
  Future<void> sendStart({required String asrStreamId});
  void sendAudio(Uint8List pcm);
  void sendFinish();
  void sendCancel();
  Future<void> close();
}
abstract interface class VoiceAsrClientFactory {
  Future<VoiceAsrConnection> connect();
}

sealed class VoiceUiState {}
final class VoiceIdle extends VoiceUiState {}
final class VoiceConnecting extends VoiceUiState {}
final class VoiceRecording extends VoiceUiState {
  final String asrStreamId; final Duration elapsed;
  final String partialText; final bool speechDetected;
}
final class VoiceFinalizing extends VoiceUiState { final String asrStreamId; }
final class VoiceErrorState extends VoiceUiState {
  final String code; final String safeMessage; final bool retryable;
}

abstract interface class VoiceDraftAccess {
  String get selectedSessionId;
  String draftOf(String sessionId);
  void setDraft(String sessionId, String text);
  void showVoiceError(String code, String safeMessage);
}

enum VoiceCancelReason { user, background, interruption, socketClosed, agentRestarted }

class VoiceInputController {
  VoiceInputController({
    required VoiceAsrClientFactory clientFactory,
    required VoiceAudioCapture capture,
    required VoiceDraftRepository drafts,
    required VoiceDraftAccess access,
    SpeechVad? vad,
    PcmPacketizer? packetizer,
  });
  VoiceUiState get state;
  Stream<VoiceUiState> get states;
  Future<void> press();
  Future<void> release();
  Future<void> cancel(VoiceCancelReason reason);
  Future<void> dismissError();
  void dispose();
}
```

- [ ] **Step 1: Write failing client tests**

连接 `/ws/asr` 时 token 只在 `Authorization` header、不在 URL；start/finish/cancel 符合 schema；音频只发二进制；解析 started/partial/final/error/cancelled/closed；未知 type、错误 sequence、closed 后事件丢弃；socket 关闭映射 `socketClosed`；不自动重连；待发送音频队列超过 20 包时以 `ASR_BACKPRESSURE` 终止且不无限排队。

- [ ] **Step 2: Write failing controller race tests**

权限拒绝 → `ASR_PERMISSION_DENIED`，麦克风不启动；麦克风启动失败 → `ASR_MIC_UNAVAILABLE`；权限/connecting 阶段松手 → cancel 且不采集、不 finalize；迟到的 started 被忽略；started 后才采集；release → finalizing → final 只写 origin session，selectedSessionId 不变；取消后迟到 final 丢弃；旧 asrStreamId/sequence 不覆盖新状态；60 秒和 VAD autoFinish；background/interruption/socketClosed 取消且不自动恢复，电话打断显示 `ASR_INTERRUPTED` 安全状态；agentRestarted 取消；旧 Mac 拒绝 `/ws/asr` 时安全失败且文字输入仍可用；错误映射安全文案。

- [ ] **Step 3: Run tests to verify they fail**

Run: `cd apps/mobile && flutter test test/voice/voice_asr_client_test.dart test/voice/voice_input_controller_test.dart`  
Expected: FAIL with missing client/controller。

- [ ] **Step 4: Implement client and state machine**

一次 press 生成一个 asrStreamId 和 UI generation；originSessionId/originalDraft 在 press 时捕获；final 经 `VoiceDraftRepository.commitFinal` 写入后用 `VoiceDraftAccess.setDraft` 更新 origin 草稿；partial 只保存在内存和 UI 状态；所有终止路径走同一幂等 `cleanup()`。

- [ ] **Step 5: Run tests and S00 ASR regressions**

Run: `cd apps/mobile && flutter test test/voice`，并运行 Task 0 记录的 S00 ASR-01–08 fake Provider 契约测试路径  
Expected: PASS，S00 契约不回归，无自动重连/自动 prompt。

- [ ] **Step 6: Commit**

```bash
git add apps/mobile/lib/voice apps/mobile/test/voice
git commit -m "feat: add hold-to-talk voice state machine"
```

### Task 11: Composer 草稿合并与单次 prompt.send

**Files:**
- Create: `apps/mobile/lib/voice/voice_send_coordinator.dart`
- Modify: `apps/mobile/lib/connection/persistent_command_coordinator.dart`, `apps/mobile/lib/features/chat/`（现有 Composer/发送入口）
- Test: `apps/mobile/test/voice/voice_send_coordinator_test.dart`, `apps/mobile/test/features/chat/composer_voice_test.dart`

**Interfaces:**
- Consumes: S04 `PersistentCommandCoordinator.send`、Task 9 `VoiceDraftRepository`、Task 10 pending voice draft 状态。
- Produces:

```dart
// S04 coordinator 增加同事务回调，不新增第二套 outbox
Future<PersistentSendOutcome> send(
  CommandRequest request, {
  FutureOr<void> Function(Transaction txn)? withinTransaction,
});

class VoiceSendCoordinator {
  VoiceSendCoordinator({
    required PersistentCommandCoordinator commands,
    required VoiceDraftRepository drafts,
  });
  Future<PersistentSendOutcome> sendPrompt({
    required CommandRequest request,
    String? voiceDraftId,
  });
}
```

- [ ] **Step 1: Write failing atomicity tests**

有 voiceDraftId 时，outbox 插入与 voice_drafts 删除在同一事务提交；事务失败时两者都不存在；无 voiceDraftId 时行为与 S04 完全相同；发送文本是编辑后的完整草稿；同一 commandId 重复点击只产生一个 prompt；confirmation_required 时 voice_draft 保留；final 到达后不自动发送。

- [ ] **Step 2: Write failing cancel and composer tests**

“取消本次语音”恢复 originalDraft 并删除 voice_drafts，不创建 prompt；已有草稿追加 final 后普通发送只读当前编辑文本；ASR 错误/未配置时文字 Composer 仍可用；切换 session 后发送只作用于当前 session 的草稿。

- [ ] **Step 3: Run tests to verify they fail**

Run: `cd apps/mobile && flutter test test/voice/voice_send_coordinator_test.dart test/features/chat/composer_voice_test.dart`  
Expected: FAIL with missing coordinator/transaction hook。

- [ ] **Step 4: Implement the atomic send path**

`VoiceSendCoordinator` 只调用既有 `PersistentCommandCoordinator.send`，把 `deleteWithin` 作为 `withinTransaction` 传入；不创建新 commandId、不绕过执行意图门控、不添加语音专用执行按钮或审批。

- [ ] **Step 5: Run tests and S04 outbox regressions**

Run: `cd apps/mobile && flutter test test/voice test/recovery test/features/chat`  
Expected: PASS，无重复 prompt、无自动重试、同 session 门控仍有效。

- [ ] **Step 6: Commit**

```bash
git add apps/mobile/lib/voice/voice_send_coordinator.dart apps/mobile/lib/connection apps/mobile/lib/features/chat apps/mobile/test/voice apps/mobile/test/features/chat
git commit -m "feat: send voice drafts through the ordinary composer"
```

### Task 12: iPhone 语音界面与中断桥

**Files:**
- Create: `apps/mobile/lib/features/chat/voice_input_button.dart`, `voice_recording_panel.dart`, `voice_draft_banner.dart`
- Create: `apps/mobile/lib/voice/voice_interruption_bridge.dart`, `apps/mobile/ios/Runner/AudioInterruptionBridge.swift`
- Modify: `apps/mobile/ios/Runner/Info.plist`, `AppDelegate.swift`, `apps/mobile/lib/features/chat/chat_page.dart`
- Test: `apps/mobile/test/features/chat/voice_input_button_test.dart`, `voice_recording_panel_test.dart`, `voice_draft_banner_test.dart`

**Interfaces:**
- Consumes: Task 10 `VoiceInputController`、Task 11 `VoiceSendCoordinator`。
- Produces: `enum VoiceInterruption { began, ended }`、`VoiceInterruptionBridge.events: Stream<VoiceInterruption>` 与 `VoiceInputButton`/`VoiceRecordingPanel`/`VoiceDraftBanner` Widget。

- [ ] **Step 1: Write failing widget tests**

按住开始、松开发 finish、滑入取消区松手取消；connecting/权限阶段松手不启动采集；partial 替换展示而不拼接；计时、音量/静音提示和 60 秒文案正确；final 追加后输入框可编辑；切换 session 显示 origin 草稿横幅；后台/错误遮罩清 partial；权限拒绝显示安全文案；ASR 不可用时麦克风禁用但文字输入可用；按钮文案不把“完成识别”写成“发送”。

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd apps/mobile && flutter test test/features/chat/voice_input_button_test.dart test/features/chat/voice_recording_panel_test.dart test/features/chat/voice_draft_banner_test.dart`  
Expected: FAIL with missing widgets。

- [ ] **Step 3: Implement the UI and interruption bridge**

Widget 只调用 controller/coordinator 的公开方法，不自行创建命令或持久状态；Swift 用 `AVAudioSession.interruptionNotification` 经 EventChannel 上报，`Info.plist` 只新增 `NSMicrophoneUsageDescription`，不新增 Speech 权限。

- [ ] **Step 4: Run tests and Flutter coverage**

Run: `cd apps/mobile && flutter test test/features/chat test/voice --coverage`  
Expected: PASS；核心 Dart 业务逻辑覆盖率 ≥80%，S02/S03/S04 交互回归不失败。

- [ ] **Step 5: Commit**

```bash
git add apps/mobile/lib/features/chat apps/mobile/lib/voice/voice_interruption_bridge.dart apps/mobile/ios apps/mobile/test/features/chat
git commit -m "feat: add iPhone hold-to-talk voice experience"
```

### Task 13: E2E-01–14、退出门禁与证据

**Files:**
- Create: `scripts/s05/verify-gate.ts`, `scripts/s05/verify-gate.test.ts`, `scripts/s05/check-secrets.ts`, `scripts/s05/check-secrets.test.ts`
- Create: `docs/s05/e2e-checklist.md`, `docs/s05/rollback.md`, `docs/s05/exit-report.md`
- Modify: `package.json`

**Interfaces:**
- Produces: `npm run test:s05`、`npm run test:s05:live`、`npm run verify:s05`。
- Produces: ASR-00、E2E-01–14、覆盖率、密钥/音频/主协议不变量的 PASS/FAIL/BLOCKED 台账；Mock 不得替代真实证据。

- [ ] **Step 1: Write failing gate and secret-scan tests**

gate 在 ASR-00 未 PASS、E2E 缺失、覆盖率 <80%、发现 API Key/Authorization/原始音频、App 包含环境变量名值、Funnel 开启或主 session seq 改变时失败；secret 扫描识别 `DOUBAO_ASR_API_KEY=` 非空值、`X-Api-Key:` 实值、device token 和 `.pcm/.wav` 证据文件。

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run scripts/s05`  
Expected: FAIL with missing gate/scanner。

- [ ] **Step 3: Implement the gates**

`verify-gate.ts` 只读取脱敏证据和固定路径，不访问真实 Key；任何 BLOCKED/FAIL 都以非零退出并列出缺口；`check-secrets.ts` 不打印匹配内容。在 `package.json` 注册 `test:s05`、`test:s05:live`、`verify:s05`，其中 live 仅在 `S05_LIVE=1` 时执行真实调用。

- [ ] **Step 4: Execute E2E-01–14 on the physical iPhone**

Run: `S05_LIVE=1 npm run test:s05:live`  
Expected: 按 spec 逐项真实通过，并记录版本、时间、traceId/streamId 和副作用次数：E2E-01 未配置/错误凭证；E2E-02 拒绝麦克风权限；E2E-03 中文 final 编辑后单次发送；E2E-04 原草稿非空并取消；E2E-05 录音中切换 session；E2E-06 重复点击/网络重试；E2E-07 取消后迟到 final；E2E-08 connecting/权限阶段松手；E2E-09 锁屏/后台/电话打断；E2E-10 finalize 超时/空 final；E2E-11 Provider 过载/主控制高负载；E2E-12 Agent 重启/revoke；E2E-13 60 秒/VAD/背压；E2E-14 final 后 App 被杀再重开。缺设备/凭证时记录 BLOCKED，不能以模拟器或 fake 代替。

- [ ] **Step 5: Verify rollback and privacy boundaries**

停止 Agent、取消活跃 ASR 流；确认回滚只需移除 ASR 配置/路由，不修改 `settings.json`、不删除主控制历史；App schema v2 为前向迁移，旧 App 不得静默降级或清库；检查 Mac/iPhone 无音频文件、无 Key、无协议原文，voice_drafts 可按用户选择保留或清除。

- [ ] **Step 6: Run full verification**

Run: `npm run test:s05 && npm run coverage:agent && cd apps/mobile && flutter test --coverage && cd ../.. && S05_LIVE=1 npm run test:s05:live && npm run verify:s05`  
Expected: 全部 PASS，Agent/Dart 覆盖率 ≥80%，E2E-01–14 全 PASS，无密钥/音频泄漏，无自动执行或自动恢复。

- [ ] **Step 7: Write the exit report**

记录真实结果和限制：单流 60 秒、无自动 ASR 重试、无音频恢复、无语音审批、无 App 直连、无多厂商；API Key 仅环境变量且轮换需重启；FileVault/Data Protection 而非 SQLCipher。任何 FAIL/BLOCKED 都停止 S05 验收，不进入 S06。

- [ ] **Step 8: Commit**

```bash
git add apps scripts/s05 docs/s05 protocol/v1 package.json
git commit -m "test: verify S05 voice input on Mac and iPhone"
```