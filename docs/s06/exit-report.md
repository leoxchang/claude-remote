# S06 退出报告

**日期：** 2026-11-23
**结论：** **BLOCKED** — 个人版中不依赖 iPhone 的交付项（CLI 入口、版本、日志、诊断、launchd）已实现并通过自动化；真机 E2E、ASR-00 与 S01–S05 验收仍未完成，S06 不得宣称验收通过。
**分支：** `master`（工作区改动未提交，等待用户授权）

## 1. 交付内容

| 范围 | 结果 |
|---|---|
| CLI 顶层入口 | 完成：`src/main.ts` + bin shim；`--help`/`doctor`/`service` 等命令真实可用（修复此前 `main` 从未被调用的缺陷） |
| 版本单一来源 | 完成：`src/app/versions.ts`；`connection.ready` 与 `agent status` 共用；测试锁定与 `package.json` 一致 |
| 结构化日志 | 完成：`command.processed` 含 `traceId`/`commandId`/`sessionId`/`runId`；`run.started`/`run.completed` 记录会话与 run；10 MiB 轮转保留 3 份 |
| doctor | 完成：config/storage/agent/tailscale/log/versions 六项检查；缺配置 FAIL、未运行 WARN、Funnel 启用 FAIL |
| 诊断导出 | 完成：`diagnostics export` 输出 0600 脱敏包，只含元数据、检查结果与日志尾部 |
| launchd | 完成：`service install/uninstall/status`；`RunAtLoad`、崩溃拉起、`ThrottleInterval`、0600 plist、显式 `--env` 注入。2026-11-23 真实安装、崩溃拉起与卸载均验证通过 |
| 文档 | 完成：`docs/s06/` 安装使用、已知限制、回滚、E2E 台账、前置核对；S06 spec 与计划 |

## 2. 自动化结果

| 项 | 命令 | 结果 |
|---|---|---|
| Agent 测试 | `npm run test:agent` | 103 文件 / **614 用例 PASS** |
| 根套件 | `npm test` | 19 文件 / **144 用例 PASS** |
| 覆盖率 | `npm run coverage:agent` | Statements 87.7%、Branches 80%、Functions 89.04%、Lines 89.57% |
| 类型检查 | `tsc -p apps/agent/tsconfig.json --noEmit` | PASS |
| doctor 实测 | 临时配置目录运行 `doctor` | 输出六项检查，退出码 0 |
| 诊断导出实测 | `diagnostics export --output` | 文件模式 0600，JSON 合法，含脱敏说明 |

新增测试：入口、版本、日志轮转、doctor、诊断导出、launchd（11 个用例），并补齐 CLI 动作覆盖。

### 真实环境验证（2026-11-23）

| 项 | 结果 |
|---|---|
| `service install --cwd <repo>` | PASS：plist 600、`launchctl print` state=running、Agent 监听 127.0.0.1:8787 |
| `agent status` | PASS：running，含 agent/sdk/runtime/protocol 版本 |
| 强杀拉起 | PASS：`kill -9` 后约 10 秒以新 PID 恢复，`last exit code=1` |
| 运行态 `doctor` | PASS：config/storage/agent/log/versions PASS，Tailscale stopped WARN，退出码 0 |
| 运行态 `diagnostics export` | PASS：文件 0600、status=running、脱敏日志尾部 |
| `service uninstall` | PASS：返回 `removed=true`；plist 已删除，`installed=false, loaded=false`，8787 无监听 |

## 3. 未完成项

| 项 | 状态 | 原因 |
|---|---|---|
| S06 E2E | 部分通过 | E2E-01/02/04/05/07/09 PASS；E2E-03/06 NOT_RUN；E2E-08 BLOCKED（详见 `e2e-checklist.md`） |
| S01–S05 真机 E2E（65 项） | NOT_RUN | iPhone 未接入 tailnet；Tailscale 当前停止 |
| ASR-00 | BLOCKED | 无 `DOUBAO_ASR_API_KEY` |
| 故障注入新增用例 | 未新增 | 沿用 S03/S04/S05 已有用例；S06 计划未要求重复实现 |

## 4. 已知问题

1. **launchd 依赖 tsx：** 当前无编译产物，服务用 `node --import tsx` 启动；删除 `node_modules` 后无法启动。已在限制文档记录。
2. **plist 可能含密钥：** `--env DOUBAO_ASR_API_KEY=...` 的值写入 0600 plist；命令不回显，但文件本身是敏感文件，不得提交。
3. **覆盖率临界：** Branches 恰为 80%，后续新增未覆盖分支会跌回阈值以下。
4. **Tailscale 状态漂移：** 2026-11-17 的 Serve 配置未在 2026-11-23 保留，`doctor` 会提示恢复但不自动修复。

## 5. 下一步

1. 在常驻服务上触发日志轮转（E2E-03）并用真实旧版 App 复验版本拒绝（E2E-06）；如需恢复常驻，重新 `service install`；
2. 配置豆包凭证并重跑 ASR-00（E2E-08）；
3. 恢复 Tailscale Serve，让 iPhone 接入 tailnet，执行 S01–S05 真机 E2E；
4. 全部 PASS 后更新本报告为通过，并提交工作区改动。