import type { ModelThinkingLevel } from '@earendil-works/pi-ai';
import type { Action } from './contracts.ts';

export class AppError extends Error {
  code: string;

  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

export function invalid(): never {
  throw new AppError('invalid_action', '操作の形式が正しくありません。');
}

function integer(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) invalid();
  return value;
}

function text(value: unknown, maximum = 65_536): string {
  if (typeof value !== 'string' || !value.trim() || value.length > maximum || value.includes('\0'))
    invalid();
  return value;
}

function optionalText(value: unknown, maximum: number): string | undefined {
  return value === undefined ? undefined : text(value, maximum);
}

const TYPES = [
  'input',
  'abort',
  'model',
  'thinking',
  'compact',
  'clear',
  'new',
  'select',
  'rename',
  'fork',
  'cancelQueued',
];
const LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];

// Validate untrusted JSON before any action is admitted. Drop no unknown fields silently.
export function parseAction(value: unknown): Action {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid();

  const action = value as Record<string, unknown>;
  if (typeof action.type !== 'string' || !TYPES.includes(action.type)) invalid();
  const conversationId = integer(action.conversationId);

  const extras: Record<string, string[]> = {
    input: ['text', 'mode'],
    model: ['model'],
    thinking: ['level'],
    compact: ['instructions'],
    clear: ['confirmation'],
    new: ['name'],
    rename: ['name'],
    fork: ['entryId', 'name'],
    cancelQueued: ['submissionId'],
    abort: [],
    select: [],
  };
  const allowed = ['type', 'conversationId', ...extras[action.type]];
  if (Object.keys(action).some(key => !allowed.includes(key))) invalid();

  switch (action.type) {
    case 'input': {
      if (!['steer', 'followUp', 'reject'].includes(String(action.mode))) invalid();

      return {
        type: 'input',
        conversationId,
        text: text(action.text),
        mode: action.mode as 'steer' | 'followUp' | 'reject',
      };
    }
    case 'model': {
      const model = action.model as Record<string, unknown> | undefined;
      if (
        !model ||
        typeof model !== 'object' ||
        Array.isArray(model) ||
        Object.keys(model).some(k => !['provider', 'modelId'].includes(k))
      )
        invalid();

      return {
        type: 'model',
        conversationId,
        model: { provider: text(model.provider, 128), modelId: text(model.modelId, 256) },
      };
    }
    case 'thinking':
      if (!LEVELS.includes(String(action.level))) invalid();
      return { type: 'thinking', conversationId, level: action.level as ModelThinkingLevel };
    case 'rename':
      return { type: 'rename', conversationId, name: text(action.name, 120) };
    case 'new':
      return { type: 'new', conversationId, name: optionalText(action.name, 120) };
    case 'fork':
      return {
        type: 'fork',
        conversationId,
        entryId: integer(action.entryId),
        name: optionalText(action.name, 120),
      };
    case 'cancelQueued':
      return { type: 'cancelQueued', conversationId, submissionId: integer(action.submissionId) };
    case 'compact':
      return {
        type: 'compact',
        conversationId,
        instructions: optionalText(action.instructions, 4096),
      };
    case 'clear':
      return {
        type: 'clear',
        conversationId,
        confirmation: optionalText(action.confirmation, 128),
      };
    case 'abort':
      return { type: 'abort', conversationId };
    case 'select':
      return { type: 'select', conversationId };
    default:
      return invalid();
  }
}
