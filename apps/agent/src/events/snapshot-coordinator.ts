import { RunRecord, SessionRecord } from '../domain/types.js';
import { SessionSnapshotEvent } from '../session/session-controller.js';
import { EventJournal } from './journal.js';
import { SnapshotFactory } from './snapshot-factory.js';

/** 快照协调器依赖；发送动作由连接层提供。 */
export interface SnapshotCoordinatorDependencies {
  journal: EventJournal;
  getSession: (sessionId: string) => SessionRecord;
  getActiveRun: (sessionId: string) => RunRecord | null;
  send: (snapshot: SessionSnapshotEvent, connectionEpoch: number) => void;
}

/**
 * 在同一同步临界区内捕获并发送快照，
 * 之后追加的事件一定排在快照之后。
 */
export class SnapshotCoordinator {
  private readonly factory = new SnapshotFactory();

  constructor(private readonly deps: SnapshotCoordinatorDependencies) {}

  /** 捕获当前状态并发送；返回快照与它覆盖到的 lastSeq。 */
  async captureAndSend(
    sessionId: string,
    connectionEpoch: number,
  ): Promise<{ snapshot: SessionSnapshotEvent; lastSeq: number }> {
    const snapshot = this.factory.create({
      session: this.deps.getSession(sessionId),
      activeRun: this.deps.getActiveRun(sessionId),
      journal: this.deps.journal,
    });
    this.deps.send(snapshot, connectionEpoch);
    return { snapshot, lastSeq: snapshot.payload['lastSeq'] as number };
  }
}