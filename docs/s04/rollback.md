# S04 回滚

## 回滚步骤

1. 停止 Agent，确认没有正在执行的 run 或未处理迁移。
2. 用 SQLite backup API 备份 `agent.sqlite3`（含 WAL），保留 0600。
3. 将 `agent.json.v3.pre-sqlite.bak` 与 `devices.json.pre-sqlite.bak` 复制回临时目录，
   仅用于恢复旧项目/设备配置。
4. 不删除 SQLite 数据库；旧版本看不到 S04 新历史，不得声称完整回滚。
5. 回滚后重新执行 S01–S03 自动化门禁。

## 边界

- 恢复 V3 JSON 只恢复旧项目/设备配置，不恢复旧 run、审批或事件。
- 不自动反向迁移、不静默从备份重建执行状态。
- 审批正文与 token 边界的承诺不因回滚改变。
