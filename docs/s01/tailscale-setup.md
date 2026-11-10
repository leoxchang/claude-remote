# Tailscale Serve 配置记录

**状态：** **NOT_RUN** — 本机未安装 Tailscale（2026-11-10 核对）。
**目标：** 只用 Serve 把 `https://<machine>.<tailnet>.ts.net` 转发到 `127.0.0.1:8787`；**不得启用 Funnel**。

## 1. 前置条件（未满足）

| 条件 | 状态 |
|---|---|
| Mac 安装 Tailscale 并登录 | 未安装 |
| iPhone 与 Mac 在同一 tailnet | 未验证 |
| MagicDNS 开启 | 未验证 |
| HTTPS Certificates 开启 | 未验证 |
| 机器名不含敏感信息（会进入公开 CT 日志） | 未验证 |

## 2. 配置步骤（安装后执行并回填）

具体子命令以安装后的官方 CLI 为准；本文件不预先写死可能过时的参数。

1. 安装 Tailscale，登录与 iPhone 相同的 tailnet。
2. 确认 `status` 显示已连接，记录脱敏的机器名与 tailnet 名。
3. 开启 MagicDNS 与 HTTPS Certificates（Admin 控制台）。
4. 配置 Serve：把 `https://<machine>.<tailnet>.ts.net` 代理到 `127.0.0.1:8787`。
5. 用 `tailscale serve status` 记录实际监听与转发目标。
6. 确认 Funnel 关闭：`funnel` 状态必须为未启用，且不存在公网入口。
7. 用系统 CA 校验访问 `https://<machine>.<tailnet>.ts.net`，记录证书主体与有效期。

回填以下字段（不记录完整证书、密钥或账号信息）：

```text
machineHostname: <已脱敏>
tailnetName:     <已脱敏>
serveTarget:     127.0.0.1:8787
funnelEnabled:   false（必须）
certificateCheck: <通过 / 失败 + 时间>
```

## 3. 验收标准

- E2E-01：系统 CA 校验通过，无 Funnel，无关闭 TLS 校验的客户端配置。
- Agent 只监听 `127.0.0.1:8787`，不存在 `0.0.0.0` 监听。
- 管理接口只走 `~/.claude-remote/agent.sock`，不经 Serve 暴露。

以上任一项未满足，E2E-01 保持 NOT_RUN，S01 不得验收。