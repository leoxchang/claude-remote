# S04 真机 E2E 台账

**日期：** 2026-11-13
**结论：** **BLOCKED** — 15 条真机用例尚未在真实 iPhone + Tailscale HTTPS + SQLite 环境执行；S04 不得验收。
**realDevice:** false
**dataProtection:** false
**sdkEvidence:** REAL（PERM-00）
**PERM-00:** PASS（S03 真实 SDK 6/6）

## 1. 前提

| 前提 | 状态 |
|---|---|
| S00 Core | PASS |
| S01/S02/S03 自动化 | PASS（S03 真机 E2E 仍 BLOCKED） |
| STORE-00 Mac（真实 better-sqlite3/WAL/backup） | PASS |
| STORE-00 iPhone（sqflite + Data Protection） | BLOCKED（无物理设备） |
| Tailscale HTTPS Certificates / Serve | 未配置 |

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

1. 启用 Tailscale HTTPS Certificates 与 Serve；
2. 接入物理 iPhone 并完成 STORE-00 iPhone（`IPHONE: PASS`、`dataProtection: true`）；
3. 逐项执行 E2E-01–15 并回填状态与 traceId；
4. `npm run verify:s04` 全部 PASS 后才允许 S04 验收。
