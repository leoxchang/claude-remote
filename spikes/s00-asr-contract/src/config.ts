import { AsrConfig } from './types.js';

const REQUIRED_FIELDS = [
  'ASR_PROVIDER',
  'DOUBAO_ASR_APP_ID',
  'DOUBAO_ASR_ACCESS_TOKEN',
  'DOUBAO_ASR_RESOURCE_ID',
  'DOUBAO_ASR_ENDPOINT',
] as const;

const SUPPORTED_PROVIDER = 'doubao';

/** 解析配置，缺项时 fail fast；错误信息只包含字段名，绝不包含已存在的值。 */
export function parseAsrConfig(env: NodeJS.ProcessEnv): AsrConfig {
  const missing = REQUIRED_FIELDS.filter(
    (field) => (env[field] ?? '').trim().length === 0,
  );
  if (missing.length > 0) {
    throw new Error(`Missing ASR config: ${missing.join(', ')}`);
  }

  const provider = env['ASR_PROVIDER'];
  if (provider !== SUPPORTED_PROVIDER) {
    throw new Error(
      `Unsupported ASR_PROVIDER (expected ${SUPPORTED_PROVIDER})`,
    );
  }

  const model = env['DOUBAO_ASR_MODEL'];
  return {
    provider: SUPPORTED_PROVIDER,
    appId: requireValue(env, 'DOUBAO_ASR_APP_ID'),
    accessToken: requireValue(env, 'DOUBAO_ASR_ACCESS_TOKEN'),
    resourceId: requireValue(env, 'DOUBAO_ASR_RESOURCE_ID'),
    endpoint: requireValue(env, 'DOUBAO_ASR_ENDPOINT'),
    ...(model !== undefined && model.trim().length > 0 ? { model } : {}),
  };
}

function requireValue(env: NodeJS.ProcessEnv, field: string): string {
  const value = (env[field] ?? '').trim();
  if (value.length === 0) {
    throw new Error(`Missing ASR config: ${field}`);
  }
  return value;
}