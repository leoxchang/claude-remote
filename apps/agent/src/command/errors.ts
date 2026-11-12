import { ProtocolErrorCode } from '@claude-remote/protocol/errors';

/** S01 使用的稳定错误码；与协议 V1 注册表一致。 */
export type AgentErrorCode = ProtocolErrorCode;

/** 命令处理失败；调用方只依赖 code。 */
export class AgentError extends Error {
  constructor(
    readonly code: AgentErrorCode,
    message: string = code,
    readonly retryable: boolean = false,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'AgentError';
  }
}