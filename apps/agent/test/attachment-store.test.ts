import { mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  AttachmentStore,
  MAX_ATTACHMENTS_PER_PROMPT,
} from '../src/attachment/attachment-store.js';

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
const PNG = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00,
]);

const roots: string[] = [];

function makeStore(): { attachments: AttachmentStore; root: string } {
  const root = mkdtempSync(join(tmpdir(), 's06-attachments-'));
  roots.push(root);
  return { attachments: new AttachmentStore(root), root };
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('AttachmentStore', () => {
  it('saves a jpeg and returns an opaque reference', () => {
    const { attachments } = makeStore();

    const saved = attachments.save({
      deviceId: 'device_1',
      mediaType: 'image/jpeg',
      bytes: JPEG,
    });

    expect(saved.attachmentId).toMatch(/^att_[A-Za-z0-9_-]+$/);
    expect(saved.mediaType).toBe('image/jpeg');
    expect(saved.size).toBe(JPEG.length);
    expect(JSON.stringify(saved)).not.toContain(tmpdir());
  });

  it('rejects bytes that do not match the declared type', () => {
    const { attachments } = makeStore();

    expect(() =>
      attachments.save({
        deviceId: 'device_1',
        mediaType: 'image/png',
        bytes: JPEG,
      }),
    ).toThrow();
  });

  it('links attachments to a run and reads them back', () => {
    const { attachments } = makeStore();
    const saved = attachments.save({
      deviceId: 'device_1',
      mediaType: 'image/png',
      bytes: PNG,
    });
    const resolved = attachments.resolve([saved]);

    attachments.linkRun('run_01', resolved);

    const loaded = attachments.loadForRun('run_01');
    expect(loaded).toHaveLength(1);
    expect(loaded[0]?.mediaType).toBe('image/png');
    expect(statSync(loaded[0]?.path ?? '').size).toBe(PNG.length);
  });

  it('rejects a reference whose size does not match the file', () => {
    const { attachments } = makeStore();
    const saved = attachments.save({
      deviceId: 'device_1',
      mediaType: 'image/jpeg',
      bytes: JPEG,
    });

    expect(() =>
      attachments.resolve([{ ...saved, size: saved.size + 1 }]),
    ).toThrow();
  });

  it('rejects unknown ids and too many attachments', () => {
    const { attachments } = makeStore();
    const saved = attachments.save({
      deviceId: 'device_1',
      mediaType: 'image/jpeg',
      bytes: JPEG,
    });

    expect(() =>
      attachments.resolve([{ ...saved, attachmentId: 'att_doesnotexist' }]),
    ).toThrow();
    expect(() =>
      attachments.resolve(
        Array.from({ length: MAX_ATTACHMENTS_PER_PROMPT + 1 }, () => saved),
      ),
    ).toThrow();
  });

  it('returns no attachments for an unknown run', () => {
    expect(makeStore().attachments.loadForRun('run_missing')).toEqual([]);
  });

  it('ignores a corrupt run manifest', () => {
    const { attachments, root } = makeStore();
    const saved = attachments.save({
      deviceId: 'device_1',
      mediaType: 'image/jpeg',
      bytes: JPEG,
    });
    attachments.linkRun('run_02', attachments.resolve([saved]));
    writeFileSync(join(root, 'runs', 'run_02.json'), '{not json');

    expect(attachments.loadForRun('run_02')).toEqual([]);
  });

  it('drops attachments that outlive the retention window', () => {
    const { attachments, root } = makeStore();
    attachments.save({
      deviceId: 'device_1',
      mediaType: 'image/jpeg',
      bytes: JPEG,
    });

    attachments.prune(Date.now() + 8 * 24 * 60 * 60 * 1000);

    expect(readdirSync(join(root, 'files'))).toEqual([]);
  });
});