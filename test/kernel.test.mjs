import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { readFile, stat } from 'node:fs/promises';
import { fauxAssistantMessage, fauxText, fauxThinking, fauxToolCall } from '@earendil-works/pi-ai';
import { fixture, eventually, busy, messages } from './helpers.mjs';
const reply = text => fauxAssistantMessage([fauxText(text)]);
const send = (kernel, conversationId, text, mode = 'steer') => kernel.execute({ type: 'input', conversationId, text, mode });

test('the durable view owns model, thinking, cwd and committed streaming state', async t => {
  const f = await fixture(t, { tokensPerSecond: 80 });
  let view = await f.kernel.snapshot();
  assert.equal(view.activeId, 1);
  assert.equal(view.conversation.docs['pi.agent'].cwd, f.workspace);
  f.faux.setResponses([fauxAssistantMessage([fauxThinking('fixture thought'), fauxText('日本語のストリーミング応答です。')])]);
  let invalidations = 0;
  const dispose = f.kernel.subscribe(() => invalidations++);
  const result = await send(f.kernel, 1, 'fixture prompt');
  assert.equal(result.kind, 'accepted');
  await eventually(() => f.kernel.snapshot(), busy);
  view = await eventually(() => f.kernel.snapshot(), view => !busy(view));
  assert.ok(messages(view).some(message => message.role === 'assistant' && message.content.some(block => block.type === 'text' && block.text.includes('日本語'))));
  assert.ok(invalidations > 0);
  dispose();
  assert.equal((await stat(path.join(f.stateDir, 'session.sqlite'))).mode & 0o777, 0o600);
});

test('existing durable CodingTools execute in the explicit workspace, not a second Pi agent', async t => {
  const f = await fixture(t);
  f.faux.setResponses([
    fauxAssistantMessage([fauxToolCall('write', { path: 'fixture.txt', content: 'local fixture' })], { stopReason: 'toolUse' }),
    fauxAssistantMessage([fauxToolCall('read', { path: 'fixture.txt' })], { stopReason: 'toolUse' }),
    reply('tools finished'),
  ]);
  await send(f.kernel, 1, 'write and read fixture');
  const view = await eventually(() => f.kernel.snapshot(), view => !busy(view));
  assert.equal(await readFile(path.join(f.workspace, 'fixture.txt'), 'utf8'), 'local fixture');
  assert.equal(messages(view).filter(message => message.role === 'toolResult').length, 2);
  assert.ok(messages(view).some(message => message.role === 'toolResult' && message.toolName === 'read' && JSON.stringify(message.content).includes('local fixture')));
});

test('catalog, selection, model, thinking and transcript survive reopening SQLite', async t => {
  const f = await fixture(t);
  await f.kernel.execute({ type: 'thinking', conversationId: 1, level: 'high' });
  await f.kernel.execute({ type: 'new', conversationId: 1, name: 'second session' });
  let view = await f.kernel.snapshot();
  const id = view.activeId;
  assert.equal(view.conversation.docs['pi.agent'].thinkingLevel, 'high');
  await f.kernel.execute({ type: 'model', conversationId: id, model: { provider: f.faux.provider.id, modelId: 'second' } });
  f.faux.setResponses([reply('persistent fixture')]);
  await send(f.kernel, id, 'persist');
  await eventually(() => f.kernel.snapshot(), view => !busy(view));
  await f.reopen();
  view = await f.kernel.snapshot();
  assert.equal(view.activeId, id);
  assert.equal(view.sessions.find(session => session.id === id).name, 'second session');
  assert.equal(view.conversation.docs['pi.agent'].model.modelId, 'second');
  assert.equal(view.conversation.docs['pi.agent'].thinkingLevel, 'off');
  assert.match(JSON.stringify(messages(view)), /persistent fixture/);
});

test('explicit conversation IDs prevent a stale screen from sending into another conversation', async t => {
  const f = await fixture(t);
  await f.kernel.execute({ type: 'new', conversationId: 1, name: 'another' });
  const selected = (await f.kernel.snapshot()).activeId;
  f.faux.setResponses([reply('original conversation')]);
  await send(f.kernel, 1, 'from stale original screen');
  assert.equal((await f.kernel.snapshot()).activeId, selected);
  assert.equal(messages(await f.kernel.snapshot()).length, 0);
  await f.kernel.execute({ type: 'select', conversationId: 1 });
  const view = await eventually(() => f.kernel.snapshot(), view => !busy(view));
  assert.match(JSON.stringify(messages(view)), /from stale original screen/);
});

test('clear requires a fresh one-use confirmation and retains stored history', async t => {
  const f = await fixture(t);
  f.faux.setResponses([reply('old answer'), reply('new answer')]);
  await send(f.kernel, 1, 'old input');
  await eventually(() => f.kernel.snapshot(), view => !busy(view));
  const old = await f.kernel.execute({ type: 'clear', conversationId: 1 });
  await send(f.kernel, 1, 'changed since confirmation');
  await eventually(() => f.kernel.snapshot(), view => !busy(view));
  await assert.rejects(f.kernel.execute({ type: 'clear', conversationId: 1, confirmation: old.token }), error => error.code === 'stale_confirmation');
  const fresh = await f.kernel.execute({ type: 'clear', conversationId: 1 });
  await f.kernel.execute({ type: 'clear', conversationId: 1, confirmation: fresh.token });
  await assert.rejects(f.kernel.execute({ type: 'clear', conversationId: 1, confirmation: fresh.token }), error => error.code === 'stale_confirmation');
  const view = await f.kernel.snapshot();
  assert.doesNotMatch(JSON.stringify(messages(view)), /old input|old answer/);
  const db = new DatabaseSync(path.join(f.stateDir, 'session.sqlite'), { readOnly: true });
  try { assert.ok(db.prepare('SELECT COUNT(*) AS n FROM entries').get().n > view.conversation.entries.length); }
  finally { db.close(); }
});

test('fork creates another durable conversation with the selected earlier context', async t => {
  const f = await fixture(t);
  f.faux.setResponses([reply('first answer'), reply('later answer')]);
  await send(f.kernel, 1, 'first input');
  await eventually(() => f.kernel.snapshot(), view => !busy(view));
  await send(f.kernel, 1, 'later input');
  const view = await eventually(() => f.kernel.snapshot(), view => !busy(view));
  const at = view.conversation.entries.find(entry => entry.kind === 'pi.user').id;
  await f.kernel.execute({ type: 'fork', conversationId: 1, entryId: at, name: 'branch' });
  const fork = await f.kernel.snapshot();
  assert.notEqual(fork.activeId, 1);
  assert.match(JSON.stringify(messages(fork)), /first input/);
  assert.doesNotMatch(JSON.stringify(messages(fork)), /later input/);
});

test('queued input can be cancelled, clear is guarded while busy, and abort settles', async t => {
  const f = await fixture(t, { tokensPerSecond: 20 });
  f.faux.setResponses([reply('long response '.repeat(20))]);
  await send(f.kernel, 1, 'run');
  await eventually(() => f.kernel.snapshot(), busy);
  await assert.rejects(f.kernel.execute({ type: 'clear', conversationId: 1 }), error => error.code === 'busy');
  const queued = await send(f.kernel, 1, 'do later', 'followUp');
  assert.ok((await f.kernel.snapshot()).conversation.docs['pi.inbox'].items.some(item => item.id === queued.operationId));
  await f.kernel.execute({ type: 'cancelQueued', conversationId: 1, submissionId: queued.operationId });
  assert.equal((await f.kernel.snapshot()).conversation.docs['pi.inbox'].items.length, 0);
  await f.kernel.execute({ type: 'abort', conversationId: 1 });
  assert.equal(busy(await f.kernel.snapshot()), false);
});

test('slash commands are backend operations, unknown commands and private shell input never reach the model', async t => {
  const f = await fixture(t);
  assert.deepEqual(await send(f.kernel, 1, '/help'), { kind: 'dialog', dialog: 'help' });
  await assert.rejects(send(f.kernel, 1, '/unknown'), error => error.code === 'unknown_command');
  await assert.rejects(send(f.kernel, 1, '!echo private'), error => error.code === 'unsupported');
  await assert.rejects(send(f.kernel, 1, '/model invalid'), error => error.code === 'model');
  assert.equal(f.faux.state.callCount, 0);
  f.faux.setResponses([reply('escaped literal accepted')]);
  await send(f.kernel, 1, '  //literal\n');
  const view = await eventually(() => f.kernel.snapshot(), view => !busy(view));
  assert.ok(messages(view).some(message => message.role === 'user' && message.content === '  /literal\n'));
});
