/** Agent 及其依赖的版本；握手、status 与诊断共用同一来源。 */
export interface AgentVersions {
  agent: string;
  sdk: string;
  runtime: string;
  protocol: number;
}

/** 当前协议版本。 */
export const PROTOCOL_VERSION = 1;

/** Agent 包版本；必须与 `apps/agent/package.json` 一致（测试锁定）。 */
export const AGENT_VERSION = '0.0.0';

/** Claude Agent SDK 版本；必须与根 `package.json` 依赖一致（测试锁定）。 */
export const SDK_VERSION = '0.3.319';

/** Claude Code Runtime 版本。 */
export const RUNTIME_VERSION = '2.1.319';

/** 当前 Agent 的完整版本视图。 */
export function agentVersions(): AgentVersions {
  return {
    agent: AGENT_VERSION,
    sdk: SDK_VERSION,
    runtime: RUNTIME_VERSION,
    protocol: PROTOCOL_VERSION,
  };
}