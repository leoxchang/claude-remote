import { mkdirSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { randomBase64Url } from '../security/random.js';

/** 允许上传的图片类型；与手机端选择器保持一致。 */
export type ImageMediaType = 'image/jpeg' | 'image/png' | 'image/webp';

/** 单张图片上限 8 MiB。 */
export const MAX_ATTACHMENT_BYTES = 8 * 1024 * 1024;

/** 单次 prompt 最多 4 张图片。 */
export const MAX_ATTACHMENTS_PER_PROMPT = 4;

/** 未被任何 run 引用的图片保留 7 天。 */
const ATTACHMENT_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const ATTACHMENT_ID_BYTES = 12;

const ATTACHMENT_ID_PATTERN = /^att_[A-Za-z0-9_-]{8,64}$/;

const RUN_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

const MEDIA_EXTENSION: Record<ImageMediaType, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
};

/** 上传成功后返回给手机的引用。 */
export interface AttachmentRef {
  attachmentId: string;
  mediaType: ImageMediaType;
  size: number;
}

/** 已落盘、可交给 SDK 的一张图片。 */
export interface RunAttachment {
  path: string;
  mediaType: ImageMediaType;
}

/** prompt 里声明的图片引用；只接受白名单字段。 */
export interface AttachmentRequest {
  attachmentId: string;
  mediaType: ImageMediaType;
  size: number;
}

interface ManifestEntry {
  file: string;
  mediaType: ImageMediaType;
}

/**
 * 手机上传的图片只保存在本机配置目录，按 run 建立清单。
 *
 * run 执行时由 adapter 读取清单并转成图片内容块，因此 queued run
 * 与重启后的恢复都不依赖手机再次上传。
 */
export class AttachmentStore {
  private readonly filesDir: string;
  private readonly runsDir: string;

  constructor(private readonly rootDir: string) {
    this.filesDir = join(rootDir, 'files');
    this.runsDir = join(rootDir, 'runs');
  }

  /** 校验并保存一张图片；返回给手机的引用不含本机路径。 */
  save(input: {
    deviceId: string;
    mediaType: ImageMediaType;
    bytes: Buffer;
  }): AttachmentRef {
    if (input.bytes.length === 0 || input.bytes.length > MAX_ATTACHMENT_BYTES) {
      throw new Error('invalid attachment size');
    }
    if (!matchesMediaType(input.bytes, input.mediaType)) {
      throw new Error('attachment content does not match media type');
    }
    mkdirSync(this.filesDir, { recursive: true, mode: 0o700 });
    this.prune();
    const attachmentId = `att_${randomBase64Url(ATTACHMENT_ID_BYTES)}`;
    const file = `${attachmentId}.${MEDIA_EXTENSION[input.mediaType]}`;
    writeFileSync(join(this.filesDir, file), input.bytes, { mode: 0o600 });
    return {
      attachmentId,
      mediaType: input.mediaType,
      size: input.bytes.length,
    };
  }

  /** 校验手机声明的引用确实存在；不匹配时整条命令按 INVALID_MESSAGE 处理。 */
  resolve(requests: readonly AttachmentRequest[]): RunAttachment[] {
    if (requests.length > MAX_ATTACHMENTS_PER_PROMPT) {
      throw new Error('too many attachments');
    }
    return requests.map((request) => {
      if (
        !ATTACHMENT_ID_PATTERN.test(request.attachmentId) ||
        request.mediaType === undefined ||
        request.size <= 0 ||
        request.size > MAX_ATTACHMENT_BYTES
      ) {
        throw new Error('invalid attachment reference');
      }
      const file = `${request.attachmentId}.${MEDIA_EXTENSION[request.mediaType]}`;
      const path = join(this.filesDir, file);
      const stat = statSync(path);
      if (stat.size !== request.size) throw new Error('attachment size mismatch');
      return { path, mediaType: request.mediaType };
    });
  }

  /** 把已接受的图片写到 run 清单；重复命令覆盖同一份清单。 */
  linkRun(runId: string, attachments: readonly RunAttachment[]): void {
    if (!RUN_ID_PATTERN.test(runId)) throw new Error('invalid run id');
    if (attachments.length === 0) return;
    mkdirSync(this.runsDir, { recursive: true, mode: 0o700 });
    const entries: ManifestEntry[] = attachments.map((attachment) => ({
      file: attachment.path.slice(this.filesDir.length + 1),
      mediaType: attachment.mediaType,
    }));
    writeFileSync(
      join(this.runsDir, `${runId}.json`),
      JSON.stringify({ version: 1, attachments: entries }),
      { mode: 0o600 },
    );
  }

  /** 同步读取 run 清单；文件缺失或损坏时按无图片启动。 */
  loadForRun(runId: string): RunAttachment[] {
    if (!RUN_ID_PATTERN.test(runId)) return [];
    let raw: string;
    try {
      raw = readFileSync(join(this.runsDir, `${runId}.json`), 'utf8');
    } catch {
      return [];
    }
    try {
      const parsed: unknown = JSON.parse(raw);
      if (typeof parsed !== 'object' || parsed === null) return [];
      const entries = (parsed as { attachments?: unknown }).attachments;
      if (!Array.isArray(entries)) return [];
      const result: RunAttachment[] = [];
      for (const entry of entries) {
        if (typeof entry !== 'object' || entry === null) continue;
        const file = (entry as { file?: unknown }).file;
        const mediaType = (entry as { mediaType?: unknown }).mediaType;
        if (
          typeof file !== 'string' ||
          file.length === 0 ||
          file.includes('/') ||
          file.includes('\\') ||
          !isImageMediaType(mediaType)
        ) {
          continue;
        }
        const path = join(this.filesDir, file);
        try {
          statSync(path);
        } catch {
          continue;
        }
        result.push({ path, mediaType });
      }
      return result;
    } catch {
      return [];
    }
  }

  /** 清掉超过保留期的图片；每次上传时顺带执行，避免后台任务。 */
  prune(now: number = Date.now()): void {
    this.pruneDir(this.filesDir, now);
    this.pruneDir(this.runsDir, now);
  }

  private pruneDir(dir: string, now: number): void {
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of names) {
      const path = join(dir, name);
      try {
        if (now - statSync(path).mtimeMs > ATTACHMENT_TTL_MS) unlinkSync(path);
      } catch {
        // 并发删除或文件消失都不影响本次上传。
      }
    }
  }
}

/** 只做格式白名单检查，不解码图片内容。 */
export function isImageMediaType(value: unknown): value is ImageMediaType {
  return (
    value === 'image/jpeg' || value === 'image/png' || value === 'image/webp'
  );
}

function matchesMediaType(bytes: Buffer, mediaType: ImageMediaType): boolean {
  if (mediaType === 'image/jpeg') {
    return bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  }
  if (mediaType === 'image/png') {
    return (
      bytes.length > 8 &&
      bytes[0] === 0x89 &&
      bytes[1] === 0x50 &&
      bytes[2] === 0x4e &&
      bytes[3] === 0x47 &&
      bytes[4] === 0x0d &&
      bytes[5] === 0x0a &&
      bytes[6] === 0x1a &&
      bytes[7] === 0x0a
    );
  }
  return (
    bytes.length > 12 &&
    bytes.toString('ascii', 0, 4) === 'RIFF' &&
    bytes.toString('ascii', 8, 12) === 'WEBP'
  );
}