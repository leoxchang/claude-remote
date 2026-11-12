import { AdapterEvent } from '../events/adapter-events.js';

/** 启动一次受管 run 的全部输入；句柄必须同步返回。 */
export interface ManagedRunStart {
  sessionId: string;
  workspaceId: string;
  claudeSessionId: string | null;
  runId: string;
  adapterGeneration: number;
  text: string;
  cwd: string;
  onEvent: (event: AdapterEvent) => void;
}

/** 一次 run 的同步句柄；事件在 resumeEvents 后交付。 */
export interface ManagedRunHandle {
  interrupt(): Promise<void>;
  close(): Promise<void>;
  resumeEvents(): void;
}

/** SDK 中立驱动；只有 Adapter 实现真实 SDK。 */
export interface ManagedRunDriver {
  startRun(input: ManagedRunStart): ManagedRunHandle;
}