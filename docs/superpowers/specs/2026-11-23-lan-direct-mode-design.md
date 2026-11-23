# 局域网直连模式设计

**日期：** 2026-11-23
**状态：** 已实现（S06 补充）
**背景：** Tailscale 控制面在部分网络环境需要额外代理，iPhone 端也不便安装。先提供同一局域网内的直连模式。

## 1. 目标与非目标

- 目标：iPhone 与 Mac 在同一 Wi-Fi 时，不依赖任何 VPN 或公网中继即可配对、收发文字与语音。
- 非目标：公网访问、NAT 穿透、局域网加密（后续可加本地 CA + TLS）。

## 2. 方案

- Agent 监听地址从固定 `127.0.0.1` 扩展为 `127.0.0.1 | 0.0.0.0`；端口仍为 8787。
- baseUrl 策略：
  - `https://` 任意主机；
  - `http://` 仅私有 IPv4（10/8、127/8、172.16/12、192.168/16）。
- 配置一致性：`listen.host=0.0.0.0` 必须配 `http` 私有地址；`127.0.0.1` 必须配 `https`。
- CLI：`init --lan`、`lan enable`、`lan status`、`lan disable --base-url <https>`。
- App：二维码校验接受同一策略；`https→wss`、`http→ws`；iOS 增加 `NSAllowsLocalNetworking` 与本地网络用途说明。
- 诊断：`doctor` 的 `tailscale` 检查改为 `endpoint`：局域网模式校验网卡地址是否与配置一致，`.ts.net` 仍做 Serve/Funnel 检查。

## 3. 安全边界

- 明文只允许私有 IPv4，公网明文一律拒绝。
- Bearer token 与一次性配对保留；不新增无认证入口。
- `lan enable` 保留 0600 备份；`doctor` 提示防火墙要求。
- 仅信任局域网：同一广播域内的设备可嗅探明文令牌，文档明确禁止在公共/公司 Wi-Fi 使用。

## 4. 改动文件

- `apps/agent/src/config/base-url.ts`、`lan.ts`、`paths.ts`、`initialize.ts`、`load.ts`、`config-v2.ts`、`config-v4.ts`
- `apps/agent/src/app/runtime.ts`（按配置监听）、`src/diagnostics/doctor.ts`、`src/cli.ts`
- `apps/mobile/lib/features/pairing/qr_payload.dart`、`lib/data/io_agent_socket.dart`、`lib/voice/voice_asr_client.dart`、`ios/Runner/Info.plist`
- 测试：Agent 配置/LAN/doctor/入口；Flutter 二维码与 ASR；文档 `docs/s06/lan-setup.md`

## 5. 验证

- `npm run test:agent`、`flutter test` 全绿；
- Mac 上 `lan enable` 后用 `curl http://<lan-ip>:8787/v1/pairings` 验证可达；
- iPhone 真机配对与文字/语音流程作为后续 E2E。