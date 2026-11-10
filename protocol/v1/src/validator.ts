import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { Ajv2020 } from 'ajv/dist/2020.js';

import { ProtocolMessage } from './types.js';

/** 校验失败码：未知类型与普通非法消息分开。 */
export type ValidationErrorCode = 'INVALID_MESSAGE' | 'UNKNOWN_MESSAGE_TYPE';

/** 只暴露路径和关键字，绝不回显输入值。 */
export interface ValidationError {
  path: string;
  keyword: string;
  code: ValidationErrorCode;
}

export type ValidationResult =
  | { valid: true; message: ProtocolMessage }
  | { valid: false; errors: ValidationError[] };

interface MessageTypeRef {
  type: string;
  ref: string;
}

const MESSAGE_TYPE_REFS: readonly MessageTypeRef[] = [
  {
    type: 'session.start',
    ref: 'https://s00.local/commands.schema.json#/$defs/session.start',
  },
  {
    type: 'prompt.send',
    ref: 'https://s00.local/commands.schema.json#/$defs/prompt.send',
  },
  {
    type: 'run.cancel',
    ref: 'https://s00.local/commands.schema.json#/$defs/run.cancel',
  },
  {
    type: 'session.snapshot',
    ref: 'https://s00.local/commands.schema.json#/$defs/session.snapshot',
  },
  {
    type: 'command.result',
    ref: 'https://s00.local/commands.schema.json#/$defs/command.result',
  },
  {
    type: 'session.status',
    ref: 'https://s00.local/events.schema.json#/$defs/session.status',
  },
  {
    type: 'error',
    ref: 'https://s00.local/events.schema.json#/$defs/error',
  },
];

const KNOWN_TYPES: ReadonlySet<string> = new Set(
  MESSAGE_TYPE_REFS.map((entry) => entry.type),
);

const ajv = new Ajv2020({ allErrors: true, strict: true, verbose: false });
ajv.addSchema(readSchema('envelope.schema.json'));
ajv.addSchema(readSchema('commands.schema.json'));
ajv.addSchema(readSchema('events.schema.json'));

const validate = ajv.compile({
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  oneOf: MESSAGE_TYPE_REFS.map((entry) => ({ $ref: entry.ref })),
});

/** 校验一条协议消息；不修改输入，错误只含 path 与 keyword。 */
export function validateProtocolMessage(input: unknown): ValidationResult {
  if (isUnknownType(input)) {
    return {
      valid: false,
      errors: [{ path: '', keyword: 'type', code: 'UNKNOWN_MESSAGE_TYPE' }],
    };
  }

  if (validate(input)) {
    return { valid: true, message: input as ProtocolMessage };
  }

  const errors: ValidationError[] = (validate.errors ?? []).map(
    (error: { instancePath: string; keyword: string }) => ({
      path: error.instancePath,
      keyword: error.keyword,
      code: 'INVALID_MESSAGE',
    }),
  );
  return { valid: false, errors };
}

function isUnknownType(input: unknown): boolean {
  if (typeof input !== 'object' || input === null) return false;
  const type = (input as Record<string, unknown>)['type'];
  return typeof type === 'string' && !KNOWN_TYPES.has(type);
}

function readSchema(fileName: string): object {
  return JSON.parse(
    readFileSync(fileURLToPath(new URL(`../${fileName}`, import.meta.url)), 'utf8'),
  ) as object;
}