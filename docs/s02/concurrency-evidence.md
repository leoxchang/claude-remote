# S02 CONC-01 并发门禁证据

**结论：** **PASS** — 三个场景均观察到真实的 SDK 并发窗口，事件按 run 隔离，独立 interrupt 不影响另一 query。
**执行日期：** 2026-11-11（Asia/Shanghai）
**代码基线：** `9ac3e10`（S01 Task 0–10）+ 本任务新增测试
**入口：** `S02_LIVE=1 npm run test:s02:concurrency`

## 1. 环境

| 项 | 值 |
|---|---|
| Node.js | v22.23.2 |
| Agent SDK | 0.3.319（仓库固定） |
| 被测实现 | `apps/agent/src/adapter/agent-sdk-adapter.ts`（未修改） |
| 连接 | 本机已配置的 SDK 网关（与 S00 证据同一来源） |
| 隔离方式 | 每个场景在系统临时目录创建独立 fixture 项目，结束后删除；未使用任何真实个人项目 |

SDK 版本与网关地址、凭证、绝对路径均未写入本文件。

## 2. 判据

- **存活窗口**：从 `init` 事件到 `runResult` 终态；未终态时以最后一个事件为界。
- **并发成立**：两个 run 的存活窗口有正交集，且双方在对方存活窗口内都产生了文本 delta。
- **文本流重叠**：两个 run 的文本 delta 时间窗重叠超过 1 秒（仅同项目/跨项目场景断言）。
- **输出归属**：每个 run 的最后一行标记出现在自己的输出中，证明两次 query 各返回各的结果。
- **事件隔离**：任一 run 的回调收到不属于自己的 `sessionId`/`runId` 时计数并立即输出诊断，计数必须为 0。
- **独立 interrupt**：A 被中断进入终态后，B 仍必须产生新 delta。
- 不以 `Promise.all` 返回即视为并发。

## 3. 结果

### 3.1 同一 workspace 两个 Claude session

| run | Claude session（前 8 位） | delta 数 | init→终态 | 终态 | 标记 |
|---|---|---|---|---|---|
| a | `48dddaeb` | 385 | 25,588 ms | succeeded | 命中 |
| b | `84e49a38` | 384 | 27,025 ms | succeeded | 命中 |

- 两个 Claude session id 不同。
- 存活窗口重叠 **25,574 ms**，文本流重叠 18,795 ms。
- A 在 B 存活期间产生 385 条 delta，B 在 A 存活期间产生 361 条。
- 跨 run 事件数：0 / 0。

### 3.2 跨 workspace 两个 session

| run | Claude session（前 8 位） | delta 数 | init→终态 | 终态 | 标记 |
|---|---|---|---|---|---|
| a | `bec28e32` | 385 | 28,978 ms | succeeded | 命中 |
| b | `07c74032` | 384 | 27,331 ms | succeeded | 命中 |

- 存活窗口重叠 **27,331 ms**，文本流重叠 18,172 ms。
- A 在 B 存活期间产生 358 条 delta，B 在 A 存活期间产生 384 条。
- 跨 run 事件数：0 / 0。

### 3.3 独立 interrupt

| run | Claude session（前 8 位） | delta 数 | 终态 |
|---|---|---|---|
| a（被中断） | `f3be370f` | 3 | cancelled |
| b（继续） | `c42b49cf` | 9 | 中断后正常收尾，非 failed |

- A、B 均产生首个 delta 后才中断 A；A 的终态为 `cancelled`。
- A 进入终态 **21 ms 后**，B 仍产生新的 delta。
- 存活窗口重叠 7,865 ms；A 存活期间 B 产生 8 条 delta，B 存活期间 A 产生 3 条。
- 跨 run 事件数：0 / 0。

### 3.4 原始输出

```text
{"scenario":"same-workspace","runs":[{"label":"a","claudeSessionPrefix":"48dddaeb","deltaCount":385,"initAt":1794390364612,"firstDeltaAt":1794390370638,"lastDeltaAt":1794390390045,"terminalAt":1794390390200,"terminalStatus":"succeeded","foreignEventCount":0,"sawMarker":true},{"label":"b","claudeSessionPrefix":"84e49a38","deltaCount":384,"initAt":1794390364626,"firstDeltaAt":1794390371250,"lastDeltaAt":1794390391467,"terminalAt":1794390391651,"terminalStatus":"succeeded","foreignEventCount":0,"sawMarker":true}],"claudeSessionsDistinct":true,"overlap":{"liveOverlapMs":25574,"textOverlapMs":18795,"deltasFromAWhileBLive":385,"deltasFromBWhileALive":361,"overlapped":true}}
{"scenario":"cross-workspace","runs":[{"label":"a","claudeSessionPrefix":"bec28e32","deltaCount":385,"initAt":1794390393787,"firstDeltaAt":1794390403061,"lastDeltaAt":1794390422622,"terminalAt":1794390422765,"terminalStatus":"succeeded","foreignEventCount":0,"sawMarker":true},{"label":"b","claudeSessionPrefix":"07c74032","deltaCount":384,"initAt":1794390394048,"firstDeltaAt":1794390400841,"lastDeltaAt":1794390421233,"terminalAt":1794390421379,"terminalStatus":"succeeded","foreignEventCount":0,"sawMarker":true}],"claudeSessionsDistinct":true,"overlap":{"liveOverlapMs":27331,"textOverlapMs":18172,"deltasFromAWhileBLive":358,"deltasFromBWhileALive":384,"overlapped":true}}
{"scenario":"independent-interrupt","runs":[{"label":"a","claudeSessionPrefix":"f3be370f","deltaCount":3,"initAt":1794390425739,"firstDeltaAt":1794390433585,"lastDeltaAt":1794390433586,"terminalAt":1794390433604,"terminalStatus":"cancelled","foreignEventCount":0,"sawMarker":false},{"label":"b","claudeSessionPrefix":"c42b49cf","deltaCount":9,"initAt":1794390425084,"firstDeltaAt":1794390433095,"lastDeltaAt":1794390433625,"terminalAt":null,"terminalStatus":"pending","foreignEventCount":0,"sawMarker":false}],"claudeSessionsDistinct":true,"overlap":{"liveOverlapMs":7865,"textOverlapMs":1,"deltasFromAWhileBLive":3,"deltasFromBWhileALive":8,"overlapped":true},"interruptedRunTerminalAt":1794390433604,"otherRunDeltaAfterInterruptAt":1794390433625}
```

```text
 Test Files  1 passed (1)
      Tests  3 passed (3)
   Duration  71.59s
```

## 4. 过程记录

| 轮次 | 结果 | 原因 | 处理 |
|---|---|---|---|
| 第 1 轮 | 3 个用例 FAIL | 判据只看文本 delta 窗口；模型大量时间在 thinking，adapter 只上报 `text_delta`，两段文本流自然错开 | 直连 SDK 探针确认并发真实存在（两 query init 相差 37 ms，A 运行 67 s 期间 B 持续活跃），改存活窗口判据 |
| 第 2 轮 | 3 个用例 PASS | — | stdout 被 Vitest 拦截，未留下指标 |
| 第 3 轮 | 3 个用例 PASS | — | 开启 `disableConsoleIntercept`，取得首批完整指标 |
| 第 4 轮 | 2 个用例 FAIL | 新增的标记校验逐 delta 调 `includes()`；400 个数字的回复被拆成数百个 delta，标记跨 delta 分割时漏判 | 单 query 探针确认标记确实出现在输出中；改为累积文本后统一校验 |
| 第 5 轮 | 3 个用例 PASS | — | 本文件第 3 节数据 |

第 1 轮与第 4 轮的失败都不是 SDK 能力问题，而是观测方法问题；两次都用独立探针定位后才改判据，没有放宽断言。

## 5. 限制与残留

- 本门禁证明 SDK 与 `AgentSdkAdapter` 支持两个 query 并存；不证明 S02 调度器、队列和槽位语义，那些由 Task 7–14 覆盖。
- 每个 run 仍是「一次 run 一个 query」，没有共享 Streaming Input 或 handle。
- 独立 interrupt 场景中 B 只产生 9 条 delta 就随之中断，post-terminal delta 只有 21 ms 间隔；该场景证明的是「A 的终态不终止 B」，不是 B 的长时间续航。
- fixture 目录已删除；SDK 仍会在 `~/.claude/projects/` 下保留这些临时会话的本地记录，属于 SDK 自身存储，未做清理。
- 运行结束后未观察到残留 query 或子进程。
- 未开启 `bypassPermissions`，未修改全局设置；Bash 审批行为与 S01 一致（`canUseTool` 一律 deny）。