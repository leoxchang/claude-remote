import { SqliteTransaction } from '../storage/unit-of-work.js';

const NEXT_ENQUEUE_ORDER = 'nextEnqueueOrder';

/** 持久队尾序号；只在调用方事务内递增。 */
export function nextEnqueueOrder(tx: SqliteTransaction): number {
  const row = tx
    .prepare('SELECT value FROM scheduler_meta WHERE key = ?')
    .get(NEXT_ENQUEUE_ORDER) as { value: string } | undefined;
  const next = Number(row?.value ?? '0') + 1;
  tx.prepare(
    `INSERT INTO scheduler_meta (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  ).run(NEXT_ENQUEUE_ORDER, String(next));
  return next;
}