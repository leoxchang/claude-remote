import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

import {
  DoctorCheck,
  DoctorReport,
  DoctorCommandRunner,
  runDoctor,
} from '../src/diagnostics/doctor.js';

const BASE_URL = 'https://macbook.example-tailnet.ts.net';

async function tempDir(prefix: string): Promise<string> {
  return mkdtemp(join(tmpdir(), prefix));
}

async function writeV4Config(directory: string): Promise<void> {
  await writeFile(
    join(directory, 'agent.json'),
    JSON.stringify({
      version: 4,
      desktopId: 'desktop_test',
      database: { file: 'agent.sqlite3' },
      listen: { host: '127.0.0.1', port: 8787 },
      tailscale: { baseUrl: BASE_URL },
    }),
  );
}

function createDatabase(path: string): void {
  const database = new Database(path);
  database.exec('CREATE TABLE sample (id INTEGER PRIMARY KEY)');
  database.close();
}

function check(report: DoctorReport, id: string): DoctorCheck {
  const found = report.checks.find((entry) => entry.id === id);
  if (found === undefined) throw new Error(`missing check ${id}`);
  return found;
}

describe('doctor', () => {
  it('reports a missing config as a failure', async () => {
    const directory = await tempDir('s06-doctor-empty-');
    const report = await runDoctor({ configDir: directory, platform: 'linux' });

    expect(check(report, 'config').status).toBe('fail');
    expect(report.ok).toBe(false);
  });

  it('passes config, storage and versions with a healthy database', async () => {
    const directory = await tempDir('s06-doctor-ok-');
    await writeV4Config(directory);
    createDatabase(join(directory, 'agent.sqlite3'));

    const report = await runDoctor({ configDir: directory, platform: 'linux' });

    expect(check(report, 'config').status).toBe('pass');
    expect(check(report, 'storage').status).toBe('pass');
    expect(check(report, 'versions').status).toBe('pass');
    expect(check(report, 'agent').status).toBe('warn');
    expect(report.ok).toBe(true);
  });

  it('fails storage when the database is corrupt', async () => {
    const directory = await tempDir('s06-doctor-corrupt-');
    await writeV4Config(directory);
    await writeFile(join(directory, 'agent.sqlite3'), 'not a database');

    const report = await runDoctor({ configDir: directory, platform: 'linux' });

    expect(check(report, 'storage').status).toBe('fail');
    expect(report.ok).toBe(false);
  });

  it('fails endpoint when Funnel is enabled', async () => {
    const directory = await tempDir('s06-doctor-funnel-');
    await writeV4Config(directory);
    createDatabase(join(directory, 'agent.sqlite3'));
    const runCommand: DoctorCommandRunner = async (_command, args) =>
      args[0] === 'serve'
        ? 'https://macbook.example-tailnet.ts.net'
        : 'Funnel on: https://macbook.example-tailnet.ts.net';

    const report = await runDoctor({
      configDir: directory,
      platform: 'darwin',
      runCommand,
    });

    expect(check(report, 'endpoint').status).toBe('fail');
    expect(report.ok).toBe(false);
  });

  it('accepts Serve endpoint when Funnel is disabled', async () => {
    const directory = await tempDir('s06-doctor-serve-');
    await writeV4Config(directory);
    createDatabase(join(directory, 'agent.sqlite3'));
    const runCommand: DoctorCommandRunner = async (_command, args) =>
      args[0] === 'serve'
        ? 'https://macbook.example-tailnet.ts.net'
        : 'Funnel is not enabled on this machine.';

    const report = await runDoctor({
      configDir: directory,
      platform: 'darwin',
      runCommand,
    });

    expect(check(report, 'endpoint').status).toBe('pass');
    expect(report.ok).toBe(true);
  });

  it('warns when Serve is not configured or the endpoint check fails', async () => {
    const directory = await tempDir('s06-doctor-serve-missing-');
    await writeV4Config(directory);
    createDatabase(join(directory, 'agent.sqlite3'));
    const noServe: DoctorCommandRunner = async () => 'No serve config';
    const failing: DoctorCommandRunner = async () => {
      throw new Error('tailscale stopped');
    };

    const noServeReport = await runDoctor({
      configDir: directory,
      platform: 'darwin',
      runCommand: noServe,
    });
    const failingReport = await runDoctor({
      configDir: directory,
      platform: 'darwin',
      runCommand: failing,
    });

    expect(check(noServeReport, 'endpoint').status).toBe('warn');
    expect(check(failingReport, 'endpoint').status).toBe('warn');
    expect(noServeReport.ok).toBe(true);
    expect(failingReport.ok).toBe(true);
  });

  it('passes the log check once a log file exists', async () => {
    const directory = await tempDir('s06-doctor-log-');
    await writeV4Config(directory);
    createDatabase(join(directory, 'agent.sqlite3'));
    await writeFile(join(directory, 'agent.log'), '{"event":"started"}\n');

    const report = await runDoctor({ configDir: directory, platform: 'linux' });

    expect(check(report, 'log').status).toBe('pass');
  });

  it('accepts an unmigrated V3 config', async () => {
    const directory = await tempDir('s06-doctor-v3-');
    await writeFile(
      join(directory, 'agent.json'),
      JSON.stringify({
        version: 3,
        desktopId: 'desktop_test',
        workspaces: [],
        listen: { host: '127.0.0.1', port: 8787 },
        tailscale: { baseUrl: BASE_URL },
      }),
    );

    const report = await runDoctor({ configDir: directory, platform: 'linux' });

    expect(check(report, 'config').status).toBe('pass');
    expect(check(report, 'config').detail).toContain('migration');
  });

  it('runs the system endpoint command when no runner is injected', async () => {
    const directory = await tempDir('s06-doctor-default-');
    await writeV4Config(directory);
    createDatabase(join(directory, 'agent.sqlite3'));

    const report = await runDoctor({ configDir: directory, platform: 'darwin' });

    expect(report.checks.some((entry) => entry.id === 'endpoint')).toBe(true);
  });
});