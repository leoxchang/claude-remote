import { fileURLToPath } from 'node:url';

import { main } from './cli.js';
import { DEFAULT_CONFIG_DIR } from './config/paths.js';

/** 唯一可执行入口：解析 CLI 并设置退出码。 */
const configDir =
  process.env['CLAUDE_REMOTE_CONFIG_DIR'] ?? DEFAULT_CONFIG_DIR;

process.exitCode = await main(process.argv.slice(2), {
  configDir,
  entryPath: fileURLToPath(import.meta.url),
});