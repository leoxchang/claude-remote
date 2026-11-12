# Tailscale Serve 配置记录

**状态：** **PARTIAL** — Tailscale 1.104.6 已安装并连接，MagicDNS 已开；**HTTPS Certificates 未启用**，Serve 尚未配置成功（2026-11-12 核对）。
**目标：** 只用 Serve 把 `https://<machine>.<tailnet>.ts.net` 转发到 `127.0.0.1:8787`；**不得启用 Funnel**。

## 1. 前置条件

| 条件 | 状态 |
|---|---|
| Mac 安装 Tailscale 并登录 | ✅ 1.104.6，BackendState=Running |
| Mac 与 iPhone 在同一 tailnet | ⏳ iPhone 未接入 |
| MagicDNS 开启 | ✅ `CurrentTailnet.MagicDNSEnabled=true` |
| HTTPS Certificates 开启 | ❌ `CertDomains: null` |
| 机器名不含敏感信息 | ✅ `macbook-pro` |

## 2. 已实测的本机信息

```text
machineHostname: macbook-pro
tailnetName:     tail0970fd.ts.net
dnsName:         macbook-pro.tail0970fd.ts.net
tailscaleIPs:    100.95.53.10, fd7a:115c:a1e0::e01:35dd
serveTarget:     127.0.0.1:8787（待配置）
funnelEnabled:   false（当前无任何 serve/funnel 配置）
```

## 3. 待执行步骤

1. 在 Tailscale 管理后台（Admin → DNS）开启 **HTTPS Certificates**；
2. 执行 `/Applications/Tailscale.app/Contents/MacOS/Tailscale serve --bg 8787`；
3. 用 `tailscale serve status` 记录实际监听与转发目标；
4. 确认 Funnel 关闭：`tailscale funnel status` 必须显示未启用；
5. 用系统 CA 校验访问 `https://macbook-pro.tail0970fd.ts.net`，记录证书主体与有效期；
6. 回填下面字段。

```text
machineHostname: macbook-pro
tailnetName:     tail0970fd.ts.net
serveTarget:     <待回填>
funnelEnabled:   false（必须）
certificateCheck: <待回填>
```

> 说明：HTTPS Certificates 关闭时 `tailscale serve --bg 8787` 会一直等待证书签发而不返回，已在 2026-11-12 观测到；这不是命令写错。

## 4. 验收标准

- E2E-01：系统 CA 校验通过，无 Funnel，无关闭 TLS 校验的客户端配置。
- Agent 只监听 `127.0.0.1:8787`，不存在 `0.0.0.0` 监听。
- 管理接口只走 `~/.claude-remote/agent.sock`，不经 Serve 暴露。

以上任一项未满足，E2E-01 保持 NOT_RUN，S01 不得验收。