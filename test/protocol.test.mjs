import test from 'node:test';
import assert from 'node:assert/strict';

import { parseAction } from '../runtime/protocol.ts';
import { parseInput, suggestions } from '../shared/commands.js';

test('action validation rejects unsafe IDs, unknown fields and malformed configuration', () => {
  for (const value of [
    null,
    [],
    {},
    { type: 'abort', conversationId: '1' },
    { type: 'abort', conversationId: 0 },
    { type: 'abort', conversationId: 1, unexpected: true },
    { type: 'thinking', conversationId: 1, level: 'bogus' },
    { type: 'model', conversationId: 1, model: { provider: 'faux', modelId: '' } },
    { type: 'input', conversationId: 1, text: 'private\0text', mode: 'steer' },
  ])
    assert.throws(
      () => parseAction(value),
      error => error.code === 'invalid_action',
    );

  assert.equal(
    parseAction({ type: 'input', conversationId: 1, text: '日本語 👩‍💻', mode: 'followUp' }).text,
    '日本語 👩‍💻',
  );
});

test('completion and literal escaping share the backend command catalogue', () => {
  assert.equal(parseInput('/model provider/model').name, 'model');
  assert.deepEqual(parseInput('//literal/path'), { type: 'text', text: '/literal/path' });
  assert.ok(suggestions('/').some(command => command.name === 'compact'));
  assert.deepEqual(suggestions('//'), []);
  assert.deepEqual(suggestions('/model '), []);
});
