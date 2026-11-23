import { mkdtemp, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { createFileLogger } from '../src/app/logger.js';

function parseJson(text: string): unknown {
  return JSON.parse(text) as unknown;
}

describe('file logger rotation', () => {
  it('rotates when the current file reaches maxBytes', async () => {
    const directory = await mkdtemp(join(tmpdir(), 's06-log-'));
    const logFile = join(directory, 'agent.log');
    const logger = createFileLogger(logFile, { maxBytes: 120, keepFiles: 2 });

    for (let index = 0; index < 20; index += 1) {
      logger.info('test.event', { index });
    }

    const current = await readFile(logFile, 'utf8');
    const rotated = await readFile(`${logFile}.1`, 'utf8');
    expect(rotated.length).toBeGreaterThan(0);
    expect(current.length).toBeGreaterThan(0);

    const firstLine = rotated.split('\n')[0] ?? '';
    expect(parseJson(firstLine)).toMatchObject({
      level: 'info',
      event: 'test.event',
    });

    await expect(stat(`${logFile}.3`)).rejects.toThrow();
  });

  it('keeps writing when rotation is not yet needed', async () => {
    const directory = await mkdtemp(join(tmpdir(), 's06-log-small-'));
    const logFile = join(directory, 'agent.log');
    const logger = createFileLogger(logFile, { maxBytes: 1_000_000 });

    logger.warn('small.event', { value: 1 });

    const lines = (await readFile(logFile, 'utf8')).trim().split('\n');
    expect(lines).toHaveLength(1);
    expect(parseJson(lines[0] ?? '')).toMatchObject({
      level: 'warn',
      event: 'small.event',
      value: 1,
    });
  });
});