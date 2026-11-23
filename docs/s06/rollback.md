# S06 回滚

**日期：** 2026-11-23

## 1. 回滚常驻服务

```bash
node --import tsx apps/agent/src/main.ts service uninstall
```

- 停止并移除 `com.claude-remote.agent`；
- 删除 `~/Library/LaunchAgents/com.claude-remote.agent.plist`；
- 配置、数据库、设备绑定与日志保留，不回退 schema。

回到前台运行：

```bash
node --import tsx apps/agent/src/main.ts start
```

## 2. 回滚诊断与日志

- 删除用户主动导出的诊断包即可，不影响 Agent；
- 日志轮转文件 `agent.log.1`–`.3` 可保留或按需删除；
- 日志与诊断均为只读产物，回滚不触碰数据库。

## 3. 代码回滚

S06 改动为增量：

- 版本常量集中在 `apps/agent/src/app/versions.ts`；
- 日志仅增加轮转与字段，格式兼容；
- `AdminStatus` 新增 `versions` 字段，客户端忽略即可；
- 新增 `doctor`、`diagnostics`、`service` 命令与 `src/main.ts` 入口，不改变既有命令；
- 不改变协议、数据库 schema、幂等与恢复语义。

回滚到 S05 版本只需切回对应提交；已安装的 launchd 服务应先 `service uninstall`，避免旧进程占用 `agent.lock`。

## 4. 验证

1. `node --import tsx apps/agent/src/main.ts --help` 正常；
2. `agent status` 能连接原配置（前台启动后）；
3. `npm run test:agent`、`npm test` 全绿；
4. S01–S05 台账状态不因回滚改变。