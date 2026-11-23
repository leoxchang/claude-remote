# S06 安装与使用

**适用范围：** 个人版（macOS + iPhone），普通用户运行，不使用 Funnel。
**入口：** `node --import tsx apps/agent/src/main.ts <command>`（等价于 `node apps/agent/bin/claude-remote-agent.js <command>`）。

## 1. 版本要求

| 项 | 要求 |
|---|---|
| macOS | Darwin 27.x（本机 27.2.0 验证） |
| Node.js | ≥ 22（本机 24.15.0） |
| 仓库依赖 | `npm ci` 已完成（含 `tsx`） |
| iPhone | 与 Mac 同一 tailnet，安装 Claude Remote App |
| 豆包 | `DOUBAO_ASR_API_KEY`（仅语音需要） |

## 2. 首次初始化

```bash
cd <repo>
npm ci

node --import tsx apps/agent/src/main.ts init \
  --workspace /absolute/path/to/project \
  --name "项目显示名" \
  --base-url https://<machine>.<tailnet>.ts.net
```

`init` 在 `~/.claude-remote/` 写入 0600 配置；已有配置时拒绝覆盖。

### 2.1 局域网直连（暂不接隧道）

iPhone 与 Mac 在同一 Wi-Fi 时，可跳过第 3 节的 Tailscale/隧道步骤：

```bash
node --import tsx apps/agent/src/main.ts lan enable
node --import tsx apps/agent/src/main.ts start
node --import tsx apps/agent/src/main.ts pair --replace
```

二维码地址为 `http://<Mac 局域网 IP>:8787`；iPhone 首次连接需允许"本地网络"权限。
局域网模式是明文 HTTP/WS，只能在可信网络使用，详见 `lan-setup.md`。

## 3. Tailscale Serve

1. Tailscale 管理后台开启 **HTTPS Certificates**；
2. 启动 Serve：

```bash
tailscale serve --bg 8787
tailscale serve status        # 应显示 https://<machine>.<tailnet>.ts.net → 127.0.0.1:8787
tailscale funnel status       # 必须显示未启用
```

**不要启用 Funnel，不要关闭 TLS 校验。** 若 443 被 nginx 占用，先停止 nginx。

## 4. 启动与配对

前台启动（调试）：

```bash
node --import tsx apps/agent/src/main.ts start
```

另一个终端配对：

```bash
node --import tsx apps/agent/src/main.ts pair          # 显示二维码
node --import tsx apps/agent/src/main.ts pair --replace # 替换已绑定设备
node --import tsx apps/agent/src/main.ts devices
node --import tsx apps/agent/src/main.ts revoke <deviceId>
```

iPhone 扫码后应通过系统 CA 校验，不弹证书例外。

## 5. 项目与会话

```bash
node --import tsx apps/agent/src/main.ts workspace list
node --import tsx apps/agent/src/main.ts workspace add --path /abs/project --name "名称"
node --import tsx apps/agent/src/main.ts workspace rename <workspaceId> --name "新名称"
node --import tsx apps/agent/src/main.ts workspace set-approval <workspaceId> --mode allow_once
node --import tsx apps/agent/src/main.ts workspace remove <workspaceId>
```

默认每个项目为 `deny`；手机只能看到 Mac 已授权的项目。

## 6. 豆包语音凭证

语音默认不可用，文字输入不受影响。密钥只在 Agent 进程启动时读取，轮换需重启。

前台运行：

```bash
export DOUBAO_ASR_API_KEY=...
node --import tsx apps/agent/src/main.ts start
```

launchd 常驻：用 `service install --env` 显式注入（见下）。**装完必须重跑 ASR-00。**

## 7. launchd 常驻

```bash
# 安装并加载（环境值写入 0600 plist，不回显）
node --import tsx apps/agent/src/main.ts service install \
  --env DOUBAO_ASR_API_KEY=...

node --import tsx apps/agent/src/main.ts service status
node --import tsx apps/agent/src/main.ts service uninstall
```

行为：

- 开机启动（`RunAtLoad`）；
- 崩溃拉起（`KeepAlive.SuccessfulExit=false`），正常退出不重拉；
- 日志：`~/.claude-remote/agent.log`，10 MiB 轮转，保留 3 份；
- launchd 自身 stdout/stderr：`~/.claude-remote/launchd.{out,err}.log`；
- plist：`~/Library/LaunchAgents/com.claude-remote.agent.plist`（0600，可能含环境值，不要提交或分享）。

可选参数：`--node <path>`、`--entry <path>`、`--cwd <path>`。

## 8. 诊断

```bash
# 配置、存储、运行状态、Tailscale、日志、版本
node --import tsx apps/agent/src/main.ts doctor

# 脱敏诊断包（0600）
node --import tsx apps/agent/src/main.ts diagnostics export --output ~/Desktop/agent-diagnostics.json
```

诊断包只含版本、检查结果、运行状态与日志尾部（默认 200 行）；不含 prompt、回复、音频、令牌或密钥。

## 9. 升级

```bash
cd <repo>
git pull
npm ci
node --import tsx apps/agent/src/main.ts service uninstall
node --import tsx apps/agent/src/main.ts service install --env DOUBAO_ASR_API_KEY=...
```

配置与数据库为增量迁移，升级前建议先 `diagnostics export` 留存现场。

## 10. 解绑与撤销

```bash
node --import tsx apps/agent/src/main.ts devices
node --import tsx apps/agent/src/main.ts revoke <deviceId>
```

撤销后旧 token 不能重连；需要重新 `pair`。

## 11. 安全提醒

- 不要把 `DOUBAO_ASR_API_KEY` 写进仓库、命令行历史、SQLite、日志或诊断包；
- 不要把 launchd plist 提交到版本库；
- 不使用 Funnel、不关闭 TLS 校验、不开启 `bypassPermissions`。