import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';
import {
  CanUseTool,
  Options,
  PermissionResult,
  Query,
  SDKMessage,
  SDKUserMessage,
  SettingSource,
  query,
} from '@anthropic-ai/claude-agent-sdk';

/** 真实 SDK 的单次探测上限。 */
const PROBE_TIMEOUT_MS = 300_000;

/** 与产品 Adapter 相同的设置来源。 */
const SETTING_SOURCES: SettingSource[] = ['user', 'project', 'local'];

/** 全局用户设置；只读哈希，不修改。 */
const GLOBAL_SETTINGS = join(homedir(), '.claude', 'settings.json');

const ALPHA_MARKER = 'S03_PERM00_ALPHA';
const READ_MARKER = 'S03_PERM00_READ_OK';

/** 回调字段是否存在的脱敏观测；不含任何正文。 */
interface PermissionObservation {
  toolName: string;
  inputKeys: string[];
  hasRequestId: boolean;
  hasToolUseID: boolean;
  hasSignal: boolean;
  agentIDPresent: boolean;
  decisionReasonPresent: boolean;
  defaultToNo: boolean | null;
  blockedPathPresent: boolean;
  mcpServerPresent: boolean;
  suggestionsCount: number;
  titlePresent: boolean;
}

/** 一次真实 query 的脱敏报告；不含路径、命令或输入正文。 */
interface ProbeReport {
  label: string;
  order: string[];
  observations: PermissionObservation[];
  terminalSubtype: string | null;
  sawReadMarker: boolean;
  sawAlphaMarker: boolean;
  settingsLocalUnchanged: boolean;
  globalSettingsUnchanged: boolean;
  signalAbortedWhilePending: boolean | null;
  allowReturnedUpdatedInput: boolean | null;
  allowReturnedUpdatedPermissions: boolean | null;
  markerFiles: Record<string, MarkerState>;
}

/** fixture 内固定标记文件的观测。 */
interface MarkerState {
  exists: boolean;
  lineCount: number;
  matchCount: number;
}

interface DecisionContext {
  toolName: string;
  input: Record<string, unknown>;
  toolUseID: string;
  signal: AbortSignal;
  observation: PermissionObservation;
  queryHandle: () => Query | null;
}

interface ProbeInput {
  label: string;
  rules: Record<string, unknown>;
  prompt: string;
  decide: (context: DecisionContext) => Promise<PermissionResult>;
}

interface RunState {
  query: Query | null;
  terminalSubtype: string | null;
  text: string;
  signalAbortedWhilePending: boolean | null;
  allowReturnedUpdatedInput: boolean | null;
  allowReturnedUpdatedPermissions: boolean | null;
}

/** 运行一次真实 SDK query，记录回调与消息顺序。 */
async function runProbe(input: ProbeInput): Promise<ProbeReport> {
  const cwd = await createFixture(input.label, input.rules);
  const settingsLocalPath = join(cwd, '.claude', 'settings.local.json');
  const settingsLocalBefore = await readFile(settingsLocalPath, 'utf8');
  const globalBefore = await hashFile(GLOBAL_SETTINGS);
  const order: string[] = [];
  const observations: PermissionObservation[] = [];
  const state: RunState = {
    query: null,
    terminalSubtype: null,
    text: '',
    signalAbortedWhilePending: null,
    allowReturnedUpdatedInput: null,
    allowReturnedUpdatedPermissions: null,
  };

  const canUseTool: CanUseTool = async (toolName, toolInput, toolOptions) => {
    const observation = observe(toolName, toolInput, toolOptions);
    observations.push(observation);
    order.push(`canUseTool:${toolName}`);
    const result = await input.decide({
      toolName,
      input: toolInput,
      toolUseID: toolOptions.toolUseID,
      signal: toolOptions.signal,
      observation,
      queryHandle: () => state.query,
    });
    state.signalAbortedWhilePending = toolOptions.signal.aborted;
    if (result.behavior === 'allow') {
      state.allowReturnedUpdatedInput = result.updatedInput !== undefined;
      state.allowReturnedUpdatedPermissions =
        result.updatedPermissions !== undefined;
    }
    return result;
  };

  const options: Options = {
    cwd,
    permissionMode: 'default',
    persistSession: false,
    includePartialMessages: false,
    settingSources: SETTING_SOURCES,
    systemPrompt: { type: 'preset', preset: 'claude_code' },
    tools: { type: 'preset', preset: 'claude_code' },
    disallowedTools: ['ToolSearch'],
    canUseTool,
  };

  const handle = query({ prompt: promptStream(input.prompt), options });
  state.query = handle;
  try {
    for await (const message of handle) {
      recordMessage(message, order, state);
    }
  } catch (error: unknown) {
    order.push(`query.error:${classifyQueryError(error)}`);
    state.terminalSubtype = 'error';
  } finally {
    handle.close();
  }

  const settingsLocalAfter = await readFile(settingsLocalPath, 'utf8');
  const globalAfter = await hashFile(GLOBAL_SETTINGS);
  const markerFiles = await readMarkers(cwd);
  await rm(cwd, { recursive: true, force: true });

  return {
    label: input.label,
    order,
    observations,
    terminalSubtype: state.terminalSubtype,
    sawReadMarker: state.text.includes(READ_MARKER),
    sawAlphaMarker: state.text.includes(ALPHA_MARKER),
    settingsLocalUnchanged: settingsLocalBefore === settingsLocalAfter,
    globalSettingsUnchanged: globalBefore === globalAfter,
    signalAbortedWhilePending: state.signalAbortedWhilePending,
    allowReturnedUpdatedInput: state.allowReturnedUpdatedInput,
    allowReturnedUpdatedPermissions: state.allowReturnedUpdatedPermissions,
    markerFiles,
  };
}

/** 只保留错误分类，不回显错误正文。 */
function classifyQueryError(error: unknown): string {
  const message = error instanceof Error ? error.message : '';
  if (message.includes('aborted')) return 'aborted';
  if (message.includes('error result')) return 'error_result';
  return 'unknown';
}

/** 模型偶尔改用其他工具；重试一次，确保 deny 规则确实面对 Bash 调用。 */
async function runBashProbeUntilAttempted(
  input: ProbeInput,
): Promise<ProbeReport> {
  const first = await runProbe(input);
  if (first.order.includes('assistant.tool_use:Bash')) return first;
  return runProbe({ ...input, label: `${input.label}-retry` });
}

const MARKER_FILES = [
  's03-marker.txt',
  's03-denied-marker.txt',
  's03-interrupted-marker.txt',
] as const;

async function readMarkers(cwd: string): Promise<Record<string, MarkerState>> {
  const result: Record<string, MarkerState> = {};
  for (const name of MARKER_FILES) {
    try {
      const content = await readFile(join(cwd, name), 'utf8');
      const lines = content.split('\n');
      result[name] = {
        exists: true,
        lineCount: lines.filter((line) => line.length > 0).length,
        matchCount: lines.filter((line) => line.includes(ALPHA_MARKER)).length,
      };
    } catch {
      result[name] = { exists: false, lineCount: 0, matchCount: 0 };
    }
  }
  return result;
}

function observe(
  toolName: string,
  input: Record<string, unknown>,
  options: {
    signal: AbortSignal;
    requestId: string;
    toolUseID: string;
    agentID?: string;
    decisionReason?: string;
    defaultToNo?: boolean;
    blockedPath?: string;
    mcpServer?: { name: string; source: string };
    suggestions?: unknown[];
    title?: string;
  },
): PermissionObservation {
  return {
    toolName,
    inputKeys: Object.keys(input).sort(),
    hasRequestId:
      typeof options.requestId === 'string' && options.requestId.length > 0,
    hasToolUseID:
      typeof options.toolUseID === 'string' && options.toolUseID.length > 0,
    hasSignal: options.signal instanceof AbortSignal,
    agentIDPresent: typeof options.agentID === 'string',
    decisionReasonPresent: typeof options.decisionReason === 'string',
    defaultToNo:
      typeof options.defaultToNo === 'boolean' ? options.defaultToNo : null,
    blockedPathPresent: typeof options.blockedPath === 'string',
    mcpServerPresent: options.mcpServer !== undefined,
    suggestionsCount: options.suggestions?.length ?? 0,
    titlePresent: typeof options.title === 'string',
  };
}

function recordMessage(
  message: SDKMessage,
  order: string[],
  state: RunState,
): void {
  if (message.type === 'assistant') {
    for (const block of message.message.content) {
      if (block.type === 'tool_use') {
        order.push(`assistant.tool_use:${block.name}`);
      }
      if (block.type === 'text') {
        state.text += block.text;
      }
    }
    return;
  }
  if (message.type === 'user') {
    for (const block of message.message.content) {
      if (typeof block === 'object' && block !== null && block.type === 'tool_result') {
        order.push(`user.tool_result:${block.is_error === true ? 'error' : 'ok'}`);
      }
    }
    return;
  }
  if (message.type === 'result') {
    order.push(`result:${message.subtype}`);
    state.terminalSubtype = message.subtype;
  }
}

async function* promptStream(text: string): AsyncGenerator<SDKUserMessage> {
  yield {
    type: 'user',
    message: { role: 'user', content: text },
    parent_tool_use_id: null,
  };
}

async function createFixture(
  label: string,
  rules: Record<string, unknown>,
): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), `s03-perm00-${label}-`));
  await mkdir(join(root, '.claude'), { recursive: true });
  await writeFile(
    join(root, '.claude', 'settings.local.json'),
    `${JSON.stringify({ permissions: rules }, null, 2)}\n`,
    'utf8',
  );
  await writeFile(join(root, 'note.md'), `${READ_MARKER}\n`, 'utf8');
  return root;
}

async function hashFile(path: string): Promise<string> {
  try {
    return createHash('sha256').update(await readFile(path)).digest('hex');
  } catch {
    return 'missing';
  }
}

/** 等到 signal 中止；超时返回 false，不抛错。 */
function waitForAbort(signal: AbortSignal, timeoutMs: number): Promise<boolean> {
  if (signal.aborted) return Promise.resolve(true);
  return new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => resolve(false), timeoutMs);
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        resolve(true);
      },
      { once: true },
    );
  });
}

function evidence(report: ProbeReport): void {
  process.stdout.write(`S03_PERM00_EVIDENCE ${JSON.stringify(report)}\n`);
}

describe('S03 PERM-00 real SDK permission gate', () => {
  it(
    'skips the callback for a locally allowed Read',
    async () => {
      const allowedRead = await runProbe({
        label: 'allow-read',
        rules: { allow: ['Read'] },
        prompt:
          'Use the Read tool to read the file ./note.md and reply with exactly its contents.',
        decide: async () => {
          throw new Error('Read must not reach canUseTool in this fixture');
        },
      });
      evidence(allowedRead);
      expect(allowedRead.observations).toHaveLength(0);
      expect(allowedRead.order).toContain('assistant.tool_use:Read');
      expect(allowedRead.terminalSubtype).toBe('success');
      expect(allowedRead.sawReadMarker).toBe(true);
      expect(allowedRead.settingsLocalUnchanged).toBe(true);
      expect(allowedRead.globalSettingsUnchanged).toBe(true);
    },
    PROBE_TIMEOUT_MS,
  );

  it(
    'skips the callback for a locally denied Bash',
    async () => {
      const deniedBash = await runBashProbeUntilAttempted({
        label: 'deny-bash',
        rules: { allow: ['Read'], deny: ['Bash(touch:*)'] },
        prompt: [
          'Use the Bash tool to run exactly this command:',
          `touch s03-denied-marker.txt`,
          'Then report its output.',
        ].join(' '),
        decide: async () => {
          throw new Error('Bash must not reach canUseTool in this fixture');
        },
      });
      evidence(deniedBash);
      expect(deniedBash.order).toContain('assistant.tool_use:Bash');
      expect(deniedBash.order).toContain('user.tool_result:error');
      expect(deniedBash.observations).toHaveLength(0);
      expect(deniedBash.markerFiles['s03-denied-marker.txt']?.exists).toBe(
        false,
      );
      expect(deniedBash.terminalSubtype).toBe('success');
      expect(deniedBash.settingsLocalUnchanged).toBe(true);
      expect(deniedBash.globalSettingsUnchanged).toBe(true);
    },
    PROBE_TIMEOUT_MS,
  );

  it(
    'allows an ask Bash with the original input and executes it once',
    async () => {
      const report = await runProbe({
        label: 'allow-bash',
        rules: { allow: ['Read'], ask: ['Bash'] },
        prompt: [
          'Use the Bash tool to run exactly this command:',
          `printf '${ALPHA_MARKER}\\n' >> s03-marker.txt`,
          'Then reply DONE.',
        ].join(' '),
        decide: async (context) => ({
          behavior: 'allow',
          updatedInput: context.input,
          toolUseID: context.toolUseID,
        }),
      });
      evidence(report);
      const observation = report.observations[0];
      expect(observation).toBeDefined();
      expect(observation?.toolName).toBe('Bash');
      expect(observation?.hasRequestId).toBe(true);
      expect(observation?.hasToolUseID).toBe(true);
      expect(observation?.hasSignal).toBe(true);
      expect(report.allowReturnedUpdatedInput).toBe(true);
      expect(report.allowReturnedUpdatedPermissions).toBe(false);
      expect(report.terminalSubtype).toBe('success');
      expect(report.markerFiles['s03-marker.txt']?.matchCount).toBe(1);

      const callbackIndex = report.order.indexOf('canUseTool:Bash');
      const toolUseIndex = report.order.indexOf('assistant.tool_use:Bash');
      expect(toolUseIndex).toBeGreaterThanOrEqual(0);
      expect(callbackIndex).toBeGreaterThan(toolUseIndex);
      expect(report.order).toContain('user.tool_result:ok');
      expect(report.settingsLocalUnchanged).toBe(true);
      expect(report.globalSettingsUnchanged).toBe(true);
    },
    PROBE_TIMEOUT_MS,
  );

  it(
    'denies an ask Bash with interrupt:false and continues the run',
    async () => {
      const report = await runProbe({
        label: 'deny-ask',
        rules: { allow: ['Read'], ask: ['Bash'] },
        prompt: [
          'Use the Bash tool to run exactly this command:',
          `touch s03-denied-marker.txt`,
          `Then reply DONE ${ALPHA_MARKER}.`,
        ].join(' '),
        decide: async (context) => ({
          behavior: 'deny',
          message: 'user denied',
          interrupt: false,
          toolUseID: context.toolUseID,
        }),
      });
      evidence(report);
      expect(report.observations).toHaveLength(1);
      expect(report.terminalSubtype).toBe('success');
      expect(report.markerFiles['s03-denied-marker.txt']?.exists).toBe(false);
      expect(report.order).toContain('user.tool_result:error');
      expect(report.settingsLocalUnchanged).toBe(true);
      expect(report.globalSettingsUnchanged).toBe(true);
    },
    PROBE_TIMEOUT_MS,
  );

  it(
    'identifies AskUserQuestion by tool name',
    async () => {
      const report = await runProbe({
        label: 'ask-user-question',
        rules: {},
        prompt: [
          'Call the AskUserQuestion tool now.',
          'Ask exactly one question: "Pick one" with options "A" and "B".',
        ].join(' '),
        decide: async (context) => ({
          behavior: 'deny',
          message: 'User interaction is not supported in S03',
          interrupt: false,
          toolUseID: context.toolUseID,
        }),
      });
      evidence(report);
      expect(report.observations.map((item) => item.toolName)).toContain(
        'AskUserQuestion',
      );
      expect(report.settingsLocalUnchanged).toBe(true);
      expect(report.globalSettingsUnchanged).toBe(true);
    },
    PROBE_TIMEOUT_MS,
  );

  it(
    'records AbortSignal and interrupt behavior while an approval is pending',
    async () => {
      const report = await runProbe({
        label: 'interrupt-pending',
        rules: { allow: ['Read'], ask: ['Bash'] },
        prompt: [
          'Use the Bash tool to run exactly this command:',
          `touch s03-interrupted-marker.txt`,
          'Then reply DONE.',
        ].join(' '),
        decide: async (context) => {
          setTimeout(() => {
            void context.queryHandle()?.interrupt();
          }, 300);
          const aborted = await waitForAbort(context.signal, 20_000);
          signalAborts.set(context.observation.toolName, aborted);
          return {
            behavior: 'deny',
            message: 'user denied',
            interrupt: false,
            toolUseID: context.toolUseID,
          };
        },
      });
      evidence(report);
      expect(report.observations).toHaveLength(1);
      expect(report.terminalSubtype).not.toBeNull();
      expect(report.markerFiles['s03-interrupted-marker.txt']?.exists).toBe(
        false,
      );
      expect(signalAborts.get('Bash')).not.toBeUndefined();
      expect(report.settingsLocalUnchanged).toBe(true);
      expect(report.globalSettingsUnchanged).toBe(true);
    },
    PROBE_TIMEOUT_MS,
  );
});

/** interrupt 测试把 abort 观测带进断言；只记录布尔值。 */
const signalAborts = new Map<string, boolean>();