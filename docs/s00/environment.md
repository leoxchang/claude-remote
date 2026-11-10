# S00 环境与版本矩阵

采集时间：2026-11-10（本地时间）

| 项目 | 值 | 来源 |
|---|---|---|
| 平台 | macOS Darwin 27.2.0（arm64） | `process.platform` / `os.release()` |
| Node.js | v22.23.2（满足计划要求 22+） | `process.version` |
| npm | 10.9.8 | `npm --version` |
| Claude Agent SDK | 0.3.319（计划固定值） | `package.json` / `package-lock.json` |
| SDK 内置 Runtime CLI | 2.1.319 | 每次 live 运行 `system/init.claude_code_version` |
| 本机 Claude Code CLI | 2.1.311 | `claude --version`，`~/.local/share/claude/versions/2.1.311` |
| Vitest | 5.1.0 | `package.json` |
| TypeScript | 7.0.2 | `package.json` |
| Ajv | 8.20.0 | `package.json` |

## 版本组合决策

计划固定 Claude Code CLI `2.1.319`，本机实际安装为 `2.1.311`。经用户确认，**按 2.1.311 执行并记录差异**，未升级、未修改本机安装。

- SDK live 测试（SDK-01–12）由 SDK 自带的 2.1.319 Runtime 执行，运行时版本记录在 SDK-01 证据中。
- CLI ↔ SDK 双向互操作（CLI-01–03）使用本机 CLI 2.1.311，因此该结论对应 `CLI 2.1.311 + SDK 0.3.319 (Runtime 2.1.319)` 组合。

## 配置来源

- 用户级配置：`~/.claude/settings.json`，只读，未修改。
- 网关与凭证来自该文件的 `env` 段：`ANTHROPIC_BASE_URL`、`ANTHROPIC_AUTH_TOKEN`（凭证值不记录、不进证据）。
- 实际网关 origin：`http://127.0.0.1:15721/`（本机网关应用监听该端口；S00 只按当前生效配置验证，不依赖其内部行为）。
- 项目级设置：仅使用隔离 fixture `spikes/s00-agent-sdk/fixture/.claude/settings.json`（`permissions.ask: ["Bash"]`）。

## 统一测试入口

| 命令 | 用途 |
|---|---|
| `npm test` | 默认单元测试（排除 `*.live.test.ts`） |
| `npm run test:coverage` | 覆盖率测试 |
| `S00_LIVE=1 npm run test:live` | 串行 live SDK 测试 |
| `S00_EVIDENCE=1 npm test` | 重新生成 `docs/s00/evidence/*.json`（默认单元测试不写盘） |
| `npm run s00:gate` | S00 退出门禁 |

## 证据索引

- SDK-01 版本与配置盘点：`docs/s00/evidence/SDK-01.json`
- SDK-02 设置来源对比：`docs/s00/evidence/SDK-02.json`
- SDK-03 网关归因：`docs/s00/evidence/SDK-03.json`（详见 `gateway-attribution.md`）
- SDK-04 preset 行为基线：`docs/s00/evidence/SDK-04.json`