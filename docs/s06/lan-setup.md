# 局域网直连（无中继）

**适用：** iPhone 与 Mac 在同一 Wi-Fi，先不接 Tailscale/Cloudflare/frp。
**安全边界：** 局域网模式使用明文 `http://` + `ws://`，只应在可信网络使用；令牌可被同网段设备嗅探。

## 1. 前置条件

- Mac 与 iPhone 连接同一个 Wi-Fi；
- Mac 有私有 IPv4（`192.168.x.x` / `10.x.x.x` / `172.16–31.x.x`）；
- macOS 防火墙允许 `node` 接受传入连接（首次启动会弹窗，选择允许）。

## 2. 开启

```bash
node --import tsx apps/agent/src/main.ts lan status   # 当前模式
node --import tsx apps/agent/src/main.ts lan enable   # 切换局域网直连
```

`lan enable` 会：

- 把 `~/.claude-remote/agent.json` 的 `listen.host` 改为 `0.0.0.0`；
- 把 baseUrl 改为 `http://<Mac 局域网 IP>:8787`；
- 在 `agent.json.lan.bak` 保留切换前配置（0600）。

然后重启 Agent，并重新配对：

```bash
node --import tsx apps/agent/src/main.ts start
# 另一个终端
node --import tsx apps/agent/src/main.ts pair --replace
```

二维码中的地址应为 `http://192.168.x.x:8787`。iPhone 首次连接会请求"本地网络"权限，必须允许。

## 3. 关闭 / 切回隧道

```bash
node --import tsx apps/agent/src/main.ts lan disable \
  --base-url https://<your-tunnel-host>
```

监听恢复为 `127.0.0.1`，baseUrl 必须为 https。

## 4. 验证

Mac 上（`<Mac 局域网 IP>` 可从 `lan status` 的 `lanAddress` 获取）：

```bash
curl -s -o /dev/null -w '%{http_code}\n' -X POST http://127.0.0.1:8787/v1/pairings
curl -s -o /dev/null -w '%{http_code}\n' -X POST http://<Mac 局域网 IP>:8787/v1/pairings
```

预期返回 `400`（缺少配对载荷）而不是连接失败。

iPhone 上：Safari 打开 `http://<Mac 局域网 IP>:8787/v1/pairings` 应返回 JSON 错误而不是"无法连接"。

## 5. 常见问题

| 现象 | 处理 |
|---|---|
| `no private IPv4 address found` | 先连接 Wi-Fi，确认拿到 192.168/10/172 地址 |
| iPhone 连不上 | 检查 macOS 防火墙、是否同一 Wi-Fi、是否开了客户端隔离（AP isolation） |
| IP 变化（DHCP） | 重新执行 `lan enable`；`doctor` 会提示地址变化 |
| 需要清除本地网络权限 | iOS 设置 → 通用 → 传输或还原 → 还原位置与隐私 |

## 6. 实测记录

2026-11-23：

- `lan enable` 后配置为 `http://192.168.5.128:8787`、监听 `0.0.0.0:8787`；
- `curl -X POST http://127.0.0.1:8787/v1/pairings` 与 `http://192.168.5.128:8787/v1/pairings` 均返回 `400`（缺载荷，链路可达）；
- macOS 防火墙为关闭状态，无拦截；
- `flutter build ios --release` 签名构建成功，App 已安装到 iPhone 17e（iPhone 地址 192.168.5.129）；
- iPhone 扫码配对成功（设备 `User iPhone`），项目/会话列表、历史同步与两条文字 prompt 全部成功；
- 服务端事件序列：`run.queued → run.started → message.delta × N → message.completed → run.completed`。

真机联调中修复的三个缺陷：

1. App 主连接与语音连接只发送 `Bearer <token>`，服务端要求 `Bearer <deviceId>.<token>`；已统一修正。
2. 项目/会话列表使用的命令连接只建立 WebSocket、不发送 `connection.hello`；服务端 10 秒握手超时后关闭，列表命令全部超时。新增 `ReadyAgentSocket` 完成握手。
3. 服务端同一设备只保留一个连接（新连接顶掉旧连接），而 App 的列表连接与聊天连接相互独立；聊天连接建立后列表连接被顶掉，导致历史同步失败。改为全 App 共用同一 `CommandClient`/socket，聊天连接就绪后复用它。

遗留观察：每次 run 在数据库中出现两条 `run.completed`（eventId 不同），不影响当前 UI 展示，已记入待办。

## 7. 限制

- 明文 HTTP/WS：同网段设备可嗅探 Bearer 令牌；不要在公司/公共 Wi-Fi 使用。
- 无 UDP 打洞、无 NAT 穿透：只能在同一局域网。
- 后续若要在局域网内加密，可引入本地 CA + TLS 反向代理，不改协议。

## 8. 输入区与图片（2026-11-23）

底部输入条按“图片 / 语音 / 键盘”三合一组织：

- 左侧相机按钮与右侧“+”都会弹出“拍照 / 相册”；
- 中间在键盘模式是文本框，在语音模式是“按住说话”（右侧麦克风按钮切换）；
- 有内容时右侧显示发送箭头，忙碌时 tooltip 为“排队”。

图片链路：

1. 手机把图片缩到长边 1568 像素、JPEG 质量 82 后 `POST /v1/attachments`（Bearer 鉴权，单张 ≤ 8 MiB；只接受 jpeg/png/webp，按魔数校验）；
2. Mac 保存到 `<configDir>/attachments/files/`（0600），返回不透明 `attachmentId`；
3. `prompt.send.payload.attachments` 只携带 `{attachmentId, mediaType, size}`，可用 `text: ""` 只发图片；
4. 接受后按 `runId` 写清单 `<configDir>/attachments/runs/<runId>.json`，run 启动时由 adapter 读回文件并以 base64 图片块交给 Agent SDK；
5. 图片 7 天后清理，queued/重启恢复的 run 仍能读到清单。

本机提问记录 `user_messages` 升到 v4，增加 `attachmentPaths`：发送时把临时图片复制到 `<Application Support>/user-attachments/`，重进会话或重启 App 后气泡里仍能看到缩略图。