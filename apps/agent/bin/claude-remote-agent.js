#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// 开发期入口：用 tsx 加载 TypeScript 源码；工作目录设为包根以解析 tsx。
const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const entry = join(packageRoot, 'src', 'main.ts');
const result = spawnSync(
  process.execPath,
  ['--import', 'tsx', entry, ...process.argv.slice(2)],
  { cwd: packageRoot, stdio: 'inherit' },
);
process.exit(result.status ?? 1);