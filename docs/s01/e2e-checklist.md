# S01 真机验收台账（E2E-01–12）

**状态：** **BLOCKED** — Mac 侧（Tailscale Serve + 系统 CA）已于 2026-11-17 验证通过；iPhone 开发签名信任问题已于 2026-11-17 解决（真机可安装并启动，STORE-00 iPhone 同日 PASS），但 iPhone 仍未接入 tailnet，无法扫码配对，真机 E2E 仍无法执行。
**规则：** 每项必须在真实 iPhone、Mac、Tailscale Serve 与真实 SDK 环境下执行；无真实证据不得写 PASS。

| ID | 场景 | 状态 | 证据 |
|---|---|---|---|
| E2E-01 | 扫码配对，系统 CA 校验通过且无 Funnel | NOT_RUN | Mac 侧 PASS（Let's Encrypt 证书、ssl_verify=0、Funnel 关闭，见 `tailscale-setup.md`）；iPhone 未接入 tailnet，未扫码 |
| E2E-02 | 未认证连接被拒绝（401/拒绝升级） | NOT_RUN | Mac 侧实测：真实 Serve 上无凭据 WS 升级返回 `HTTP/1.1 401 Unauthorized`（2026-11-17 12:34）；待 iPhone 复验 |
| E2E-03 | 只读问答：prompt → 流式正文 | NOT_RUN | BLOCKED：iPhone 未接入 tailnet（签名信任已解决，未配对） |
| E2E-04 | 忙碌时第二次 prompt 返回 SESSION_BUSY 且输入保留 | NOT_RUN | BLOCKED：iPhone 未接入 tailnet |
| E2E-05 | 停止活跃 run，状态进入 cancelled | NOT_RUN | BLOCKED：iPhone 未接入 tailnet |
| E2E-06 | App 退后台不取消任务，回前台恢复 | NOT_RUN | BLOCKED：iPhone 未接入 tailnet |
| E2E-07 | 断网重连后凭快照恢复时间线 | NOT_RUN | BLOCKED：iPhone 未接入 tailnet |
| E2E-08 | 同一 commandId 重试不产生第二个 run | NOT_RUN | BLOCKED：iPhone 未接入 tailnet |
| E2E-09 | 工具审批一律拒绝并显示工具卡片 | NOT_RUN | BLOCKED：iPhone 未接入 tailnet |
| E2E-10 | Mac revoke 后旧 token 不能重连 | NOT_RUN | BLOCKED：无已绑定设备（devices 为空） |
| E2E-11 | Agent 重启后旧会话不可用，不自动重放 | NOT_RUN | BLOCKED：无已绑定设备 |
| E2E-12 | 两个顺序 run 复用同一 Claude session | NOT_RUN | BLOCKED：iPhone 未接入 tailnet |

## 解除条件（2026-11-17 更新）

已完成：Tailscale Serve（Funnel 关闭）、系统 CA 校验、Agent 仅监听 127.0.0.1:8787、未认证升级返回 401（2026-11-23 核对：Tailscale 已停止、Serve 配置为空，需重新启用后复验）。

剩余：

1. ~~在 iPhone「设置 → 通用 → VPN 与设备管理」信任开发签名~~ ✅ 2026-11-17 已解决：真机可安装并启动，STORE-00 iPhone 同日 PASS（见 `docs/s04/store00-evidence.md`）；
2. 恢复 Tailscale 与 Serve（2026-11-23 核对：`tailscale status` 为 stopped，`tailscale serve status` 无配置），并让 iPhone 安装 Tailscale 登录同一 tailnet（当前无 iPhone 节点）；
3. 逐项执行，把真实时间、traceId 与结果回填到上表。

任何一项无法取得真实证据时保持 NOT_RUN，不得用 Mock、模拟器或本地 HTTP 代替。