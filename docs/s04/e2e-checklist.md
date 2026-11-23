# S04 真机 E2E 台账

**日期：** 2026-11-13（iPhone 补测 2026-11-17）
**结论：** **BLOCKED** — 15 条真机 E2E 尚未在真实 iPhone + Tailscale HTTPS + SQLite 环境执行；STORE-00 iPhone 已于 2026-11-17 PASS，S04 仍不得验收。
**realDevice:** true
**dataProtection:** true
**sdkEvidence:** REAL（PERM-00）
**PERM-00:** PASS（S03 真实 SDK 6/6）

## 1. 前提

| 前提 | 状态 |
|---|---|
| S00 Core | PASS |
| S01/S02/S03 自动化 | PASS（S03 真机 E2E 仍 BLOCKED） |
| STORE-00 Mac（真实 better-sqlite3/WAL/backup） | PASS |
| STORE-00 iPhone（sqflite + Data Protection） | PASS（2026-11-17 真机 integration_test，见 `store00-evidence.md`） |
| Tailscale HTTPS Certificates / Serve | 2026-11-17 已配置并验证（2026-11-23 核对：Tailscale 已停止、Serve 配置为空，需重新启用） |

## 2. 用例

| ID | 场景 | 状态 | 证据 |
|---|---|---|---|
| E2E-01 | V3 升级 V4 | NOT_RUN | - |
| E2E-02 | App 在 prompt ACK 前后被杀 | NOT_RUN | - |
| E2E-03 | App 与 Agent 都重启且有未确认命令 | NOT_RUN | - |
| E2E-04 | 活跃 run 时强杀 Agent | NOT_RUN | - |
| E2E-05 | queued 时强杀 Agent | NOT_RUN | - |
| E2E-06 | 显式 requeue | NOT_RUN | - |
| E2E-07 | 跨另一次重启使用旧 requeue | NOT_RUN | - |
| E2E-08 | pending 时强杀 Agent | NOT_RUN | - |
| E2E-09 | allow commit 附近故障注入 | NOT_RUN | - |
| E2E-10 | 高频输出中断网再恢复 | NOT_RUN | - |
| E2E-11 | 清理事件后旧客户端重连 | NOT_RUN | - |
| E2E-12 | 模拟磁盘写失败/容量上限 | NOT_RUN | - |
| E2E-13 | 启动第二实例/损坏迁移 | NOT_RUN | - |
| E2E-14 | 重启后用户发送新 prompt | NOT_RUN | - |
| E2E-15 | revoke/replace/unpair | NOT_RUN | - |

## 3. 解除条件

1. 恢复 Tailscale HTTPS Certificates 与 Serve（2026-11-17 曾验证通过，当前已停止）；
2. ~~接入物理 iPhone 并完成 STORE-00 iPhone~~ ✅ 2026-11-17 完成（`IPHONE: PASS`、`dataProtection: true`）；
3. iPhone 安装 Tailscale 登录同一 tailnet（当前无 iPhone 节点，E2E 依赖时仍需）；
4. 逐项执行 E2E-01–15 并回填状态与 traceId；
5. `npm run verify:s04` 全部 PASS 后才允许 S04 验收。
