import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, realpath, rm, stat, symlink } from 'node:fs/promises';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import os from 'node:os';

import { installGitTools } from '../runtime/cli.ts';
import { fixture, eventually, busy, messages } from './helpers.mjs';
import { fauxAssistantMessage, fauxText, fauxToolCall } from '@earendil-works/pi-ai';

const run = promisify(execFile);

async function setup(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'android-pi-node-cli-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const state = path.join(root, 'state');
  const prefix = path.join(root, 'usr');
  const cwd = path.join(root, 'project 日本語');
  const entries = path.join(prefix, 'lib/node_modules/npm/bin');
  await mkdir(entries, { recursive: true });
  await mkdir(path.join(prefix, 'bin'), { recursive: true });
  await mkdir(cwd);
  for (const name of ['npm', 'npx']) {
    await writeFile(path.join(prefix, 'bin', name), '#!/fixed/termux/path/node\nBROKEN_BASELINE\n');
    await writeFile(
      path.join(entries, `${name}-cli.js`),
      `
const fs = require('node:fs');
const args = process.argv.slice(2);
if (args[0] === '--exit') process.exit(Number(args[1]));
if (args[0] === '--signal') process.kill(process.pid, 'SIGTERM');
console.error('CLI_STDERR');
console.log(JSON.stringify({ name: ${JSON.stringify(name)}, args, cwd: process.cwd(),
  input: fs.readFileSync(0, 'utf8'), node: process.execPath }));
`,
    );
  }
  const env = await installGitTools(state, prefix);
  return { root, state, prefix, cwd, entries, env };
}

function withInput(file, args, options, input) {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, options);
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => (stdout += chunk));
    child.stderr.on('data', chunk => (stderr += chunk));
    child.on('error', reject);
    child.on('close', code => resolve({ code, stdout, stderr }));
    child.stdin.end(input);
  });
}

test('managed npm/npx use the existing Node entry, preserving cwd, args, stdio and baseline', async t => {
  const f = await setup(t);
  const args = ['--no-install', '日本語 space', "quote'arg", '--', 'line\nbreak'];
  for (const name of ['npm', 'npx']) {
    const wrapper = path.join(f.state, 'bin', name);
    const result = await withInput(
      wrapper,
      args,
      { cwd: f.cwd, env: { ...process.env, ...f.env } },
      'STDIN日本語',
    );
    assert.equal(result.code, 0);
    assert.equal(result.stderr, 'CLI_STDERR\n');
    assert.deepEqual(JSON.parse(result.stdout), {
      name,
      args,
      cwd: await realpath(f.cwd),
      input: 'STDIN日本語',
      node: process.execPath,
    });
    assert.equal((await stat(wrapper)).mode & 0o777, 0o700);
    assert.ok((await readFile(wrapper, 'utf8')).startsWith(`#!${process.execPath}\n`));
    assert.equal(
      await readFile(path.join(f.prefix, 'bin', name), 'utf8'),
      '#!/fixed/termux/path/node\nBROKEN_BASELINE\n',
    );
  }
});

test('managed Node CLIs retain failure codes and refuse missing or redirected entry files', async t => {
  const f = await setup(t);
  const wrapper = path.join(f.state, 'bin/npm');
  for (const [args, code] of [
    [['--exit', '23'], 23],
    [['--signal'], 143],
  ]) {
    await assert.rejects(run(wrapper, args), error => error.code === code);
  }
  const entry = path.join(f.entries, 'npm-cli.js');
  await rm(entry);
  await assert.rejects(
    run(wrapper, ['--version']),
    error =>
      error.code === 1 && /npm is unavailable/.test(error.stderr) && !error.stderr.includes(f.root),
  );
  const outside = path.join(f.root, 'do-not-run.cjs');
  await writeFile(outside, "console.log('OUTSIDE_SHOULD_NOT_RUN');");
  await symlink(outside, entry);
  await assert.rejects(
    run(wrapper, []),
    error => error.code === 1 && !error.stdout.includes('OUTSIDE_SHOULD_NOT_RUN'),
  );
});

test('ordinary durable bash can invoke npm without another model loop or baseline rewrite', async t => {
  const f = await setup(t);
  const entry = path.join(f.entries, 'npm-cli.js');
  await writeFile(entry, "console.log('DURABLE_MANAGED_NPM_OK');\n");
  const k = await fixture(t, { shellEnv: f.env });
  k.faux.setResponses([
    fauxAssistantMessage([fauxToolCall('bash', { command: 'npm --version' })], {
      stopReason: 'toolUse',
    }),
    fauxAssistantMessage([fauxText('managed CLI completed')]),
  ]);
  await k.kernel.execute({
    type: 'input',
    conversationId: 1,
    text: 'scripted npm fixture',
    mode: 'reject',
  });
  const view = await eventually(
    () => k.kernel.snapshot(),
    view => !busy(view) && messages(view).length >= 3,
  );
  const result = messages(view).find(message => message.role === 'toolResult');
  assert.equal(result.isError, false);
  assert.ok(JSON.stringify(result.content).includes('DURABLE_MANAGED_NPM_OK'));
  assert.equal(
    await readFile(path.join(f.prefix, 'bin/npm'), 'utf8'),
    '#!/fixed/termux/path/node\nBROKEN_BASELINE\n',
  );
});
