# S06 个人版交付与验收 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让个人版 Agent 可安装、可常驻、可诊断、可回归：补齐 CLI 入口、版本单一来源、结构化日志与轮转、doctor/诊断导出、launchd 常驻与显式环境注入。

**Architecture:** 全部改动集中在 `apps/agent` 与文档；不改变协议、数据库 schema、幂等或恢复语义。CLI 以 `src/main.ts` 为唯一入口；launchd 用 `node --import tsx` 启动前台进程；诊断只读取元数据。

**Tech Stack:** Node.js 24.15.0、TypeScript 7.0.2、Fastify 5.12.8、commander 15.1.0、better-sqlite3 13.0.3、Vitest 5.1.0、macOS launchd。

**Spec:** `docs/superpowers/specs/2026-11-23-s06-personal-release-acceptance-design.md`

## Global Constraints

- **真机 E2E 与 ASR-00 不在本计划内解除**：S01–S05 台账仍为 NOT_RUN/BLOCKED；S06 退出报告保持 BLOCKED。
- 不改变任何命令、事件、错误码或数据库 schema；所有改动向后兼容。
- 不把密钥写入命令行参数、仓库、SQLite、协议、日志或诊断包；launchd 只接受显式 `--env` 注入并写 0600 plist。
- 日志与诊断默认只含元数据：不含 prompt、回复、音频、device token、配对码、API Key。
- 新文件权限：plist/诊断包/日志 0600，配置目录 0700。
- 核心 TypeScript 覆盖率不低于 80%；新增模块必须有单元测试。
- 只有用户明确授权提交后才执行 Commit 步骤，否则标记 SKIPPED。

## Review Focus

1. **CLI 入口不存在：** `apps/agent/src/cli.ts` 只导出 `main`，从未调用；任何 `claude-remote-agent` 用法都静默无效。Task 1 必须先修，否则 launchd 无从启动。
2. **launchd 不继承交互 shell 环境：** `DOUBAO_ASR_API_KEY` 必须显式注入，安装后需重跑 ASR-00；Task 6 与文档同时覆盖。
3. **诊断导出泄漏：** 默认只读日志尾部与元数据，写 0600；Task 5 测试锁定。
4. **日志轮转与并发写：** 单进程同步追加；轮转失败不得影响主流程；Task 3 测试锁定。
5. **版本漂移：** `AGENT_VERSION`/`SDK_VERSION` 与 `package.json` 不一致会导致握手版本失真；Task 2 用测试锁定。

## File Structure

```text
apps/agent/
  package.json                              # bin 指向 bin/claude-remote-agent.js
  src/main.ts                               # 唯一可执行入口
  src/cli.ts                                # + doctor / diagnostics / service 命令
  src/app/versions.ts                       # 版本单一来源
  src/app/logger.ts                         # + 大小轮转
  src/app/durable-wire.ts                   # 版本引用、日志 IDs、run 生命周期日志
  src/app/wire.ts                           # 版本引用
  src/admin/server.ts                       # AdminStatus + versions
  src/diagnostics/doctor.ts                 # doctor 检查
  src/diagnostics/export.ts                 # 脱敏诊断包
  src/service/launchd.ts                    # plist 生成与 launchctl 调用
  test/main-entry.test.ts
  test/versions.test.ts
  test/logger-rotation.test.ts
  test/diagnostics-doctor.test.ts
  test/diagnostics-export.test.ts
  test/service-launchd.test.ts
docs/s06/
  preflight.md / rollback.md / e2e-checklist.md / exit-report.md
  install-usage.md / known-limitations.md
```

---

### Task 0: 现状核对与文档修正

**Files:**
- Modify: `docs/s01/e2e-checklist.md`, `docs/s04/e2e-checklist.md`
- Create: `docs/s06/preflight.md`

- [x] **Step 1: 修正 S01/S04 台账**

按 2026-11-17 真机事实更新：签名信任已解决、STORE-00 iPhone PASS；Tailscale 当前已停止并需恢复。验证：两份台账无 "开发签名未信任" 与 "STORE-00 iPhone BLOCKED" 的过时表述。

- [x] **Step 2: 记录 S06 前置**

`docs/s06/preflight.md` 记录：CLI 入口缺失、Tailscale 停止、ASR Key 未配置、iPhone 未入 tailnet、S01–S05 E2E 数量。验证：文件存在且与实测一致。

### Task 1: CLI 顶层入口

**Files:**
- Create: `apps/agent/src/main.ts`, `apps/agent/test/main-entry.test.ts`
- Modify: `apps/agent/package.json`

**Interfaces:**
- Consumes: `cli.ts` 的 `main(argv)`。
- Produces: 可执行入口 `claude-remote-agent`（bin shim 用 tsx 加载 `src/main.ts`）。

- [x] **Step 1: 写失败测试**

`main-entry.test.ts`：以子进程运行 `node --import tsx src/main.ts --help`，断言退出码 0 且 stdout 含 `init`、`start`、`doctor`、`service`。

- [x] **Step 2: 实现入口**

`main.ts`：读取 `CLAUDE_REMOTE_CONFIG_DIR`，调用 `main(process.argv.slice(2), { configDir, entryPath })` 并设置 `process.exitCode`。`package.json` 的 `bin` 指向 `bin/claude-remote-agent.js`（用 `node --import tsx` 加载源码）。

- [x] **Step 3: 验证**

Run: `npx tsx apps/agent/src/main.ts --help`  
Expected: 输出命令列表，退出码 0。

### Task 2: 版本单一来源与 status 暴露

**Files:**
- Create: `apps/agent/src/app/versions.ts`, `apps/agent/test/versions.test.ts`
- Modify: `apps/agent/src/app/wire.ts`, `apps/agent/src/app/durable-wire.ts`, `apps/agent/src/admin/server.ts`, `apps/agent/src/app/*`（status 构造处）

- [x] **Step 1: 写失败测试**

`versions.test.ts`：`agentVersions()` 含四个字段；`AGENT_VERSION` 等于 `apps/agent/package.json` 的 `version`；`SDK_VERSION` 等于根 `package.json` 依赖 `@anthropic-ai/claude-agent-sdk` 的版本。

- [x] **Step 2: 实现并接线**

`versions.ts` 导出常量与 `agentVersions()`；替换 `wire.ts`/`durable-wire.ts` 的本地常量；`AdminStatus` 增加 `versions`，两处 `getStatus` 返回它。

- [x] **Step 3: 验证**

Run: `npm run test:agent -- versions admin`  
Expected: PASS。

### Task 3: 结构化日志与轮转

**Files:**
- Modify: `apps/agent/src/app/logger.ts`, `apps/agent/src/app/durable-wire.ts`
- Create: `apps/agent/test/logger-rotation.test.ts`

**Interfaces:**
- Produces: `createFileLogger(path, { maxBytes?, keepFiles? })`。

- [x] **Step 1: 写失败测试**

轮转测试：`maxBytes` 设小值，连续写入触发 `.1`/`.2` 生成且当前文件小于阈值；日志行仍为合法 JSON。ID 测试：`command.processed` 日志含 `traceId`/`commandId`/`sessionId`/`runId`。

- [x] **Step 2: 实现轮转与 ID**

logger 增加 `rotateIfNeeded`（`statSync` + `renameSync` + `unlinkSync`，失败仅 stderr）。`command.processed` 从 CommandMessage 取四个 ID；`journal.subscribe` 对 `run.started`/`run.completed` 记录 `sessionId`/`runId`/`eventId`/`seq`。

- [x] **Step 3: 验证**

Run: `npm run test:agent -- logger`  
Expected: PASS，且原 `integration/logging.test.ts` 仍通过。

### Task 4: doctor

**Files:**
- Create: `apps/agent/src/diagnostics/doctor.ts`, `apps/agent/test/diagnostics-doctor.test.ts`
- Modify: `apps/agent/src/cli.ts`

**Interfaces:**
- Produces: `runDoctor(options): Promise<DoctorReport>`；CLI `agent doctor`。

- [x] **Step 1: 写失败测试**

缺配置 → `config` FAIL；损坏 DB → `storage` FAIL；Agent 未运行 → `agent` WARN 且 `ok` 仍为 true；注入的 Tailscale 输出含 Funnel 启用 → FAIL。

- [x] **Step 2: 实现**

检查项 `config`/`storage`/`agent`/`tailscale`/`log`/`versions`。`tailscale` 仅 darwin，命令缺失或 "No serve config" WARN；`runCommand` 可注入。CLI 打印 JSON，`ok=false` 时退出码 1。

- [x] **Step 3: 验证**

Run: `npx tsx apps/agent/src/main.ts doctor`  
Expected: JSON 报告，含六项检查。

### Task 5: 诊断导出

**Files:**
- Create: `apps/agent/src/diagnostics/export.ts`, `apps/agent/test/diagnostics-export.test.ts`
- Modify: `apps/agent/src/cli.ts`

- [x] **Step 1: 写失败测试**

导出文件 0600；含版本、doctor、日志尾部；不含 prompt、device token、配对码、`Bearer` 原文；日志超过尾部行数时只保留最后 N 行。

- [x] **Step 2: 实现**

`buildDiagnostics` 汇总；`writeDiagnostics` 以 `mode: 0o600` 写入；`redact` 遮蔽 `Bearer <token>`、`"deviceToken":"..."`。

- [x] **Step 3: 验证**

Run: `npx tsx apps/agent/src/main.ts diagnostics export --output /tmp/agent-diagnostics.json && stat -f '%Lp' /tmp/agent-diagnostics.json`  
Expected: `600`，JSON 合法。

### Task 6: launchd service

**Files:**
- Create: `apps/agent/src/service/launchd.ts`, `apps/agent/test/service-launchd.test.ts`
- Modify: `apps/agent/src/cli.ts`, `apps/agent/src/main.ts`

**Interfaces:**
- Produces: `buildLaunchAgentPlist(options): string`；CLI `agent service install|uninstall|status`。

- [x] **Step 1: 写失败测试**

plist 含 Label、ProgramArguments、RunAtLoad、`KeepAlive SuccessfulExit=false`、ThrottleInterval、日志路径；`--env` 值写入但不出现在返回值摘要；XML 特殊字符转义。

- [x] **Step 2: 实现**

`install` 生成 0600 plist 并 `launchctl bootstrap gui/<uid>`（已加载先 bootout）；`uninstall` bootout（忽略未加载）并删 plist；`status` 打印 `launchctl print` 摘要与是否安装。默认入口来自 `main.ts` 的 `fileURLToPath(import.meta.url)`。

- [x] **Step 3: 验证**

Run: `node --import tsx apps/agent/src/main.ts service install --cwd <repo>`，随后 `status`、`kill -9`、`diagnostics export`、`service uninstall`。  
Expected: 生成 plist 且 Agent 由 launchd 启动；`agent status` 可读；卸载干净。

结果（2026-11-23）：安装 PASS（plist 600、state=running、8787 监听）；强杀后约 10 秒自动拉起；运行态 doctor/diagnostics PASS；卸载 PASS（plist 删除、8787 释放）。未注入 `DOUBAO_ASR_API_KEY`（无凭证），E2E-08 保持 BLOCKED。

### Task 7: 文档

**Files:**
- Create: `docs/s06/install-usage.md`, `docs/s06/known-limitations.md`, `docs/s06/rollback.md`, `docs/s06/e2e-checklist.md`, `docs/s06/exit-report.md`

- [x] **Step 1: 写安装/使用文档**

覆盖 init、Tailscale Serve、配对、项目授权、豆包 `--env` 注入、service install/uninstall、doctor、diagnostics、升级与解绑。

- [x] **Step 2: 写限制、回滚、E2E 与退出报告**

E2E 至少含：launchd 开机启动与崩溃拉起、日志轮转、诊断导出脱敏、版本不兼容拒绝、卸载干净；未能执行项标 NOT_RUN/BLOCKED。退出报告如实写 BLOCKED 与原因。

### Task 8: 全量回归

- [x] **Step 1: Agent 测试与覆盖率**

Run: `npm run test:agent`、`npm run coverage:agent`  
Expected: 全绿，覆盖率 ≥ 80%。

结果：103 文件 / 614 用例 PASS；Statements 87.7%、Branches 80%、Functions 89.04%、Lines 89.57%。

- [x] **Step 2: 根套件与类型检查**

Run: `npm test`、`npx tsc -p apps/agent/tsconfig.json --noEmit`  
Expected: PASS。

结果：19 文件 / 144 用例 PASS；类型检查 PASS。

- [x] **Step 3: 门禁状态记录**

Run: `npm run verify:s01`（以及 s02–s05 可选）  
Expected: 仍因 E2E NOT_RUN 失败；把结果写入 S06 退出报告，不隐瞒。

结果：`S01 Gate: FAIL`，12 项 E2E 全部 NOT_RUN；已记录于 `docs/s06/exit-report.md`。