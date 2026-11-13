# ASR-00 真实豆包门禁证据

**日期：** 2026-11-13
**结论：** **BLOCKED** — 无豆包服务凭证（`DOUBAO_ASR_API_KEY` 缺失）、无物理 iPhone、无 Tailscale HTTPS 链路。真实鉴权、识别语义、错误映射与真机录音全部 **NOT_RUN**。fake Provider 与合成音频只证明内部契约，不构成 ASR-00 证据。

## 1. 环境

| 项目 | 值 |
|---|---|
| macOS | Darwin 27.2.0 |
| Node（探针运行时） | v24.15.0（fnm） |
| Flutter / Dart | 3.47.9 / 3.13.7 |
| `DOUBAO_ASR_API_KEY` | **缺失** |
| resourceId | 未选定（默认 `volc.seedasr.sauc.duration` 仅为计划值） |
| 物理 iPhone | 不可用 |

## 2. 逐项结果

| ID | 检查项 | 结果 | 原因 |
|---|---|---|---|
| ASR-00-1 | TLS + `X-Api-Key`/`X-Api-Resource-Id`/`X-Api-Request-Id` 鉴权 | BLOCKED | 无凭证 |
| ASR-00-2 | 16 kHz mono PCM16、200 ms 包可识别 | BLOCKED | 无凭证 |
| ASR-00-3 | 单句/多句/中英混合的 partial 与 definite | BLOCKED | 无凭证 |
| ASR-00-4 | `result.text` 快照/增量、重复与迟到 final | BLOCKED | 无凭证 |
| ASR-00-5 | finish 最后一包、连接结束顺序、10 秒无 final | BLOCKED | 无凭证 |
| ASR-00-6 | cancel 帧或关闭 socket、迟到结果丢弃 | BLOCKED | 无凭证 |
| ASR-00-7 | 无效凭证/resourceId/空音频/8 秒无音频/过载/限流 | BLOCKED | 无凭证 |
| ASR-00-8 | `record 7.1.2` 真机 PCM 格式与电话中断 | BLOCKED | 无物理 iPhone |
| ASR-00-9 | 官方 iOS 短期凭证 | NOT_RUN | 无官方证据，维持 Mac 代理方案 |
| ASR-00-10 | 脱敏协议映射与 framing 依据 | PARTIAL | 仅官方文档字段；未获真实响应 |

## 3. 已验证的内部事实

- 合成音频夹具已生成（无个人录音、无 WAV header、偶数字节）：

| 夹具 | SHA-256 |
|---|---|
| `single-zh.pcm` | `a914de23768a7652dbf6a54813814a6e90b10e6377203fd24c4a570c3c6e6bf7` |
| `multi-zh.pcm` | `b993f4279e5b996544dbcd14bfab8b01187e460835644f284ccbf7f9fcf5f176` |
| `mixed-zh-en.pcm` | `b50efa61416cf7f22821dc65e1e367b404988176e0ef4fb64396c5003b4904e2` |

- 探针入口：`ASR00_LIVE=1 npm run test:s05:asr00`。缺 `DOUBAO_ASR_API_KEY` 时整组失败并输出 `ASR00_BLOCKED`，不会误记 PASS。
- framing 目前只按官方文档实现：4 字节 header、JSON/raw 序列化、正序列号与 last-audio 标志。`end_window_size` 等模型参数尚未由真实证据确认。

## 4. 解除阻塞所需

1. 在火山引擎开通流式语音识别，创建 API Key，并选定 `volc.seedasr.sauc.duration` 或 `volc.seedasr.sauc.concurrent`。
2. 仅在 Mac 进程环境注入 `DOUBAO_ASR_API_KEY`，然后运行 `ASR00_LIVE=1 npm run test:s05:asr00`。
3. 用真实响应补全第 2 节各项，并把脱敏 `.bin` 帧与事件 JSON 写入 `apps/agent/test/fixtures/s05/doubao/`。
4. 连接物理 iPhone，执行 `integration_test/s05_record_probe_test.dart`，记录电话中断行为。
5. 任一项失败即保持 S05 BLOCKED，不得调整断言掩盖官方行为。