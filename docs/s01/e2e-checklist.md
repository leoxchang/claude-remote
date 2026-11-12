# S01 真机验收台账（E2E-01–12）

**状态：** **BLOCKED** — Tailscale 未安装、无 iPhone 真机（2026-11-12 核对）。
**规则：** 每项必须在真实 iPhone、Mac、Tailscale Serve 与真实 SDK 环境下执行；无真实证据不得写 PASS。

| ID | 场景 | 状态 | 证据 |
|---|---|---|---|
| E2E-01 | 扫码配对，系统 CA 校验通过且无 Funnel | NOT_RUN | BLOCKED：Tailscale 未安装，无 Serve 证据 |
| E2E-02 | 未认证连接被拒绝（401/拒绝升级） | NOT_RUN | BLOCKED：无真机连接环境 |
| E2E-03 | 只读问答：prompt → 流式正文 | NOT_RUN | BLOCKED：无真机环境 |
| E2E-04 | 忙碌时第二次 prompt 返回 SESSION_BUSY 且输入保留 | NOT_RUN | BLOCKED：无真机环境 |
| E2E-05 | 停止活跃 run，状态进入 cancelled | NOT_RUN | BLOCKED：无真机环境 |
| E2E-06 | App 退后台不取消任务，回前台恢复 | NOT_RUN | BLOCKED：无真机环境 |
| E2E-07 | 断网重连后凭快照恢复时间线 | NOT_RUN | BLOCKED：无真机环境 |
| E2E-08 | 同一 commandId 重试不产生第二个 run | NOT_RUN | BLOCKED：无真机环境 |
| E2E-09 | 工具审批一律拒绝并显示工具卡片 | NOT_RUN | BLOCKED：无真机环境 |
| E2E-10 | Mac revoke 后旧 token 不能重连 | NOT_RUN | BLOCKED：无真机环境 |
| E2E-11 | Agent 重启后旧会话不可用，不自动重放 | NOT_RUN | BLOCKED：无真机环境 |
| E2E-12 | 两个顺序 run 复用同一 Claude session | NOT_RUN | BLOCKED：无真机环境 |

## 解除条件

1. 安装 Tailscale，Mac 与 iPhone 登录同一 tailnet，开启 MagicDNS 与 HTTPS Certificates；
2. 按 `tailscale-setup.md` 配置 Serve（**不启用 Funnel**），记录脱敏主机名与证书检查；
3. Xcode 激活（`sudo xcode-select -s /Applications/Xcode.app/Contents/Developer` 与 `sudo xcodebuild -runFirstLaunch`）并完成真机签名；
4. 逐项执行，把真实时间、版本、traceId 与结果回填到上表。

任何一项无法取得真实证据时保持 NOT_RUN，不得用 Mock、模拟器或本地 HTTP 代替。