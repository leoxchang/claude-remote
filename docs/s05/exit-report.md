# S05 退出报告

**日期：** 2026-11-13
**结论：** **BLOCKED** — Mac 与 Flutter 自动化实现完成；ASR-00 与 E2E-01–14 未执行，S05 不得验收，不进入 S06。

## 1. 交付内容

| 范围 | 结果 |
|---|---|
| 共享 ASR 协议与错误模型 | 完成：`asr-messages.schema.json`、9 个样例、Ajv 校验 |
| 豆包 Provider 边界 | 完成：固定 endpoint/resourceId、二进制 framing、背压与安全错误 |
| 事件归一化 | 完成：partial 快照、唯一 final、大小/空结果校验 |
| 单流生命周期 | 完成：10 秒连接/final 超时、60 秒上限、幂等清理 |
| `/ws/asr` 网关 | 完成：Bearer 鉴权、一连接一流、10 次/分钟、4 条事件队列 |
| Mac wiring | 完成：缺 Key 时 Agent 正常启动、revoke 关闭音频 |
| Flutter 采集与状态机 | 完成：PCM 分包、VAD、按住说话、取消/中断 |
| RecoveryStore v2 | 完成：增量迁移、voice_drafts、同事务草稿消费 |
| iPhone 语音界面 | 完成：录音面板、草稿横幅、中断桥；真机未验证 |
| 门禁与证据 | 完成：`verify:s05` 正确报告 BLOCKED |

## 2. 自动化结果

| 检查 | 结果 |
|---|---|
| `npm run test:s05`（Agent） | 通过：96 文件 / 593 测试（含 ASR 94） |
| `npm run coverage:agent` | 通过：branches 80.27%，其余 ≥87% |
| `flutter test --coverage` | 通过：301 测试；Dart 行覆盖率 80.19%（3287/4099） |
| `npx vitest run scripts/s05` | 通过：14 测试 |
| `ASR00_LIVE=1 npm run test:s05:asr00` | BLOCKED：`DOUBAO_ASR_API_KEY` 缺失 |
| `npm run verify:s05` | FAIL：ASR-00 BLOCKED、E2E-01–14 BLOCKED |

## 3. 未完成项

| ID | 状态 | 原因 |
|---|---|---|
| ASR-00 全部真实项 | BLOCKED | 无豆包服务凭证与计费资源 |
| ASR-00-8 真机录音 | BLOCKED | 无物理 iPhone |
| E2E-01–14 | BLOCKED | 无真机、无 Tailscale HTTPS/Serve |
| 真机 Data Protection（S04 遗留） | BLOCKED | 需物理设备锁屏验证 |

## 4. 已知限制

- 单次录音最长 60 秒，只允许一个全局活跃流。
- 不自动重试、不自动恢复音频流，也不提供语音审批或语音直接执行。
- API Key 只来自 Mac 进程环境，轮换需重启；S05 不实现 Keychain/秘密服务。
- iPhone 使用 FileVault/Data Protection 级别的本地保护，不是 SQLCipher。
- framing 仅按官方文档实现，未获真实豆包响应确认；ASR-00 通过前不得视为已验证。

## 5. 解除阻塞

按 `docs/s05/asr00-evidence.md` 第 4 节准备凭证与真机，完成 ASR-00 与 E2E-01–14 后重跑 `npm run verify:s05`。任何 FAIL/BLOCKED 都保持 S05 未验收。