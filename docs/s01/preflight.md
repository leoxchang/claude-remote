# S01 入口预检

**日期：** 2026-11-10
**分支：** `feat/s01-personal-direct-text-mvp`（基线 `d4c4f04`，S00 已合并 master）
**结论：** **PARTIAL** — Mac Agent（Task 1–10）可执行；Flutter/iOS/真机部分（Task 11–15）BLOCKED。

## 1. S00 Core 门禁

```text
$ npm run s00:gate
S00 Core: PASS
ASR Contract: PASS
ASR Live: DEFERRED
```

| 项 | 结果 | 证据 |
|---|---|---|
| Core（SDK-01–12、CLI-01–03、PROTO-01–11） | PASS | `docs/s00/exit-report.md` |
| ASR 契约（ASR-01–08） | PASS | `docs/s00/asr-contract.md` |
| 真实豆包联调 | NOT_RUN（S05 前关闭） | `docs/s00/status.json` |

## 2. 版本矩阵

| 项 | 计划要求 | 本机实测 | 结论 |
|---|---|---|---|
| Node.js | 24.15.0（22+） | v22.23.2 | 满足下限 |
| TypeScript | 7.0.2 | 7.0.2（随仓库固定） | 满足 |
| Agent SDK | 0.3.319 | 0.3.319（随仓库固定） | 满足 |
| SDK 内置 Runtime | 2.1.319 | 2.1.319（S00 证据） | 满足 |
| Claude Code CLI | 2.1.319 | **2.1.311** | **差异，按实测版本执行**（与 S00 一致） |
| Flutter | 3.47.9 | 未安装 | **BLOCKED** |
| Dart | 3.13.7 | 未安装 | **BLOCKED** |
| Xcode | 完整 Xcode + 真机签名 | 仅 CommandLineTools | **BLOCKED** |
| Tailscale | Serve（不启用 Funnel） | 未安装 | **BLOCKED** |

## 3. 工具链核对

执行于 2026-11-10，命令与结果：

```text
$ command -v flutter          → 未找到
$ command -v dart             → 未找到
$ xcodebuild -version         → requires Xcode, active developer directory is CommandLineTools
$ command -v tailscale        → 未找到
$ /Applications/Tailscale.app → 不存在
$ node -v                     → v22.23.2
```

已按要求检查 `/Applications/Tailscale.app/Contents/MacOS/Tailscale`，确认不是“仅 PATH 缺失”。

## 4. 处理决定

用户于 2026-11-10 明确选择：**先执行 Mac Agent（Task 1–10），并行安装移动端工具链**。

| 任务 | 状态 |
|---|---|
| Task 0 | 可完成（本文件即产物） |
| Task 1 | 只建 `apps/agent`；`apps/mobile` 部分延后 |
| Task 2–10 | 可执行 |
| Task 11–15 | BLOCKED，直到 Flutter/Xcode/Tailscale/真机就绪 |

Task 1 的 Flutter 断言、`flutter create`、`npm run test:mobile` 与 Task 11–15 一律在 `docs/s01/e2e-checklist.md` 中保持 NOT_RUN，**不得用 Mock 或单元测试替代真机验收**。

## 5. 待安装清单（由用户执行）

以下命令未在本仓库执行，仅记录需要安装的组件；具体版本与安装方式以执行时官方文档为准。

1. **Xcode**：从 App Store 安装完整 Xcode，`sudo xcode-select -s /Applications/Xcode.app/Contents/Developer`，并登录 Apple 开发者账号准备真机签名。
2. **Flutter 3.47.9 stable**：安装后确认 `flutter --version` 与 `dart --version` 分别为 3.47.9 / 3.13.7，再执行 `flutter doctor`。
3. **Tailscale**：Mac 与 iPhone 登录同一 tailnet；开启 MagicDNS 与 HTTPS Certificates；Serve 配置见 `tailscale-setup.md`。
4. **iPhone**：可调试真机，与 Mac 同 tailnet。

安装完成后重新执行 `flutter doctor`、Tailscale `status`，把结果补进本文件，再把 Task 11–15 从 BLOCKED 解除。

## 6. SDK 映射冻结

七项映射已从 S00 证据提取，缺失字段用同 fixture 的只读补充探针实测补齐，见 `docs/s01/sdk-mapping.md`。其中两项影响 S01 状态机：

- 被 `interrupt()` 打断的 query 以 `result:error_during_execution` 结束，且 SDK 读取该 result 时**抛出 Error**；
- `thinking` / `signature` delta 与正文 delta 同时出现，不得计入 `message.delta`。

## 7. 安全与证据

- 预检未读取或记录任何 token、Cookie、完整请求头、环境变量或个人绝对路径。
- 补充探针只在 `spikes/s00-agent-sdk/fixture/` 中运行，只记录字段名与布尔形态，不记录消息内容。
- 未开启 `bypassPermissions`，未修改全局 `settings.json`，未写入 `.claude/settings.local.json`。