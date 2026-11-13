import { readdirSync, readFileSync } from 'node:fs';
import { basename, join, relative } from 'node:path';

/** 一处疑似泄漏；只记录文件、行号和类别，不记录命中内容。 */
export interface SecretFinding {
  file: string;
  line: number;
  kind: string;
}

const PATTERNS: ReadonlyArray<{ kind: string; pattern: RegExp }> = [
  { kind: 'anthropic-key', pattern: /sk-ant-[A-Za-z0-9_-]{20,}/ },
  { kind: 'bearer-token', pattern: /\bBearer\s+[A-Za-z0-9._~+/=-]{20,}/ },
  {
    kind: 'private-key',
    pattern: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
  },
  { kind: 'aws-key', pattern: /\bAKIA[0-9A-Z]{16}\b/ },
  { kind: 'absolute-private-path', pattern: /\/private\/[A-Za-z0-9._-]+/ },
  { kind: 'absolute-home-path', pattern: /\/Users\/[A-Za-z0-9._-]+/ },
  { kind: 'literal-token', pattern: /\btoken=[A-Za-z0-9._-]{3,}/i },
  {
    kind: 'approval-body',
    pattern: /\bworkingDirectory=\/(?:private|Users|home)\//,
  },
  {
    // 分成两段拼接，避免扫描器源码命中自身规则。
    kind: 'queued-prompt-text',
    pattern: new RegExp(['queued prompt', 'text'].join(' '), 'i'),
  },
];

const SKIP_DIRECTORIES = new Set([
  'node_modules',
  '.git',
  'coverage',
  'build',
  '.dart_tool',
  'Pods',
  '.serena',
  '.superpowers',
  'superpowers',
]);

const TEXT_EXTENSIONS = new Set([
  '.ts',
  '.dart',
  '.json',
  '.md',
  '.yaml',
  '.yml',
  '.plist',
  '.sh',
]);

const GENERATED_FILES = new Set(['flutter_export_environment.sh']);

/** 构建工具生成、已被 gitignore 的文件；其中的本机路径不算泄漏。 */
export function isGeneratedFile(name: string): boolean {
  return GENERATED_FILES.has(name);
}

/** 扫描单个文本，返回所有命中。 */
export function scanText(file: string, text: string): SecretFinding[] {
  const findings: SecretFinding[] = [];
  const lines = text.split('\n');
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? '';
    for (const { kind, pattern } of PATTERNS) {
      if (pattern.test(line)) findings.push({ file, line: index + 1, kind });
    }
  }
  return findings;
}

/** 断言一段文本不含 secret、真实绝对路径、审批正文或排队正文。 */
export function checkSecrets(text: string): void {
  if (scanText('input', text).length > 0) {
    throw new Error('SECRET_DETECTED');
  }
}

/** 递归扫描目录树，跳过依赖、构建产物和测试夹具。 */
export function scanTree(root: string): SecretFinding[] {
  const findings: SecretFinding[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIP_DIRECTORIES.has(entry.name) || entry.name === 'tests') continue;
      findings.push(...scanTree(join(root, entry.name)));
      continue;
    }
    if (entry.name.endsWith('.test.ts')) continue;
    if (isGeneratedFile(entry.name)) continue;
    if (!TEXT_EXTENSIONS.has(extensionOf(entry.name))) continue;
    const path = join(root, entry.name);
    findings.push(
      ...scanText(relative(root, path) || path, readFileSync(path, 'utf8')),
    );
  }
  return findings;
}

function extensionOf(name: string): string {
  const index = basename(name).lastIndexOf('.');
  return index < 0 ? '' : name.slice(index);
}