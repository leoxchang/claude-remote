/**
 * S04 复用 S03 的扫描规则；导出保持脚本独立可测试。
 */
export {
  checkSecrets,
  isIgnoredGeneratedFile,
  scanText,
  scanTree,
} from '../s03/check-secrets.js';
export type { SecretFinding } from '../s03/check-secrets.js';
