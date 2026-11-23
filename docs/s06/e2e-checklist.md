# S06 交付验收台账

**日期：** 2026-11-23
**结论：** **BLOCKED** — launchd 安装、崩溃拉起、卸载、doctor 与诊断导出已在真实环境通过；日志轮转与版本拒绝未实机复验，ASR-00 与 S01–S05 真机 E2E 仍未完成。
**realDevice:** 未在本轮复检（STORE-00 iPhone 2026-11-17 PASS）
**sdkEvidence:** REAL（PERM-00）

## 1. 前提

| 前提 | 状态 |
|---|---|
| S00 Core | PASS |
| S01–S05 自动化 | PASS（Agent 614、根套件 144） |
| S01–S05 真机 E2E | NOT_RUN（65 项） |
| ASR-00 真实豆包 | BLOCKED（无 `DOUBAO_ASR_API_KEY`） |
| Tailscale Serve | 2026-11-17 PASS；2026-11-23 已停止、无配置 |
| STORE-00 iPhone | PASS（2026-11-17） |

## 2. 用例

| ID | 场景 | 状态 | 证据/原因 |
|---|---|---|---|
| E2E-01 | `service install` 后 launchd 启动 Agent，`status` 可读 | PASS | 2026-11-23 11:09：plist 600、`launchctl print` state=running、`agent status` 返回 running 与 versions、127.0.0.1:8787 监听（PID 67520） |
| E2E-02 | 强杀 Agent 后 launchd 自动拉起 | PASS | 2026-11-23 11:10：`kill -9 67520` 后约 10 秒以 PID 68061 恢复；`status` 正常，`last exit code=1` 与强杀一致 |
| E2E-03 | 日志达到上限后生成 `.1` 并遵守保留数 | NOT_RUN | 自动化：`test/logger-rotation.test.ts` PASS；真实服务日志仅数百字节，未触发 10 MiB 轮转 |
| E2E-04 | `doctor` 对缺配置、坏数据库、未运行、Tailscale 停止分别给出正确状态 | PASS | 自动化：`test/diagnostics-doctor.test.ts` PASS；真实运行态 6 项检查：config/storage/agent/log/versions PASS，Tailscale stopped WARN，退出码 0 |
| E2E-05 | `diagnostics export` 产物 0600、脱敏且不含 prompt/令牌 | PASS | 2026-11-23 11:11：真实运行态导出 0600、status=running、4 条日志尾部、检查项齐全；自动化 `test/diagnostics-export.test.ts` PASS |
| E2E-06 | 不兼容客户端被 `VERSION_INCOMPATIBLE` 拒绝 | NOT_RUN | 自动化：`connection-manager.test.ts` 覆盖；未用真实旧版 App 复验 |
| E2E-07 | `service uninstall` 停止服务并删除 plist | PASS | 2026-11-23 11:2x：`service uninstall` 返回 `removed=true`；随后 `service status` 为 `installed=false, loaded=false`，plist 不存在，8787 无监听 |
| E2E-08 | launchd 注入 `DOUBAO_ASR_API_KEY` 后语音可用 | BLOCKED | 无豆包凭证；ASR-00 BLOCKED |
| E2E-09 | 安装后 `agent status` 显示 agent/sdk/runtime/protocol 版本 | PASS | 2026-11-23 11:09：status 返回 agent=0.0.0、sdk=0.3.319、runtime=2.1.319、protocol=1 |

## 3. 自动化证据（不等于 E2E）

- `npm run test:agent`：103 文件 / 614 用例 PASS；
- `npm test`：19 文件 / 144 用例 PASS；
- `npm run coverage:agent`：Statements 87.7%、Branches 80%、Functions 89.04%、Lines 89.57%；
- `tsc -p apps/agent/tsconfig.json --noEmit`：PASS；
- 新增：入口、版本、日志轮转、doctor、诊断导出、launchd plist/install/uninstall/status 单元测试。

## 4. 解除条件

1. 在常驻服务上触发日志轮转（E2E-03）并用真实旧版 App 复验版本拒绝（E2E-06）；如需恢复常驻，重新执行 `service install`；
2. 配置真实豆包凭证并重跑 ASR-00，完成 E2E-08；
3. S01–S05 真机 E2E 全部 PASS；
4. 恢复 Tailscale Serve 并让 iPhone 接入 tailnet。

任何一项无法取得真实证据时保持 NOT_RUN，不得用单元测试或模拟器代替。