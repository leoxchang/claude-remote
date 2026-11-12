# S02 回滚边界

**原则：** 回滚只恢复「本机项目授权配置」，不删除项目文件、不删除 Claude 原生会话文件、不重放内存中的 run。

## 回滚步骤

1. 在 Mac 终止所有活跃 run：对每个会话执行 `run.cancel`，等待 `run.completed`；
2. 逐项 `queue.remove` 清空排队项，确认 `workspace.list` 的 `activeRunCount=0`、`queuedRunCount=0`；
3. 停止 Agent 进程；
4. 备份当前 V2 配置（`agent.json`），确认同目录存在迁移时生成的 `agent.json.v1.bak`；
5. 用 `agent.json.v1.bak` 覆盖 `agent.json`（权限保持 `0600`），该文件只含原始单项目；
6. 重新启动 Agent；启动逻辑只会迁移 V1，不会截断多项目 V2 配置后静默启动；
7. 用 `claude-remote-agent workspace list` 确认恢复结果。

## 边界

- 回滚后原有内存会话、run、队列与 Journal 均不可恢复（S02 不持久化这些数据）；
- 被移除项目的 `workspaceId` 不会复活，重新添加会生成新 ID；
- 回滚不会删除任何项目目录，也不会撤销 Claude 原生会话文件；
- 若 `agent.json.v1.bak` 不存在，不得猜测配置，必须停止并人工确认。