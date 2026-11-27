import { Options, SDKUserMessage, query } from '@anthropic-ai/claude-agent-sdk';

import { baseQueryOptions } from '../adapter/query-options.js';
import {
  ModelCatalogService,
  ModelOption,
  ModelQueryFactory,
  ModelQueryHandle,
} from './model-catalog.js';

/** 目录缓存有效期；TTL 过期后重新向 SDK 查询。 */
const DEFAULT_TTL_MS = 10 * 60 * 1000;

/** 目录缓存条目：查询时间戳 + 过滤后的模型列表。 */
interface CacheEntry {
  at: number;
  models: ModelOption[];
}

/** 只保留协议层关心的四个字段；丢弃 SDK 的扩展字段。 */
function toModelOption(row: ModelOption): ModelOption {
  return {
    value: row.value,
    displayName: row.displayName,
    description: row.description,
    ...(row.resolvedModel === undefined ? {} : { resolvedModel: row.resolvedModel }),
  };
}

/**
 * 永不 resolve、永不 yield 的 prompt；配合 Streaming Input 让 query
 * 在不发送任何用户消息的情况下可调用 supportedModels()。
 * 2026-11-27 已实测该方式能返回完整模型清单。
 */
async function* idleInput(): AsyncGenerator<SDKUserMessage> {
  await new Promise<never>(() => undefined);
}

/** 默认目录查询：新建一个挂起的 query，直接读它的模型清单。 */
function defaultQueryFactory(cwd: string): ModelQueryHandle {
  const options: Options = baseQueryOptions(cwd);
  const q = query({ prompt: idleInput(), options });
  return {
    supportedModels: () => q.supportedModels(),
    close: () => {
      q.close();
    },
  };
}

/** 基于 SDK supportedModels() 的模型目录服务；按 cwd 缓存，TTL 10 分钟。 */
export class SdkModelCatalog implements ModelCatalogService {
  private readonly cache = new Map<string, CacheEntry>();
  private readonly queryFactory: ModelQueryFactory;
  private readonly now: () => number;
  private readonly ttlMs: number;

  constructor(
    options: {
      queryFactory?: ModelQueryFactory;
      now?: () => number;
      ttlMs?: number;
    } = {},
  ) {
    this.queryFactory = options.queryFactory ?? defaultQueryFactory;
    this.now = options.now ?? (() => Date.now());
    this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
  }

  /** 返回该 cwd 可用的模型；`value === 'default'` 的行被丢弃。 */
  async list(cwd: string): Promise<ModelOption[]> {
    const cached = this.cache.get(cwd);
    const at = this.now();
    if (cached !== undefined && at - cached.at < this.ttlMs) {
      return cached.models;
    }
    const handle = this.queryFactory(cwd);
    try {
      const rows = await handle.supportedModels();
      const models = rows
        .filter((row) => row.value !== 'default')
        .map(toModelOption);
      this.cache.set(cwd, { at, models });
      return models;
    } finally {
      handle.close();
    }
  }
}
