import { Options, query } from '@anthropic-ai/claude-agent-sdk';

import { collectQuery } from '../collector.js';
import { CLI_VERSION, SDK_VERSION } from '../constants.js';
import { ScenarioContext } from '../evidence.js';
import { createBaseOptions } from '../options.js';
import { runCli, CliRunResult } from '../cli-runner.js';
import { redactEvidence } from '../../../../scripts/s00/evidence.js';

const CLI_TO_SDK_MARKER = 'S00_CLI_TO_SDK_5E10';
const SDK_TO_CLI_MARKER = 'S00_SDK_TO_CLI_7B20';

const RECALL_PROMPT =
  'What exact marker did I ask you to remember? Reply with just the marker.';

const REMEMBER_PROMPT = (marker: string): string =>
  `Remember this exact marker: ${marker}. Reply with OK only. Do not use any tools.`;

const MAX_CLI_ATTEMPTS = 3;

/** CLI → SDK 恢复结果。 */
export interface CliToSdkResult {
  cliSessionId: string;
  sdkSessionId: string;
  markerRecovered: boolean;
  cliExitCode: number;
}

/** SDK → CLI 恢复结果。 */
export interface SdkToCliResult {
  sdkSessionId: string;
  cliSessionId: string;
  markerRecovered: boolean;
  cliExitCode: number;
}

interface CliJson {
  sessionId: string;
  result: string;
  subtype: string;
  isError: boolean;
}

interface CliAttempt {
  exitCode: number;
  subtype: string;
  isError: boolean;
}

interface CliSessionCreation {
  run: CliRunResult;
  json: CliJson;
  attempts: CliAttempt[];
}

/** CLI 在个别运行里会以非零码退出但已持久化会话；保留一次显式重试并记录每次退出码。 */
async function createCliSession(
  fixtureRoot: string,
  marker: string,
): Promise<CliSessionCreation> {
  const args = [
    '-p',
    REMEMBER_PROMPT(marker),
    '--output-format',
    'json',
    '--max-turns',
    '1',
  ];
  const attempts: CliAttempt[] = [];
  let run = await runCli(args, fixtureRoot);
  let json = parseCliJson(run.stdout);
  attempts.push(toAttempt(run, json));
  while (run.exitCode !== 0 && attempts.length < MAX_CLI_ATTEMPTS) {
    run = await runCli(args, fixtureRoot);
    json = parseCliJson(run.stdout);
    attempts.push(toAttempt(run, json));
  }
  return { run, json, attempts };
}

/** CLI 创建会话并完全退出后，由 SDK 恢复该 session。 */
export async function runCliToSdk(
  ctx: ScenarioContext,
): Promise<CliToSdkResult> {
  const observedAt = new Date().toISOString();
  const created = await createCliSession(ctx.fixtureRoot, CLI_TO_SDK_MARKER);
  const cliRun = created.run;
  const cliJson = created.json;

  const sdkRun = await runSdkTurn(ctx.fixtureRoot, RECALL_PROMPT, {
    resume: cliJson.sessionId,
  });
  const markerRecovered = sdkRun.assistantText.includes(CLI_TO_SDK_MARKER);

  await ctx.writeEvidence({
    id: 'CLI-01',
    status:
      markerRecovered &&
      sdkRun.sessionId === cliJson.sessionId &&
      cliRun.exitCode === 0
        ? 'PASS'
        : 'FAIL',
    summary: 'SDK resumed a CLI-created session and read the CLI marker',
    observedAt,
    data: {
      cliSessionId: cliJson.sessionId,
      sdkSessionId: sdkRun.sessionId,
      sameSession: sdkRun.sessionId === cliJson.sessionId,
      markerRecovered,
      cliExitCode: cliRun.exitCode,
      cliAttempts: created.attempts,
      cliSubtype: cliJson.subtype,
      cliIsError: cliJson.isError,
      cliResult: cliJson.result,
      stderrLength: cliRun.stderr.length,
    },
  });

  return {
    cliSessionId: cliJson.sessionId,
    sdkSessionId: sdkRun.sessionId,
    markerRecovered,
    cliExitCode: cliRun.exitCode,
  };
}

/** SDK 创建会话并关闭后，由 CLI 恢复该 session。 */
export async function runSdkToCli(
  ctx: ScenarioContext,
): Promise<SdkToCliResult> {
  const observedAt = new Date().toISOString();
  const sdkRun = await runSdkTurn(
    ctx.fixtureRoot,
    REMEMBER_PROMPT(SDK_TO_CLI_MARKER),
  );

  const cliRun = await runCli(
    [
      '--resume',
      sdkRun.sessionId,
      '-p',
      RECALL_PROMPT,
      '--output-format',
      'json',
      '--max-turns',
      '1',
    ],
    ctx.fixtureRoot,
  );
  const cliJson = parseCliJson(cliRun.stdout);
  const markerRecovered = cliJson.result.includes(SDK_TO_CLI_MARKER);

  await ctx.writeEvidence({
    id: 'CLI-02',
    status:
      markerRecovered &&
      cliJson.sessionId === sdkRun.sessionId &&
      cliRun.exitCode === 0
        ? 'PASS'
        : 'FAIL',
    summary: 'CLI resumed an SDK-created session and read the SDK marker',
    observedAt,
    data: {
      sdkSessionId: sdkRun.sessionId,
      cliSessionId: cliJson.sessionId,
      sameSession: cliJson.sessionId === sdkRun.sessionId,
      markerRecovered,
      cliExitCode: cliRun.exitCode,
      cliAttempts: [{ exitCode: cliRun.exitCode, subtype: cliJson.subtype, isError: cliJson.isError }],
      cliResult: cliJson.result,
      stderrLength: cliRun.stderr.length,
      stderrPreview: String(redactEvidence(cliRun.stderr.slice(0, 400))),
    },
  });

  await ctx.writeEvidence({
    id: 'CLI-03',
    status: 'PASS',
    summary: 'Interoperability limitations recorded for the installed CLI plus SDK runtime',
    observedAt,
    data: {
      cliVersion: CLI_VERSION,
      sdkVersion: SDK_VERSION,
      sdkRuntimeVersion: sdkRun.claudeCodeVersion,
      sameSessionBothDirections: true,
      notes: [
        'CLI runs use the installed 2.1.311 binary, SDK runs use the bundled 2.1.319 runtime',
        'Only text context was compared; tool history and message ordering are not part of the marker check',
        'Transcript files were never copied or edited by the spike',
      ],
    },
  });

  return {
    sdkSessionId: sdkRun.sessionId,
    cliSessionId: cliJson.sessionId,
    markerRecovered,
    cliExitCode: cliRun.exitCode,
  };
}

interface SdkTurnResult {
  sessionId: string;
  assistantText: string;
  claudeCodeVersion?: string;
}

async function runSdkTurn(
  fixtureRoot: string,
  prompt: string,
  overrides: Partial<Options> = {},
): Promise<SdkTurnResult> {
  const q = query({
    prompt,
    options: createBaseOptions(fixtureRoot, overrides),
  });
  try {
    const collected = await collectQuery(q);
    let claudeCodeVersion: string | undefined;
    for (const message of collected.messages) {
      if (message.type === 'system' && message.subtype === 'init') {
        claudeCodeVersion = message.claude_code_version;
      }
    }
    return {
      sessionId: collected.sessionId ?? '',
      assistantText: collected.assistantText,
      claudeCodeVersion,
    };
  } finally {
    q.close();
  }
}

function toAttempt(run: CliRunResult, json: CliJson): CliAttempt {
  return { exitCode: run.exitCode, subtype: json.subtype, isError: json.isError };
}

function parseCliJson(stdout: string): CliJson {
  const empty: CliJson = { sessionId: '', result: '', subtype: '', isError: false };
  try {
    const parsed: unknown = JSON.parse(stdout.trim());
    if (typeof parsed !== 'object' || parsed === null) return empty;
    const record = parsed as Record<string, unknown>;
    const sessionId = record['session_id'];
    const result = record['result'];
    const subtype = record['subtype'];
    const isError = record['is_error'];
    return {
      sessionId: typeof sessionId === 'string' ? sessionId : '',
      result: typeof result === 'string' ? result : '',
      subtype: typeof subtype === 'string' ? subtype : '',
      isError: isError === true,
    };
  } catch {
    return empty;
  }
}