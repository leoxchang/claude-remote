# 网关请求归因（SDK-03）

## 预期配置来源

- 用户级 `~/.claude/settings.json` 的 `env` 定义：
  - `ANTHROPIC_BASE_URL` → origin `http://127.0.0.1:15721/`（路径与查询串不记录）
  - `ANTHROPIC_AUTH_TOKEN`（值不记录、不进入任何证据文件）
- 该端口由本机网关应用监听。S00 不依赖该应用的具体实现，只按当前生效配置验证。

## 本次运行

本文件**不固定**时间窗口或 session ID：每次 live 运行都会覆盖 `evidence/SDK-03.json`，其中的
`window`、`sessionIds`、`gatewayOrigin` 是该次运行的权威记录。

## 归因证据

1. **Runtime 日志**：SDK 子进程的 debug 日志包含 `settingsEnv keys: ANTHROPIC_AUTH_TOKEN,ANTHROPIC_BASE_URL,...`，说明 CLI 子进程应用了用户设置的网关环境变量；
   `runtimeDebugMentionsModel = true`，日志中出现预期模型名。
2. **进程级连接记录**：在运行窗口内反复采样 `lsof -iTCP:15721 -sTCP:ESTABLISHED`，观察到测试进程的后代进程 `claude`（SDK 自带的 CLI 二进制）与该端口保持已建立连接；采样按进程祖先链过滤，只统计本次测试进程的子进程，排除了本机其他 Claude 会话。
3. **无回落证据**：同一窗口的 Runtime 日志未出现 `api.anthropic.com` 直连记录（`runtimeDebugMentionsDirectAnthropic = false`）。**该条件现在是 SDK-03 判定 PASS 的必要条件。**
4. **日志是否包含网关主机**：`runtimeDebugMentionsGateway` 随运行而不同（debug 日志并不总是打印 base URL 主机）。该字段记录在证据中，但主机归因不依赖它——第 2 条连接记录才是主证据。

## 限制

- 本机网关应用不提供可读取的请求级日志，因此没有网关侧的 request id、请求体或逐请求记录。
- 归因是「OS 级连接记录 + Runtime 日志」的组合证据，不是网关请求日志。

## CLI 与 SDK 请求路径对照

- SDK 路径：如上，SDK 自带 Runtime 2.1.319 的子进程经 `127.0.0.1:15721` 访问模型。
- CLI 路径：CLI-01/02 在相同 fixture、相同用户设置下调用本机 `claude` 2.1.311，两个方向的会话创建与恢复均成功（见 `session-interoperability.md`）。CLI 子进程同样读取用户 settings 中的 `ANTHROPIC_BASE_URL`，因此与 SDK 走同一网关；本次没有单独对 CLI 进程做 lsof 采样，该结论来自配置来源一致性 + 双向恢复成功。