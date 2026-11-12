# S01 退出报告

**最终结论：** **BLOCKED** — Mac 侧与 Flutter 侧自动化验收通过，但 E2E-01–12 尚未在真实 iPhone + Tailscale 环境执行，S01 不得宣称完成，S02 入口保持 BLOCKED。
**日期：** 2026-11-12
**分支：** `feat/s01-personal-direct-text-mvp`

## 1. 已通过的门禁

| 项 | 命令 | 结果 |
|---|---|---|
| Agent 单元/集成 | `npm run test:s01` | 22 files / 152 tests PASS |
| Agent 覆盖率 | `npm run coverage:agent` | Lines 91.33%、Branches 81.73%、Functions 91.66% |
| Flutter 单元/Widget | `npm run test:mobile` | 77 tests PASS |
| Dart 核心覆盖率 | `flutter test --coverage` | 83.7%（不含 `main.dart`） |
| 真实 SDK 冒烟 | `S01_LIVE=1 npm run test:s01:live` | 3 tests PASS（resume、interrupt、Bash 拒绝） |
| iOS 模拟器构建 | `flutter build ios --simulator --no-codesign` | PASS（Xcode 27.2，产物 `build/ios/iphonesimulator/Runner.app`） |
| Secret 扫描 | `npm run verify:s01` | 无命中 |
| S01 总门禁 | `npm run verify:s01` | **FAIL** — 仅剩 E2E-01–12 NOT_RUN |

真实 SDK 证据：两个顺序 run 复用同一 Claude session 并召回唯一标记；活跃 run 被 interrupt 后进入 `cancelled`；Bash 工具调用被拒绝且目标文件未被创建。

## 2. 本轮发现并修复的缺陷

**Bash 预授权绕过拒绝策略。** 修复前的适配器只设置 `canUseTool` 返回 deny。本机 `~/.claude/settings.json` 存在 `permissions.allow: ["Bash(*)"]`，SDK 对已预授权的工具不调用 `canUseTool`，真实测试中 Bash 实际执行了命令。

修复：`AgentSdkAdapter` 增加 `PreToolUse` hook 返回 `permissionDecision: 'deny'`，在工具执行前无条件拦截；`canUseTool` 继续保留作为第二道防线。新增单测锁定 hook 输出，真实 SDK 测试复跑后目标文件不再产生。

该缺陷若未修复，会直接违反「S01 无手机审批、工具一律拒绝」的产品约束。

**运行时空缺。** 接线前 `ConnectionController`、`CommandClient`、`SessionController` 只有单测，没有任何代码在 App 启动时创建连接、发送 hello、创建/附着实体会话或把入站事件写入时间线。已补齐 `ChatSessionRuntime`：握手成功 → `session.start`/快照 → 时间线事件与快照转发到 `ChatController`；重连时替换 socket；退后台/回前台转发 `onLifecycle`。聊天页现在会真正建立链路。

## 3. 未完成项

| ID | 状态 | 原因 |
|---|---|---|
| E2E-01–12 | NOT_RUN | HTTPS Certificates 未启用、Serve 未配置；iPhone 真机未接入 |
| `verify:s01` | FAIL | 由上面一项直接导致；门禁按设计拒绝在缺证据时放行 |

解除步骤见 `docs/s01/e2e-checklist.md` 的「解除条件」一节。

## 4. 已知限制（S01 设计内）

- 会话、run、Journal 和命令幂等只存在内存；Agent 重启后不可恢复，不自动重放。
- 无手机审批：所有工具请求一律拒绝，App 只显示被拒绝的工具卡片。
- 不保证 Bash stdout 实时流；工具结果可能一次性到达。
- App 被杀或断线期间不补发 prompt；重连依赖完整快照，无 `afterSeq` 增量同步。
- 设备令牌只在 Keychain 与一次性配对响应中出现，Mac 只保存 SHA-256 哈希。

## 5. 下一步

1. 执行 `sudo xcode-select -s /Applications/Xcode.app/Contents/Developer` 与 `sudo xcodebuild -runFirstLaunch`，完成真机签名；
2. 安装 Tailscale，Mac 与 iPhone 同 tailnet，按 `tailscale-setup.md` 开启 Serve 且保持 Funnel 关闭；
3. 逐项执行 E2E-01–12 并回填台账；
4. 全部 PASS 后重新运行 `npm run verify:s01`，通过后才解除 S02 入口 BLOCKED。