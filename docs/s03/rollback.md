# S03 回滚边界

**原则：** 先让全部审批失去可批准状态，再停止或等待活跃 run；不重放、不自动 allow，也不宣称旧 run 已成功。

## 回滚步骤

1. 对每个 workspace 执行 `claude-remote-agent workspace set-approval <workspaceId> --mode deny`，确认其 pending 全部变为 `invalidated/policy_disabled`；
2. 等待活跃 run 结束，或对每个会话执行 `run.cancel`，确认 `permission.resolved` 先于 `run.completed`；
3. 用 `queue.remove` 清空 queued run，确认 `workspace.list` 的 `activeRunCount=0`、`queuedRunCount=0`、`pendingApprovalCount=0`；
4. 停止 Agent 进程；优雅关闭会先 `invalidateAll('agent_shutdown')` 再关闭连接；
5. 备份当前 V3 配置（`agent.json`），确认同目录存在迁移时生成的 `agent.json.v2.bak`（0600）；
6. 用 `agent.json.v2.bak` 覆盖 `agent.json`（权限保持 `0600`），该文件只含 V2 项目与队列策略；
7. 重新启动旧版本 Agent；启动逻辑只把 V2 视为未知版本或按 V2 读取，不得把 V3 项目静默改成 `allow_once`；
8. 用旧版本 `workspace list` 确认项目恢复结果，并确认没有旧 callback 永久等待。

## 边界

- 回滚后审批、审计、Journal、队列与幂等表均不可恢复（S03 仍为内存状态）；
- 旧 `approvalId` 不可读取、不可响应，App 显示“旧审批失效/执行结果未知”；
- 回滚不删除任何项目目录，也不撤销 Claude 原生会话文件；
- V3 中已开启 `allow_once` 的项目不会因回滚变成默认允许；恢复 V2 后需要重新逐项目开启；
- 若 `agent.json.v2.bak` 不存在，不得猜测配置，必须停止并人工确认；
- `funnelEnabled: false` 必须保持。