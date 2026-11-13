# S03 真机 E2E 台账

**日期：** 2026-11-12
**结论：** **BLOCKED** — 12 条真机用例尚未在真实 iPhone + Tailscale HTTPS 环境执行；S03 不得验收。
**realDevice:** false
**sdkEvidence:** REAL（PERM-00）
**PERM-00:** PASS（6/6，见 `perm00-evidence.md`）

```text
desktop:      MacBook Pro (Xcode 27.2, Flutter 3.47.9)
tailnet:      macbook-pro.tail0970fd.ts.net
serve:        未配置（HTTPS Certificates 未启用）
device:       未连接
agent:        未在真机链路启动
global-settings: 未修改（PERM-00 前后 SHA-256 一致）
```

## 1. 前提

| 前提 | 状态 |
|---|---|
| S00 Core | ✅ PASS |
| S01 验收 | ❌ 未完成（E2E NOT_RUN） |
| S02 验收 | ❌ 未完成（E2E NOT_RUN） |
| PERM-00 真实 SDK | ✅ PASS |
| Tailscale HTTPS Certificates | ❌ 未启用 |
| `tailscale serve --bg 8787` | ❌ 未执行 |
| iPhone 同 tailnet 并信任开发者证书 | ❌ 未接入 |
| Funnel | ✅ 未启用 |

## 2. 用例台账

| ID | 场景 | 状态 | 证据 |
|---|---|---|---|
| E2E-01 | V2 升级后全部 deny，只开启 A 后 B 仍 deny | NOT_RUN | 无真机链路 |
| E2E-02 | A 中触发 Bash，完整查看并允许一次 | NOT_RUN | 无真机链路 |
| E2E-03 | 再次触发相同 Bash，重新审批且无永久规则 | NOT_RUN | 无真机链路 |
| E2E-04 | 拒绝一次 Bash，命令不执行且 deny 给模型 | NOT_RUN | 无真机链路 |
| E2E-05 | 审批 Edit 并查看 old/new 与非真实 Diff 标记 | NOT_RUN | 无真机链路 |
| E2E-06 | 不操作等待 120 秒，expired 且不能补允许 | NOT_RUN | 无真机链路 |
| E2E-07 | pending 时断网，过期前后恢复表现 | NOT_RUN | 无真机链路 |
| E2E-08 | pending 时 run.cancel，迟到响应不能执行 | NOT_RUN | 无真机链路 |
| E2E-09 | 两个会话同时 pending，响应不串线 | NOT_RUN | 无真机链路 |
| E2E-10 | 重复 commandId、新 commandId、错 runId | NOT_RUN | 无真机链路 |
| E2E-11 | pending 时 set-approval deny / revoke | NOT_RUN | 无真机链路 |
| E2E-12 | pending 时强杀重启，不自动 allow/replay | NOT_RUN | 无真机链路 |

## 3. 解除条件

1. 完成 S01/S02 的 E2E-01–12 并让 `npm run verify:s01`、`npm run verify:s02` 通过；
2. Tailscale 管理后台开启 **HTTPS Certificates**，执行 `tailscale serve --bg 8787` 并用系统 CA 校验；
3. iPhone 与 Mac 同 tailnet，安装开发签名并信任；
4. 先运行 `S03_LIVE=1 npm run test:s03:live` 复核真实 SDK；
5. 按上表逐项执行并回填状态、时间、traceId 与副作用次数，把 `realDevice` 改为 true；
6. 执行 `npm run verify:s03`，全部 PASS 后 S03 才算验收。