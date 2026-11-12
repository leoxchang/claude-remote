# S02 真机 E2E 台账

**日期：** 2026-11-12
**结论：** **NOT_RUN** — 12 条真机用例尚未在真实 iPhone + Tailscale HTTPS 环境执行；S02 按设计不得验收。
**realDevice:** false

```text
desktop:      MacBook Pro (Xcode 27.2, Flutter 3.47.9)
tailnet:      macbook-pro.tail0970fd.ts.net
serve:        未配置（HTTPS Certificates 未启用）
device:       未连接
agent:        未在真机链路启动
```

## 1. 前提

| 前提 | 状态 |
|---|---|
| Tailscale HTTPS Certificates | ❌ 未启用 |
| `tailscale serve --bg 8787` | ❌ 未执行（证书缺失时会挂起） |
| 系统 CA 校验 `https://macbook-pro.tail0970fd.ts.net` | ❌ 未验证 |
| Funnel | ✅ 未启用 |
| iPhone 同 tailnet 并信任开发者证书 | ❌ 未接入 |

## 2. 用例台账

| ID | 场景 | 状态 | 证据 |
|---|---|---|---|
| E2E-01 | 本机授权两个项目，App 只显示名称 | NOT_RUN | 无真机链路 |
| E2E-02 | 两个项目各自独立 cwd 上下文与 Claude 会话 | NOT_RUN | 无真机链路 |
| E2E-03 | 同会话连续两条 prompt 按 FIFO 排队并 resume 同一 Claude 会话 | NOT_RUN | 无真机链路 |
| E2E-04 | 三个会话同时提交，全局最多两个 activeRun | NOT_RUN | 无真机链路 |
| E2E-05 | `queue.remove` 只移除目标 queued run | NOT_RUN | 无真机链路 |
| E2E-06 | `run.cancel` 后同会话下一 queued 项真正开始 | NOT_RUN | 无真机链路 |
| E2E-07 | 反复切换项目/会话，草稿与时间线互不串扰 | NOT_RUN | 无真机链路 |
| E2E-08 | rename 与 archive 的可见性与只读行为 | NOT_RUN | 无真机链路 |
| E2E-09 | 断网重连后目标会话快照恢复正确 | NOT_RUN | 无真机链路 |
| E2E-10 | 重复 commandId 返回 duplicate；改内容返回 `COMMAND_ID_CONFLICT` | NOT_RUN | 无真机链路 |
| E2E-11 | 有活跃 run 时本机移除项目返回 `WORKSPACE_BUSY` | NOT_RUN | 无真机链路 |
| E2E-12 | Agent 重启后不自动重放，旧 prompt 标为结果未知 | NOT_RUN | 无真机链路 |

## 3. 解除条件

1. Tailscale 管理后台开启 **HTTPS Certificates**，执行 `tailscale serve --bg 8787` 并用系统 CA 校验；
2. iPhone 与 Mac 同 tailnet，安装开发签名并信任；
3. 用 `npm run test:s02:live` 先跑真实 SDK 回归，再按上表逐项执行；
4. 回填每行的状态、时间、traceId 与证据，把 `realDevice` 改为 true；
5. 执行 `npm run verify:s02`，全部 PASS 后 S02 才算验收。