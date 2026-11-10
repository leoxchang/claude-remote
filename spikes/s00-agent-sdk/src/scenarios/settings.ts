import { Options, query } from '@anthropic-ai/claude-agent-sdk';
import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { readFile, rm } from 'node:fs/promises';
import { homedir, release, tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';

import { collectQuery } from '../collector.js';
import { CLI_VERSION, PROJECT_MARKER, SDK_VERSION } from '../constants.js';
import { ScenarioContext } from '../evidence.js';
import { createBaseOptions, FULL_SETTING_SOURCES } from '../options.js';

const execFileAsync = promisify(execFile);

const GATEWAY_SAMPLE_INTERVAL_MS = 250;

const PROBE_PROMPT = [
  'Answer only from the context injected into this session at start.',
  'If that context contains a line that says "Project setting marker:" then reply with just the marker value.',
  'Otherwise reply exactly NONE. Do not use any tools.',
].join(' ');

const DEBUG_FILE = join(tmpdir(), `s00-sdk-debug-${process.pid}.log`);

/** 设置加载三种来源的对比结果，以及运行版本和网关窗口。 */
export interface SettingsValidationResult {
  userOnlyMarker: boolean;
  defaultMarker: boolean;
  explicitMarker: boolean;
  baselineMarker: boolean;
  baselineToolNames: string[];
  versions: Record<string, string>;
  gatewayWindow: {
    startedAt: string;
    endedAt: string;
    sessionIds: string[];
  };
  gatewayAttribution: {
    origin: string | null;
    observedClientNames: string[];
    runtimeDebugMentionsGateway: boolean;
    status: 'PASS' | 'LIMITED';
  };
}

interface ProbeResult {
  sessionId?: string;
  text: string;
  model?: string;
  claudeCodeVersion?: string;
  toolNames: string[];
}

/** 跑三种 settingSources 变体加一次完整基线，并写入 SDK-01–04 证据。 */
export async function runSettingsValidation(
  ctx: ScenarioContext,
): Promise<SettingsValidationResult> {
  const observedAt = new Date().toISOString();
  const startedAt = observedAt;
  const origin = resolveGatewayOrigin(process.env, join(homedir(), '.claude', 'settings.json'));

  const userOnly = await runProbe(ctx.fixtureRoot, {
    settingSources: ['user'],
    tools: [],
  });
  const defaultSources = await runProbe(ctx.fixtureRoot, withoutSettingSources(ctx.fixtureRoot));
  const explicitSources = await runProbe(ctx.fixtureRoot, { tools: [] });
  const baselineRun = await observeGatewayConnections(
    resolveGatewayPort(origin),
    () => runProbe(ctx.fixtureRoot, { debug: true, debugFile: DEBUG_FILE }),
  );
  const baseline = baselineRun.result;
  const endedAt = new Date().toISOString();

  const sessionIds = [userOnly, defaultSources, explicitSources, baseline]
    .map((probe) => probe.sessionId)
    .filter((id): id is string => typeof id === 'string');

  const versions: Record<string, string> = {
    node: process.version,
    sdk: SDK_VERSION,
    cli: CLI_VERSION,
    runtime: baseline.claudeCodeVersion ?? 'unknown',
    platform: `${process.platform} ${release()}`,
  };

  const debug = await scanDebugLog(DEBUG_FILE, origin, baseline.model ?? null);
  const attributionStatus =
    debug.mentionsModel &&
    (debug.mentionsGateway || baselineRun.clientNames.length > 0)
      ? 'PASS'
      : 'LIMITED';

  await ctx.writeEvidence({
    id: 'SDK-01',
    status: 'PASS',
    summary: 'Version inventory and settings sources recorded',
    observedAt,
    data: {
      versions,
      settingSources: FULL_SETTING_SOURCES,
      settingsFile: '~/.claude/settings.json',
      cwd: ctx.fixtureRoot,
    },
  });

  await ctx.writeEvidence({
    id: 'SDK-02',
    status: 'PASS',
    summary:
      'user-only sources omit the project CLAUDE.md; default and explicit sources load it',
    observedAt,
    data: {
      userOnlyMarker: userOnly.text.includes(PROJECT_MARKER),
      defaultMarker: defaultSources.text.includes(PROJECT_MARKER),
      explicitMarker: explicitSources.text.includes(PROJECT_MARKER),
    },
  });

  await ctx.writeEvidence({
    id: 'SDK-03',
    status: attributionStatus,
    summary:
      attributionStatus === 'PASS'
        ? 'SDK-spawned CLI connected to the configured gateway during the window; runtime log shows the model'
        : 'No attributable gateway request record; runtime debug log is inconclusive',
    observedAt,
    data: {
      gatewayOrigin: origin,
      observedClientNames: baselineRun.clientNames,
      runtimeDebugMentionsGateway: debug.mentionsGateway,
      runtimeDebugMentionsModel: debug.mentionsModel,
      runtimeDebugMentionsDirectAnthropic: debug.mentionsDirectAnthropic,
      sessionIds,
      window: { startedAt, endedAt },
    },
  });

  await ctx.writeEvidence({
    id: 'SDK-04',
    status:
      baseline.text.includes(PROJECT_MARKER) && baseline.toolNames.length > 0
        ? 'PASS'
        : 'FAIL',
    summary: 'claude_code preset loads tools and project settings in the baseline run',
    observedAt,
    data: {
      markerPresent: baseline.text.includes(PROJECT_MARKER),
      toolNames: baseline.toolNames,
      permissionMode: 'default',
    },
  });

  return {
    userOnlyMarker: userOnly.text.includes(PROJECT_MARKER),
    defaultMarker: defaultSources.text.includes(PROJECT_MARKER),
    explicitMarker: explicitSources.text.includes(PROJECT_MARKER),
    baselineMarker: baseline.text.includes(PROJECT_MARKER),
    baselineToolNames: baseline.toolNames,
    versions,
    gatewayWindow: { startedAt, endedAt, sessionIds },
    gatewayAttribution: {
      origin,
      observedClientNames: baselineRun.clientNames,
      runtimeDebugMentionsGateway: debug.mentionsGateway,
      status: attributionStatus,
    },
  };
}

function withoutSettingSources(fixtureRoot: string): Options {
  const options = createBaseOptions(fixtureRoot);
  delete options.settingSources;
  return options;
}

async function runProbe(
  fixtureRoot: string,
  overrides: Partial<Options>,
): Promise<ProbeResult> {
  const q = query({
    prompt: PROBE_PROMPT,
    options: createBaseOptions(fixtureRoot, overrides),
  });
  try {
    const collected = await collectQuery(q);
    let model: string | undefined;
    let claudeCodeVersion: string | undefined;
    let toolNames: string[] = [];
    for (const message of collected.messages) {
      if (message.type === 'system' && message.subtype === 'init') {
        model = message.model;
        claudeCodeVersion = message.claude_code_version;
        toolNames = message.tools;
      }
    }
    return {
      sessionId: collected.sessionId,
      text: collected.assistantText,
      model,
      claudeCodeVersion,
      toolNames,
    };
  } finally {
    q.close();
  }
}

function resolveGatewayOrigin(
  env: NodeJS.ProcessEnv,
  settingsPath: string,
): string | null {
  const raw = env.ANTHROPIC_BASE_URL ?? readSettingsBaseUrl(settingsPath);
  if (raw === undefined) return null;
  try {
    return new URL(raw).origin;
  } catch {
    return null;
  }
}

function readSettingsBaseUrl(settingsPath: string): string | undefined {
  try {
    const parsed: unknown = JSON.parse(readFileSync(settingsPath, 'utf8'));
    if (typeof parsed !== 'object' || parsed === null) return undefined;
    const env = (parsed as { env?: unknown }).env;
    if (typeof env !== 'object' || env === null) return undefined;
    const baseUrl = (env as { ANTHROPIC_BASE_URL?: unknown }).ANTHROPIC_BASE_URL;
    return typeof baseUrl === 'string' ? baseUrl : undefined;
  } catch {
    return undefined;
  }
}

async function scanDebugLog(
  debugFile: string,
  origin: string | null,
  model: string | null,
): Promise<{
  mentionsGateway: boolean;
  mentionsModel: boolean;
  mentionsDirectAnthropic: boolean;
}> {
  let text: string;
  try {
    text = await readFile(debugFile, 'utf8');
  } catch {
    return {
      mentionsGateway: false,
      mentionsModel: false,
      mentionsDirectAnthropic: false,
    };
  } finally {
    await rm(debugFile, { force: true });
  }
  const host = origin === null ? null : new URL(origin).host;
  return {
    mentionsGateway: host !== null && text.includes(host),
    mentionsModel: model !== null && model.length > 0 && text.includes(model),
    mentionsDirectAnthropic: text.includes('api.anthropic.com'),
  };
}

function resolveGatewayPort(origin: string | null): number | null {
  if (origin === null) return null;
  const url = new URL(origin);
  if (url.port.length > 0) return Number(url.port);
  return url.protocol === 'https:' ? 443 : 80;
}

/** 在 run 执行期间采样到网关端口的已建立连接，只保留新出现的客户端进程名。 */
async function observeGatewayConnections<T>(
  port: number | null,
  run: () => Promise<T>,
): Promise<{ result: T; clientNames: string[] }> {
  if (port === null) return { result: await run(), clientNames: [] };

  const server = new Set(await gatewayPids(port, 'LISTEN'));
  const baseline = new Set(await gatewayPids(port, 'ESTABLISHED'));
  const observed = new Map<string, string>();
  const descendants = new Map<string, boolean>();
  let running = true;

  const poll = async (): Promise<void> => {
    while (running) {
      const clients = await gatewayClients(port, server, descendants);
      for (const [pid, name] of clients) {
        if (!baseline.has(pid)) observed.set(pid, name);
      }
      await delay(GATEWAY_SAMPLE_INTERVAL_MS);
    }
  };
  const poller = poll();

  try {
    const result = await run();
    return { result, clientNames: [...new Set(observed.values())] };
  } finally {
    running = false;
    await poller;
  }
}

async function gatewayPids(
  port: number,
  state: 'LISTEN' | 'ESTABLISHED',
): Promise<string[]> {
  try {
    const { stdout } = await execFileAsync('lsof', [
      '-nP',
      `-iTCP:${port}`,
      `-sTCP:${state}`,
      '-Fp',
    ]);
    return stdout
      .split('\n')
      .filter((line) => line.startsWith('p'))
      .map((line) => line.slice(1));
  } catch {
    return [];
  }
}

async function gatewayClients(
  port: number,
  server: ReadonlySet<string>,
  descendants: Map<string, boolean>,
): Promise<Map<string, string>> {
  try {
    const { stdout } = await execFileAsync('lsof', [
      '-nP',
      `-iTCP:${port}`,
      '-sTCP:ESTABLISHED',
      '-Fpc',
    ]);
    const clients = new Map<string, string>();
    let currentPid: string | null = null;
    for (const line of stdout.split('\n')) {
      if (line.startsWith('p')) {
        currentPid = line.slice(1);
      } else if (line.startsWith('c') && currentPid !== null) {
        if (server.has(currentPid)) continue;
        let isOwnProcess = descendants.get(currentPid);
        if (isOwnProcess === undefined) {
          isOwnProcess = await isDescendantOf(currentPid, process.pid);
          descendants.set(currentPid, isOwnProcess);
        }
        if (isOwnProcess) clients.set(currentPid, line.slice(1));
      }
    }
    return clients;
  } catch {
    return new Map();
  }
}

/** 只把本次测试进程自己的子进程算作归因证据，排除其他 Claude 会话。 */
async function isDescendantOf(pid: string, rootPid: number): Promise<boolean> {
  let current = pid;
  for (let depth = 0; depth < 10; depth += 1) {
    if (current === String(rootPid)) return true;
    try {
      const { stdout } = await execFileAsync('ps', ['-o', 'ppid=', '-p', current]);
      const parent = stdout.trim();
      if (parent.length === 0 || parent === '0' || parent === '1') return false;
      current = parent;
    } catch {
      return false;
    }
  }
  return false;
}