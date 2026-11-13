import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';

import { AgentError } from '../command/errors.js';
import { migrateConfigV2ToV3, isMobileApprovalMode } from '../config/config-v3.js';
import {
  AgentConfigV4,
  DEFAULT_DATABASE_FILE,
  readConfigV4IfExists,
  writeConfigV4AtomicSync,
} from '../config/config-v4.js';
import { CONFIG_FILE_MODE, resolveAgentPaths } from '../config/paths.js';
import { DeviceRecord } from '../domain/types.js';
import { WorkspaceRecord } from '../workspace/workspace-types.js';
import { UnitOfWork } from './unit-of-work.js';

/** 迁移状态机；只允许这三个值。 */
export type MigrationState = 'absent' | 'database_committed' | 'completed';

export interface SourceHashes {
  config: string;
  devices: string | null;
}

export interface MigrationHooks {
  afterDatabaseCommit?: () => void;
  afterV4Write?: () => void;
}

export interface MigrationInput {
  configDir: string;
  uow: UnitOfWork;
  sourceHashes: SourceHashes;
  now: number;
  hooks?: MigrationHooks;
}

export interface MigrationResult {
  state: MigrationState;
  imported: boolean;
  counts: { workspaces: number; devices: number };
}

interface Sources {
  workspaces: WorkspaceRecord[];
  devices: DeviceRecord[];
  v4: AgentConfigV4;
}

/**
 * V3/devices 两阶段迁移。
 *
 * DB 导入单事务提交后，才写 0600 备份与 V4；来源哈希决定恢复或拒绝，
 * 任何不完整状态都 fail closed。
 */
export function migrateV3Sources(input: MigrationInput): MigrationResult {
  const paths = resolveAgentPaths(input.configDir);
  const state = readMigrationState(input.uow);
  const existingV4 = readConfigV4IfExists(input.configDir);

  if (existingV4 !== null) {
    if (state === 'completed') {
      return {
        state,
        imported: false,
        counts: countRows(input.uow),
      };
    }
    if (state === 'database_committed') {
      finishPhaseTwo(input, existingV4);
      return {
        state: 'completed',
        imported: false,
        counts: countRows(input.uow),
      };
    }
    throw new AgentError('STORAGE_MIGRATION_CONFLICT');
  }

  const configText = readRequired(paths.agentFile);
  if (hash(configText) !== input.sourceHashes.config) {
    throw new AgentError('STORAGE_MIGRATION_CONFLICT');
  }
  const devicesText = existsSync(paths.devicesFile)
    ? readFileSync(paths.devicesFile, 'utf8')
    : null;
  if (
    (devicesText === null ? null : hash(devicesText)) !==
    input.sourceHashes.devices
  ) {
    throw new AgentError('STORAGE_MIGRATION_CONFLICT');
  }

  const sources = parseSources(configText, devicesText);
  if (state === 'completed') {
    throw new AgentError('STORAGE_MIGRATION_CONFLICT');
  }

  if (state === 'absent') {
    const expected = countRows(input.uow);
    if (expected.workspaces > 0 || expected.devices > 0) {
      throw new AgentError('STORAGE_MIGRATION_CONFLICT');
    }
    insertSources(input, sources);
    input.hooks?.afterDatabaseCommit?.();
    verifyCounts(input.uow, sources);
    backupFile(paths.agentFile, `${paths.agentFile}.v3.pre-sqlite.bak`);
    if (devicesText !== null) {
      backupFile(paths.devicesFile, `${paths.devicesFile}.pre-sqlite.bak`);
    }
    writeConfigV4AtomicSync(input.configDir, sources.v4);
    input.hooks?.afterV4Write?.();
    markCompleted(input, sources.v4.desktopId);
    return {
      state: 'completed',
      imported: true,
      counts: countRows(input.uow),
    };
  }

  // state === 'database_committed'：DB 已有相同来源，只完成第二段。
  verifyCounts(input.uow, sources);
  backupFile(paths.agentFile, `${paths.agentFile}.v3.pre-sqlite.bak`);
  if (devicesText !== null) {
    backupFile(paths.devicesFile, `${paths.devicesFile}.pre-sqlite.bak`);
  }
  writeConfigV4AtomicSync(input.configDir, sources.v4);
  input.hooks?.afterV4Write?.();
  markCompleted(input, sources.v4.desktopId);
  return {
    state: 'completed',
    imported: false,
    counts: countRows(input.uow),
  };
}

export function sha256Text(text: string): string {
  return hash(text);
}

function readMigrationState(uow: UnitOfWork): MigrationState {
  const row = uow.connectionRef
    .prepare('SELECT migrationState FROM schema_meta WHERE id = 1')
    .get() as { migrationState?: string } | undefined;
  const state = row?.migrationState;
  if (
    state !== 'absent' &&
    state !== 'database_committed' &&
    state !== 'completed'
  ) {
    throw new AgentError('STORAGE_MIGRATION_CONFLICT');
  }
  return state;
}

function parseSources(configText: string, devicesText: string | null): Sources {
  const v3 = migrateConfigV2ToV3(JSON.parse(configText));
  const workspaces = v3.workspaces.map((workspace) => {
    if (
      typeof workspace.rootPath !== 'string' ||
      !isMobileApprovalMode(workspace.policy.mobileApprovalMode)
    ) {
      throw new AgentError('STORAGE_MIGRATION_CONFLICT');
    }
    return {
      workspaceId: workspace.workspaceId,
      displayName: workspace.displayName,
      rootPath: workspace.rootPath,
      createdAt: workspace.createdAt,
      policy: {
        perSessionQueueLimit: workspace.policy.perSessionQueueLimit,
        mobileApprovalMode: workspace.policy.mobileApprovalMode,
      },
    };
  });
  return {
    workspaces,
    devices: devicesText === null ? [] : parseDevices(devicesText),
    v4: {
      version: 4,
      desktopId: v3.desktopId,
      database: { file: DEFAULT_DATABASE_FILE },
      listen: v3.listen,
      tailscale: v3.tailscale,
    },
  };
}

function parseDevices(text: string): DeviceRecord[] {
  const parsed: unknown = JSON.parse(text);
  if (typeof parsed !== 'object' || parsed === null) {
    throw new AgentError('STORAGE_MIGRATION_CONFLICT');
  }
  const devices = (parsed as { devices?: unknown }).devices;
  if (!Array.isArray(devices)) {
    throw new AgentError('STORAGE_MIGRATION_CONFLICT');
  }
  return devices.map((entry) => {
    if (typeof entry !== 'object' || entry === null) {
      throw new AgentError('STORAGE_MIGRATION_CONFLICT');
    }
    const record = entry as Partial<DeviceRecord>;
    if (
      typeof record.deviceId !== 'string' ||
      typeof record.deviceName !== 'string' ||
      typeof record.tokenHash !== 'string' ||
      typeof record.createdAt !== 'string'
    ) {
      throw new AgentError('STORAGE_MIGRATION_CONFLICT');
    }
    const createdAt = Date.parse(record.createdAt);
    if (Number.isNaN(createdAt)) {
      throw new AgentError('STORAGE_MIGRATION_CONFLICT');
    }
    return {
      deviceId: record.deviceId,
      deviceName: record.deviceName,
      tokenHash: record.tokenHash,
      createdAt: record.createdAt,
      revokedAt: record.revokedAt ?? null,
    };
  });
}

function insertSources(input: MigrationInput, sources: Sources): void {
  input.uow.immediate((tx) => {
    const workspaceInsert = tx.prepare(
      `INSERT INTO workspaces
         (workspaceId, displayName, rootPath, perSessionQueueLimit,
          mobileApprovalMode, createdAt, removedAt)
       VALUES (?, ?, ?, ?, ?, ?, NULL)`,
    );
    for (const workspace of sources.workspaces) {
      workspaceInsert.run(
        workspace.workspaceId,
        workspace.displayName,
        workspace.rootPath,
        workspace.policy.perSessionQueueLimit,
        workspace.policy.mobileApprovalMode,
        workspace.createdAt,
      );
    }
    const deviceInsert = tx.prepare(
      `INSERT INTO devices (deviceId, deviceName, tokenHash, status, createdAt, revokedAt)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    for (const device of sources.devices) {
      const revokedAt =
        device.revokedAt === null ? null : Date.parse(device.revokedAt);
      deviceInsert.run(
        device.deviceId,
        device.deviceName,
        device.tokenHash,
        device.revokedAt === null ? 'active' : 'revoked',
        Date.parse(device.createdAt),
        revokedAt,
      );
    }
    const sourceInsert = tx.prepare(
      'INSERT INTO migration_sources (sourceType, sourceHash, migratedAt) VALUES (?, ?, ?)',
    );
    sourceInsert.run('agent_config', input.sourceHashes.config, input.now);
    if (input.sourceHashes.devices !== null) {
      sourceInsert.run('devices', input.sourceHashes.devices, input.now);
    }
    tx.prepare(
      `UPDATE schema_meta
       SET migrationState = 'database_committed', desktopId = ?, updatedAt = ?
       WHERE id = 1`,
    ).run(sources.v4.desktopId, input.now);
  });
}

function finishPhaseTwo(input: MigrationInput, v4: AgentConfigV4): void {
  markCompleted(input, v4.desktopId);
}

function markCompleted(input: MigrationInput, desktopId: string): void {
  input.uow.immediate((tx) => {
    tx.prepare(
      `UPDATE schema_meta SET migrationState = 'completed', desktopId = ?, updatedAt = ?
       WHERE id = 1`,
    ).run(desktopId, input.now);
  });
}

function verifyCounts(uow: UnitOfWork, sources: Sources): void {
  const counts = countRows(uow);
  if (
    counts.workspaces !== sources.workspaces.length ||
    counts.devices !== sources.devices.length
  ) {
    throw new AgentError('STORAGE_MIGRATION_CONFLICT');
  }
}

function countRows(uow: UnitOfWork): { workspaces: number; devices: number } {
  const workspaces = uow.connectionRef
    .prepare('SELECT count(*) AS total FROM workspaces')
    .get() as { total: number };
  const devices = uow.connectionRef
    .prepare('SELECT count(*) AS total FROM devices')
    .get() as { total: number };
  return { workspaces: workspaces.total, devices: devices.total };
}

function readRequired(path: string): string {
  if (!existsSync(path)) throw new AgentError('STORAGE_MIGRATION_CONFLICT');
  return readFileSync(path, 'utf8');
}

function backupFile(source: string, destination: string): void {
  if (existsSync(destination)) return;
  writeFileSync(destination, readFileSync(source), {
    mode: CONFIG_FILE_MODE,
  });
  chmodSync(destination, CONFIG_FILE_MODE);
}

function hash(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}