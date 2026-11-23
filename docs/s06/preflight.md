# S06 前置核对

**日期：** 2026-11-23
**结论：** 不依赖 iPhone 的交付项可以开工；真机 E2E、ASR-00 与整体验收仍 BLOCKED。

## 1. 上游状态

| 项 | 状态 | 证据 |
|---|---|---|
| S00 Core | PASS | `docs/s00/exit-report.md` |
| S01–S05 自动化 | PASS | 2026-11-17：Agent 597、根套件 144、Flutter 307；Dart 覆盖率 80.3% |
| S01 E2E-01–12 | NOT_RUN | `docs/s01/e2e-checklist.md` |
| S02 E2E-01–12 | NOT_RUN | `docs/s02/e2e-checklist.md` |
| S03 E2E-01–12 | NOT_RUN | `docs/s03/e2e-checklist.md` |
| S04 E2E-01–15 | NOT_RUN | `docs/s04/e2e-checklist.md` |
| S05 E2E-01–14 | NOT_RUN | `docs/s05/e2e-checklist.md` |
| PERM-00 | PASS | `docs/s03/perm00-evidence.md` |
| STORE-00 Mac | PASS | `docs/s04/store00-evidence.md` |
| STORE-00 iPhone | PASS（2026-11-17） | `docs/s04/store00-evidence.md` |
| ASR-00 | BLOCKED | `docs/s05/asr00-evidence.md`（无 `DOUBAO_ASR_API_KEY`） |

## 2. 环境实测（2026-11-23）

| 项 | 结果 |
|---|---|
| `tailscale status` | stopped |
| `tailscale serve status` | No serve config（2026-11-17 曾 PASS） |
| Agent 8787 监听 | 无 |
| claude-remote launchd 项 | 无（仅存在 `com.bozee.andisplay.agent.plist`） |
| `DOUBAO_ASR_API_KEY` | 未配置（仅文档引用） |
| CLI 顶层入口 | 缺失：`npx tsx apps/agent/src/cli.ts --help` 无输出，`main` 从未被调用 |
| 物理 iPhone | 2026-11-17 已可安装启动并完成 STORE-00；当前未连接检查 |
| iPhone tailnet | 未接入（Tailscale iOS 区域受限） |

## 3. S06 本次范围

- 修 CLI 顶层入口；
- 版本单一来源与 `agent status` 暴露；
- 结构化日志补齐 ID 与大小轮转；
- `agent doctor` 与脱敏诊断导出；
- launchd 常驻（含 `DOUBAO_ASR_API_KEY` 显式注入）；
- 安装/使用与限制文档、S06 台账。

不在本次范围：真机 E2E、ASR-00、故障注入新增用例（沿用 S03/S04/S05 已有测试）、公网产品化。

## 4. 解除条件

S06 整体验收前必须满足：

1. S01–S05 台账全部 PASS 或按用户书面批准降级；
2. ASR-00 与 S05 E2E 使用真实豆包凭证通过；
3. Tailscale Serve 恢复并由 iPhone 完成配对；
4. `docs/s06/e2e-checklist.md` 全部 PASS。