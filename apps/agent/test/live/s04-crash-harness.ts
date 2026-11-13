import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const SQLITE_MODULE = require.resolve('better-sqlite3');

const CHILD = String.raw`
const Database = require(process.env.S04_SQLITE_MODULE);
const db = new Database(process.env.S04_DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
const scenario = process.env.S04_SCENARIO;
db.exec("CREATE TABLE IF NOT EXISTS crash_marker (id TEXT PRIMARY KEY)");
if (scenario === 'before-commit') {
  db.exec('BEGIN IMMEDIATE');
  db.prepare('INSERT INTO crash_marker (id) VALUES (?)').run('uncommitted');
  process.exit(9);
}
db.prepare('INSERT INTO crash_marker (id) VALUES (?)').run('committed');
process.exit(0);
`;

/** 独立 child process 在 commit 前/后退出；返回退出码。 */
export function runCrashScenario(
  scenario: 'before-commit' | 'after-commit',
  dbPath: string,
): number {
  try {
    execFileSync(process.execPath, ['-e', CHILD], {
      env: {
        ...process.env,
        S04_SQLITE_MODULE: SQLITE_MODULE,
        S04_SCENARIO: scenario,
        S04_DB_PATH: dbPath,
      },
      stdio: 'ignore',
    });
    return 0;
  } catch (error: unknown) {
    return (error as { status?: number }).status ?? -1;
  }
}