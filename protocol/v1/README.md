# 协议 V1（S00 基线）

本目录是 S00 冻结的协议契约，供 S01–S05 共同使用。S00 只定义契约，不实现 Mac Agent 服务。

## 公共信封

所有消息必填：`protocolVersion: 1`、`messageId`、`timestamp`（Unix epoch 毫秒）、`type`、`payload`。

- `commandId` / `traceId`：所有命令及其 `command.result` 必填。
- `eventId` / `seq`：所有会话时间线事件必填，`seq` 从 `1` 开始、同一 `sessionId` 内逐事件加 1。
- `command.result`、握手（`connection.hello` / `connection.ready`）、`desktop.status` 和非时间线 `error` **不占用**会话 `seq`。
- 时间戳、到达顺序和 Relay 都不是排序依据；排序只用 `sessionId + seq`。

## 语义要点

1. **`command.result` 不代表 run 成功。** 它只表示命令已被接受或同步完成。
2. **run 的最终状态只由 `run.completed` 表达**：`succeeded / failed / cancelled / interrupted`。
3. **未知可选字段可以忽略**：payload 不禁止额外字段，同大版本内只允许向后兼容的扩展。
4. **未知类型必须安全拒绝**：返回 `UNKNOWN_MESSAGE_TYPE`，不能把它当成其他类型处理；校验错误只暴露 `instancePath` 与 `keyword`，绝不回显输入值或密钥。
5. **握手不协商权限或 cwd**：`connection.hello/ready` 只交换协议版本、设备标识、版本信息和展示能力，不能通过握手获得更高工具权限或任意工作目录。两个方向都必须携带同一个随机 `handshakeId`，`connection.ready` 原样回显 `connection.hello` 的值，仅用于日志关联，不作为认证凭证。
6. **重传与去重**：同一 `eventId` 只保留一份；同 `eventId` 不同内容、同 `seq` 不同 `eventId`、混入不同 `sessionId` 均视为 `PROTOCOL_CONFLICT`（见 `src/timeline.ts`）。
7. **重复命令**：重传使用相同 `commandId/traceId`、不同 `messageId`，第二次 `command.result.duplicate = true`，不得执行第二次业务操作。

## 错误码基线

S00 注册以下稳定错误码（`src/errors.ts` 的 `ERROR_CODES`），客户端逻辑只依赖 `code`，不解析 `message`：

| 分组 | 错误码 |
|---|---|
| 通用 | `UNAUTHENTICATED`、`FORBIDDEN`、`RATE_LIMITED`、`INVALID_MESSAGE`、`UNKNOWN_MESSAGE_TYPE`、`INTERNAL_ERROR` |
| 项目/会话 | `WORKSPACE_NOT_ALLOWED`、`SESSION_BUSY`、`RUN_NOT_ACTIVE` |
| 同步 | `RESYNC_REQUIRED` |
| 版本 | `VERSION_INCOMPATIBLE` |
| 审批（S03） | `APPROVAL_EXPIRED`、`APPROVAL_ALREADY_RESOLVED` |
| 语音（S05） | `ASR_PROVIDER_ERROR` |

## 版本

- S00 固定 `protocolVersion = 1`。
- 不兼容时返回 `error` + `VERSION_INCOMPATIBLE` 并关闭连接，不能继续创建 run（见 `src/handshake.ts`）。
- S02–S05 预留类型名见 `src/types.ts` 的 `RESERVED_MESSAGE_TYPES`，V1 校验器会按未知类型安全拒绝。

## 文件

| 文件 | 内容 |
|---|---|
| `envelope.schema.json` | 公共信封与 `$defs.envelope` |
| `commands.schema.json` | `session.start`、`prompt.send`、`run.cancel`、`session.snapshot`（命令）、`command.result` |
| `events.schema.json` | 时间线事件、`session.snapshot`（事件）、`desktop.status`、握手、`error` |
| `examples/valid.json` | 合法命令/结果/事件样例（含重复命令） |
| `examples/invalid.json` | 非法样例及预期校验关键字 |
| `examples/flows.json` | S01 主流程与握手流程 |
| `src/validator.ts` | Ajv 2020-12 校验与安全错误映射 |
| `src/timeline.ts` | 不可变去重、排序与冲突检测 |
| `src/handshake.ts` | 版本选择 |

## 测试身份

`PROTO-01`–`PROTO-11` 的状态与证据见 `docs/s00/status.json` 和 `docs/s00/evidence/`。
覆盖面：合法样例、必填字段、条件关联、类型与格式、未知类型、重复命令、排序去重、错误安全、S01 流程、后续扩展、连接握手。

## 覆盖率

`scripts/s00/` 与 `protocol/v1/src/` 的 statements/branches/functions/lines 均要求 ≥ 80%（`npm run test:coverage`）。