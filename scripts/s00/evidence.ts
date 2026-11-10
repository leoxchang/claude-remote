import { mkdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** 每个测试 ID 唯一允许的状态。 */
export type EvidenceStatus = 'PASS' | 'FAIL' | 'BLOCKED' | 'NOT_RUN' | 'LIMITED';

/** 一条脱敏后的测试证据。 */
export interface EvidenceRecord {
  id: string;
  status: EvidenceStatus;
  summary: string;
  observedAt: string | null;
  data?: unknown;
  deferredTo?: 'S05';
  evidence?: string;
}

const REDACTED_PLACEHOLDER = '[REDACTED]';
const EVIDENCE_ID_PATTERN = /^(SDK|CLI|PROTO|ASR)-\d{2}$/;
const URL_PATTERN = /https?:\/\/[^\s"'<>]+/gi;
const MAX_DEPTH = 20;
const MIN_SECRET_LENGTH = 8;

const DEFAULT_EVIDENCE_ROOT = fileURLToPath(
  new URL('../../docs/s00/evidence/', import.meta.url),
);

const SENSITIVE_KEY_EXACT_NAMES = new Set([
  'authorization',
  'proxyauthorization',
  'cookie',
  'setcookie',
  'headers',
  'auth',
  'credential',
  'credentials',
]);

const SENSITIVE_KEY_SUFFIXES = [
  'token',
  'secret',
  'password',
  'passwd',
  'apikey',
  'accesskey',
  'privatekey',
  'credential',
];

/** 递归脱敏证据，返回全新副本，绝不修改输入。 */
export function redactEvidence(
  value: unknown,
  secrets: readonly string[] = [],
): unknown {
  return redactValue(value, sanitizeSecrets(secrets), 0);
}

/** 校验 ID 后把脱敏证据写入 `<root>/<id>.json`，返回写入路径。 */
export async function writeEvidence(
  record: EvidenceRecord,
  root: string = DEFAULT_EVIDENCE_ROOT,
): Promise<string> {
  assertEvidenceId(record.id);

  const secrets = collectSensitiveEnvValues(process.env);
  const redacted = redactEvidence(record, secrets);
  const serialized = `${JSON.stringify(redacted, null, 2)}\n`;
  assertNoLeakedSecret(serialized, secrets);

  await mkdir(root, { recursive: true });
  const target = join(root, `${record.id}.json`);
  await writeFile(target, serialized, { encoding: 'utf8', mode: 0o600 });
  return target;
}

/** 只允许形如 SDK-01 / PROTO-11 的测试 ID，防止路径穿越。 */
export function assertEvidenceId(id: string): void {
  if (!EVIDENCE_ID_PATTERN.test(id)) {
    throw new Error(
      `Invalid evidence id "${id}": expected SDK|CLI|PROTO|ASR-<2 digits>`,
    );
  }
}

function sanitizeSecrets(secrets: readonly string[]): string[] {
  return secrets.filter((secret) => secret.length >= MIN_SECRET_LENGTH);
}

function collectSensitiveEnvValues(
  env: Readonly<Record<string, string | undefined>>,
): string[] {
  const values: string[] = [];
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined || value.length < MIN_SECRET_LENGTH) continue;
    if (isSensitiveKey(key)) values.push(value);
  }
  return values;
}

function isSensitiveKey(key: string): boolean {
  const normalized = key.toLowerCase().replace(/[-_]/g, '');
  if (SENSITIVE_KEY_EXACT_NAMES.has(normalized)) return true;
  return SENSITIVE_KEY_SUFFIXES.some((suffix) => normalized.endsWith(suffix));
}

function redactValue(
  value: unknown,
  secrets: readonly string[],
  depth: number,
): unknown {
  if (depth > MAX_DEPTH) return REDACTED_PLACEHOLDER;
  if (typeof value === 'string') return redactString(value, secrets);
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) {
    return value.map((item) => redactValue(item, secrets, depth + 1));
  }
  if (value === null || typeof value !== 'object') {
    return typeof value === 'function' || typeof value === 'symbol'
      ? REDACTED_PLACEHOLDER
      : value;
  }

  const redacted: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    redacted[key] = isSensitiveKey(key)
      ? REDACTED_PLACEHOLDER
      : redactValue(entry, secrets, depth + 1);
  }
  return redacted;
}

function redactString(value: string, secrets: readonly string[]): string {
  let result = value;
  for (const secret of secrets) {
    result = result.split(secret).join(REDACTED_PLACEHOLDER);
  }
  result = result.replace(URL_PATTERN, redactUrl);
  const home = homedir();
  if (home.length > 0) result = result.split(home).join('~');
  return result;
}

function redactUrl(rawUrl: string): string {
  try {
    return `${new URL(rawUrl).origin}/`;
  } catch {
    return REDACTED_PLACEHOLDER;
  }
}

function assertNoLeakedSecret(
  serialized: string,
  secrets: readonly string[],
): void {
  const leaked = secrets.some((secret) => serialized.includes(secret));
  if (leaked) {
    throw new Error('Refusing to write evidence: a sensitive value survived');
  }
}