import { MessageEnvelope } from '@claude-remote/protocol/types';

/** session.snapshot 事件；payload 由 SnapshotFactory 填充。 */
export interface SessionSnapshotEvent extends MessageEnvelope {
  type: 'session.snapshot';
  payload: Record<string, unknown>;
}