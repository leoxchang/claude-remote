# S03 退出报告

**日期：** 2026-11-12
**结论：** **BLOCKED** — 实现与自动化测试完成，但真机 E2E-01–12 未执行，S03 不得验收，不进入 S04。

## 1. 交付内容

| 范围 | 结果 |
|---|---|
| PERM-00 真实 SDK 权限门禁 | **PASS（6/6）**，见 `perm00-evidence.md` |
| 配置 V3 与逐项目 `mobileApprovalMode` | 完成：V1/V2 迁移全部 `deny`，`.v2.bak` 0600，本机 CLI `workspace set-approval` |
| Broker 创建、去重、容量、终态、超时、失效 | 完成：120s monotonic、每 run 8 / 全局 16、completed allow 重入 deny |
| 完整内容 HTTPS 分块 | 完成：1 MiB、32 KiB/块、SHA-256、Bearer、`no-store`、每设备 120 次/分钟 |
| run 生命周期 | 完成：`waiting_approval` 占槽、cancel 先失效后 interrupt、revoke/policy/shutdown fail closed |
| 协议、快照与幂等 | 完成：`permission.requested/resolved/respond`、`approvalId`、pending 安全摘要与全局计数 |
| Flutter 审批投影与内容校验 | 完成：按 session 隔离、chunk/hash 校验、固定 commandId 重试、后台/重启清理 |
| iPhone 审批 UI | 完成：卡片、详情页、Bash/Write/Edit/JSON、非真实 Diff 标记、defaultToNo 二次确认、隐私遮罩 |

## 2. 自动化结果

| 检查 | 结果 |
|---|---|
| `npm run test:s03`（Agent） | 全通过（含 S03 协议、Broker、调度、集成与重启） |
| `npm run coverage:agent` | statements 89.67% / branches 82.64% / functions 92.95% / lines 91.18% |
| `cd apps/mobile && flutter test --coverage` | 全通过；覆盖率见第 4 节 |
| `S03_LIVE=1 npm run test:s03:perm00` | PASS 6/6 |
| `S03_LIVE=1 npm run test:s03:live` | 本环境未能执行（见第 3 节），状态 BLOCKED |
| `npm run verify:s03` | FAIL：E2E-01–12 NOT_RUN、realDevice 缺失、S02 门禁未 PASS |

## 3. 未完成项

| ID | 状态 | 原因 |
|---|---|---|
| E2E-01–12 | NOT_RUN | Tailscale HTTPS Certificates 未启用、Serve 未配置、iPhone 未接入 |
| S01/S02 上游验收 | BLOCKED | 同样缺真机 E2E；S03 的硬门禁要求上游 PASS |
| S03 真实 SDK 回归 | BLOCKED | 需要真实网关与真机链路；本地 120s 过期与双会话场景已由 `test:s03:live` 就绪 |
| `verify:s03` | FAIL | 由以上三项直接导致；门禁按设计拒绝放行 |

解除步骤见 `e2e-checklist.md` 的「解除条件」。

## 4. 覆盖率与测量口径

- Agent 覆盖率来自 `apps/agent/coverage/lcov.info`（v8）。
- Dart 覆盖率来自 `apps/mobile/coverage/lcov.info`；核心审批逻辑位于 `features/approvals` 与 `domain/app_state.dart`。
- Mock 只覆盖确定性竞争与协议形状；PERM-00 与 E2E 使用固定版本真实 SDK（0.3.319 / Claude Code 2.1.319）。

## 5. 已知限制（S03 设计内）

- 完整内容上限 1 MiB；单块 32 KiB；最多 32 块。
- 只支持 `Bash、Write、Edit、NotebookEdit、Read、Glob、Grep、WebFetch、WebSearch`；AskUserQuestion、所有 MCP/connector 与未知工具一律 deny。
- Edit/Write 的变更预览由请求参数生成，不是实际文件 Diff 或执行结果。
- 审批、审计、队列与 Journal 均为内存状态；Agent 重启后旧 `approvalId` 不可读、不可响应，不自动重放。
- 无“始终允许”、批量批准、输入修改或永久 rules；不启用 Funnel。
- S01 既有 `tool.started`/`tool.output` 预览可能早于审批并包含命令、路径或参数；内容 endpoint 不是绝对保密边界。
- 本机 user 设置若已 allow 某工具，该工具不会产生手机审批（方案 A 的既有边界）。
- 无 APNs/FCM 推送；无 `afterSeq` 增量同步。

## 6. 下一步

1. 完成 S01/S02 真机 E2E 并通过各自门禁；
2. 开启 Tailscale HTTPS Certificates 与 Serve，接入 iPhone；
3. 运行 `S03_LIVE=1 npm run test:s03:live` 复核真实 SDK；
4. 逐项执行 E2E-01–12 并回填 `e2e-checklist.md`（`realDevice: true`）；
5. `npm run verify:s03` 全部 PASS 后才解除 S04 入口。