# S06 详细 Spec：个人版交付与验收

**日期：** 2026-11-23
**状态：** 实现中（新增 spec）
**上游：** `2026-11-07-personal-mobile-claude-control-spec-breakdown-design.md` 第 11 节

## 1. 目的与成功结果

把 S00–S05 集成成可安装、可常驻、可诊断、可回归的个人版本。本 spec 只覆盖不依赖物理 iPhone 的交付项；S01–S05 的真机 E2E 与 ASR-00 仍按各自台账独立验收，不能用本 spec 的自动化结果替代。

成功结果：

1. `claude-remote-agent` 是真实可执行的命令（当前 `main` 从未被调用，运行 `cli.ts` 无任何输出）。
2. Agent 可由 launchd 以普通用户常驻：开机启动、崩溃拉起、日志轮转，密钥经显式环境注入而不是依赖交互 shell。
3. `agent doctor` 一处输出配置、存储、运行状态、Tailscale Serve、日志与版本检查。
4. `agent diagnostics export` 导出脱敏诊断包：只含元数据、版本、检查结果与日志尾部，默认不含 prompt、回复、音频、令牌与密钥。
5. 结构化日志在命令与 run 生命周期中贯穿 `traceId`/`commandId`/`sessionId`/`runId`，并按大小轮转。
6. Agent 版本（agent/SDK/runtime/protocol）来自单一来源，在 `connection.ready` 与 `agent status` 中可见。

## 2. 入口条件与现状

| 项 | 现状 | 本 spec 的处理 |
|---|---|---|
| S01–S05 真机 E2E | 65 项 NOT_RUN/BLOCKED | 不解除；S06 退出报告保持 BLOCKED |
| ASR-00 真实豆包 | BLOCKED（无 `DOUBAO_ASR_API_KEY`） | launchd 提供显式环境注入；装完必须重跑 ASR-00 |
| Tailscale Serve | 2026-11-17 PASS，2026-11-23 已停止且无配置 | `doctor` 检测并给出恢复提示，不自动改系统配置 |
| CLI 顶层入口 | 缺失 | Task 1 补齐 |
| 版本上报 | `connection.ready` 已有版本与 `VERSION_INCOMPATIBLE` | 抽出单一来源并在 `status` 暴露 |
| 结构化日志 | JSON 行已存在，含 commandId；缺 traceId/sessionId/runId 与轮转 | Task 3 补齐 |
| 诊断导出 | 缺失 | Task 4/5 新增 |
| launchd | 缺失 | Task 6 新增 |

## 3. 目标、非目标与反目标

### 3.1 目标

- 普通用户可安装、启动、停止、卸载 Agent 常驻服务。
- 出问题时用户能一条命令导出脱敏诊断包并自行判断下一步。
- 版本不兼容时拒绝新 run，但本机历史仍可查看。
- 日志与诊断都不泄漏 prompt、回复、音频、令牌或密钥。

### 3.2 非目标

- 自动更新、签名分发、企业审计后台、完整监控平台。
- 多平台（仅 macOS launchd）。
- 公网产品化的 Relay、推送、多设备租约。
- 自动修复 Tailscale 或系统证书配置。

### 3.3 反目标

- 把密钥写进命令行参数、仓库、SQLite、协议或日志。
- 诊断包默认包含完整 prompt、回复、音频或工具参数。
- 用交互 shell 的环境变量启动服务（launchd 不加载 `.zshrc`）。
- 用 `KeepAlive` + 交互式前台进程混用导致重复实例；已有 `agent.lock` 保证单实例。

## 4. 设计

### 4.1 CLI 入口

- 新增 `apps/agent/src/main.ts`，作为唯一可执行入口：调用 `cli.ts` 的 `main(process.argv.slice(2))`，设置 `process.exitCode`。
- `main.ts` 通过 `fileURLToPath(import.meta.url)` 得知自身路径，传给 `createCli` 供 launchd 生成 `ProgramArguments`。
- 当前工具链无编译产物（`tsconfig` 为 `noEmit`），因此服务默认用 `node --import tsx <main.ts> start` 启动；安装时要求仓库内已安装 `tsx`。将来若引入构建产物，`--entry` 可覆盖为编译后的 `.js`。
- `package.json` 增加 `bin`：`claude-remote-agent -> bin/claude-remote-agent.js`；shim 用 `node --import tsx src/main.ts` 加载源码，便于本地 `npm link` 或直接调试。

### 4.2 版本单一来源

新增 `apps/agent/src/app/versions.ts`：

```ts
export const PROTOCOL_VERSION = 1;
export const AGENT_VERSION = '0.0.0';
export const SDK_VERSION = '0.3.319';
export const RUNTIME_VERSION = '2.1.319';
export function agentVersions(): AgentVersions;
```

- `wire.ts` 与 `durable-wire.ts` 删除本地重复常量，改为引用该模块。
- 用测试断言 `AGENT_VERSION`/`SDK_VERSION` 与 `package.json` 一致，避免版本漂移。
- `AdminStatus` 增加 `versions: AgentVersions`，`agent status` 与诊断包直接复用。

### 4.3 结构化日志

- 现有 `createFileLogger` 保持 JSON 行格式与 0600。
- 新增轮转：默认 `maxBytes = 10 MiB`、`keepFiles = 3`；超过阈值时依次 `agent.log.2 -> .3`、`.1 -> .2`、`agent.log -> .1`。写失败只报告 stderr。
- `command.processed` 增加 `traceId`、`sessionId`、`runId`（取自 CommandMessage）。
- `run.started` 与 `run.completed` 事件落日志，带 `sessionId`、`runId`、`eventId`、`seq`。
- 仍禁止写 prompt 正文、令牌、配对码；沿用现有日志脱敏集成测试并扩展。

### 4.4 诊断

新增 `apps/agent/src/diagnostics/`：

- `doctor.ts`：`runDoctor({ configDir, runCommand?, platforms? })` 返回 `DoctorReport`。
  - `config`：`agent.json` 存在且可解析（缺配置 FAIL，提示 `init`）。
  - `storage`：数据库文件存在，只读打开做 `PRAGMA integrity_check`。
  - `agent`：通过 admin socket 请求 `/admin/v1/status`（未运行 WARN，不视为失败）。
  - `tailscale`：仅 macOS，执行 `tailscale serve status`（未配置/命令缺失 WARN；检测到 Funnel 启用 FAIL）。
  - `log`：日志文件存在且可写，报告大小与轮转文件数。
  - `versions`：输出 agent/SDK/runtime/protocol 版本。
  - `ok = 没有 fail`。
- `export.ts`：`buildDiagnostics` 汇总 doctor、`agent status`（可用时）、日志尾部（默认 200 行）与文件大小；`writeDiagnostics` 以 0600 写入目标路径。
  - 脱敏：对 `Bearer <token>`、`deviceToken`、`code` 字段做遮蔽；日志本身按设计只含元数据。
  - 不读取或导出数据库内容、prompt、回复、音频。

### 4.5 launchd

新增 `apps/agent/src/service/launchd.ts` 与 CLI `agent service`：

- Label 固定 `com.claude-remote.agent`，plist 路径 `~/Library/LaunchAgents/com.claude-remote.agent.plist`，文件权限 0600。
- `service install`：
  - `ProgramArguments = [node, '--import', 'tsx', <main.ts 绝对路径>, 'start']`（可用 `--node`/`--entry` 覆盖）。
  - `WorkingDirectory = 安装时 cwd`（可用 `--cwd` 覆盖）。
  - `RunAtLoad = true`，`KeepAlive = { SuccessfulExit: false }`（崩溃拉起，正常退出不重拉）。
  - `ThrottleInterval = 10`。
  - `StandardOutPath` / `StandardErrorPath` 指向 `~/.claude-remote/launchd.{out,err}.log`，0600。
  - 环境注入：`--env KEY=VALUE` 可重复，写入 `EnvironmentVariables`。`DOUBAO_ASR_API_KEY` 只能用此方式注入，安装后必须重跑 ASR-00。plist 0600，安装命令不回显值。
  - 安装后执行 `launchctl bootstrap gui/<uid> <plist>`；已加载时先 `bootout` 再 `bootstrap`。
- `service uninstall`：`launchctl bootout gui/<uid>/<label>`（忽略未加载），删除 plist。
- `service status`：`launchctl print gui/<uid>/<label>` 摘要 + 是否已安装。
- 服务与 `agent.lock` 共用单实例保护；重复启动第二个实例会因锁失败退出，launchd 不无限重试（ThrottleInterval）。

### 4.6 文档

- `docs/s06/install-usage.md`：版本要求、init、Tailscale、配对、项目授权、豆包注入、launchd 安装/卸载、诊断导出、升级、解绑。
- `docs/s06/known-limitations.md`：单用户、macOS、无自动更新、无 Relay、ASR Key 轮换需重启、真机 E2E 阻塞等。
- `docs/s06/preflight.md`、`rollback.md`、`e2e-checklist.md`、`exit-report.md`：与 S01–S05 同格式。

## 5. 安全边界

- 密钥只来自进程启动时的环境；launchd 的 `EnvironmentVariables` 是显式注入，plist 权限 0600，命令不回显。
- 诊断包默认只含元数据；导出前打印目标路径与脱敏说明。
- 日志与诊断不得含 prompt 正文、回复、音频、device token、配对码、API Key。
- 所有新增文件（plist、诊断包、日志轮转文件）权限 0600；目录 0700。

## 6. 测试与故障注入

本 spec 新增的自动化：

- 入口：`main(['--help'])` 可用；CLI 现有 `init` 测试保持通过。
- 版本：常量与 `package.json` 一致；`status` 含 versions。
- 日志：轮转文件生成；`command.processed` 含四个 ID；现有"不含敏感信息"测试继续通过。
- doctor：缺配置 FAIL、损坏数据库 FAIL、Agent 未运行 WARN、Tailscale 注入桩、Funnel 启用 FAIL。
- 诊断导出：0600、脱敏、日志尾部截断、不含 prompt/令牌。
- launchd：plist 结构、XML 转义、环境注入、卸载路径（不实际执行 launchctl 的单元测试；真机安装由 E2E 项覆盖）。

故障注入沿用 S03/S04/S05 已有测试；本 spec 不重复实现网络乱序/模型超时等已有用例。launchd 崩溃拉起、日志轮转与诊断导出列入 `docs/s06/e2e-checklist.md`。

## 7. 验收标准

1. `agent doctor` 在已配置与未配置机器上都给出可操作结果，不崩溃。
2. `agent diagnostics export` 产物 0600 且不含敏感内容。
3. `agent service install` 后 launchd 常驻、崩溃可拉起、日志轮转生效；`uninstall` 干净移除。
4. `agent status` 显示版本；不兼容客户端仍被 `VERSION_INCOMPATIBLE` 拒绝。
5. 全部新增自动化测试通过，Agent 覆盖率保持 80% 以上。
6. S01–S05 的真机 E2E 与 ASR-00 另行验收；本 spec 不因自动化通过而宣称整体完成。

## 8. 回滚

- `agent service uninstall` 停止并移除常驻服务，回退到前台 `agent start`。
- 删除诊断导出文件；不影响配置、数据库与设备绑定。
- 版本/日志/诊断/CDI 改动均为增量，不改变协议、数据库 schema 或幂等语义。

## 9. 与公网产品化的边界

不在本 spec 引入 Relay、推送、多设备租约、自动更新或企业监控。个人版完成后如需公网产品化，应重新 brainstorm 并另立阶段。