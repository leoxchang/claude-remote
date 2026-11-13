/**
 * S05 ASR 配置：固定 endpoint 与允许的 resourceId。
 *
 * 只在调用时读取进程环境，不在模块加载时读取；API Key 不进入日志或错误。
 */
import { AsrError } from './asr-protocol.js';

/** 固定官方 endpoint；不接受 App 或普通配置覆盖。 */
export const DOUBAO_ASR_ENDPOINT =
  'wss://openspeech.bytedance.com/api/v3/sauc/bigmodel_async';

/** 允许的 resourceId。 */
export type AsrResourceId =
  | 'volc.seedasr.sauc.duration'
  | 'volc.seedasr.sauc.concurrent';

/** 默认 resourceId。 */
export const DEFAULT_DOUBAO_RESOURCE_ID: AsrResourceId =
  'volc.seedasr.sauc.duration';

/** Provider 配置；只含 Provider 名、Key 与 resourceId。 */
export interface AsrConfig {
  provider: 'doubao';
  apiKey: string;
  resourceId: AsrResourceId;
}

/**
 * 读取配置；缺 Key 返回 null，非法 resourceId 抛 ASR_NOT_CONFIGURED。
 * 错误信息只含固定文案，不回显 Key 或非法值。
 */
export function loadAsrConfig(env: NodeJS.ProcessEnv): AsrConfig | null {
  const apiKey = env['DOUBAO_ASR_API_KEY'];
  if (typeof apiKey !== 'string' || apiKey.length === 0) {
    return null;
  }
  const rawResourceId = env['DOUBAO_ASR_RESOURCE_ID'];
  const resourceId =
    rawResourceId === undefined || rawResourceId.length === 0
      ? DEFAULT_DOUBAO_RESOURCE_ID
      : parseResourceId(rawResourceId);
  return { provider: 'doubao', apiKey, resourceId };
}

function parseResourceId(value: string): AsrResourceId {
  if (
    value === 'volc.seedasr.sauc.duration' ||
    value === 'volc.seedasr.sauc.concurrent'
  ) {
    return value;
  }
  throw new AsrError('ASR_NOT_CONFIGURED', false, 'ASR_NOT_CONFIGURED');
}