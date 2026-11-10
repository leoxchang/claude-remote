import { AdapterEvent } from '../events/adapter-events.js';

/** 启动一次 run 所需的全部输入。 */
export interface StartRunInput {
  sessionId: string;
  claudeSessionId: string | null;
  runId: string;
  text: string;
  cwd: string;
  onEvent: (event: AdapterEvent) => void;
}

/** 一次 run 的句柄；终态后必须 close。 */
export interface AgentRunHandle {
  interrupt(): Promise<void>;
  close(): void;
}

/** SDK 中立驱动接口；只有 Adapter 实现真实 SDK。 */
export interface AgentDriver {
  startRun(input: StartRunInput): Promise<AgentRunHandle>;
}