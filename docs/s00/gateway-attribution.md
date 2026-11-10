# 网关请求归因（SDK-03）

## 预期配置来源

- 用户级 `~/.claude/settings.json` 的 `env` 定义：
  - `ANTHROPIC_BASE_URL` → origin `http://127.0.0.1:15721/`（路径与查询串不记录）
  - `ANTHROPIC_AUTH_TOKEN`（值不记录、不进入任何证据文件）
- 该端口由本机网关应用监听。S00 不依赖该应用的具体实现，只按当前生效配置验证。

## 本次运行

- 时间窗口（UTC）：`2026-11-10T04:35:34.287Z` → `2026-11-10T04:35:53.368Z`
- 会话 ID：
  - `5099f46c-92cf-44f1-adea-3d9d1522a6ac`
  - `50b9bf49-067d-4365-882e-905693cf627c`
  - `8ea4d427-2180-490c-ac2d-fa388bd87d28`
  - `0ffc7c76-af33-4db8-b566-0bd4243d1c06`
- 预期模型：以 `system/init.model` 为准（见 `evidence/SDK-04.json` 的运行记录）

## 归因证据

1. **Runtime 日志**：SDK 子进程的 debug 日志包含 `settingsEnv keys: ANTHROPIC_AUTH_TOKEN,ANTHROPIC_BASE_URL,...`，说明 CLI 子进程应用了用户设置的网关环境变量。
2. **进程级连接记录**：在时间窗口内反复采样 `lsof -iTCP:15721 -sTCP:ESTABLISHED`，观察到测试进程的后代进程 `claude`（SDK 自带的 CLI 二进制）与该端口保持已建立连接；采样按进程祖先链过滤，只统计本次测试进程的子进程，排除了本机其他 Claude 会话。
3. **无回落证据**：同一窗口的 Runtime 日志未出现 `api.anthropic.com` 直连记录；`runtimeDebugMentionsDirectAnthropic = false`。
4. **模型对照**：Runtime 日志中出现预期模型名，`runtimeDebugMentionsModel = true`。

## 限制

- 本机网关应用不提供可读取的请求级日志，因此没有网关侧的 request id、请求体或逐请求记录。
- 归因是「OS 级连接记录 + Runtime 日志」的组合证据，不是网关请求日志。
- Runtime 日志不打印 `ANTHROPIC_BASE_URL` 的主机值（`runtimeDebugMentionsGateway = false`），主机归因完全依赖第 2 条连接记录。

## CLI 与 SDK 请求路径对照

- SDK 路径：如上，SDK 自带 Runtime 2.1.319 的子进程经 `127.0.0.1:15721` 访问模型。
- CLI 路径：CLI-01–03（Task 7）在相同 fixture、相同用户设置下调用本机 `claude` 2.1.311，其请求同样必须经过该网关；对照结论在 Task 7 完成后补充到本节。