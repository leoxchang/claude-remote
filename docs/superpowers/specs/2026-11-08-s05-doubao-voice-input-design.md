# S05 详细 Spec：豆包语音输入

**版本：** V1.0  
**日期：** 2026-11-08  
**状态：** 设计评审稿，已完成独立实现检查与修订  
**上游文档：**
- `claude-code-mobile-control-architecture.md`
- `docs/superpowers/specs/2026-11-07-personal-mobile-claude-control-spec-breakdown-design.md`
- `docs/superpowers/specs/2026-11-07-s00-technical-validation-protocol-design.md`
- `docs/superpowers/specs/2026-11-08-s02-multi-workspace-multi-session-design.md`
- `docs/superpowers/specs/2026-11-08-s03-mobile-permission-approval-design.md`
- `docs/superpowers/specs/2026-11-08-s04-persistence-reconnect-recovery-design.md`

**豆包官方设计依据（2026-11-08 核对）：**
- `https://docs.volcengine.com/docs/doubao-voice/access-must-read-1-1?lang=zh`
- `https://docs.volcengine.com/docs/doubao-voice/bidirectional-streaming-automatic-speech-recognition-websocket?lang=zh`
- `https://docs.volcengine.com/docs/6561/2534847?lang=zh`
- `https://docs.volcengine.com/docs/6561/2611432?lang=zh`

## 1. 目的与成功结果

S05 在现有 iPhone 对话页增加按住说话的中文语音输入。首个且唯一正式 Provider 是豆包流式语音识别 2.0；Mac 持有长期凭证并提供独立音频代理，iPhone 不接触豆包密钥。

语音只负责生成可编辑草稿，不负责执行。成功时，用户可以：

1. 按住麦克风，看到连接、录音、计时、partial 和静音/音量状态；
2. 松开或静音辅助结束后等待唯一 final，并在原 session 的输入框中编辑；
3. 取消录音、清除本次语音草稿或恢复原输入内容，不产生 prompt；
4. 切换 session 后仍让结果回到开始录音的 session，不串到其他草稿；
5. 点击普通发送按钮，经 S04 PersistentCommandCoordinator 只产生一个 prompt.send；
6. 在权限拒绝、无 final、Provider 错误、断线、退后台、电话打断和 Agent 重启时得到明确状态，文字输入和既有 run/审批不受影响；
7. 确认原始音频不写 Mac/App 长期存储，豆包长期凭证不进入 App、协议、日志或数据库。

## 2. 入口条件与 ASR-00 真实门禁

开始 S05 前必须满足：

- S00 Core、S01、S02、S03、S04 全部验收通过；
- S04 mutating outbox、同 session 执行意图门控、草稿持久化和 agentInstanceId 恢复语义可复用；
- 固定 Flutter `record 7.1.2`、Mac `ws 8.22.1`、`@types/ws 8.18.2`；
- 豆包服务已开通，API Key 只由 Mac 本地安全注入；当前设计编写时没有可用凭证，真实门禁仍为 NOT_RUN/BLOCKED；
- 真实测试只使用无隐私的合成或明确授权中文音频，不录制个人项目对话。

ASR-00 必须先于产品 Provider/代理实现，验证：

1. 固定 endpoint 的 TLS、X-Api-Key、X-Api-Resource-Id 和 X-Api-Request-Id 鉴权；
2. 16 kHz、mono、signed PCM16 little-endian 无 WAV header 音频，200 ms 包的真实可识别性；
3. 中文单句、多句和中英混合音频的 partial、utterance definite、整流 final/is_last_package 语义；
4. `result.text` 与 utterances 是全量快照还是增量，防止重复拼接；final 重复/空文本/迟到事件处理；
5. finish 最后一包的真实封装、连接结束顺序和 10 秒无 final 行为；
6. cancel 是否有官方帧；若没有，以关闭 Provider socket 为取消并验证迟到结果被丢弃；
7. 无效凭证、错误 resourceId、空音频、8 秒无音频、服务过载和限流的真实错误；
8. record 7.1.2 在真实 iPhone 的 startStream 是否产出所声明 PCM 格式，电话中断是否需额外原生监听；
9. 官方是否出现适合 iOS 的短期凭证；在没有新证据前不得改为 App 直连或下发动态 API Key；
10. 保存脱敏协议映射、官方二进制 framing 依据和测试结果，不保存 API Key、请求头或真实个人音频。

ASR-00 未通过时，S05 产品实现保持 BLOCKED。fake Provider 只能证明内部契约，不能替代上述证据。

**当前文档基线：**本仓库目前只有架构、spec 和计划文档，没有已落地的 S00–S04 TypeScript/Dart 产品实现。S05 是 spec-to-spec 设计；实施 Task 0 必须核对届时的 Fastify/WSS 鉴权、RecoveryStore drafts/outbox、revoke 和 agentInstanceId 真实接口，不能假定今天已有这些类。

**服务与计费开通：**开通豆包语音服务、创建 API Key、选择 `volc.seedasr.sauc.duration` 或 `volc.seedasr.sauc.concurrent` 是用户在火山引擎控制台完成的外部前置条件，不由助手代购、开通或决定计费方案。设计默认 duration 仅用于契约和测试示例；实际 resourceId 由用户在 ASR-00 前选择并注入，未提供有效服务/凭证时保持 BLOCKED。

**真实设备前提：**ASR-00 和 E2E 需要可签名的真实 iPhone、同一 tailnet 的 Mac，以及无隐私的合成/明确授权中文音频。当前没有这些环境已就绪的证据；实施 Task 0 必须逐项验证，缺任一项即 BLOCKED，不能以桌面 fake/模拟器结果替代。

## 3. 目标、非目标与反目标

### 3.1 目标

- Mac 唯一持有豆包 X-Api-Key，固定官方 endpoint 和允许的资源 ID；
- 音频使用独立认证 `/ws/asr` 连接，与主控制 WSS 隔离；
- Provider 中立语义沿用 S00：start/write/finalize/cancel、partial/final/error/cancelled/closed；
- 一次录音一个 asrStreamId、一个音频 WSS 连接、一个 Provider 连接，全局最多一个活跃流；
- 原始音频仅经有界内存转发，不落盘、不进主协议、Journal、SQLite 或 RecoveryStore；
- partial 只展示，final 才进入原 session 草稿；用户编辑/取消/确认后才可能 prompt.send；
- 退后台、锁屏、电话打断、取消、音频 socket 断开均停止采集和 Provider 流；
- ASR 错误不影响主控制、文字草稿、活跃 run 和权限审批；
- final 草稿和实际发送文本沿用 S04 数据保护、outbox 和保留边界。

### 3.2 非目标

S05 不包含：

- App 直连豆包、App 保存长期/动态 API Key、自行实现短期凭证；
- 多 ASR 厂商、离线识别、说话人识别、翻译、热词/自定义词表；
- 后台连续录音、唤醒词、TTS、语音对话和端到端实时语音模型；
- 自动改写/润色 final 的 LLM、语音直接执行、语音权限审批；
- 原音频历史、音频文件上传、ASR 事件持久审计或跨重启恢复音频流；
- 自动重试已发送部分音频的 ASR 流，或从中间音频断点续传；
- 多路同时录音、多设备 ASR、Relay、公网 Funnel；
- 将端到端实时语音 Seeduplex 与本次 ASR bigmodel_async 混为同一产品。

### 3.3 反目标

以下结果视为失败：

- final、partial 或用户松手自动生成 prompt.run/工具调用/审批 allow；
- 将 API Key 放进 Flutter、二维码、WSS 消息、URL、日志或 SQLite；
- 在主控制 WSS 中发送音频二进制帧，或让 ASR 事件占用 session seq；
- cancel 后旧 final 写入草稿，旧 stream 覆盖新 stream；
- 把全量 text 快照当 delta 拼接，造成重复文本；
- App 退后台或电话打断仍继续采集/转发音频；
- 网络背压导致音频内存无限增长，或控制消息被音频阻塞；
- ASR 未配置/失败时禁用普通文字输入；
- 为“断线恢复”而自动重播音频、恢复 Provider 流或重发 prompt。

## 4. 方案比较与选择

### 4.1 方案 A：Mac 独立音频代理（选定）

iPhone 经独立认证 WSS 将 PCM 音频发送到 Mac，Mac 使用 ws 连接豆包 bigmodel_async，并转发规范化文本事件。

优点：长期凭证不离开 Mac；可使用当前已验证静态 X-Api-Key；与主协议隔离。  
代价：需要二进制 Provider Adapter 和一层音频转发。

### 4.2 方案 B：iPhone 直连豆包

优点：少一层转发和 Mac 带宽。  
缺点：目前没有官方短期 iOS 凭证证据，长期 X-Api-Key 进入 App 违反既定边界。

**结论：**采用方案 A。未来只有在新的官方短期凭证证据和独立 spec 下才重新考虑 B。

## 5. 总体结构

```text
iPhone
  ├─ record 7.1.2 → PCM16 packetizer（200 ms）
  ├─ VoiceInputController / VAD / interruption handling
  ├─ Per-session voice draft + 普通 Composer
  └─ 独立 IOWebSocketChannel /ws/asr
                 │ Bearer device credential
                 │ JSON control + binary PCM（非主控制 WSS）
                 ▼
Mac Agent
  ├─ AsrGateway（一连接一流、鉴权、限流、背压）
  ├─ AsrStreamManager（stream generation、cancel、清理）
  ├─ DoubaoAsrProvider（唯一豆包协议/密钥边界）
  └─ AsrEventNormalizer（partial/final 唯一化、安全错误）
                 │ ws 8.22.1 + X-Api-Key
                 ▼
wss://openspeech.bytedance.com/api/v3/sauc/bigmodel_async
```

ASR 不调用 Claude Agent SDK，不进入 RunController、EventJournal、PermissionBroker 或 S04 commands/events 表。

## 6. 豆包 Provider 边界

### 6.1 固定配置

```text
ASR_PROVIDER=doubao
DOUBAO_ASR_API_KEY=
DOUBAO_ASR_RESOURCE_ID=volc.seedasr.sauc.duration
```

- endpoint 固定为 `wss://openspeech.bytedance.com/api/v3/sauc/bigmodel_async`，不提供 App/Mac 普通配置任意覆盖，防止凭证被导向恶意服务；测试通过 Provider factory 注入 fake。
- resourceId 只允许 `volc.seedasr.sauc.duration` 或 `volc.seedasr.sauc.concurrent`，默认 duration；模型 1.0 legacy 不在本版范围。
- Provider 请求使用 `X-Api-Key`、所选 `X-Api-Resource-Id`、每流唯一 `X-Api-Request-Id`；requestId 不等于 deviceToken，也不作为认证 App 的依据。
- `model_name='bigmodel'`、`format='pcm'、rate=16000、bits=16、channel=1`；`show_utterances=true` 和 `end_window_size=800` 的映射由 ASR-00 证据固定。
- 不沿用 S00 猜测的 APP_ID/ACCESS_TOKEN/MODEL/ENDPOINT 占位；legacy 鉴权不作为本版第二套实现。
- API Key 只从 Mac 进程启动时的 `DOUBAO_ASR_API_KEY` 环境变量读取并保存在 Provider 配置内存，禁止经命令行参数传入，避免进入进程列表；S05 不实现 macOS Keychain/秘密服务组件。测试通过受控环境或 fake factory 注入，日志只记录字段名。
- 缺少 API Key 时仅 ASR 显示 ASR_NOT_CONFIGURED，Agent 其他功能照常启动；Key 只在 Agent 重启时重新读取，轮换需重启，不提供手机或运行中热更新。S06 配置 launchd 时必须显式解决环境注入并重跑 ASR-00，不能假设交互 shell 环境会继承。
- API Key 不写 agent.json、SQLite、Dart、日志或示例。

### 6.2 Provider 中立接口

```ts
type AsrProvider = {
  start(config:AsrProviderStart):Promise<AsrProviderHandle>
  write(handle:AsrProviderHandle,audio:Uint8Array):void
  finalize(handle:AsrProviderHandle):void
  cancel(handle:AsrProviderHandle):void
}

type AsrProviderHandle = {
  asrStreamId:string
  events:AsyncIterable<AsrProviderEvent>
}
```

- start 在 10 秒内未完成返回 ASR_CONNECTION_FAILED；write/finalize/cancel 不产生 Promise 驱动的无限等待。
- finalize 只发送 ASR-00 已验证的最后一包并等待事件，不自行拼接“最终答案”。
- cancel 立即将本地 handle 标为 terminal；有官方 cancel 帧则发送，否则关闭 Provider socket，随后丢弃所有迟到事件。
- Provider 原始响应、音频和文本不得写日志；官方 log_id 可作为安全诊断元数据保存。
- 非 2xx/业务 code 统一映射为安全错误，不将原始 payload 回传 App。

### 6.3 partial/final 归一化

- Mac 为每流分配单调 `sequence`，从 1 开始；这不是 Claude session seq。
- partial.text 是**当前识别快照**，不是 delta；App 只替换当前 partial，不做字符串累加。
- utterance definite 只表示该句稳定，不等于整流 final，不自动结束录音。
- final 只能在 App/ Mac 已进入 finalizing 后接受，并要求 ASR-00 证明的整流终包条件；每流最多发一次。
- final 为全空白、超过 16,384 UTF-8 字节、Provider 在 recording 中提前结束或无法确认整流终态时，返回 ASR_EMPTY_RESULT/ASR_RESULT_TOO_LARGE/ASR_PROVIDER_ENDED，不生成候选草稿。
- final 后重复 final、迟到 partial 和旧 Provider callback 全部丢弃，不改变已发 final。

## 7. 独立音频代理协议

### 7.1 连接与鉴权

- 使用既有 Tailscale Serve → 127.0.0.1:8787 下独立 `wss /ws/asr`；Bearer 仍只在 Authorization header，token 不放 URL。
- 每条连接仅允许一个 asrStreamId 和一次完整生命周期，terminal 后关闭；新录音必须新连接、新 ID。
- 全局最多一个 active stream；新 start 返回 ASR_BUSY，不隐式取消旧流。每设备每分钟最多 10 次 start，超限 ASR_RATE_LIMITED。
- revoke/pair replace 同时关闭主控制与音频连接并取消 Provider；普通主控制 WSS 断开不自动取消独立音频流。
- 音频 WSS 断开且未 finish 一律视为 cancel，不恢复、不 finalize、不保存草稿。

### 7.2 App → Mac 控制消息

```json
{
  "protocolVersion": 1,
  "messageId": "msg_01...",
  "timestamp": 1762432800000,
  "type": "asr.start",
  "asrStreamId": "asr_01...",
  "payload": {
    "audio": {"format":"pcm-s16le","sampleRate":16000,"channels":1}
  }
}
```

- `asr.start` 只允许上述音频参数；不得传 endpoint、API Key、resourceId、sessionId、runId、commandId 或 Provider 任意参数。
- `asr.finish`、`asr.cancel` 只携带同一 asrStreamId 和空 payload；控制消息最大 4 KiB。
- finish/cancel 在 connecting 中也允许：finish 在尚未 started 时按取消处理，cancel 立即终止，避免松手后产生空识别。
- 非首条 start、重复 start、错误 streamId、start 后修改格式均返回 INVALID_MESSAGE/ASR_STREAM_CONFLICT。

### 7.3 二进制音频

- start 成功后进入 recording，二进制帧只含 PCM16 little-endian，无 JSON/WAV/header。
- 每帧标准 6,400 bytes（200 ms），最后一帧可更小但必须非空、偶数字节；超过 6,400、奇数字节或 recording 外帧返回 ASR_INVALID_AUDIO并终止。
- 不假定 Flutter record 原生回调就是 200 ms，App packetizer 负责拆合样本且不拆分 16-bit sample。
- Mac 不做转码，避免 CPU 阻塞控制服务；网络转发顺序与 WSS 到达顺序一致。

### 7.4 Mac → App 事件

```text
asr.started
asr.partial {asrStreamId,sequence,text}
asr.final {asrStreamId,sequence,text}
asr.error {asrStreamId,code,retryable,safeMessage}
asr.cancelled {asrStreamId,reason}
asr.closed {asrStreamId,reason}
```

- started 表示 Provider 已 ready，App 此时才启动麦克风采集。
- error/cancelled/final 后必须紧跟 closed；closed 后 App 忽略该流所有事件。
- `asr.cancelled` 是终态事件，不是可重试错误。
- 所有事件仅存在音频通道，不写 EventJournal、session seq、commands、audit_logs 或时间线。

## 8. 超时、背压与资源清理

固定限制：

| 项目 | 默认值 |
|---|---|
| Provider connect | 10 秒 |
| finalize 等 final | 10 秒 |
| 单次录音 | 60 秒，达到后自动 finalize |
| 标准音频包 | 200 ms / 6,400 bytes |
| App 待发送包 | 最多 20 包，超过 ASR_BACKPRESSURE |
| Mac Provider bufferedAmount | 最大 256 KiB，超过 ASR_BACKPRESSURE |
| Mac→App 文本事件队列 | 每流最多 4 条；partial 只保留最新，final/error 优先，超限 ASR_BACKPRESSURE |
| 活跃流 | 全局 1、每连接 1 |
| start 频率 | 每设备 10 次/分钟 |

- 背压时不得继续无限排队、静默丢音频或写临时文件；进入 error→cancel Provider→closed，用户需重新录音。Mac→App 的 partial 可合并为最新快照，final/error 必须清除旧 partial 队列并优先发送，不能在 final 后再发旧 partial。
- recording 中收到 finish：先停止接受新音频，再按发送顺序完成已接受帧和最后一包；finalizing 中音频帧无效。
- cancel、error、final、disconnect、timeout、revoke、Agent close 都经同一幂等 cleanup，释放 mic 引用、计时器、队列、Provider socket 和 stream 索引。
- Agent 重启没有 ASR 恢复；App 将旧流标为 cancelled/agent_restarted，不自动重录或重试。
- ASR retryable 只表示用户可手动新录音，不自动重发已有音频；550xxxxx 官方偶发错误也遵守此规则。

## 9. iPhone 录音与交互状态机

### 9.1 状态

```text
idle → permission → connecting → recording → finalizing → completed
  │         │            │            │            │
  │         │            │            │            └→ idle（final 已写草稿）
  │         │            │            ├→ cancelled → idle
  │         │            │            └→ error → idle
  └─────────┴────────────┴────────────┴→ cancelled/error → idle
```

- completed 只表示 final 已写入草稿，不表示 prompt 已发送。
- 任一状态只能接受当前 asrStreamId 和预期 sequence；旧 stream/sequence 不得覆盖新状态。
- 同时最多一个本地录音流，文字输入、历史查看和其他 session 草稿仍可用。

### 9.2 按住、松开和取消

- pointer down 创建本地 UI generation 并请求权限；只有手指仍按住且权限/Provider started 成功才启动采集。
- 用户在权限对话框或 connecting 时松手：取消，不启动采集、不 finalize、不产生空草稿。
- started 后松开：停止采集并发送 finish；started 前取消优先级高于迟到的 started。
- 在取消区松手、点击取消、原生 interruption began、inactive/hidden/paused、音频 socket 断开：cancel。
- 电话 interruption ended 不自动恢复录音，用户必须重新按住。
- Info.plist 只增加 NSMicrophoneUsageDescription；不使用 Apple Speech framework，不新增语音识别权限。

### 9.3 VAD 与最长录音

- 本地 RMS 仅作辅助：至少累计 500 ms 高于 -40 dBFS 才视为检测到语音；之后连续 1,500 ms 低于 -45 dBFS 可自动 finish。
- 未达到语音条件时的静音只更新提示，不自动产生 final；用户始终可主动松开或取消。
- VAD 阈值不是安全边界，真机噪声测试后如需修改必须更新 spec 和测试；不得把 Provider definite 当作本地自动松手。
- 60 秒到点自动 finish，UI 明确“已达到最长录音，正在完成识别”。

## 10. 草稿归属、编辑与发送

### 10.1 原 session 绑定

- 开始录音时 App 捕获 originSessionId、原草稿和本地 voiceDraftId；asrStreamId 不进入 prompt 协议。
- 允许切换 session，但 origin session 在 recording/finalizing 中禁止直接编辑该草稿；其他 session 可编辑。
- partial 只在录音面板显示，不写 RecoveryStore；final 到达时只更新 origin session，selectedSessionId 不变。
- final 与原草稿之间使用一个换行追加；原草稿为空时只使用 final。不得静默覆盖已有文字。
- 合并后超过 prompt 16 KiB 时仍可编辑，但普通发送按既有长度校验禁用。

### 10.2 final 草稿与取消

RecoveryStore 以增量 schema v2 增加 voice_drafts 元数据；迁移必须保留既有 outbox_commands、sync_cursors、cached_events/sessions 和 drafts，不得清库重建：

```text
voiceDraftId、asrStreamId、originSessionId、originalDraft、combinedDraft、status=pending
```

- final 写入草稿和 voice_drafts 必须在同一 App SQLite 事务，App 被杀后可恢复待确认文本；不保存 partial/audio。
- “取消本次语音”恢复 originalDraft 并删除 voice_drafts；编辑过 combinedDraft 后取消也需明确提示会丢弃本次编辑。
- 普通发送点击时，以当前编辑后的完整草稿创建唯一 prompt.send；outbox enqueue 与 voice_drafts consumed/删除同事务，防止重复确认。
- prompt.send 的业务错误按 S04 处理；已成功进入 outbox 后由 S04 重试，ASR 不再参与，也不生成新 asrStreamId/commandId。
- Agent 实例改变时，已生成 voice_drafts 保留，但旧 ASR 流不恢复；未确认 prompt 按 S04 confirmation_required 处理。

### 10.3 普通 Composer 是唯一执行入口

```text
[Fixture Alpha / 修复测试]
[识别中 00:18]  正在识别：这是中间文本…
[取消]                        [松开发送识别]
                ↓ final
输入框：原有草稿
        这是最终识别文本，可继续编辑
[取消本次语音]                         [普通发送]
```

- “松开发送识别”表示送交 ASR 完成，不是发送 Claude prompt，UI 文案应使用“松开完成”，避免误导。
- 没有语音专用执行按钮、语音审批按钮或自动确认；普通发送仍受 S02/S04 在线、归档、执行意图门控限制。
- ASR 未配置或失败时只禁用麦克风，普通文字 Composer 保持可用。

## 11. 中断、断线与生命周期

| 场景 | 必须结果 |
|---|---|
| 主控制 WSS 断开、音频仍连接 | 可完成识别并保存草稿，但普通发送等待重连；不改变活跃 run |
| 音频 WSS 断开 | 当前流 cancel，Provider 关闭，不保存 partial |
| App 退后台/锁屏 | 停 mic、cancel、遮罩并清 partial；已提交 final 草稿可按 S04 保留 |
| 电话/音频中断 | cancel，中断结束不自动恢复 |
| App 被杀 | socket 断开使 Mac cancel；已提交 voice_drafts 可恢复，未提交 final 丢失但不执行 |
| Agent 重启 | 旧流失败/取消，不恢复；已确认 prompt 走 S04，voice_drafts 仍可编辑 |
| revoke/replace/unpair | 关闭音频/Provider，清凭证、voice_drafts、partial 和本地敏感缓存 |
| Provider 无 final/空结果 | 明确错误，不写空草稿、不创建 prompt |
| 新 stream 启动后旧 stream final | 按 asrStreamId/generation 丢弃 |

## 12. 错误模型与隐私

### 12.1 安全错误码

- 配置/连接：`ASR_NOT_CONFIGURED`、`ASR_CONNECTION_FAILED`、`ASR_PROVIDER_UNAUTHENTICATED`、`ASR_PROVIDER_ERROR`；
- 资源：`ASR_BUSY`、`ASR_RATE_LIMITED`、`ASR_BACKPRESSURE`；
- 数据/协议：`ASR_INVALID_AUDIO`、`ASR_STREAM_CONFLICT`、`ASR_RESULT_TOO_LARGE`；
- 终态：`ASR_FINAL_TIMEOUT`、`ASR_EMPTY_RESULT`、`ASR_PROVIDER_ENDED`、`ASR_PROVIDER_OVERLOADED`；
- App 本地：`ASR_PERMISSION_DENIED`、`ASR_MIC_UNAVAILABLE`、`ASR_INTERRUPTED`，不伪装成 Mac Provider 错误。

错误只含 code/retryable/safeMessage/streamId；不回传 API Key、请求头、原始 Provider payload、音频或完整识别文本。

### 12.2 数据保护

- Mac 原始音频只在当前帧/有界队列内存，禁止写文件、SQLite、日志、崩溃上下文或诊断导出。
- App 使用 startStream，不创建录音文件；实现必须检查 record/系统临时目录无本产品音频副本。
- partial/final 在 Mac 仅内存；partial 在 App 仅内存。final 进入 origin 草稿后才受 S04 RecoveryStore 保护。
- 用户实际发送的文本按 S04 成为 outbox/run prompt，沿用 30 天 Mac 保留；这不是“保存原始音频”。
- API Key 永不进入 App 包、Keychain、协议响应、数据库或日志；设备 token 与 API Key 完全分离。
- 不启用 Funnel，不关闭 TLS 校验，不修改 Claude settings.json，不增加语音权限旁路。

## 13. 测试策略

### 13.1 Provider 与 Mac 测试

| ID | 场景 | 通过标准 |
|---|---|---|
| ASR-00 | 真实鉴权/格式/partial/final/cancel/error | 官方行为有脱敏证据，无凭证时不标 PASS |
| PROV-01 | 全量多句文本与 definite | 不重复拼接，只有整流 final 一次 |
| PROV-02 | 空/超大/提前结束/重复 final | 无草稿，安全错误，迟到事件丢弃 |
| GATE-01 | 鉴权/一流一连接/限流 | 错 token 拒绝，第二流 BUSY，第 11 次 start 限流 |
| GATE-02 | PCM 边界/格式 | 6,400/较小偶数帧接受，奇数/超大/非法配置拒绝 |
| GATE-03 | finish/cancel/disconnect | 清理幂等，cancel 无 final，断开不恢复 |
| GATE-04 | 背压/超时 | 20 包/256 KiB/4 条文本事件/10 秒/60 秒生效，内存有界 |
| SEC-01 | 配置和日志扫描 | 无 API Key/Authorization/音频/Provider 原文，主 seq/DB 不变 |

### 13.2 Flutter 单元与 Widget

- S00 ASR-01–08 fake Provider 契约全部保持；
- 权限/松开竞争、started 迟到、cancel/final 竞争、旧 stream/sequence；
- PCM packetizer 的奇数输入处理、200 ms 拆合和中文 final 长度；
- VAD 500 ms/-40 dB、1,500 ms/-45 dB、60 秒边界；
- 多 utterance partial 替换、final 唯一、空结果和 Provider 错误；
- origin session 草稿追加、切换不串线、取消恢复原草稿、App 重开 voice_drafts；RecoveryStore v1→v2 保留全部旧 outbox/cursor/cache/drafts；
- 普通发送只一次，outbox consumed 原子性、重复点击和 S04 confirmation_required；
- 后台/锁屏/电话打断不自动恢复，文字输入/控制事件不受 ASR 失败影响；
- Widget/log/普通存储无 partial、音频、API Key 或 token。

### 13.3 真实 iPhone + Mac + 豆包 E2E

| ID | 操作 | 通过标准 |
|---|---|---|
| E2E-01 | 未配置/错误凭证 | 麦克风安全失败，文字和主控制正常，无密钥泄漏 |
| E2E-02 | 拒绝麦克风权限 | 无音频/Provider 流，权限说明清晰 |
| E2E-03 | 中文讲话并编辑 final | partial/final 正常，编辑后普通发送一次，回复正确 |
| E2E-04 | 原草稿非空并取消语音 | final 追加不覆盖，取消恢复原草稿，无 prompt |
| E2E-05 | 录音中切换 session | final 只回 origin，selectedSession 不变，不串草稿 |
| E2E-06 | 重复点击/网络重试 | 同一 S04 commandId，只一个 run |
| E2E-07 | 取消后 Provider 迟到 final | 无草稿、无 prompt、无残留流 |
| E2E-08 | connecting/权限阶段松手 | 不启动采集、不生成空 final |
| E2E-09 | 锁屏/后台/电话打断 | mic 和 Provider 均停止，中断结束不自动恢复 |
| E2E-10 | finalize 超时/空 final | 明确错误，无空 prompt，文字可继续 |
| E2E-11 | Provider 过载/主控制高负载 | 安全错误，控制消息仍收发，音频内存有界 |
| E2E-12 | Agent 重启/revoke | 流终止且不恢复，API Key 不下发，旧审批不受影响 |
| E2E-13 | 60 秒/VAD/背压 | 自动 finish 或明确错误，无无限队列/失控录音 |
| E2E-14 | final 后 App 被杀再重开 | voice_drafts 恢复，确认只产生一个 prompt |

## 14. 完成标准

- S00–S04 验收仍有效，ASR-00 真实证据完整；
- Mac、代理和 Flutter 核心测试通过，TypeScript/Dart 核心覆盖率均不低于 80%；
- E2E-01–14 在真实 iPhone、Mac、Tailscale、豆包 2.0 中通过；
- 所有执行都经普通 Composer + S04 prompt.send，重复操作只一个 run；
- partial/cancel/旧 stream 不写草稿，final 可编辑/取消且不串 session；
- 后台、电话、断线、重启和背压均停止或有界，不自动恢复音频；
- 原始音频不落盘，API Key 不下发、不入库/日志，主控制 seq/协议不变；
- 文档明确单流 60 秒、无自动 ASR 重试、无音频恢复、无语音审批和无 App 直连。

## 15. 回滚与兼容

- ASR 使用独立控制类型和 `/ws/asr`，不改变主协议 V1、session seq、prompt schema 或审批；
- 旧 App 不创建音频连接即可继续使用文字；新 App 连旧 Mac 时 ASR_NOT_CONFIGURED/UNKNOWN_MESSAGE_TYPE，麦克风禁用但文字可用；
- 回滚前取消活跃音频流并关闭 Provider，不保留音频/ASR 待恢复状态；voice_drafts 可作为普通草稿保留或按用户选择清除；
- 配置回滚只需移除 ASR Provider 配置/停用入口，不修改 Claude settings.json，不把 API Key 写入回滚文档；
- 当前目录不是 Git 仓库，不因本 spec 自动初始化、提交或回滚 Git。

## 16. 留给实现者的事项

实现者可决定：

- DoubaoAsrProvider 二进制 framing 内部函数拆分，但必须来自 ASR-00 官方依据；
- AsrGateway/AsrStreamManager/事件 Normalizer 内部文件结构；
- record 回调 packetizer、RMS 计算和 Swift interruption 通知的最小实现；
- 录音面板、取消区、音量/计时动画和无障碍文案；
- fake Provider、合成中文音频和错误 fixture。

不得自行改变：

- Mac 独立代理、固定官方 endpoint、API Key 不下发、无 App 直连；
- 独立音频 WSS、一连接一流、16 kHz/mono/PCM16、200 ms 和固定资源上限；
- partial 仅展示、final 才入 origin 草稿、普通发送才创建 prompt；
- 后台/中断/取消/断开停止，迟到结果丢弃，无自动音频重试/恢复；
- 原始音频不落盘，ASR 事件不进主 Journal/seq/SQLite；
- 真实 ASR-00 和真机 E2E 不得由 fake 替代。

## 17. 后续接口预留

- S06 可提供 ASR 状态、脱敏 log_id、版本与故障诊断，但不默认导出音频/文本/API Key；
- 未来短期凭证、其他 ASR 厂商、热词、TTS 或离线识别需要独立 spec；
- 任何“语音直接执行/语音审批”都必须重新做安全设计，不能复用本次普通发送路径暗中添加。
