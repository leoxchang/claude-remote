import { SnapshotCoordinator } from '../events/snapshot-coordinator.js';
import { RunController } from '../run/run-controller.js';
import {
  AgentOperations,
  RunAccepted,
  SessionController,
  SessionSnapshotEvent,
  SessionStartResult,
} from '../session/session-controller.js';

/** AgentOperations 的组合实现。 */
export interface AgentOperationsDependencies {
  sessions: SessionController;
  runs: RunController;
  snapshots: SnapshotCoordinator;
  currentEpoch: () => number;
}

/** 把会话、run 与快照组合成命令层可用的操作。 */
export class AgentOperationsImpl implements AgentOperations {
  constructor(private readonly deps: AgentOperationsDependencies) {}

  async startSession(workspaceId: string): Promise<SessionStartResult> {
    const session = await this.deps.sessions.start(workspaceId);
    return {
      sessionId: session.sessionId,
      claudeSessionId: session.claudeSessionId,
      status: session.status,
    };
  }

  sendPrompt(
    sessionId: string,
    text: string,
    commandId: string,
  ): Promise<RunAccepted> {
    return this.deps.runs.sendPrompt(sessionId, text, commandId);
  }

  cancelRun(sessionId: string, runId: string): Promise<RunAccepted> {
    return this.deps.runs.cancel(sessionId, runId);
  }

  async snapshot(sessionId: string): Promise<SessionSnapshotEvent> {
    const { snapshot } = await this.deps.snapshots.captureAndSend(
      sessionId,
      this.deps.currentEpoch(),
    );
    return snapshot;
  }
}