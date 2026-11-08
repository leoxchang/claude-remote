# S00 详细 Spec：技术验证与协议基线

**版本：** V1.0  
**日期：** 2026-11-07  
**状态：** 设计已确认，待制定实施计划  
**上游文档：**
- `claude-code-mobile-control-architecture.md`
- `docs/superpowers/specs/2026-11-07-personal-mobile-claude-control-spec-breakdown-design.md`

## 1. 目的

S00 用最小、隔离、可丢弃的验证程序回答三个问题：

1. Claude Agent SDK 能否直接使用 Claude Code 当前的 `settings.json` 和自定义模型网关，并提供后续远程控制所需的会话、流式输入、权限回调、中断与恢复能力？
2. Claude Code CLI 与 Agent SDK 创建的本地会话能否串行双向恢复，从而证明两者复用兼容的会话数据，而不是两套隔离状态？
3. 后续 iOS App 与 Mac Agent 能否建立一份稳定、可校验、可扩展的协议 V1 基线，避免各 spec 各自解释命令、事件、幂等和错误语义？

同时，S00 为豆包流式 ASR 预留配置与 Provider 中立契约。由于当前没有豆包服务或调用凭证，本阶段不执行真实豆包联调，也不宣称其已验证。

S00 的成功结果不是“写出正式 Desktop Agent”，而是取得足够证据决定后续架构可以继续、需要调整，或存在阻塞。

## 2. 已确认决策

- 直接以 Claude Code 当前生效的 `settings.json` 为配置来源，不开发 cc-switch 适配层，不依赖 cc-switch 的运行时行为。
- 验证环境为当前 Mac 和当前用户下的 Claude Code；首版目标客户端为 iPhone，但 S00 不开发 App。
- Agent SDK 验证必须覆盖 CLI → SDK 和 SDK → CLI 的双向会话恢复。
- 两个入口不得同时写入同一个活跃会话；跨入口恢复必须在一侧进程完全退出后进行。
- 为贴近 Claude Code CLI，必须验证 `claude_code` system prompt preset 和显式设置加载范围，不能把最简 `query()` 的行为视为等价。
- 豆包仅预留配置和接口；真实服务验证延迟到 S05 前，不阻塞 S01–S04。
- Agent SDK 与 ASR fake 验证程序均标记为 throwaway。协议 schema、协议符合性测试、脱敏证据和决策记录作为长期基线保留；不能把 spike 当作产品代码继续扩展。

## 3. 范围与非范围

### 3.1 范围内

- 读取并核对当前 Claude Code 版本、Node.js 版本、Agent SDK 版本和配置来源。
- 在隔离测试项目中验证 SDK 的消息、工具、权限、中断、恢复和双向会话互操作。
- 验证自定义模型网关确实接收 SDK 发起的请求，而非意外回落到其他认证或 Provider。
- 形成协议 V1 的消息信封、S01 命令/事件 schema、关联规则、版本协商和错误结构。
- 为 S02–S05 预留协议类型名称与扩展规则。
- 定义 ASR 配置占位、Provider 中立状态与事件语义，并用伪实现执行契约测试。
- 输出可复核的脱敏证据、版本矩阵、限制和后续决策。

### 3.2 范围外

- Flutter App、WSS 服务、Tailscale、设备配对和 launchd；
- 正式 SDK Adapter、Session Orchestrator、Permission Broker 和 SQLite；
- 对真实个人项目执行任务，或修改用户的全局 `settings.json`；
- 同时接管一个正在 CLI 中运行的会话；
- 真实豆包调用、iOS 录音、音频转发和供应商性能对比；
- 接入多个 ASR 厂商或实现通用语音框架；
- Relay、多用户、公网产品化和官方 Remote Control；
- 将 throwaway 验证代码重构成正式产品的实现工作。

### 3.3 反目标

出现以下任一情况，不能宣称 S00 验证成功：

- 仅因为 SDK 返回了文本，就断定它使用了预期网关或模型；
- 将 `settings.json`、密钥、完整环境变量或个人路径复制到仓库与证据文档；
- 只验证 SDK 自身 resume，未验证 CLI 与 SDK 双向恢复；
- 把 Streaming Input 与 token 级流式输出混为一谈，只验证其中一项；
- 真实豆包测试未执行，却在报告中写成 PASS；
- 为让测试通过而开启全局 `bypassPermissions`、关闭权限回调或修改真实项目；
- 协议只记录类型名称，没有必填字段、关联规则、示例和非法样例。

## 4. 前置条件与输入

执行 S00 前需要：

- 一台可运行当前 Claude Code CLI 的 Mac；
- Node.js 22+；
- 当前用户的 Claude Code `settings.json` 已能通过自定义模型网关完成普通 CLI 对话；
- 允许在隔离目录创建一次性测试项目和 throwaway Node.js 程序；
- 能访问 Agent SDK 官方文档和 npm 包；
- 能提供一种可归因的网关请求证据，例如网关请求日志或 Runtime 调试日志；只有模型名称而没有请求归因证据时，网关验证只能标为 LIMITED/BLOCKED；
- 执行者知道哪些字段属于敏感信息，并在采集证据前启用脱敏。

当前明确缺少：

- 豆包/火山引擎语音识别服务开通状态；
- 豆包调用凭证；
- 对具体豆包流式接口、资源 ID 和鉴权方式的选择。

这些缺项只影响 ASR live gate，不影响 SDK 和协议验证。

## 5. 安全、隔离与证据规则

### 5.1 测试隔离

- 新建专用测试项目，不使用真实代码仓库。
- 测试项目包含无害源码、测试命令和用于验证项目设置加载的标记文本。
- Bash 权限测试只执行 `pwd`、打印固定文本或等待等无副作用命令。
- 文件写入测试如确有必要，只能写测试项目内固定文件。
- 不安装或调用具有外部副作用的 MCP 工具；已有 MCP 只记录加载状态，不执行高风险操作。
- 每次测试结束关闭 SDK query、CLI 子进程和残留等待任务。

### 5.2 配置处理

- 不修改全局 `settings.json`，不让测试程序重写用户配置。
- 只记录配置来源、非敏感字段名、脱敏后的网关标识和模型标识。
- 密钥、token、Cookie、完整请求头和完整环境变量不得进入日志。
- 证据中需要展示 URL 时，只保留协议和可公开的脱敏主机标识；路径查询参数默认全部移除。
- 如果配置实际由环境变量覆盖，记录覆盖来源和优先级，不强行改写成 `settings.json` 行为。

### 5.3 证据状态

每个测试只能使用以下状态：

- `PASS`：按步骤执行，结果与证据均满足标准；
- `FAIL`：已执行，行为不符合要求；
- `BLOCKED`：因缺少外部条件无法完成；
- `NOT_RUN`：尚未执行；
- `LIMITED`：部分行为通过，但证据不足以支持完整结论。

任何 `FAIL`、`BLOCKED` 或 `LIMITED` 都必须附原因和后续决策，不能省略测试记录。

## 6. 建议产物布局

以下是本 spec 的实现建议，目录名可在计划中微调，但 throwaway 与长期产物必须分离：

```text
spikes/s00-agent-sdk/             # 可丢弃 SDK 验证程序
spikes/s00-asr-contract/          # 可丢弃伪 ASR 契约验证

docs/s00/
  environment.md                 # 版本和脱敏配置来源
  agent-sdk-evidence.md           # SDK 测试记录
  session-interoperability.md    # 双向恢复记录
  gateway-attribution.md         # 网关请求归因证据
  asr-contract.md                # ASR 配置和 Provider 契约
  exit-report.md                 # 总结、限制和 gate 决策

protocol/v1/
  README.md                      # 协议语义与版本规则
  envelope.schema.json           # 基础信封
  commands.schema.json           # S01 命令
  events.schema.json             # S01 事件及 command.result
  examples/                      # 合法与非法脱敏样例
```

原始事件如包含路径、工具输入或模型正文，应先脱敏再保存；不能只把原始 SDK 日志整体复制到 `docs/`。

## 7. 工作流 A：Agent SDK 技术验证

### 7.1 配置基线

以执行时固定的 SDK 官方文档为准，基线验证采用以下意图：

- 显式加载用户、项目和本地设置，候选配置为 `settingSources: ['user', 'project', 'local']`；
- 使用 Claude Code 预设系统提示词，候选配置为 `systemPrompt: { type: 'preset', preset: 'claude_code' }`；
- 在隔离测试项目目录启动 query；
- 使用 Streaming Input 维持同一受管会话的多轮输入；
- 如需 token/内容块增量，启用当前 SDK 文档规定的 partial message 选项，并记录实际事件形式。

如果固定版本的实际选项名或行为不同，应记录文档依据并调整 spike，不得静默省略相应验证。

### 7.2 测试矩阵

| ID | 验证项 | 核心步骤 | PASS 标准 |
|---|---|---|---|
| SDK-01 | 版本与配置盘点 | 记录 macOS、Node、CLI、SDK、Runtime、cwd 和脱敏配置来源 | 版本可复现；配置来源清楚；无敏感值泄露 |
| SDK-02 | 显式设置加载 | 对比未显式加载设置与显式加载 user/project/local 设置的初始化结果 | 能说明默认差异；目标配置加载方式有文档和事件证据 |
| SDK-03 | 网关切真使用 | 通过 SDK 发起唯一可识别请求，并对照网关或 Runtime 请求记录 | 请求可归因到预期网关和模型；无官方路径意外回落证据 |
| SDK-04 | Claude Code 行为基线 | 使用 `claude_code` preset，核对工具、权限模式、项目设置及 CLAUDE.md 标记 | preset 生效；项目配置按预期加载；差异被记录 |
| SDK-05 | Streaming Input 多轮 | 第一轮写入无害标记，第二轮在同一 query 中询问该标记 | 同一会话接受多轮输入；第二轮能利用第一轮上下文 |
| SDK-06 | 增量消息 | 接收助手输出并记录完整消息与 partial/stream 事件 | 明确各事件类型和顺序；能支撑后续 `message.delta` 归一化 |
| SDK-07 | 工具权限允许 | 触发无害 Bash，`canUseTool` 返回允许一次 | 回调收到工具名和输入；allow 后工具执行；request 关联可追踪 |
| SDK-08 | 工具权限拒绝 | 再次触发工具并拒绝 | deny 返回 SDK；不会错误执行；Agent 可继续回复；run 最终状态被记录 |
| SDK-09 | 主动中断 | 启动可持续任务，在执行中调用当前 SDK 的中断 API | query 停止；收到可识别的中断/错误/结果；无残留子进程 |
| SDK-10 | SDK 自身 resume | 结束首次 query，使用其 session ID 新起 query 并询问旧标记 | 恢复同一历史上下文；新事件可关联到原 Claude session ID |
| SDK-11 | 中断后明确恢复 | 在 SDK-09 后由测试者显式 resume，不自动重放原 prompt | 能查看/继续会话；中断状态与恢复行为有证据 |
| SDK-12 | 非法恢复与错误 | 使用不存在的 session ID 或无效恢复输入 | 返回可捕获错误；不会误创建看似恢复成功的新会话 |
| CLI-01 | CLI → SDK 恢复 | CLI 在测试项目创建标记会话并完全退出；SDK 使用该 ID resume | SDK 能读取旧上下文；两侧 cwd、session ID 和模型配置一致 |
| CLI-02 | SDK → CLI 恢复 | SDK 创建标记会话并完全关闭；CLI 使用该 ID resume | CLI 能读取旧上下文；不会要求不兼容迁移或创建空白替代会话 |
| CLI-03 | 互操作限制 | 比较两侧工具历史、消息顺序和版本信息 | 不能恢复的字段或行为差异被明确记录；无数据损坏 |

### 7.3 网关归因的最低证据

SDK-03 不能仅依赖“回答正常”或初始化事件中的模型字段。至少需要：

1. 脱敏后的预期配置来源；
2. 本次 SDK 测试的唯一时间窗口、session ID 或请求标记；
3. 同一时间窗口内预期网关的请求记录，或可明确显示目标 Provider 的 Runtime 调试记录；
4. CLI 与 SDK 请求路径的对照结论。

如果无法取得第 3 项，则 SDK-03 标为 `LIMITED`。在执行者决定接受该限制前，S00 Core 不得标记为完整 PASS。

### 7.4 双向恢复的操作约束

- CLI 与 SDK 使用相同测试项目真实路径。
- 一侧退出后再启动另一侧，不并行写入。
- 每侧使用不同的上下文标记，避免把模型猜测误认为历史读取。
- 保存会话 ID 映射和消息摘要，不保存完整敏感输出。
- 如果跨入口恢复依赖特定 CLI/SDK 版本，该版本组合必须写入环境矩阵。
- 如果任一方向失败，先确认官方是否支持该互操作路径；不能通过复制会话数据库或修改内部文件伪造成功。

## 8. 工作流 B：协议 V1 基线

### 8.1 设计原则

- Mac Agent 是未来会话、run、审批和事件的事实源；S00 只定义契约，不实现该服务。
- 使用 JSON，所有 schema 可在运行时校验；TypeScript 与 Dart 类型生成属于后续实现，不在 S00 建代码生成框架。
- V1 冻结基础信封、关联规则、错误结构和 S01 必需 payload。
- S02–S05 可以新增命令、事件和可选字段，但不能改变已有字段含义或复用 ID。
- 未识别可选字段应可忽略；未识别命令/事件类型必须返回或记录结构化协议错误，不能按其他类型处理。

### 8.2 基础信封

```json
{
  "protocolVersion": 1,
  "messageId": "msg_01...",
  "commandId": "cmd_01...",
  "traceId": "trace_01...",
  "sourceDeviceId": "device_phone_01",
  "desktopId": "desktop_mac_01",
  "workspaceId": "ws_01...",
  "sessionId": "session_01...",
  "runId": "run_01...",
  "timestamp": 1762432800000,
  "type": "prompt.send",
  "payload": {
    "text": "检查这个测试项目"
  }
}
```

规则：

| 字段 | 要求 |
|---|---|
| `protocolVersion` | 所有消息必填，S00 固定为整数 `1` |
| `messageId` | 所有消息必填，每次实际消息唯一，重传保持原值 |
| `timestamp` | 所有消息必填，Unix epoch 毫秒；排序不依赖该字段 |
| `type` | 所有消息必填，使用本协议注册名称 |
| `payload` | 所有消息必填，无数据时使用空对象 |
| `commandId` | 所有命令及其 `command.result` 必填；异步业务事件可携带用于溯源 |
| `traceId` | 所有命令及其派生结果/错误必填，贯穿日志 |
| `eventId` | 所有进入会话时间线的业务事件必填，传输重试不改变；`command.result`、握手和桌面级控制消息不要求 |
| `seq` | 所有会话时间线事件必填，从 `1` 开始在同一 `sessionId` 内逐事件加 `1`；`command.result`、握手、`desktop.status` 和非时间线错误不占用 seq |
| `workspaceId/sessionId/runId/approvalId` | 按对象关联条件必填，禁止用旧对象 ID 代替当前对象 |
| `sourceDeviceId/desktopId` | 建立配对协议前作为可选路由字段，S01 认证生效后必须校验来源 |

ID 使用 UUID 或 ULID 等可实现唯一性的方案，具体库由实现者决定。时间戳、到达顺序和 Relay 均不是事件排序依据。

### 8.3 命令结果与异步事件

本 spec 作出的协议选择是：每个命令都有统一的 `command.result`，业务过程继续使用异步事件。

`command.result` 至少包含：

```json
{
  "status": "ok",
  "duplicate": false,
  "data": {}
}
```

失败时：

```json
{
  "status": "error",
  "duplicate": false,
  "error": {
    "code": "SESSION_BUSY",
    "message": "当前会话已有任务执行",
    "retryable": true,
    "details": {}
  }
}
```

规则：

- `command.result` 使用原 `commandId` 和 `traceId`，但拥有自己的 `messageId`。
- 重复命令返回首次处理结果，`duplicate` 为 `true`；不得执行第二次业务操作。
- `command.result.status=ok` 只表示该命令已被接受或同步完成，不代表后续 run 已成功。
- run 的最终结果只由 `run.completed` 表达。
- `error` 事件用于无法归属于某个命令的异步或控制面错误；命令失败优先使用 `command.result`。
- `message` 字段用于人类诊断，客户端逻辑必须依赖稳定的 `code`，不能解析 message 文本。

### 8.4 S01 必须冻结的类型

命令：

| 类型 | S00 需要定义的 payload/result |
|---|---|
| `session.start` | 固定测试项目引用或首版会话参数、客户端能力；返回本地/Claude 会话标识 |
| `prompt.send` | `text`；信封携带原 `commandId`；返回会话/run 接受状态；S01 busy 返回 `SESSION_BUSY` |
| `run.cancel` | `sessionId + runId`；只取消指定 run |
| `session.snapshot` | 请求当前会话快照；结果关联对应快照 |

事件：

| 类型 | 必须表达的语义 |
|---|---|
| `session.snapshot` | 会话、当前 run、最近事件和 `lastSeq`，作为易失状态覆盖来源 |
| `session.status` | 会话生命周期状态变化 |
| `message.delta` | 稳定的助手内容关联、增量内容和顺序，不依赖网络到达顺序 |
| `message.completed` | 助手消息完成及与 delta 的合并关系 |
| `tool.started` | 工具调用 ID、工具名和可展示输入 |
| `tool.output` | 工具输出分块、顺序和截断标记 |
| `tool.completed` | 工具成功/失败及最终状态 |
| `run.completed` | `succeeded/failed/cancelled/interrupted` 等明确状态及错误摘要 |
| `desktop.status` | Mac Agent、SDK、Runtime 和在线状态，不使用会话 seq |
| `command.result` | 命令首次结果或重复结果 |
| `error` | 非命令归属的结构化控制面错误 |

### 8.5 为后续 spec 预留的类型

S00 只注册名称和所属对象，不在没有 SDK/交互证据时过度冻结完整 payload：

- S02：`workspace.list`、`session.create`、`session.resume`、`session.archive`、`queue.remove`、`run.queued`、`run.started`；
- S03：`permission.requested`、`permission.respond`、`permission.resolved`；
- S04：`session.sync`、快照分页和 `RESYNC_REQUIRED`；
- S05：主协议仍只使用 `prompt.send`，ASR partial/final 不进入 Claude 会话事件流。

这些预留不构成对应功能已经实现的声明。

### 8.6 版本协商

S00 定义握手需要交换的数据，不实现 WSS 服务：

- App 在认证后的连接上发送 `connection.hello`，携带 `supportedProtocolVersions`、设备标识、App 版本和客户端能力；
- Mac Agent 返回 `connection.ready`，携带选定的 `protocolVersion`、`desktopId`、Agent/SDK/Runtime 版本和服务端能力；
- 握手包含随机握手 ID，用于关联日志，不作为设备认证凭证；
- 不兼容时返回 `error` 和 `VERSION_INCOMPATIBLE`，然后关闭连接；握手与控制消息不占用会话 seq。

规则：

- 同一大版本内优先采用向后兼容的可选字段扩展。
- 不兼容时不能继续创建 run。
- 首版协议不允许客户端通过握手声明获得更高工具权限或任意工作目录；能力协商只声明协议和展示能力。

### 8.7 错误码与限制基线

S00 至少注册：

- 通用：`UNAUTHENTICATED`、`FORBIDDEN`、`RATE_LIMITED`、`INVALID_MESSAGE`、`UNKNOWN_MESSAGE_TYPE`、`INTERNAL_ERROR`；
- 项目与会话：`WORKSPACE_NOT_ALLOWED`、`SESSION_BUSY`、`RUN_NOT_ACTIVE`；
- 同步：`RESYNC_REQUIRED`；
- 版本：`VERSION_INCOMPATIBLE`；
- 后续审批：`APPROVAL_EXPIRED`、`APPROVAL_ALREADY_RESOLVED`；
- 语音：`ASR_PROVIDER_ERROR`，只用于未来 Mac 代理或控制面错误，不替代 App 本地录音错误。

S00 只给出后续实现可调整的初始限制建议：控制消息 64 KiB、工具输出单块不超过 32 KiB、prompt 明确长度上限、快照分页。真正默认值由 S01/S04 根据实测确定。

### 8.8 协议测试

| ID | 验证项 | PASS 标准 |
|---|---|---|
| PROTO-01 | 合法样例 | 所有 S01 命令、结果和事件样例通过 schema |
| PROTO-02 | 必填字段 | 缺 protocolVersion/messageId/type/payload 等字段被拒绝 |
| PROTO-03 | 条件关联 | prompt/cancel/tool/approval 等样例缺少对应对象 ID 时被拒绝 |
| PROTO-04 | 类型与格式 | 错误类型、负 seq、非法 timestamp、未知错误结构被拒绝 |
| PROTO-05 | 未知字段/类型 | 可选扩展字段可兼容；未知类型不会被误处理 |
| PROTO-06 | 重复命令 | 同样例展示原 commandId、首次结果和 duplicate 结果，语义一致 |
| PROTO-07 | 排序去重 | 同样例证明按 eventId 去重、按 sessionId+seq 排序，而非 timestamp |
| PROTO-08 | 错误安全 | 错误样例不包含密钥、请求头或完整敏感环境变量 |
| PROTO-09 | S01 流程覆盖 | schema 能表达启动会话、两轮 prompt、工具、取消和错误流程 |
| PROTO-10 | 后续扩展 | S02–S05 预留类型不与 S01 字段语义冲突 |
| PROTO-11 | 连接握手 | hello/ready 能选择协议版本并交换版本能力；不兼容返回 VERSION_INCOMPATIBLE，不能创建 run |

保留的 schema 验证代码和测试需要全部通过，核心校验逻辑覆盖率不低于 80%；throwaway spike 不纳入覆盖率要求。

## 9. 工作流 C：豆包 ASR 配置与契约预留

### 9.1 当前边界

本阶段没有豆包凭证，因此只完成：

- 配置占位和Secret边界；
- Provider 中立接口与状态机；
- 基于 fake Provider 的契约测试；
- 真实联调前置清单。

不通过猜测官方 API 来声明豆包已经兼容，也不要求现在购买或开通服务。

### 9.2 配置占位

建议的环境配置名称如下，最终必填项在真实联调前按豆包官方文档调整：

```text
ASR_PROVIDER=doubao
DOUBAO_ASR_APP_ID=
DOUBAO_ASR_ACCESS_TOKEN=
DOUBAO_ASR_RESOURCE_ID=
DOUBAO_ASR_ENDPOINT=
DOUBAO_ASR_MODEL=
```

约束：

- 只提交 `.example` 或文档占位，不提交真实值。
- 长期凭证只由 Mac 保存，不能通过协议返回 App。
- `DOUBAO_ASR_ENDPOINT` 不应被 App 任意覆盖；未来 Mac 代理只允许连接配置的受信服务地址。
- 是否还需要其他豆包字段、这些字段如何映射到具体语音产品，均标记为 `TO_VERIFY_WITH_OFFICIAL_DOCS`。
- 音频基线为 16 kHz、单声道、PCM16；若实际服务要求不同，Provider 负责转码或封装，不改变主控制协议。

### 9.3 Provider 中立语义

接口能力：

```text
start(config) -> stream handle
write(handle, audio chunk)
finalize(handle) -> final transcript or error
cancel(handle)
```

事件：

```text
asr.started
asr.partial(transcript, sequence)
asr.final(transcript, sequence)
asr.error(code, retryable, safeMessage)
asr.cancelled
asr.closed
```

状态机：

```text
idle → connecting → recording → finalizing → completed
                   │             │
                   └─────────────┴→ cancelled
任意非终态 → error
```

规则：

- partial 只用于展示，可以更新或撤销；final 才是进入输入框的候选文本。
- cancel 后到达的 partial/final 必须按 stream ID 丢弃。
- finalize 超时或没有 final 时返回明确错误，不自动生成空 prompt。
- 每个音频流有独立 `asrStreamId`，与 `commandId` 分离。
- 只有用户确认文本后才创建 `prompt.send`；重试沿用同一 `commandId`。
- ASR 不调用 Claude Agent SDK，不修改 prompt 语义，不处理工具审批。

### 9.4 Fake Provider 契约测试

| ID | 场景 | PASS 标准 |
|---|---|---|
| ASR-01 | 正常 partial/final | partial 顺序可见，final 唯一，状态进入 completed |
| ASR-02 | 用户取消 | cancel 后不再接受结果，状态为 cancelled |
| ASR-03 | Provider 错误 | 返回安全错误码，不泄露密钥，不影响文字输入 |
| ASR-04 | finalize 无结果 | 超时/空结果被显式处理，不生成 prompt |
| ASR-05 | 乱序或迟到事件 | 旧 sequence 和旧 stream ID 不覆盖新状态 |
| ASR-06 | 重复 final | 同一 stream 只产生一个待确认文本，不自动发送 |
| ASR-07 | 配置缺失 | 缺少必需配置时 fail fast，错误只指出字段名 |
| ASR-08 | 主协议隔离 | fake ASR 事件不改变 prompt.send schema 和会话 seq |

### 9.5 S05 前必须完成的真实联调

以下项目当前统一标为 `NOT_RUN / DEFERRED_TO_BEFORE_S05`：

- 根据官方文档确定具体豆包流式语音产品和 API；
- 开通服务并安全保存凭证；
- 验证鉴权、音频格式、partial/final、cancel、超时和限流；
- 判断是否存在适合 iOS 的短期凭证；若没有，确定 Mac 代理；
- 验证一段中文语音的实际结果和错误路径；
- 更新配置字段、资源 ID 和 endpoint，不保留猜测值。

该清单未完成时，S05 不得标记为可验收，但 S01–S04 可以继续。

## 10. 执行顺序

1. **固定版本与文档依据** → 验证：环境矩阵可复现，选项名有当前官方文档来源。
2. **建立隔离 fixture 和脱敏规则** → 验证：不包含个人项目、密钥或全局配置修改。
3. **执行 SDK-01–SDK-12** → 验证：每项有状态、事件摘要和限制说明。
4. **执行 CLI-01–CLI-03** → 验证：双向恢复证据完整，一侧退出后再由另一侧恢复。
5. **根据真实事件完成协议 V1** → 验证：PROTO-01–PROTO-11 全部通过。
6. **完成 ASR 配置与 fake 契约** → 验证：ASR-01–ASR-08 全部通过，真实联调明确 deferred。
7. **汇总 exit report** → 验证：所有 FAIL/BLOCKED/LIMITED 均有结论，没有隐式跳过。

协议草案可在 SDK 测试期间并行记录，但冻结前必须使用真实观察到的事件校对，不能完全脱离 SDK 行为设计。

## 11. S00 退出门禁

### 11.1 S00 Core：解锁 S01 的必要条件

必须同时满足：

- 环境、版本和配置来源记录完整且无敏感信息；
- SDK-01–SDK-12 全部为 PASS，或用户对明确记录的 LIMITATIONS 作出书面架构决策；
- CLI-01 与 CLI-02 双向恢复均为 PASS；
- CLI-03 的限制已经记录，不影响受管会话方案；
- 自定义网关请求归因达到 SDK-03 的最低证据要求；
- 协议 V1 的 S01 schema、示例和语义测试全部通过；
- 至少一次权限允许、一次拒绝、一次主动中断和一次显式恢复成功；
- 未开启全局 `bypassPermissions`，未修改真实项目或全局配置；
- exit report 明确写出“可以进入 S01”或“需要调整架构”。

如果双向恢复被固定版本官方明确不支持，则不能简单勾选通过；需要回到架构层决定是否放弃跨入口恢复，只支持 SDK 受管会话，并更新上游 spec。

### 11.2 ASR Contract：当前可完成条件

- 配置示例不含真实凭证；
- Provider 中立状态、事件和 stream ID 语义完整；
- ASR-01–ASR-08 fake 契约测试通过；
- 真实豆包项目全部明确标记为 deferred；
- S05 前置条件可追踪。

### 11.3 ASR Live：延迟门禁

真实豆包联调不是本次 S00 Core 的完成条件，但必须在 S05 实施前完成。报告不得把 `NOT_RUN` 转换成 `PASS`。

## 12. 最终交付物

- 环境及版本矩阵；
- 脱敏后的 settings 加载与自定义网关归因报告；
- Agent SDK 测试记录和事件样例；
- CLI ↔ SDK 双向会话恢复报告；
- 中断、拒绝和恢复行为的限制说明；
- 协议 V1 文档、JSON Schema、合法/非法样例及测试结果；
- ASR 配置示例、Provider 契约、fake 测试和真实联调清单；
- S00 exit report，明确 Core gate、ASR live gate 和所有遗留风险。

## 13. 留给实现者的事项

以下不需要用户继续决策：

- UUID/ULID 生成库、测试运行器和 JSON Schema 校验库；
- spike 的具体文件拆分与命令行参数；
- 在不泄露敏感信息的前提下选择网关日志或 Runtime 调试日志作为归因证据；
- 无害测试项目中的具体源码与标记文本；
- SDK 选项的准确拼写和当前版本调用方式，以固定版本官方文档为准；
- ASR fake 的实现语言，优先复用 TypeScript 契约测试环境；
- 协议样例中的具体 ID 字符串和脱敏形式。

实现者不得自行改变的事项：

- 不依赖 cc-switch；
- 不取消 CLI ↔ SDK 双向恢复验证；
- 不把真实豆包联调提前宣称为完成；
- 不把 throwaway 代码直接纳入正式产品；
- 不放宽密钥、权限、隔离和证据要求。

## 14. 完成后的下一步

S00 详细设计确认后，下一步是编写具体实施计划，再按测试先行方式执行验证与协议 schema 工作。S00 Core 通过后进入 S01；ASR live gate 在 S05 前单独关闭。
