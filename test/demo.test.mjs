import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { eventually } from './helpers.mjs';

test('demo entrypoint creates a private launcher and never reads ambient provider credentials', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'android-pi-demo-test-'));
  const workspace = path.join(directory, 'work');
  const state = path.join(directory, 'state');
  await mkdir(workspace);

  const child = spawn(
    process.execPath,
    [
      fileURLToPath(new URL('../runtime/main.ts', import.meta.url)),
      '--demo',
      '--state',
      state,
      '--workspace',
      workspace,
    ],
    {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, OPENAI_API_KEY: 'unusable-fixture-only-key' },
    },
  );

  let output = '';
  child.stdout.on('data', chunk => {
    output += chunk;
  });
  child.stderr.on('data', chunk => {
    output += chunk;
  });
  const exited = new Promise(resolve => child.once('exit', code => resolve(code)));
  t.after(async () => {
    if (child.exitCode === null) child.kill('SIGTERM');
    await exited;
    await rm(directory, { recursive: true, force: true });
  });

  const launcher = path.join(state, 'open.html');
  const html = await eventually(
    async () => {
      try {
        return await readFile(launcher, 'utf8');
      } catch {
        return '';
      }
    },
    html => html.includes('#token='),
  );
  const match = html.match(/url=(http:\/\/127\.0\.0\.1:\d+)\/#token=([^"<>]+)/);
  assert.ok(match);
  assert.equal((await stat(launcher)).mode & 0o777, 0o600);

  const response = await fetch(match[1] + '/api/view', { headers: { 'x-pi-token': match[2] } });
  const view = await response.json();
  assert.equal(view.demo, true);
  assert.ok(view.models.every(model => model.provider.startsWith('faux')));
  assert.ok(!output.includes(match[2]));
  assert.ok(!output.includes('unusable-fixture-only-key'));

  child.kill('SIGTERM');
  assert.equal(await exited, 0);
});
