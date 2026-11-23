# Tailscale Serve 配置记录

**状态：** **Mac 侧 PASS（2026-11-17 12:33 实测）** — HTTPS Certificates 已开启，Serve 已生效，系统 CA 校验通过，Funnel 未启用；**iPhone 仍未接入 tailnet**（`tailscale status` 无 Peer）。
**目标：** 只用 Serve 把 `https://<machine>.<tailnet>.ts.net` 转发到 `127.0.0.1:8787`；**不得启用 Funnel**。

## 1. 前置条件

| 条件 | 状态 |
|---|---|
| Mac 安装 Tailscale 并登录 | ✅ 1.104.6（daemon）/ 1.104.7（CLI），BackendState=Running |
| Mac 与 iPhone 在同一 tailnet | ❌ iPhone 未接入（status 仅本机一个节点） |
| MagicDNS 开启 | ✅ `CurrentTailnet.MagicDNSEnabled=true` |
| HTTPS Certificates 开启 | ✅ `CertDomains: ["macbook-pro.tail0970fd.ts.net"]` |
| 机器名不含敏感信息 | ✅ `macbook-pro` |

> 2026-11-17 发现 443 冲突：Homebrew nginx 以 root 监听 IPv4 443（cert `www-local.yxt101.com`），导致 TLS 握手拿到自签证书。停止 nginx 后 tailscaled 同时接管 IPv4/IPv6 443，证书恢复正常。

## 2. 已实测的本机信息

```text
machineHostname: macbook-pro
tailnetName:     tail0970fd.ts.net
dnsName:         macbook-pro.tail0970fd.ts.net
tailscaleIPs:    100.95.53.10, fd7a:115c:a1e0::e01:35dd
serveTarget:     127.0.0.1:8787
funnelEnabled:   false（`tailscale funnel status` 仅显示 tailnet only，无 Funnel）
```

## 3. 执行步骤（2026-11-17 复核）

1. 在 Tailscale 管理后台（Admin → DNS）开启 **HTTPS Certificates**；
2. 执行 `/Applications/Tailscale.app/Contents/MacOS/Tailscale serve --bg 8787`；
3. 用 `tailscale serve status` 记录实际监听与转发目标；
4. 确认 Funnel 关闭：`tailscale funnel status` 必须显示未启用；
5. 用系统 CA 校验访问 `https://macbook-pro.tail0970fd.ts.net`，记录证书主体与有效期；
6. 回填下面字段。

```text
machineHostname: macbook-pro
tailnetName:     tail0970fd.ts.net
serveTarget:     127.0.0.1:8787
funnelEnabled:   false（必须）
certificateCheck: PASS — curl ssl_verify_result=0（系统 CA），
                 subject=CN=macbook-pro.tail0970fd.ts.net，
                 issuer=Let's Encrypt YE2，
                 notBefore=2026-11-17 03:29:13 UTC，notAfter=2027-02-15 03:29:12 UTC
```

> 说明：HTTPS Certificates 关闭时 `tailscale serve --bg 8787` 会一直等待证书签发而不返回，已在 2026-11-12 观测到；这不是命令写错。

## 4. 验收标准

- E2E-01：系统 CA 校验通过，无 Funnel，无关闭 TLS 校验的客户端配置。
- Agent 只监听 `127.0.0.1:8787`，不存在 `0.0.0.0` 监听。
- 管理接口只走 `~/.claude-remote/agent.sock`，不经 Serve 暴露。

以上任一项未满足，E2E-01 保持 NOT_RUN，S01 不得验收。