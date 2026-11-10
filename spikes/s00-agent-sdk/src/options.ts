import { Options, SettingSource } from '@anthropic-ai/claude-agent-sdk';
import { fileURLToPath } from 'node:url';

/** 隔离 fixture 的绝对路径。 */
export const FIXTURE_ROOT = fileURLToPath(new URL('../fixture/', import.meta.url));

/** 与 CLI 默认一致的完整设置来源。 */
export const FULL_SETTING_SOURCES: SettingSource[] = ['user', 'project', 'local'];

/** 统一 SDK 选项：固定 cwd、轮次上限、权限模式、设置来源和 claude_code preset。 */
export function createBaseOptions(
  fixtureRoot: string,
  overrides: Partial<Options> = {},
): Options {
  return {
    cwd: fixtureRoot,
    maxTurns: 6,
    permissionMode: 'default',
    persistSession: true,
    includePartialMessages: true,
    settingSources: [...FULL_SETTING_SOURCES],
    systemPrompt: { type: 'preset', preset: 'claude_code' },
    tools: { type: 'preset', preset: 'claude_code' },
    ...overrides,
  };
}