import { PermissionResult, SDKMessage, query } from '@anthropic-ai/claude-agent-sdk';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { collectQuery } from '../collector.js';
import { ScenarioContext } from '../evidence.js';
import { createBaseOptions } from '../options.js';

const ALLOW_MARKER = 'S00_PERMISSION_ALLOW_4A91';
const DENY_MARKER = 'S00_PERMISSION_DENY_7B20';
const LOCAL_SETTINGS = '.claude/settings.local.json';

interface AllowObservation {
  callback: boolean;
  outputMarker: boolean;
  requestId: boolean;
  toolUseID: boolean;
}

interface DenyObservation {
  callback: boolean;
  outputMarker: boolean;
  denialObserved: boolean;
}

/** 一次 allow、一次 deny 的权限回调结果。 */
export interface PermissionValidationResult {
  allow: AllowObservation;
  deny: DenyObservation;
  persistentSettingsWritten: boolean;
}

interface CaseObservation {
  callback: boolean;
  requestId: boolean;
  toolUseID: boolean;
  toolResultText: string;
  denialObserved: boolean;
  resultSubtypes: string[];
}

/** 用 fixture 的 Bash ask 规则验证一次性允许和显式拒绝。 */
export async function runPermissionValidation(
  ctx: ScenarioContext,
): Promise<PermissionValidationResult> {
  const settingsBeforeRun = existsSync(join(ctx.fixtureRoot, LOCAL_SETTINGS));

  const allowCase = await runPermissionCase(ctx.fixtureRoot, ALLOW_MARKER, 'allow');
  const denyCase = await runPermissionCase(ctx.fixtureRoot, DENY_MARKER, 'deny');

  const settingsAfterRun = existsSync(join(ctx.fixtureRoot, LOCAL_SETTINGS));
  const persistentSettingsWritten = settingsAfterRun && !settingsBeforeRun;

  const observedAt = new Date().toISOString();
  const allow: AllowObservation = {
    callback: allowCase.callback,
    outputMarker: allowCase.toolResultText.includes(ALLOW_MARKER),
    requestId: allowCase.requestId,
    toolUseID: allowCase.toolUseID,
  };
  const deny: DenyObservation = {
    callback: denyCase.callback,
    outputMarker: denyCase.toolResultText.includes(DENY_MARKER),
    denialObserved: denyCase.denialObserved,
  };

  await ctx.writeEvidence({
    id: 'SDK-07',
    status:
      allow.callback && allow.outputMarker && allow.requestId && allow.toolUseID
        ? 'PASS'
        : 'FAIL',
    summary: 'canUseTool allowed one Bash call and the command output was observed',
    observedAt,
    data: allow,
  });

  await ctx.writeEvidence({
    id: 'SDK-08',
    status:
      deny.callback && !deny.outputMarker && deny.denialObserved ? 'PASS' : 'FAIL',
    summary:
      'canUseTool denied Bash, the command did not run, and the agent kept replying',
    observedAt,
    data: {
      ...deny,
      allowCaseResultSubtypes: allowCase.resultSubtypes,
      denyCaseResultSubtypes: denyCase.resultSubtypes,
      persistentSettingsWritten,
    },
  });

  return { allow, deny, persistentSettingsWritten };
}

async function runPermissionCase(
  fixtureRoot: string,
  marker: string,
  decision: 'allow' | 'deny',
): Promise<CaseObservation> {
  let callback = false;
  let requestId = false;
  let toolUseID = false;

  const canUseTool = async (
    toolName: string,
    input: Record<string, unknown>,
    options: { requestId: string; toolUseID: string },
  ): Promise<PermissionResult> => {
    if (toolName !== 'Bash') {
      return { behavior: 'allow', updatedInput: input };
    }
    callback = true;
    requestId = options.requestId.length > 0;
    toolUseID = options.toolUseID.length > 0;
    if (decision === 'allow') {
      return { behavior: 'allow', updatedInput: input, toolUseID: options.toolUseID };
    }
    return {
      behavior: 'deny',
      message: 'S00 validation denied',
      toolUseID: options.toolUseID,
    };
  };

  const q = query({
    prompt: `Use the Bash tool to run exactly this command: printf ${marker}. Then reply with DONE.`,
    options: createBaseOptions(fixtureRoot, { canUseTool }),
  });

  try {
    const collected = await collectQuery(q);
    return {
      callback,
      requestId,
      toolUseID,
      toolResultText: toolResultText(collected.messages),
      denialObserved: denialObserved(collected.messages),
      resultSubtypes: collected.resultSubtypes,
    };
  } finally {
    q.close();
  }
}

function toolResultText(messages: readonly SDKMessage[]): string {
  const blocks: unknown[] = [];
  for (const message of messages) {
    if (message.type !== 'user') continue;
    const content = message.message.content;
    if (typeof content === 'string') continue;
    for (const block of content) {
      if (block.type === 'tool_result') blocks.push(block);
    }
  }
  return JSON.stringify(blocks);
}

function denialObserved(messages: readonly SDKMessage[]): boolean {
  return messages.some((message) => {
    if (message.type === 'system' && message.subtype === 'permission_denied') {
      return true;
    }
    return message.type === 'result' && message.permission_denials.length > 0;
  });
}