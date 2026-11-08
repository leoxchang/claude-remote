# S00 技术验证与协议基线 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 用固定版本的 Claude Agent SDK 验证 settings.json、自定义网关、权限、中断和 CLI ↔ SDK 双向恢复，并交付可测试的协议 V1 与豆包 ASR 契约预留。

**Architecture:** Agent SDK 与 ASR 验证放在独立 throwaway spike 中，真实模型测试串行执行且只使用隔离 fixture。协议 schema、时间线符合性工具、脱敏证据和退出门禁作为长期基线保留；协议设计必须由真实 SDK 事件校对，豆包真实联调保持 deferred。

**Tech Stack:** macOS、Node.js 24.15.0（要求 22+）、TypeScript 7.0.2、`@anthropic-ai/claude-agent-sdk` 0.3.319、Claude Code 2.1.319、Vitest 5.1.0、tsx 4.23.15、Ajv 8.20.0、JSON Schema 2020-12。

**Spec:** `docs/superpowers/specs/2026-11-07-s00-technical-validation-protocol-design.md`

## Global Constraints

- 直接读取 Claude Code 当前生效的 `settings.json`，不开发或依赖 cc-switch，不修改全局设置。
- 固定 Agent SDK `0.3.319` 和 Claude Code `2.1.319`；如执行前版本不一致，先记录并重新确认版本组合，不能静默升级。
- 所有 SDK 测试使用 `systemPrompt: { type: 'preset', preset: 'claude_code' }`、`tools: { type: 'preset', preset: 'claude_code' }` 和显式 `settingSources: ['user', 'project', 'local']`，除专门的对照测试外。
- SDK live 测试只在 `spikes/s00-agent-sdk/fixture/` 中运行，串行执行，`maxTurns <= 6`，不得使用真实个人项目或开启 `bypassPermissions`。
- CLI ↔ SDK 恢复必须串行：一侧进程完全退出后才能由另一侧恢复；不得复制或修改会话 JSONL 来伪造成功。
- 密钥、token、Cookie、完整请求头、完整环境变量和个人绝对路径不得进入证据；原始 SDK 事件必须在写盘前脱敏。
- Agent SDK 和 ASR fake 程序是 throwaway；`protocol/v1/`、`scripts/s00/` 和脱敏文档是保留基线。
- 豆包只写配置占位和 fake 契约，真实联调统一标记 `NOT_RUN / DEFERRED_TO_BEFORE_S05`，不得写成 PASS。
- 控制消息 `command.result`、`connection.hello/ready`、`desktop.status` 和非时间线错误不占用会话 `seq`；时间线事件从 `1` 开始逐事件加 `1`。
- 当前目录不是 Git 仓库。只有用户明确授权初始化/提交后才执行各任务的 Commit 步骤；否则将 Commit 标为 SKIPPED，不得自行 `git init` 或提交。

## Review Focus

1. **嵌套密钥和带查询参数的 URL：** 即使秘密出现在工具输出或错误字符串中，也只能留下 `[REDACTED]`；由 Task 2 的嵌套证据测试锁定。
2. **重复但内容冲突的 eventId/seq：** 正常重传应去重，同 ID 不同内容或同 seq 不同 ID 必须报冲突，不能静默覆盖；由 Task 9 的时间线测试锁定。
3. **旧 ASR stream 的迟到 final：** 取消或开始新流后，迟到结果不能覆盖当前文本；由 Task 10 的 stream/sequence 测试锁定。
4. **缺失或 LIMITED 的验证记录：** 未执行、证据不足或豆包 deferred 不能被退出门禁算成 Core PASS；由 Task 11 的门禁测试锁定。
5. **未知协议类型和含敏感值的 schema 错误：** 未知类型应安全拒绝，校验错误不能回显 secret；由 Task 8 的非法样例测试锁定。

## File Structure

```text
package.json / package-lock.json       # 固定 S00 依赖和统一测试命令
tsconfig.json / vitest.config.ts       # 严格 TypeScript 与默认单元测试
vitest.live.config.ts                  # 串行、长超时、显式开启的 SDK live 测试

scripts/s00/
  evidence.ts                          # EvidenceRecord、脱敏与安全写证据
  gate.ts / gate-cli.ts                # Core、ASR Contract、ASR Live 门禁
  tests/                               # 脱敏和门禁单元测试

spikes/s00-agent-sdk/
  fixture/                             # 无害项目、CLAUDE.md、Bash ask 规则
  src/constants.ts                     # 固定标记、版本与测试 ID
  src/options.ts                       # 统一 SDK Options
  src/collector.ts                     # SDKMessage 内存采集和摘要
  src/evidence.ts                      # spike 到共享证据层的适配
  src/cli-runner.ts                    # 无 shell 的 Claude CLI 调用
  src/scenarios/                       # settings、conversation、permissions、recovery、interop
  tests/                               # 对应 *.live.test.ts

protocol/v1/
  envelope.schema.json                 # 公共信封和条件字段
  commands.schema.json                 # S01 命令、command.result、connection.hello
  events.schema.json                   # 时间线、桌面、connection.ready、error
  examples/valid.json                  # 带名称的合法消息集合
  examples/invalid.json                # 非法消息及预期校验关键字
  examples/flows.json                  # 重试、乱序、S01 流程和握手
  src/types.ts                         # 协议 TypeScript 类型
  src/validator.ts                     # Ajv 编译与安全校验结果
  src/timeline.ts                      # 不可变去重、排序和冲突检测
  tests/                               # PROTO-01–PROTO-11

spikes/s00-asr-contract/
  asr.example.env                      # 不含真实值的豆包配置占位
  src/types.ts                         # AsrProvider、事件、状态、配置
  src/config.ts                        # 配置解析和缺项 fail fast
  src/controller.ts                    # stream/sequence 状态机
  src/fake-provider.ts                 # 可脚本化伪 Provider
  tests/                               # ASR-01–ASR-08

docs/s00/
  status.json                          # 每个测试 ID 的唯一状态台账
  environment.md                       # 版本与脱敏配置来源
  evidence/                            # 每个测试的脱敏 JSON 证据
  gateway-attribution.md               # 网关请求归因
  session-interoperability.md          # 双向恢复结果与限制
  asr-contract.md                      # ASR 契约和 deferred 清单
  exit-report.md                       # 最终 gate 决策
```

---

### Task 1: 固定工具链与隔离 fixture

**Files:**
- Create: `package.json`, `package-lock.json`, `tsconfig.json`, `.gitignore`, `vitest.config.ts`, `vitest.live.config.ts`
- Create: `spikes/s00-agent-sdk/src/constants.ts`
- Create: `spikes/s00-agent-sdk/fixture/CLAUDE.md`, `.claude/settings.json`, `README.md`, `src/example.ts`
- Test: `spikes/s00-agent-sdk/tests/bootstrap.test.ts`

**Interfaces:**
- Produces: `PROJECT_MARKER = 'S00_PROJECT_SETTING_OK_7F3A'`、`SDK_VERSION = '0.3.319'`、`CLI_VERSION = '2.1.319'`。
- Produces: `npm test`、`npm run test:coverage`、`npm run test:live`、`npm run s00:gate` 四个统一入口。

- [ ] **Step 1: Create the pinned package manifest and failing bootstrap test**

先写仅承载工具链的 `package.json`、默认/live Vitest config 和测试文件，再写断言：

```ts
expect(pkg.dependencies['@anthropic-ai/claude-agent-sdk']).toBe('0.3.319');
expect(pkg.engines.node).toBe('>=22');
expect(fixtureClaudeMd).toContain(PROJECT_MARKER);
expect(fixtureSettings.permissions.ask).toContain('Bash');
expect(liveConfig.test.fileParallelism).toBe(false);
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm install && npm test -- spikes/s00-agent-sdk/tests/bootstrap.test.ts`  
Expected: 测试因 constants 或 fixture 尚不存在而 FAIL，而不是因 npm/test script 不存在而失败。

- [ ] **Step 3: Create the remaining strict TypeScript config and isolated fixture**

`package.json` 已在 Step 1 固定 `typescript@7.0.2`、`tsx@4.23.15`、`vitest@5.1.0`、`@vitest/coverage-v8@5.1.0`、`ajv@8.20.0`、`@anthropic-ai/claude-agent-sdk@0.3.319`，并启用 ESM。补齐 strict TypeScript；默认测试排除 `*.live.test.ts`，live config 设置 `fileParallelism: false`、`maxConcurrency: 1`、`testTimeout: 120000`，并要求 `S00_LIVE=1`。fixture 只包含无害文本和 `permissions.ask: ['Bash']`，不写 allow 规则。

- [ ] **Step 4: Install and run the test**

Run: `npm test -- spikes/s00-agent-sdk/tests/bootstrap.test.ts`  
Expected: PASS；`package-lock.json` 固定 SDK 0.3.319。

- [ ] **Step 5: Commit**

```bash
git add package.json package-lock.json tsconfig.json .gitignore vitest*.ts spikes/s00-agent-sdk
git commit -m "test: add isolated S00 validation harness"
```

### Task 2: 脱敏证据层与状态台账

**Files:**
- Create: `scripts/s00/evidence.ts`, `scripts/s00/tests/evidence.test.ts`
- Create: `docs/s00/status.json`, `docs/s00/evidence/.gitkeep`
- Modify: `.gitignore`

**Interfaces:**
- Produces: `type EvidenceStatus = 'PASS' | 'FAIL' | 'BLOCKED' | 'NOT_RUN' | 'LIMITED'`。
- Produces: `interface EvidenceRecord { id: string; status: EvidenceStatus; summary: string; observedAt: string | null; data?: unknown; deferredTo?: 'S05' }`。
- Produces: `redactEvidence(value: unknown, secrets?: readonly string[]): unknown`。
- Produces: `writeEvidence(record: EvidenceRecord, root?: string): Promise<string>`，只允许 `^(SDK|CLI|PROTO|ASR)-\d{2}$` ID。

- [ ] **Step 1: Write failing redaction and evidence-ID tests**

测试嵌套 `authorization`、`token`、`cookie` 字段，URL `https://user:pass@example.test/path?token=secret`，以及字符串中出现的环境密钥；断言序列化结果不包含原秘密、用户密码或查询串。另测 `writeEvidence({id:'../secret', ...})` 拒绝，且输入对象未被修改。

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- scripts/s00/tests/evidence.test.ts`  
Expected: FAIL with `Cannot find module .../evidence.ts`。

- [ ] **Step 3: Implement immutable redaction and safe evidence writing**

递归创建新对象；敏感字段名使用大小写不敏感匹配，显式 secrets 做全字符串替换，URL 去掉用户信息、路径查询和 fragment，用户 home 前缀替换为 `~`。写入前再次序列化检查，文件名只取已校验 ID；不保存原始消息。`.gitignore` 添加 `.env`、`*.log`、coverage 和私有临时证据目录，但不忽略脱敏后的 `docs/s00/evidence/*.json`。

- [ ] **Step 4: Initialize every status as NOT_RUN and run tests**

`status.json` 列出 SDK-01–12、CLI-01–03、PROTO-01–11、ASR-01–08，以及单独对象 `DOUBAO-LIVE: {status:'NOT_RUN', deferredTo:'S05'}`。  
Run: `npm test -- scripts/s00/tests/evidence.test.ts`  
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add scripts/s00 docs/s00/status.json docs/s00/evidence/.gitkeep .gitignore
git commit -m "feat: add redacted S00 evidence records"
```

### Task 3: SDK 配置、版本与网关归因（SDK-01–04）

**Files:**
- Create: `spikes/s00-agent-sdk/src/options.ts`, `collector.ts`, `evidence.ts`
- Create: `spikes/s00-agent-sdk/src/scenarios/settings.ts`
- Test: `spikes/s00-agent-sdk/tests/settings.live.test.ts`
- Create: `docs/s00/environment.md`, `docs/s00/gateway-attribution.md`
- Modify: `docs/s00/status.json`

**Interfaces:**
- Produces: `interface ScenarioContext { fixtureRoot: string; writeEvidence(record: EvidenceRecord): Promise<string> }`。
- Produces: `createBaseOptions(fixtureRoot: string, overrides?: Partial<Options>): Options`。
- Produces: `interface CollectedSession { sessionId?: string; messageTypes: string[]; assistantText: string; textDeltas: string[]; resultSubtypes: string[]; messages: SDKMessage[] }`。
- Produces: `collectQuery(q: Query, onMessage?: (message: SDKMessage) => void): Promise<CollectedSession>`。
- Produces: `runSettingsValidation(ctx: ScenarioContext): Promise<{ userOnlyMarker: boolean; defaultMarker: boolean; explicitMarker: boolean; versions: Record<string,string>; gatewayWindow: {startedAt:string;endedAt:string;sessionIds:string[]} }>`。

- [ ] **Step 1: Write the failing live settings test**

断言 `userOnlyMarker === false`、`defaultMarker === true`、`explicitMarker === true`，版本等于 Task 1 常量，并且 gateway window 有非空时间窗口和 session ID。测试前设置 `S00_LIVE=1`，不得 mock SDK。

- [ ] **Step 2: Run the live test to verify it fails**

Run: `S00_LIVE=1 npm run test:live -- spikes/s00-agent-sdk/tests/settings.live.test.ts`  
Expected: FAIL，因为 settings scenario 尚未实现；不得把失败记成 BLOCKED。

- [ ] **Step 3: Implement base options, collection and three-source comparison**

`createBaseOptions` 固定 `cwd`、`maxTurns: 6`、`permissionMode: 'default'`、`persistSession: true`、`includePartialMessages: true`、完整 settingSources、claude_code system/tool presets。分别用 `settingSources: ['user']`、省略 settingSources、显式完整来源询问 fixture marker；user-only 仍加载用户网关，但不加载项目 CLAUDE.md。空数组行为只引用官方文档，不发起可能绕过网关的 live 请求。采集 init、assistant、stream_event 和 result 摘要，写盘前使用 Task 2 脱敏。

- [ ] **Step 4: Run the live test and capture the gateway window**

Run: `S00_LIVE=1 npm run test:live -- spikes/s00-agent-sdk/tests/settings.live.test.ts`  
Expected: PASS；环境报告显示 user-only 不加载项目 marker，省略 settingSources 与显式完整来源一致；空数组不加载磁盘设置的结论仅引用官方文档。

- [ ] **Step 5: Attribute the request to the configured gateway**

在 `gateway-attribution.md` 填入脱敏配置来源、测试时间窗口、session ID、预期模型和网关/Runtime 日志中的对应请求。只有可归因证据存在时把 SDK-03 标为 PASS；没有则保持 LIMITED，不能进入最终 Core PASS。

- [ ] **Step 6: Verify evidence and commit**

Run: `npm test -- scripts/s00/tests/evidence.test.ts && S00_LIVE=1 npm run test:live -- spikes/s00-agent-sdk/tests/settings.live.test.ts`  
Expected: PASS，且 evidence 中无秘密。  
Commit: `git add spikes/s00-agent-sdk/src spikes/s00-agent-sdk/tests/settings.live.test.ts docs/s00/environment.md docs/s00/gateway-attribution.md docs/s00/status.json docs/s00/evidence && git commit -m "test: verify SDK settings and gateway attribution"`。

### Task 4: Streaming Input 与增量输出（SDK-05–06）

**Files:**
- Create: `spikes/s00-agent-sdk/src/scenarios/conversation.ts`
- Test: `spikes/s00-agent-sdk/tests/conversation.live.test.ts`
- Modify: `docs/s00/status.json`

**Interfaces:**
- Consumes: `createBaseOptions`、`collectQuery`、`ScenarioContext`。
- Produces: `runTwoTurnConversation(ctx): Promise<{sessionId:string;turnResults:number;secondTurnText:string;deltaCount:number;sawAssistant:boolean}>`。
- Produces: `createUserMessage(text: string): SDKUserMessage`。

- [ ] **Step 1: Write the failing two-turn streaming test**

第一轮要求记住 `S00_STREAM_MARKER_91C2`，第二轮询问该 marker。断言同一 session ID、两个 turn result、第二轮包含 marker、`deltaCount > 0`、`sawAssistant === true`。

- [ ] **Step 2: Run test to verify it fails**

Run: `S00_LIVE=1 npm run test:live -- spikes/s00-agent-sdk/tests/conversation.live.test.ts`  
Expected: FAIL with missing `runTwoTurnConversation`。

- [ ] **Step 3: Implement coordinated async-iterable Streaming Input**

使用一个 `query()` 和 async iterable `SDKUserMessage`；通过 `collectQuery` 的 `onMessage` 观察第一轮 result，再用已完成的 deferred 通知 generator yield 第二轮，不能用固定 sleep 猜测轮次。通过 `includePartialMessages: true` 收集 `stream_event → content_block_delta → text_delta`，在 finally 中 `q.close()`。

- [ ] **Step 4: Run test and inspect event ordering**

Run: `S00_LIVE=1 npm run test:live -- spikes/s00-agent-sdk/tests/conversation.live.test.ts`  
Expected: PASS；证据能区分 Streaming Input、多轮 result、partial delta 和完整 assistant message。

- [ ] **Step 5: Update status and commit**

将 SDK-05、SDK-06 标为 PASS 并附证据路径。  
Commit: `git add spikes/s00-agent-sdk/src/scenarios/conversation.ts spikes/s00-agent-sdk/tests/conversation.live.test.ts docs/s00/status.json docs/s00/evidence && git commit -m "test: verify SDK streaming input and deltas"`。

### Task 5: 工具权限允许与拒绝（SDK-07–08）

**Files:**
- Create: `spikes/s00-agent-sdk/src/scenarios/permissions.ts`
- Test: `spikes/s00-agent-sdk/tests/permissions.live.test.ts`
- Modify: `docs/s00/status.json`

**Interfaces:**
- Produces: `runPermissionValidation(ctx): Promise<{allow:{callback:boolean;outputMarker:boolean;requestId:boolean;toolUseID:boolean};deny:{callback:boolean;outputMarker:boolean;denialObserved:boolean};persistentSettingsWritten:boolean}>`。

- [ ] **Step 1: Write failing allow/deny tests**

allow 用命令 `printf S00_PERMISSION_ALLOW_4A91`，断言 callback、requestId、toolUseID 和输出 marker 均出现；deny 用不同 marker，断言 callback 出现、输出 marker 不出现、denial 被观察且 query 在超时内结束。两次都断言 `persistentSettingsWritten === false`。

- [ ] **Step 2: Run tests to verify they fail**

Run: `S00_LIVE=1 npm run test:live -- spikes/s00-agent-sdk/tests/permissions.live.test.ts`  
Expected: FAIL with missing permission scenario。

- [ ] **Step 3: Implement one-shot allow and explicit deny**

`canUseTool(toolName,input,options)` 记录 `toolName`、脱敏 input、`requestId`、`toolUseID`。allow 返回 `{behavior:'allow',updatedInput:input,toolUseID}`，不得返回 `updatedPermissions`；deny 返回 `{behavior:'deny',message:'S00 validation denied',toolUseID}`。使用 fixture 的 Bash ask 规则，不设置 allowedTools，不使用 `bypassPermissions`，finally 关闭 query。

- [ ] **Step 4: Run tests and check no persistent rule was written**

Run: `S00_LIVE=1 npm run test:live -- spikes/s00-agent-sdk/tests/permissions.live.test.ts`  
Expected: PASS；fixture 不存在新增的 `.claude/settings.local.json`，deny 后 Agent 可继续回复。

- [ ] **Step 5: Update status and commit**

Commit: `git add spikes/s00-agent-sdk/src/scenarios/permissions.ts spikes/s00-agent-sdk/tests/permissions.live.test.ts docs/s00/status.json docs/s00/evidence && git commit -m "test: verify SDK tool permission decisions"`。

### Task 6: 中断、恢复与非法 session（SDK-09–12）

**Files:**
- Create: `spikes/s00-agent-sdk/src/scenarios/recovery.ts`
- Test: `spikes/s00-agent-sdk/tests/recovery.live.test.ts`
- Modify: `docs/s00/status.json`

**Interfaces:**
- Produces: `runRecoveryValidation(ctx): Promise<{normalResumedMarker:boolean;interrupted:boolean;interruptedResumedMarker:boolean;invalidResumeRejected:boolean;closed:boolean;normalSessionId:string;interruptedSessionId:string}>`。

- [ ] **Step 1: Write the failing recovery test**

先用正常完成的 session 记住 `S00_NORMAL_RESUME_51A0`，新 query resume 后断言 `normalResumedMarker === true`，覆盖 SDK-10。再用另一 session 记住 `S00_INTERRUPT_MARKER_62BD` 后持续输出；收到首个 text delta 后调用 `q.interrupt()`，随后显式 resume 并断言 `interruptedResumedMarker === true`，覆盖 SDK-09/11。断言 closed 为 true；对全零且确认不存在的 UUID 断言拒绝且不能返回一个看似恢复成功的新 session，覆盖 SDK-12。

- [ ] **Step 2: Run test to verify it fails**

Run: `S00_LIVE=1 npm run test:live -- spikes/s00-agent-sdk/tests/recovery.live.test.ts`  
Expected: FAIL with missing recovery scenario。

- [ ] **Step 3: Implement bounded interrupt and explicit resume**

先完成普通 query 并用新 query 的 `resume: normalSessionId` 恢复；再执行中断场景。只在 Streaming Input query 上调用 `interrupt(): Promise<SDKControlInterruptResponse | undefined>`，设置总超时，finally 调用 `close(): void`。两种恢复都使用新 query，不自动重放被中断 prompt；非法 resume 捕获异常/错误 result 并保留脱敏摘要。

- [ ] **Step 4: Run test and verify cleanup**

Run: `S00_LIVE=1 npm run test:live -- spikes/s00-agent-sdk/tests/recovery.live.test.ts`  
Expected: PASS；所有 iterator 和子进程均结束，无后台等待任务。

- [ ] **Step 5: Update status and commit**

Commit: `git add spikes/s00-agent-sdk/src/scenarios/recovery.ts spikes/s00-agent-sdk/tests/recovery.live.test.ts docs/s00/status.json docs/s00/evidence && git commit -m "test: verify SDK interruption and resume"`。

### Task 7: CLI ↔ SDK 双向会话恢复（CLI-01–03）

**Files:**
- Create: `spikes/s00-agent-sdk/src/cli-runner.ts`
- Create: `spikes/s00-agent-sdk/src/scenarios/interop.ts`
- Test: `spikes/s00-agent-sdk/tests/interop.live.test.ts`
- Create: `docs/s00/session-interoperability.md`
- Modify: `docs/s00/status.json`

**Interfaces:**
- Produces: `runCli(args: readonly string[], cwd: string): Promise<{stdout:string;stderr:string;exitCode:number}>`，使用 `execFile`，禁止 shell 字符串拼接。
- Produces: `runCliToSdk(ctx): Promise<{cliSessionId:string;sdkSessionId:string;markerRecovered:boolean}>`。
- Produces: `runSdkToCli(ctx): Promise<{sdkSessionId:string;cliSessionId:string;markerRecovered:boolean}>`。

- [ ] **Step 1: Write failing bidirectional interoperability tests**

CLI → SDK 使用 `S00_CLI_TO_SDK_5E10`，SDK → CLI 使用 `S00_SDK_TO_CLI_7B20`。两侧分别断言 session ID 相同、后一侧输出包含前一侧 marker，并且调用顺序完成后才启动下一进程。

- [ ] **Step 2: Run tests to verify they fail**

Run: `S00_LIVE=1 npm run test:live -- spikes/s00-agent-sdk/tests/interop.live.test.ts`  
Expected: FAIL with missing CLI runner/interop scenario。

- [ ] **Step 3: Implement CLI creation and resume without touching transcript files**

CLI 创建使用 `claude -p <prompt> --output-format json --max-turns 1`，从 JSON 读取 `session_id`；SDK 使用 `resume: sessionId`。SDK 创建并完全关闭后，CLI 使用 `claude --resume <sessionId> -p <prompt> --output-format json --max-turns 1`。所有调用使用 fixture cwd、无 shell、显式超时和 stderr 脱敏。

- [ ] **Step 4: Run both directions sequentially**

Run: `S00_LIVE=1 npm run test:live -- spikes/s00-agent-sdk/tests/interop.live.test.ts`  
Expected: PASS；报告中记录两个方向的 session ID、上下文证据和任何工具历史/版本差异。

- [ ] **Step 5: Reject unsupported interoperability instead of waiving it**

若任一方向 FAIL，保持 CLI-01/02 非 PASS，并在 `session-interoperability.md` 记录官方支持依据和架构决策需求；不得复制 JSONL、并行写入或改测试 marker 让测试变绿。

- [ ] **Step 6: Commit**

Commit: `git add spikes/s00-agent-sdk/src/cli-runner.ts spikes/s00-agent-sdk/src/scenarios/interop.ts spikes/s00-agent-sdk/tests/interop.live.test.ts docs/s00/session-interoperability.md docs/s00/status.json docs/s00/evidence && git commit -m "test: verify CLI and SDK session interoperability"`。

### Task 8: 协议信封、命令与安全校验（PROTO-01–06、08）

**Files:**
- Create: `protocol/v1/src/types.ts`, `protocol/v1/src/validator.ts`
- Create: `protocol/v1/envelope.schema.json`, `commands.schema.json`, `events.schema.json`
- Create: `protocol/v1/examples/valid.json`, `invalid.json`
- Test: `protocol/v1/tests/core.test.ts`
- Modify: `docs/s00/status.json`

**Interfaces:**
- Produces: `type ProtocolMessage = CommandMessage | CommandResultMessage | EventMessage | ControlMessage`。
- Produces: `type ValidationResult = {valid:true;message:ProtocolMessage} | {valid:false;errors:Array<{path:string;keyword:string;code:'INVALID_MESSAGE'|'UNKNOWN_MESSAGE_TYPE'}>}`。
- Produces: `validateProtocolMessage(input: unknown): ValidationResult`，不修改输入，不返回输入值。

- [ ] **Step 1: Write failing schema and safe-error tests**

覆盖合法 `session.start`、`prompt.send`、`run.cancel`、`session.snapshot`、`command.result`；缺必填字段、负 seq、字符串 timestamp、未知 type、缺 runId、非法 duplicate 组合均必须拒绝。把 `secret='DO_NOT_LEAK_99'` 放入非法消息，断言 errors 序列化不包含它。重复命令样例要求相同 commandId/traceId、不同 messageId、相同首次 data、第二次 `duplicate:true`。

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- protocol/v1/tests/core.test.ts`  
Expected: FAIL with missing validator/schema。

- [ ] **Step 3: Implement Ajv 2020-12 schemas and discriminated unions**

公共必填为 `protocolVersion:1`、`messageId`、`timestamp`、`type`、`payload`；命令及 result 要求 commandId/traceId，时间线事件要求 eventId/sessionId/正整数 seq，控制 result 不要求 seq。Ajv 使用 `allErrors:true`、`strict:true`、`verbose:false`，错误只映射 `instancePath` 和 `keyword`；未知类型返回 `UNKNOWN_MESSAGE_TYPE` 对应的安全校验结果。

- [ ] **Step 4: Run protocol tests and invalid examples**

Run: `npm test -- protocol/v1/tests/core.test.ts`  
Expected: PASS，PROTO-01–06、08 有合法/非法样例证据。

- [ ] **Step 5: Update status and commit**

Commit: `git add protocol/v1 docs/s00/status.json docs/s00/evidence && git commit -m "feat: add protocol V1 command schemas"`。

### Task 9: 时间线事件、快照与握手（PROTO-07、09–11）

**Files:**
- Create: `protocol/v1/src/timeline.ts`
- Modify: `protocol/v1/events.schema.json`, `protocol/v1/src/types.ts`
- Create: `protocol/v1/examples/flows.json`, `protocol/v1/README.md`
- Test: `protocol/v1/tests/events.test.ts`, `timeline.test.ts`, `handshake.test.ts`
- Modify: `docs/s00/status.json`

**Interfaces:**
- Produces: `normalizeTimeline<T extends {eventId:string;sessionId:string;seq:number}>(events: readonly T[]): T[]`，只接受同一 sessionId，返回新数组。
- Produces: `class ProtocolConflictError extends Error { readonly code: 'PROTOCOL_CONFLICT' }`。
- Produces: `connection.hello` 的 `supportedProtocolVersions/appVersion/deviceId/capabilities` 与 `connection.ready` 的 `protocolVersion/desktopId/agentVersion/sdkVersion/runtimeVersion/capabilities` schema。

- [ ] **Step 1: Write failing timeline, full-flow and handshake tests**

乱序事件输出去重后的升序新数组，原数组不变；相同 eventId+相同内容只保留一个；相同 eventId 不同内容、相同 seq 不同 eventId、混入不同 sessionId 均抛 `ProtocolConflictError`。S01 flow 覆盖 session.start、两轮 prompt、tool、cancel、result。握手覆盖版本 1 成功和不兼容 `VERSION_INCOMPATIBLE`，且控制消息无 seq。

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- protocol/v1/tests`  
Expected: FAIL with missing timeline/events/handshake definitions。

- [ ] **Step 3: Implement event schemas and immutable conflict detection**

补齐 snapshot、session.status、message.delta/completed、tool.started/output/completed、run.completed、desktop.status、error、connection.ready。`normalizeTimeline` 先按 eventId 检查冲突，再检查 seq 冲突，最后返回排序副本；不得用 timestamp 排序。

- [ ] **Step 4: Run all protocol tests**

Run: `npm test -- protocol/v1/tests`  
Expected: PASS，PROTO-01–11 全部满足。

- [ ] **Step 5: Document exact semantics and commit**

README 写明 command.result 不代表 run 成功、run.completed 才是最终状态、未知可选字段可忽略、未知类型安全拒绝、握手不能协商权限或 cwd。  
Commit: `git add protocol/v1 docs/s00 && git commit -m "feat: complete protocol V1 event contracts"`。

### Task 10: 豆包配置占位与 Fake ASR 契约（ASR-01–08）

**Files:**
- Create: `spikes/s00-asr-contract/asr.example.env`
- Create: `spikes/s00-asr-contract/src/types.ts`, `config.ts`, `controller.ts`, `fake-provider.ts`
- Test: `spikes/s00-asr-contract/tests/config.test.ts`, `controller.test.ts`
- Create: `docs/s00/asr-contract.md`
- Modify: `docs/s00/status.json`

**Interfaces:**
- Produces: `parseAsrConfig(env: NodeJS.ProcessEnv): AsrConfig`。
- Produces: `interface AsrStreamHandle { readonly streamId: string }`。
- Produces: `interface AsrProvider { start(handle:AsrStreamHandle,config:AsrConfig,emit:(event:AsrEvent)=>void):Promise<void>;write(handle:AsrStreamHandle,audio:Uint8Array):Promise<void>;finalize(handle:AsrStreamHandle):Promise<void>;cancel(handle:AsrStreamHandle):Promise<void> }`。
- Produces: `interface AsrSnapshot { state:'idle'|'connecting'|'recording'|'finalizing'|'completed'|'cancelled'|'error';streamId?:string;draft:string;finalText?:string;lastSequence:number;error?:{code:string;retryable:boolean;safeMessage:string} }`。
- Produces: `class AsrController { constructor(provider:AsrProvider,config:AsrConfig,idFactory?:()=>string);start():Promise<void>;write(audio:Uint8Array):Promise<void>;finalize():Promise<void>;cancel():Promise<void>;snapshot():AsrSnapshot }`。
- Produces: `FakeAsrProvider`，测试可发送 `asr.started/partial/final/error/cancelled/closed`。

- [ ] **Step 1: Write failing ASR-01–08 tests**

测试正常 partial/final、cancel、provider error、空 final、旧 sequence、旧 streamId、重复 final、缺配置。另测取消后新 stream 的旧 final 不改变 `finalText`，任何路径都不调用或生成 `prompt.send`；配置错误只包含缺失字段名，不包含已存在 secret。

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- spikes/s00-asr-contract/tests`  
Expected: FAIL with missing ASR modules。

- [ ] **Step 3: Implement provider-neutral immutable state transitions**

Controller 通过注入 `idFactory: () => string` 生成 streamId，忽略旧 stream 和不大于当前 sequence 的事件；completed/cancelled/error 为终态。`parseAsrConfig` 只验证候选字段 `ASR_PROVIDER=doubao`、APP_ID、ACCESS_TOKEN、RESOURCE_ID、ENDPOINT，MODEL 可选；所有字段在文档标记 `TO_VERIFY_WITH_OFFICIAL_DOCS`。

- [ ] **Step 4: Run tests and verify deferred status**

Run: `npm test -- spikes/s00-asr-contract/tests`  
Expected: PASS，ASR-01–08 可标 PASS；`DOUBAO-LIVE` 仍为 NOT_RUN/deferred。

- [ ] **Step 5: Document and commit**

`asr-contract.md` 写明 16 kHz/mono/PCM16 基线、密钥只在 Mac、真实豆包产品/API/短期凭证尚未验证，以及 S05 前的六项 live 清单。  
Commit: `git add spikes/s00-asr-contract docs/s00 && git commit -m "test: add deferred Doubao ASR contract"`。

### Task 11: 退出门禁、覆盖率与最终报告

**Files:**
- Create: `scripts/s00/gate.ts`, `scripts/s00/gate-cli.ts`, `scripts/s00/tests/gate.test.ts`
- Modify: `vitest.config.ts`, `docs/s00/exit-report.md`, `docs/s00/status.json`

**Interfaces:**
- Consumes: Task 2 的 `EvidenceRecord`、Task 8–10 的协议/ASR 测试入口。
- Produces: `evaluateS00Gate(records: readonly EvidenceRecord[]): {core:'PASS'|'FAIL'|'BLOCKED';asrContract:'PASS'|'FAIL'|'BLOCKED';asrLive:'PASS'|'FAIL'|'DEFERRED';missingCoreIds:string[];limitedCoreIds:string[]}`。

- [ ] **Step 1: Write failing gate tests**

覆盖：缺任一 Core ID → BLOCKED；任一 FAIL → FAIL；任一 LIMITED → BLOCKED 且列入 limitedCoreIds；Core 全 PASS + ASR fake 全 PASS + DOUBAO-LIVE NOT_RUN → core/asrContract PASS、asrLive DEFERRED；deferred 不影响已通过的 Core，但自身只能是 DEFERRED，也不能替代任何缺失的 Core 记录。

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- scripts/s00/tests/gate.test.ts`  
Expected: FAIL with missing gate module。

- [ ] **Step 3: Implement explicit ID-set gate evaluation**

Core 集合固定为 SDK-01–12、CLI-01–03、PROTO-01–11；ASR Contract 为 ASR-01–08。`gate-cli.ts` 读取 `docs/s00/status.json` 并转换为 `EvidenceRecord[]`，其中 `DOUBAO-LIVE` 必须保留 `deferredTo:'S05'`。CLI-01/02 和 SDK-03 无豁免；任何缺失、NOT_RUN、BLOCKED、LIMITED 均不能算 Core PASS。CLI 输出人类可读摘要并以非零码阻止未通过 gate。

- [ ] **Step 4: Run the complete verification suite**

Run: `npm test && npm run test:coverage && S00_LIVE=1 npm run test:live && npm run s00:gate`  
Expected: 全部测试 PASS；`scripts/s00/` 与 `protocol/v1/src/` 的 statements/branches/functions/lines 均至少 80%；Core PASS、ASR Contract PASS、ASR Live DEFERRED。若网关或双向恢复 BLOCKED/FAIL，保留失败输出并停止，不进入 S01。

- [ ] **Step 5: Write the evidence-backed exit report**

`exit-report.md` 逐项链接环境、SDK、网关、双向恢复、协议和 ASR 证据，列出所有 FAIL/BLOCKED/LIMITED；明确写出“可以进入 S01”或“需要调整架构”。不得将本次未执行的豆包联调写成已验证。

- [ ] **Step 6: Commit**

```bash
git add scripts/s00 protocol spikes docs/s00 vitest.config.ts
git commit -m "test: add S00 exit gate and evidence report"
```
