import { Options } from '@anthropic-ai/claude-agent-sdk';

/** S00 验证过的完整设置来源。 */
const SETTING_SOURCES = ['user', 'project', 'local'] as const;

/** 静态 query options；调用方在其上追加 persistSession、canUseTool、resume 等 run 级字段。 */
export function baseQueryOptions(cwd: string): Options {
  return {
    cwd,
    permissionMode: 'default',
    settingSources: [...SETTING_SOURCES],
    systemPrompt: { type: 'preset', preset: 'claude_code' },
    tools: { type: 'preset', preset: 'claude_code' },
  };
}
