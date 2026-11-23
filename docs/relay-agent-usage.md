# Agent 云端中转（relay）使用说明

本文说明如何让 Agent 通过云端 Relay 与手机互联（手机与电脑无需同一网络）。
直连模式（Tailscale / 局域网 + 扫码配对）保持原样，两种模式可以同时开启。

## 1. 部署云端 Relay

在任意可被手机与电脑访问的服务器（或本机开发环境）上：

```bash
RELAY_DATA_DIR=./relay-data node --import tsx apps/relay/src/main.ts serve
# 生产环境由反向代理终止 TLS，监听地址与端口用 RELAY_HOST / RELAY_PORT 配置
```

启动后输出一行 JSON：`{"event":"relay.started","host":"…","port":…}`。

## 2. 创建账号（管理员内部操作）

```bash
RELAY_DATA_DIR=./relay-data node apps/relay/bin/claude-remote-relay.js admin create-user alice --password '<初始口令>'
```

其他管理命令：`reset-password`、`disable-user` / `enable-user`、`list-accounts`、
`list-devices <username>`、`revoke-device <deviceId>`（吊销立即断开存活连接）。

## 3. 电脑端登录云端

Agent 需先 `init`。注意**先 `start` 一次**（完成配置升级到 v5，随后可 Ctrl-C 停止），
再执行登录：

```bash
claude-remote-agent relay login --url https://relay.example.com --username alice --password '<口令>' --name "我的 Mac"
```

成功后凭证写入 `agent.json` 的 `relay` 段（文件权限 0600）。
`relay status` 查看配置（不显示令牌）；`relay logout` 清除凭证。

## 4. 启动与查看状态

```bash
claude-remote-agent start     # 前台启动；或 service install 后常驻
claude-remote-agent status    # relay 字段：enabled/baseUrl/state/lastEpoch/lastError
claude-remote-agent doctor    # 含 relay 配置检查项
```

`state` 含义：`connecting` 正在连接/重连；`ready` 已握手（`lastEpoch` 为云端分配的
连接代次）；`stopped` 已停止（`lastError` 为致命关闭码，如 4004=凭证被吊销，
需重新 `relay login`；4000=被同身份的另一个 Agent 示例取代）。

## 5. 手机端

手机 App 使用同一账号登录云端，即可看到并控制名下所有电脑；无需扫码配对。
云端模式下的手机不会出现在电脑的本地设备列表中（`agent devices` 仅列直连设备）。

## 故障排查

- `state` 长期 `connecting`：检查 `baseUrl` 可达性与服务端 TLS。
- `lastError` 为 `HTTP_401` / `HTTP_403`：升级被拒（凭证失效或配置错误），
  重新 `relay login` 后**重启 agent** 使新凭证生效。
- 云端吊销了本机：`lastError=4004`，重新登录并重启即可恢复。
- 两台机器误用同一份凭证（如复制了配置目录）：后连者生效，先连者停止重连
  （`lastError=4000`）。