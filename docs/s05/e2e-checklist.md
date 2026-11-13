# S05 E2E 验收清单

**日期：** 2026-11-13
**结论：** **BLOCKED** — 无豆包服务凭证、无物理 iPhone、Tailscale HTTPS/Serve 未配置；以下 14 项均未执行。

> 模拟器、fake Provider 或合成音频都不能替代真实设备与真实豆包证据。

| ID | 场景 | 状态 | 证据/原因 |
|---|---|---|---|
| E2E-01 | 未配置或错误凭证时麦克风失败、文字输入可用 | BLOCKED | 无 `DOUBAO_ASR_API_KEY` |
| E2E-02 | 拒绝麦克风权限给出安全文案 | BLOCKED | 无物理 iPhone |
| E2E-03 | 中文 final 编辑后单次发送 | BLOCKED | 无真实豆包/iPhone |
| E2E-04 | 原草稿非空、编辑后取消并提示丢弃 | BLOCKED | 无物理 iPhone |
| E2E-05 | 录音中切换 session，结果回到 origin | BLOCKED | 无物理 iPhone |
| E2E-06 | 重复点击/网络重试只产生一个 prompt | BLOCKED | 无物理 iPhone |
| E2E-07 | 取消后迟到 final 被丢弃 | BLOCKED | 无真实豆包 |
| E2E-08 | connecting/权限阶段松手不产生空草稿 | BLOCKED | 无物理 iPhone |
| E2E-09 | 锁屏/后台/电话打断停止录音 | BLOCKED | 无物理 iPhone |
| E2E-10 | finalize 超时或空 final 给出安全错误 | BLOCKED | 无真实豆包 |
| E2E-11 | Provider 过载/主控制高负载下互不影响 | BLOCKED | 无真实豆包 |
| E2E-12 | Agent 重启/revoke 关闭音频且不恢复 | BLOCKED | 无真机/Tailscale |
| E2E-13 | 60 秒、VAD 与背压边界 | BLOCKED | 无物理 iPhone |
| E2E-14 | final 后 App 被杀，重开可恢复草稿 | BLOCKED | 无物理 iPhone |

## 自动化替代证据（不等于 E2E）

- `npm run test:s05`：Agent ASR 协议、Provider、Normalizer、StreamManager、Gateway 与集成流程。
- `flutter test test/voice test/features/chat`：分包、VAD、状态机、草稿事务与 Widget。
- 以上均标为自动化，不得写入本清单的 PASS。