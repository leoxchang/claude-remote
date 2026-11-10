# 豆包 ASR 契约（S00）

**状态：** 配置占位与 fake 契约已完成；真实豆包联调 **未执行**，统一标记 `NOT_RUN / DEFERRED_TO_BEFORE_S05`。

## 音频基线

- 16 kHz、单声道、PCM16。
- 若实际服务要求不同格式，由 Provider 负责转码或封装，不改变主控制协议。

## 配置字段（全部为占位，`TO_VERIFY_WITH_OFFICIAL_DOCS`）

```text
ASR_PROVIDER=doubao
DOUBAO_ASR_APP_ID=
DOUBAO_ASR_ACCESS_TOKEN=
DOUBAO_ASR_RESOURCE_ID=
DOUBAO_ASR_ENDPOINT=
DOUBAO_ASR_MODEL=
```

- 只提交 `asr.example.env` 占位，不提交真实值。
- 长期凭证只由 Mac 保存；`DOUBAO_ASR_ENDPOINT` 不允许 App 任意覆盖。
- 缺任一必填字段时 `parseAsrConfig` 立即失败，错误信息**只包含字段名**，不回显已存在的值。

## Provider 中立语义

```text
start(handle, config, emit) -> asr.started
write(handle, audio)
finalize(handle)            -> asr.final 或 asr.error
cancel(handle)              -> asr.cancelled
```

事件：`asr.started`、`asr.partial(transcript, sequence)`、`asr.final(transcript, sequence)`、
`asr.error(code, retryable, safeMessage)`、`asr.cancelled`、`asr.closed`。

状态机：

```text
idle → connecting → recording → finalizing → completed
                   │             │
                   └─────────────┴→ cancelled
任意非终态 → error
```

规则：

- partial 只用于展示；final 才是候选文本。
- 每条音频流有独立 `streamId`，与 `commandId` 分离；旧 stream 的事件一律丢弃。
- 旧 sequence（不大于当前 sequence）一律丢弃。
- `completed` / `cancelled` / `error` 为终态，之后的事件全部忽略。
- finalize 超时或没有 final 时返回 `ASR_NO_FINAL`，不自动生成空 prompt。
- **只有用户确认文本后才创建 `prompt.send`**；ASR 不调用 Agent SDK、不修改 prompt 语义、不处理审批。

## Fake 契约测试（ASR-01–08，全部 PASS）

| ID | 覆盖点 | 证据 |
|---|---|---|
| ASR-01 | partial 顺序 + 唯一 final + completed | `docs/s00/evidence/ASR-01.json` |
| ASR-02 | cancel 终态、迟到结果丢弃 | `docs/s00/evidence/ASR-02.json` |
| ASR-03 | Provider 错误码安全、不泄露 token | `docs/s00/evidence/ASR-03.json` |
| ASR-04 | 无 final 时显式失败、不生成 prompt | `docs/s00/evidence/ASR-04.json` |
| ASR-05 | 旧 sequence / 旧 streamId 不覆盖新状态 | `docs/s00/evidence/ASR-05.json` |
| ASR-06 | 重复 final 只保留一个、不自动发送 | `docs/s00/evidence/ASR-06.json` |
| ASR-07 | 缺配置 fail fast、只报字段名 | `docs/s00/evidence/ASR-07.json` |
| ASR-08 | ASR 事件不进入主协议、不产生 prompt.send | `docs/s00/evidence/ASR-08.json` |

## S05 前必须完成的真实联调（NOT_RUN / DEFERRED_TO_BEFORE_S05）

1. 根据官方文档确定具体豆包流式语音产品和 API。
2. 开通服务并安全保存凭证。
3. 验证鉴权、音频格式、partial/final、cancel、超时和限流。
4. 判断是否存在适合 iOS 的短期凭证；若没有，确定 Mac 代理。
5. 验证一段中文语音的实际结果和错误路径。
6. 更新配置字段、资源 ID 和 endpoint，不保留猜测值。

该清单未完成时，S05 不得标记为可验收；S01–S04 不受影响。`DOUBAO-LIVE` 在 `docs/s00/status.json` 中保持 `NOT_RUN` 且 `deferredTo: S05`。