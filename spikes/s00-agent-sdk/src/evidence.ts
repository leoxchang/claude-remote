import { fileURLToPath } from 'node:url';

import {
  EvidenceRecord,
  writeEvidence as writeSharedEvidence,
} from '../../../scripts/s00/evidence.js';

/** SDK 场景可用的上下文：fixture 路径与共享证据写入器。 */
export interface ScenarioContext {
  fixtureRoot: string;
  writeEvidence(record: EvidenceRecord): Promise<string>;
}

/** 构造指向隔离 fixture 和共享脱敏证据层的上下文。 */
export function createScenarioContext(): ScenarioContext {
  return {
    fixtureRoot: fileURLToPath(new URL('../fixture/', import.meta.url)),
    writeEvidence: (record) => writeSharedEvidence(record),
  };
}