# S00 Exit Report

**日期：** 2026-11-10
**结论：** **可以进入 S01**（Core PASS，ASR Contract PASS，ASR Live DEFERRED）。
**分支：** `feat/s00-technical-validation`

## 1. 门禁结果

```text
S00 Core: PASS
ASR Contract: PASS
ASR Live: DEFERRED
```

- Core 集合：SDK-01–12、CLI-01–03、PROTO-01–11（26 个 ID，全部 PASS，无缺失、无 LIMITED）。
- ASR Contract：ASR-01–08 全部 PASS（fake Provider 契约）。
- ASR Live：`DOUBAO-LIVE` 保持 `NOT_RUN`，`deferredTo: S05`。**本次没有执行真实豆包联调，不能视为已验证。**
- 门禁实现：`scripts/s00/gate.ts` + `scripts/s00/gate-cli.ts`，由 `npm run s00:gate` 驱动。

## 2. 环境与版本

| 项 | 值 |
|---|---|
| 平台 | macOS Darwin 27.2.0 (arm64) |
| Node.js | v22.23.2 |
| Agent SDK | 0.3.319 |
| SDK 内置 Runtime | 2.1.319 |
| 本机 Claude Code CLI | **2.1.311**（计划固定 2.1.319，经用户确认按实测版本执行） |
| 网关 | 用户 settings 中的 `ANTHROPIC_BASE_URL` → `http://127.0.0.1:15721/` |

证据：`environment.md`、`agent-sdk-evidence.md`、`evidence/SDK-01.json`。

## 3. SDK 验证（SDK-01–12）

| ID | 结论 | 证据 |
|---|---|---|
| SDK-01 | 版本与配置来源可复现，无敏感值 | `evidence/SDK-01.json` |
| SDK-02 | `settingSources: ['user']` 不加载项目 CLAUDE.md；省略与显式完整来源一致；三个对照 probe 均无工具调用 | `evidence/SDK-02.json` |
| SDK-03 | 请求归因到配置网关与模型（OS 连接记录 + Runtime 日志，且无 direct-Anthropic 回落） | `evidence/SDK-03.json`、`gateway-attribution.md` |
| SDK-04 | `claude_code` preset 加载工具与项目设置 | `evidence/SDK-04.json` |
| SDK-05 | 同一 query 两轮流式输入，第二轮复用上下文 | `evidence/SDK-05.json` |
| SDK-06 | 完整 assistant 消息与 text_delta 增量均可观察 | `evidence/SDK-06.json` |
| SDK-07 | `canUseTool` 允许一次 Bash，输出 marker 可见 | `evidence/SDK-07.json` |
| SDK-08 | deny 后命令未执行、denial 可观察、Agent 继续回复 | `evidence/SDK-08.json` |
| SDK-09 | `interrupt()` 停止流式轮次，进程干净关闭 | `evidence/SDK-09.json` |
| SDK-10 | 新 query `resume` 正常会话，读到旧标记 | `evidence/SDK-10.json` |
| SDK-11 | 中断会话显式 resume 后仍读到旧标记 | `evidence/SDK-11.json` |
| SDK-12 | 不存在的 session ID 直接抛错，未伪造新会话 | `evidence/SDK-12.json` |

## 4. CLI ↔ SDK 互操作（CLI-01–03）

两个方向都成功，会话 ID 一致，标记可跨入口读取；未复制或修改任何会话 JSONL。

- CLI → SDK：`evidence/CLI-01.json`
- SDK → CLI：`evidence/CLI-02.json`
- 限制记录：`evidence/CLI-03.json`、`session-interoperability.md`

已知限制：

1. 组合为 **CLI 2.1.311 + SDK Runtime 2.1.319**，不是计划固定的 2.1.319/2.1.319。
2. `--max-turns 1` 偶发 `error_max_turns`；创建提示已显式禁用工具，并保留最多 3 次尝试，每次尝试的退出码都写入证据。
3. 只比较了文本上下文，未逐项对照工具调用历史与消息顺序。

## 5. 协议 V1（PROTO-01–11）

- 合法/非法样例、必填字段、条件关联、类型格式、未知类型、重复命令、排序去重、错误安全、S01 流程、后续扩展、连接握手全部 PASS。
- 证据：`evidence/PROTO-01.json` … `evidence/PROTO-11.json`，语义说明见 `protocol/v1/README.md`。
- 关键结论：`command.result` 不代表 run 成功；`run.completed` 才是最终状态；未知类型安全拒绝；握手不能协商权限或 cwd。

## 6. ASR 契约（ASR-01–08）

- fake Provider 契约全部 PASS：`evidence/ASR-01.json` … `evidence/ASR-08.json`。
- 真实豆包联调、凭证、音频格式、鉴权与限流**均未验证**，保持 `NOT_RUN / DEFERRED_TO_BEFORE_S05`；S05 前必须按 `asr-contract.md` 的六项清单完成。

## 7. 验证命令与结果

| 命令 | 结果 |
|---|---|
| `npm test` | 9 个文件、83 个测试全部通过 |
| `npm run test:coverage` | statements 94.14%、branches 88.39%、functions 100%、lines 96.34%（阈值 80%） |
| `S00_LIVE=1 npm run test:live` | 5 个文件、6 个 live 测试全部通过（串行，约 93s） |
| `npm run s00:gate` | Core PASS / ASR Contract PASS / ASR Live DEFERRED（退出码 0） |

## 8. 未验证与风险

| 项 | 状态 | 影响 |
|---|---|---|
| 真实豆包联调 | `NOT_RUN`（S05 前关闭） | 不影响 S01–S04；S05 不可验收 |
| CLI 版本组合 | 2.1.311（非 2.1.319） | 互操作结论只覆盖该组合 |
| 网关请求级日志 | 不可用 | SDK-03 依赖 OS 连接记录 + Runtime 日志，无网关侧 request id |
| 工具历史跨入口一致性 | 未逐项对照 | 不影响受管会话方案，但属于未验证范围 |

## 9. 决策

- 没有 FAIL、BLOCKED 或 LIMITED 的 Core 记录。
- 未开启 `bypassPermissions`，未修改真实项目或全局配置。
- **可以进入 S01。**