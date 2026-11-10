import { chmod, open, readFile, rename, rm } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

/** 原子写入文件：写同目录临时文件、落盘、设权限，再 rename 覆盖。 */
export async function writeFileAtomic(
  path: string,
  content: string,
  mode: number,
): Promise<void> {
  const tempPath = join(
    dirname(path),
    `.${basename(path)}.${process.pid}.tmp`,
  );
  try {
    const handle = await open(tempPath, 'w');
    try {
      await handle.writeFile(content, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    await chmod(tempPath, mode);
    await rename(tempPath, path);
  } catch (error: unknown) {
    await rm(tempPath, { force: true });
    throw error;
  }
}

/** 读取并解析 JSON；文件不存在时返回 undefined。 */
export async function readJsonFileIfExists(
  path: string,
): Promise<unknown | undefined> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (error: unknown) {
    if (isMissingFile(error)) return undefined;
    throw error;
  }
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    throw new Error(`${basename(path)} is not valid JSON`);
  }
}

function isMissingFile(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === 'ENOENT'
  );
}