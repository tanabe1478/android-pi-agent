import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { eventually } from './helpers.mjs';

const main = fileURLToPath(new URL('../runtime/main.ts', import.meta.url));

test('real entrypoint boots without ambient auth, preserves an isolated profile and refuses inference before login', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'android-pi-real-test-'));
  const state = path.join(directory, '.android-pi');
  const child = spawn(
    process.execPath,
    [main, '--bridge-file', '--parent-pid', String(process.pid)],
    {
      cwd: directory,
      env: { ...process.env, OPENAI_API_KEY: 'test-only-ambient-key-must-be-ignored' },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  let output = '';
  let exited = false;
  child.stdout.on('data', bytes => {
    output += bytes;
  });
  child.stderr.on('data', bytes => {
    output += bytes;
  });
  child.once('exit', () => {
    exited = true;
  });
  t.after(async () => {
    if (!exited) child.kill('SIGTERM');
    await eventually(
      () => exited,
      value => value,
    );
    await rm(directory, { recursive: true, force: true });
  });

  const ready = await eventually(
    async () => {
      if (exited) throw new Error('Real runtime exited before readiness.');
      try {
        return JSON.parse(await readFile(path.join(state, 'bridge.json'), 'utf8'));
      } catch {
        return undefined;
      }
    },
    value => Boolean(value),
  );
  const url = `http://127.0.0.1:${ready.port}`;
  const headers = { 'x-pi-token': ready.token };
  const view = await (await fetch(url + '/api/view', { headers })).json();
  assert.equal(view.demo, false);
  assert.equal(view.auth.connected, false);
  assert.equal(view.conversation.docs['pi.agent'].model.modelId, 'gpt-6.1-sol');
  assert.ok(view.models.some(model => model.provider === 'openai'));
  assert.ok(!view.models.some(model => model.provider === 'faux'));
  const response = await fetch(url + '/api/action', {
    method: 'POST',
    headers: { ...headers, 'content-type': 'application/json' },
    body: JSON.stringify({
      type: 'input',
      conversationId: view.activeId,
      text: 'must not reach a real model',
      mode: 'reject',
    }),
  });
  assert.equal(response.status, 400);
  assert.equal((await response.json()).error, 'login_required');
  await assert.rejects(readFile(path.join(state, 'auth.json')), error => error.code === 'ENOENT');
  assert.ok(!output.includes(ready.token));
  assert.ok(!output.includes('test-only-ambient-key'));
  child.kill('SIGTERM');
  await eventually(
    () => exited,
    value => value,
  );
  assert.equal(child.exitCode, 0);
  await assert.rejects(readFile(path.join(state, 'bridge.json')), error => error.code === 'ENOENT');
});
