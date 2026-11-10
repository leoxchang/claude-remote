/**
 * S00 注册的错误码基线（spec §8.7）。
 * 客户端逻辑只依赖稳定的 code，永远不解析 message 文本。
 */
export const ERROR_CODES = [
  'UNAUTHENTICATED',
  'FORBIDDEN',
  'RATE_LIMITED',
  'INVALID_MESSAGE',
  'UNKNOWN_MESSAGE_TYPE',
  'INTERNAL_ERROR',
  'WORKSPACE_NOT_ALLOWED',
  'SESSION_BUSY',
  'RUN_NOT_ACTIVE',
  'RESYNC_REQUIRED',
  'VERSION_INCOMPATIBLE',
  'APPROVAL_EXPIRED',
  'APPROVAL_ALREADY_RESOLVED',
  'ASR_PROVIDER_ERROR',
] as const;

/** 协议 V1 已注册的错误码。 */
export type ProtocolErrorCode = (typeof ERROR_CODES)[number];