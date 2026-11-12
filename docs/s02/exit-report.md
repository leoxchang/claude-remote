# S02 退出报告

**最终结论：** **BLOCKED** — Mac Agent 与 Flutter App 的 S02 实现、自动化测试与真实 SDK 回归已完成；E2E-01–12 尚未在真实 iPhone + Tailscale HTTPS 环境执行，S02 不得宣称验收，S03 入口保持 BLOCKED。
**日期：** 2026-11-12
**分支：** `feat/s02-multi-workspace-multi-session`（基线 `073a8ea`，S01 已合并 master）

## 1. 已通过的门禁

| 项 | 命令 | 结果 |
|---|---|---|
| Agent 单元/集成 | `npm run test:s02` | 37 文件 / 250 用例 PASS |
| Agent 覆盖率 | `npm run coverage:agent` | Lines 90.38% |
| Flutter 单元/Widget | `flutter test` | 148 用例 PASS |
| Dart 核心覆盖率 | `flutter test --coverage` | lib（不含 `main.dart`）81.3% |
| 真实 SDK 双并发 | `S02_LIVE=1 npm run test:s02:concurrency` | Task 1 证据 3/3 PASS（`concurrency-evidence.md`）；本轮复跑见第 3.2 节 |
| 真实 SDK 回归 | `npm run test:s02:live -- test/live/s02-real-sdk.live.test.ts` | 4 用例 PASS（147.27s） |
| 共享协议样例与门禁测试 | `npm test` | 14 文件 / 112 用例 PASS |
| S02 总门禁 | `npm run verify:s02` | **FAIL** — 仅剩 E2E-01–12 NOT_RUN、缺真机标记 |

## 2. 交付内容

- **配置与项目**：`AgentConfigV2`、V1→V2 迁移（0600 备份）、Unicode 名称、`realpath` 复核、本机 CLI `workspace add/list/rename/remove`（只走 Unix socket）。
- **多会话**：`SessionRegistry`（不可变记录、稳定分页、Claude 映射冲突拒绝改绑）、`session.start` 兼容语义、归档只读。
- **队列与调度**：每会话 FIFO、全局双槽、`queue.remove`、`cancelling` 占槽、启动前 `assertUsable`、启动失败有界收尾。
- **协议**：新增 7 个命令、`run.queued`/`run.started`、快照 `queuedRuns`/`globalCapacity`、请求指纹幂等与 `COMMAND_ID_CONFLICT`、`agentInstanceId`。
- **Flutter**：项目/会话列表、会话创建/恢复/改名/归档、每会话命令门控与 `agentInstanceId` 重启失效、队列面板（匿名冷启动卡片 + 逐项移除 + 停止不清队列提示）。

## 3. 真实 SDK 回归

### 3.1 S02 调度回归（`npm run test:s02:live -- test/live/s02-real-sdk.live.test.ts`）

```text
Test Files  1 passed (1)
     Tests  4 passed (4)
  Duration  147.27s
```

| 用例 | 结果 | 观察 |
|---|---|---|
| 跨项目双会话并发 | PASS | 两个工作区各自 `init`，Claude session 不同，`foreignEventCount=0`，双方 marker 命中 |
| 同会话排队 + resume | PASS | 第二个 run 在第一个终态后才开始（`startedAt ≥ endedAt`），召回唯一标记，Claude 映射不变 |
| 跨会话独立取消 | PASS | A 取消后进入终态，B 继续执行到 `succeeded`，事件不串线 |
| Bash 仍被拒绝 | PASS | 目标文件未被创建 |

### 3.2 CONC-01 复跑（2026-11-12）

| 场景 | 结果 | 观察 |
|---|---|---|
| same-workspace | PASS | 存活重叠 17,951 ms，文本重叠 4,104 ms，事件零串线 |
| independent-interrupt | PASS | A `cancelled` 后 B 仍产生新 delta |
| cross-workspace | 单独运行 PASS | 存活重叠 17,696 ms，文本重叠 3,464 ms |

背靠背连续复跑时，cross-workspace 偶发出现一方首个 delta 超过 180 s 的网关/模型抖动；adapter 自 Task 1 起未改变并发语义，Task 1 的 3/3 PASS 仍是 CONC-01 的门禁依据。

## 4. 未完成项

| ID | 状态 | 原因 |
|---|---|---|
| E2E-01–12 | NOT_RUN | HTTPS Certificates 未启用、Serve 未配置、iPhone 未接入 |
| `verify:s02` | FAIL | 由上面一项直接导致；门禁按设计拒绝在缺真机证据时放行 |

解除步骤见 `docs/s02/e2e-checklist.md` 的「解除条件」。

## 5. 已知限制（S02 设计内）

- 会话、run、队列、Journal 与幂等只存在内存；Agent 重启生成新 `agentInstanceId`，不恢复、不自动重放。
- queued 卡片冷启动时只显示匿名摘要（runId 短标识 + 入队时间），Mac 不回传 prompt 正文。
- 无 `afterSeq` 增量同步；重连依赖目标会话完整有界快照。
- 手机端没有项目添加/删除、路径输入、队列排序或批量清空。
- 无手机审批：工具一律拒绝（`canUseTool` + `PreToolUse` 双重拦截）。
- 单设备订阅；不提供 CLI 历史导入或双设备并行写入。
- Flutter 聊天页当前只展示所选会话的时间线；跨会话保留策略已在 `AppState.evictIdleTimelines` 建模，页面接线留待后续阶段。

## 6. 下一步

1. 开启 Tailscale HTTPS Certificates 并配置 Serve，验证系统 CA；
2. iPhone 接入同一 tailnet，安装签名；
3. 运行 `S02_LIVE=1 npm run test:s02:live` 复核真实 SDK 回归；
4. 逐项执行 E2E-01–12 并回填台账（`realDevice` 改为 true）；
5. `npm run verify:s02` 全部 PASS 后再解除 S03 入口 BLOCKED。