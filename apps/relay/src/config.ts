/** Relay 运行时配置；全部来自环境变量，缺省为本地开发值。 */
export interface RelayConfig {
  host: string;
  port: number;
  dataDir: string;
}

const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 8788;
const DEFAULT_DATA_DIR = './data';
const MIN_PORT = 0;
const MAX_PORT = 65535;

/** 解析环境变量；非法端口抛 INVALID_CONFIG。 */
export function loadConfig(
  env: Record<string, string | undefined>,
): RelayConfig {
  const host = env['RELAY_HOST'] ?? DEFAULT_HOST;
  const rawPort = env['RELAY_PORT'] ?? String(DEFAULT_PORT);
  const port = Number(rawPort);
  if (!Number.isInteger(port) || port < MIN_PORT || port > MAX_PORT) {
    throw new Error('INVALID_CONFIG');
  }
  const dataDir = env['RELAY_DATA_DIR'] ?? DEFAULT_DATA_DIR;
  return { host, port, dataDir };
}