/** 协议公共信封：所有消息必填字段。 */
export interface MessageEnvelope {
  protocolVersion: 1;
  messageId: string;
  timestamp: number;
  type: string;
  payload: unknown;
}

/** command.result 的 payload。 */
export interface CommandResultPayload {
  status: 'ok' | 'error';
  duplicate: boolean;
  data?: Record<string, unknown>;
  error?: {
    code: string;
    message: string;
    retryable: boolean;
    details?: Record<string, unknown>;
  };
}

/** 客户端命令：commandId 与 traceId 必填。 */
export interface CommandMessage extends MessageEnvelope {
  commandId: string;
  traceId: string;
  sessionId?: string;
  workspaceId?: string;
  runId?: string;
  approvalId?: string;
  /** 发送命令的设备 ID；schema 要求必填，这里保留可选以兼容只读场景。 */
  sourceDeviceId?: string;
}

/** 命令结果：与命令共享 commandId/traceId，不占用会话 seq。 */
export interface CommandResultMessage extends MessageEnvelope {
  commandId: string;
  traceId: string;
  payload: CommandResultPayload;
}

/** 会话时间线事件：eventId/sessionId/seq 必填，seq 从 1 开始。 */
export interface EventMessage extends MessageEnvelope {
  eventId: string;
  sessionId: string;
  seq: number;
  runId?: string;
  approvalId?: string;
}

/** 握手、桌面状态和非时间线错误等控制消息。 */
export interface ControlMessage extends MessageEnvelope {}

/** 协议 V1 消息联合类型。 */
export type ProtocolMessage =
  | CommandMessage
  | CommandResultMessage
  | EventMessage
  | ControlMessage;

/**
 * 尚未实现的预留类型名：不在 V1 实现，
 * 必须与已实现字段语义不冲突（由 PROTO-10 测试锁定）。
 */
export const RESERVED_MESSAGE_TYPES: readonly string[] = ['asr.transcribe'];