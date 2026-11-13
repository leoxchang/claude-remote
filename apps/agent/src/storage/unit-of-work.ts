import Database from 'better-sqlite3';

import { AgentError } from '../command/errors.js';

/** 事务回调收到的连接；只允许同步 SQL。 */
export type SqliteTransaction = Database.Database;

/**
 * 单 writer 同步事务边界。
 *
 * 回调必须是同步函数：任何 Promise 都表示误用了 SDK/网络操作，
 * 直接拒绝，避免在事务内 await 造成跨连接写。
 */
export class UnitOfWork {
  private inImmediate = false;

  constructor(private readonly connection: Database.Database) {}

  /** 只读访问；仍是同步调用。 */
  read<T>(fn: (tx: SqliteTransaction) => T): T {
    const value = fn(this.connection);
    if (isPromiseLike(value)) {
      throw new AgentError('STORAGE_TRANSACTION_ASYNC');
    }
    return value;
  }

  /** BEGIN IMMEDIATE 写事务；嵌套调用直接失败。 */
  immediate<T>(fn: (tx: SqliteTransaction) => T): T {
    if (this.inImmediate) {
      throw new AgentError('STORAGE_TRANSACTION_NESTED');
    }
    const run = this.connection.transaction(() => {
      const value = fn(this.connection);
      if (isPromiseLike(value)) {
        throw new AgentError('STORAGE_TRANSACTION_ASYNC');
      }
      return value;
    });
    this.inImmediate = true;
    try {
      return run.immediate() as T;
    } finally {
      this.inImmediate = false;
    }
  }

  /** 当前是否在一个写事务内；backup 等异步操作据此拒绝。 */
  get inTransaction(): boolean {
    return this.inImmediate;
  }

  /** 供仓库复用当前事务连接；调用方不得在事务外执行写操作。 */
  get connectionRef(): Database.Database {
    return this.connection;
  }
}

function isPromiseLike(value: unknown): boolean {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { then?: unknown }).then === 'function'
  );
}