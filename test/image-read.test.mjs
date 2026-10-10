import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, symlink, truncate, mkdir } from 'node:fs/promises';
import path from 'node:path';

import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { NodeExecutionEnv } from '@earendil-works/pi-durable/env/node';
import { createReadTool } from '@earendil-works/pi-durable/tools';
import { fauxAssistantMessage, fauxToolCall, fauxText } from '@earendil-works/pi-ai';

import { imageMimeType, imageReadWrap, MAX_IMAGE_BYTES } from '../runtime/image-read.ts';
import { fixture, eventually, busy, messages } from './helpers.mjs';

const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==',
  'base64',
);

test('image read validates signatures and preserves the existing text tool and path conventions', async t => {
  const f = await fixture(t);
  const env = new NodeExecutionEnv({ cwd: f.workspace });
  const tool = imageReadWrap().wrap(createReadTool());
  t.after(() => env.cleanup(BACKGROUND_CONTEXT));
  assert.equal(imageMimeType(png), 'image/png');
  assert.equal(imageMimeType(Buffer.from([255, 216, 255, 0])), 'image/jpeg');
  assert.equal(imageMimeType(Buffer.from('RIFF1234WEBP')), 'image/webp');
  assert.equal(imageMimeType(Buffer.from('<svg></svg>')), undefined);
  await writeFile(path.join(f.workspace, 'fixture.png'), png);
  await writeFile(path.join(f.workspace, 'text.png'), 'one\ntwo\nthree');
  await writeFile(path.join(f.workspace, 'notes.txt'), 'one\ntwo\nthree');
  await symlink('fixture.png', path.join(f.workspace, 'link.png'));
  for (const file of ['@fixture.png', 'link.png']) {
    const result = await tool.execute({ path: file }, { env }, BACKGROUND_CONTEXT);
    assert.deepEqual(result.content, [
      { type: 'image', mimeType: 'image/png', data: png.toString('base64') },
    ]);
  }
  for (const file of ['text.png', 'notes.txt']) {
    const result = await tool.execute(
      { path: file, offset: 2, limit: 1 },
      { env },
      BACKGROUND_CONTEXT,
    );
    assert.equal(result.content[0].text, 'two');
  }
  await assert.rejects(
    tool.execute({ path: 'fixture.png' }, {}, BACKGROUND_CONTEXT),
    /environment/,
  );
});

test('oversized image targets, directories, changed-size reads and cancellation are rejected', async t => {
  const f = await fixture(t);
  const env = new NodeExecutionEnv({ cwd: f.workspace });
  const tool = imageReadWrap().wrap(createReadTool());
  await writeFile(path.join(f.workspace, 'large.png'), png);
  await truncate(path.join(f.workspace, 'large.png'), MAX_IMAGE_BYTES + 1);
  await symlink('large.png', path.join(f.workspace, 'alias.png'));
  await mkdir(path.join(f.workspace, 'directory.png'));
  for (const file of ['large.png', 'alias.png', 'directory.png'])
    await assert.rejects(
      tool.execute({ path: file }, { env }, BACKGROUND_CONTEXT),
      /8 MiB|regular/,
    );
  await writeFile(path.join(f.workspace, 'small.png'), png);
  env.readBinaryFile = async () => ({ ok: true, value: new Uint8Array(MAX_IMAGE_BYTES + 1) });
  await assert.rejects(tool.execute({ path: 'small.png' }, { env }, BACKGROUND_CONTEXT), /8 MiB/);
  const aborted = new NodeExecutionEnv({ cwd: f.workspace });
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    tool.execute(
      { path: 'small.png' },
      { env: aborted },
      { ...BACKGROUND_CONTEXT, abortSignal: controller.signal },
    ),
  );
});

test('one durable Harness returns and persists model image content through the ordinary read tool', async t => {
  const f = await fixture(t);
  await writeFile(path.join(f.workspace, 'public-fixture.png'), png);
  f.faux.setResponses([
    fauxAssistantMessage([fauxToolCall('read', { path: 'public-fixture.png' })], {
      stopReason: 'toolUse',
    }),
    fauxAssistantMessage([fauxText('fixture inspected')]),
  ]);
  await f.kernel.execute({
    type: 'input',
    conversationId: 1,
    text: 'read public fixture',
    mode: 'steer',
  });
  const view = await eventually(
    () => f.kernel.snapshot(),
    view => !busy(view),
  );
  const result = messages(view).find(message => message.role === 'toolResult');
  assert.equal(result.toolName, 'read');
  assert.equal(result.isError, false);
  assert.deepEqual(result.content, [
    { type: 'image', mimeType: 'image/png', data: png.toString('base64') },
  ]);
  await f.reopen();
  assert.deepEqual(
    messages(await f.kernel.snapshot()).find(message => message.role === 'toolResult').content,
    result.content,
  );
});
