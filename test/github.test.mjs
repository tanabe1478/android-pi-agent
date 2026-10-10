import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, stat, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { openGitHub, parseGitHubAction, withGitHub } from '../runtime/github.ts';
import { installGitTools, githubCLISource, writeExecutable } from '../runtime/cli.ts';
import { createBridge } from '../runtime/bridge.ts';
import { fixture, eventually, busy, messages } from './helpers.mjs';
import { fauxAssistantMessage, fauxText, fauxToolCall } from '@earendil-works/pi-ai';

const run = promisify(execFile);
const TOKEN = 'test_only_github_pat_never_real';
const OTHER = 'test_only_reauth_token_never_real';

async function setup(t, options = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'android-pi-github-'));
  const state = path.join(root, 'state');
  const file = path.join(state, 'github.json');
  const github = await openGitHub(state, {
    fetcher: async () => Response.json({ login: 'test-user' }),
    ...options,
  });
  t.after(async () => {
    await github.close();
    await rm(root, { recursive: true, force: true });
  });
  const save = token =>
    github.execute({ type: 'save', token, revision: github.summary().revision });
  return { root, state, file, github, save };
}

test('GitHub validates only through bounded official API and preserves credentials after failed reauth', async t => {
  let failure = false;
  const f = await setup(t, {
    fetcher: async (url, options) => {
      assert.equal(url, 'https://api.github.com/user');
      assert.equal(options.redirect, 'error');
      assert.ok(options.signal);
      assert.equal(options.headers.authorization, `Bearer ${failure ? OTHER : TOKEN}`);
      if (failure) throw new Error(OTHER);
      return Response.json({ login: 'test-user' });
    },
  });
  await f.save(TOKEN);
  assert.equal((await stat(f.file)).mode & 0o777, 0o600);
  assert.equal((await stat(f.state)).mode & 0o777, 0o700);
  const before = await readFile(f.file, 'utf8');
  assert.equal(f.github.summary().connected, true);
  assert.ok(!JSON.stringify(f.github.snapshot()).includes(TOKEN));
  failure = true;
  await assert.rejects(
    f.save(OTHER),
    error => error.code === 'github_verify' && !error.message.includes(OTHER),
  );
  assert.equal(await readFile(f.file, 'utf8'), before);
  assert.equal(f.github.summary().connected, true);
  const reopened = await openGitHub(f.state);
  assert.equal(reopened.summary().user, 'test-user');
  await reopened.close();
});

test('GitHub protocol is strict, stale operations and simultaneous saves are rejected', async t => {
  for (const value of [
    null,
    [],
    {},
    { type: 'save', revision: 0, token: TOKEN, extra: true },
    { type: 'save', revision: -1, token: TOKEN },
    { type: 'save', revision: 0, token: 'short' },
    { type: 'save', revision: 0, token: `${TOKEN}\ninside` },
    { type: 'disconnect', revision: 0, confirmation: 'wrong' },
  ]) {
    assert.throws(() => parseGitHubAction(value));
  }
  let finish;
  const f = await setup(t, {
    fetcher: () =>
      new Promise(resolve => {
        finish = resolve;
      }),
  });
  const operation = f.save(TOKEN);
  await eventually(
    () => finish,
    value => Boolean(value),
  );
  assert.throws(
    () => f.save(OTHER),
    error => error.code === 'stale_github',
  );
  finish(Response.json({ login: 'test-user' }));
  await operation;
  assert.throws(
    () => f.github.execute({ type: 'disconnect', revision: 0 }),
    error => error.code === 'stale_github',
  );
});

test('disconnect needs a one-use revision-bound confirmation and only removes the new PAT', async t => {
  const f = await setup(t);
  await f.save(TOKEN);
  await writeFile(path.join(f.state, 'auth.json'), 'KEEP_OPENAI');
  const prepare = () =>
    f.github.execute({ type: 'disconnect', revision: f.github.summary().revision });
  const ticket = await prepare();
  assert.equal(ticket.kind, 'confirmation');
  assert.ok(await readFile(f.file));
  await assert.rejects(
    f.github.execute({
      type: 'disconnect',
      revision: ticket.revision,
      confirmation: '00000000-0000-0000-0000-000000000000',
    }),
    error => error.code === 'stale_github',
  );
  const fresh = await prepare();
  await f.github.execute({
    type: 'disconnect',
    revision: fresh.revision,
    confirmation: fresh.token,
  });
  assert.equal(f.github.summary().connected, false);
  await assert.rejects(readFile(f.file), error => error.code === 'ENOENT');
  assert.equal(await readFile(path.join(f.state, 'auth.json'), 'utf8'), 'KEEP_OPENAI');
  assert.throws(() =>
    f.github.execute({ type: 'disconnect', revision: fresh.revision, confirmation: fresh.token }),
  );
});

test('corrupt, symlinked and oversized GitHub storage is never silently overwritten', async t => {
  const f = await setup(t);
  await writeFile(f.file, 'BROKEN_TEST_ONLY');
  await assert.rejects(f.save(TOKEN), error => error.code === 'github_storage');
  assert.equal(await readFile(f.file, 'utf8'), 'BROKEN_TEST_ONLY');
  await assert.rejects(openGitHub(f.state), error => error.code === 'github_storage');
  await rm(f.file);
  const target = path.join(f.root, 'keep');
  await writeFile(target, 'KEEP');
  await symlink(target, f.file);
  await assert.rejects(f.save(TOKEN), error => error.code === 'github_storage');
  assert.equal(await readFile(target, 'utf8'), 'KEEP');
  await rm(f.file);
  await writeFile(f.file, 'x'.repeat(256 * 1024 + 1));
  await assert.rejects(openGitHub(f.state), error => error.code === 'github_storage');
});

test('verification timeout and shutdown do not persist a late response', async t => {
  const f = await setup(t, {
    timeoutMs: 25,
    fetcher: async (_url, { signal }) => {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, 30_000);
        signal.addEventListener(
          'abort',
          () => {
            clearTimeout(timer);
            reject(new Error(TOKEN));
          },
          { once: true },
        );
      });
      return Response.json({ login: 'test-user' });
    },
  });
  await assert.rejects(f.save(TOKEN), error => error.code === 'github_verify');
  await assert.rejects(readFile(f.file), error => error.code === 'ENOENT');
  const second = f.save(OTHER);
  await f.github.close();
  await assert.rejects(second);
  await assert.rejects(readFile(f.file), error => error.code === 'ENOENT');
  assert.throws(
    () => f.save(TOKEN),
    error => error.code === 'closed',
  );
});

test('git consumes profile PAT using askpass without changing host configuration or child environment', async t => {
  const f = await setup(t);
  await f.save(TOKEN);
  const shellEnv = await installGitTools(f.state);
  assert.ok(!JSON.stringify(shellEnv).includes(TOKEN));
  assert.equal((await stat(shellEnv.GIT_ASKPASS)).mode & 0o777, 0o700);
  const helper = async prompt => (await run(shellEnv.GIT_ASKPASS, [prompt])).stdout.trim();
  assert.equal(await helper("Username for 'https://github.com/test-user/repo':"), 'x-access-token');
  assert.equal(
    await helper("Password for 'https://x-access-token@github.com/test-user/repo':"),
    TOKEN,
  );
  for (const prompt of [
    "Password for 'http://github.com/repo':",
    "Password for 'https://github.com.evil/repo':",
    "Password for 'https://github.com:444/repo':",
    "Password for 'https://example.com':",
    'arbitrary prompt',
  ]) {
    await assert.rejects(helper(prompt));
  }
  // Real git credential protocol; test-only secret output stays in memory, never in tool logs.
  const child = execFile('git', ['credential', 'fill'], { env: { ...process.env, ...shellEnv } });
  child.stdin.end('protocol=https\nhost=github.com\npath=test-user/repo\n\n');
  const output = await new Promise((resolve, reject) => {
    let text = '';
    child.stdout.on('data', chunk => {
      text += chunk;
    });
    child.on('error', reject);
    child.on('close', code =>
      code === 0 ? resolve(text) : reject(new Error('Test git credential failed')),
    );
  });
  assert.match(output, /username=x-access-token/);
  assert.ok(output.includes(`password=${TOKEN}`));
});

test('gh wrapper shares the new PAT, restricts hosts and prevents common credential disclosure', async t => {
  const f = await setup(t);
  await f.save(TOKEN);
  const native = path.join(f.root, 'test-native');
  await writeExecutable(
    native,
    `#!${process.execPath}
console.log(JSON.stringify({ tokenMatches: process.env.GH_TOKEN === ${JSON.stringify(TOKEN)},
  host: process.env.GH_HOST, enterprise: Boolean(process.env.GH_ENTERPRISE_TOKEN),
  debug: Boolean(process.env.GH_DEBUG), config: process.env.GH_CONFIG_DIR }));
`,
  );
  const wrapper = path.join(f.root, 'gh-wrapper.cjs');
  const config = path.join(f.state, 'gh');
  await writeExecutable(wrapper, githubCLISource(process.execPath, native, f.file, config));
  const env = {
    ...process.env,
    GH_TOKEN: 'ambient_should_not_be_used',
    GH_ENTERPRISE_TOKEN: 'ambient_enterprise_not_used',
    GH_DEBUG: 'api',
  };
  const success = await run(wrapper, ['api', '/user'], { env });
  const value = JSON.parse(success.stdout);
  assert.equal(value.tokenMatches, true);
  assert.equal(value.host, 'github.com');
  assert.equal(value.config, config);
  assert.equal(value.enterprise, false);
  assert.equal(value.debug, false);
  assert.ok(!success.stdout.includes(TOKEN));
  for (const args of [
    ['auth', 'token'],
    ['--help', 'auth', 'token'],
    ['auth', 'status', '--show-token'],
    ['auth', 'status', '-at'],
    ['auth', 'login'],
    ['alias', 'set', 'test'],
    ['extension', 'exec', 'test'],
    ['api', '/user', '--hostname', 'example.com'],
    ['repo', 'view', '-Rexample.com/o/r'],
    ['api', 'http://api.github.com/user'],
    ['api', 'https://example.com/user'],
  ]) {
    await assert.rejects(
      run(wrapper, args, { env }),
      error => !error.stdout.includes(TOKEN) && !error.stderr.includes(TOKEN),
    );
  }
  const ticket = await f.github.execute({
    type: 'disconnect',
    revision: f.github.summary().revision,
  });
  await f.github.execute({
    type: 'disconnect',
    revision: ticket.revision,
    confirmation: ticket.token,
  });
  await assert.rejects(run(wrapper, ['api', '/user'], { env }), /PAT is unavailable/);
  assert.equal(JSON.parse((await run(wrapper, ['--version'], { env })).stdout).tokenMatches, false);
});

test('CLI setup rejects redirected managed directories without modifying outside files', async t => {
  const f = await setup(t);
  const outside = path.join(f.root, 'outside');
  await mkdir(outside);
  await writeFile(path.join(outside, 'keep'), 'KEEP');
  await symlink(outside, path.join(f.state, 'bin'));
  await assert.rejects(installGitTools(f.state), /Unsafe managed CLI directory/);
  assert.equal(await readFile(path.join(outside, 'keep'), 'utf8'), 'KEEP');
});

test('durable CodingTools inherit the profile CLI environment without a second agent or token in entries', async t => {
  const f = await setup(t);
  await f.save(TOKEN);
  const prefix = path.join(f.root, 'usr');
  await mkdir(path.join(prefix, 'bin'), { recursive: true });
  await writeExecutable(
    path.join(prefix, 'bin/gh'),
    `#!${process.execPath}
if (!process.env.GH_TOKEN) process.exit(1);
console.log('DURABLE_PROFILE_GITHUB_CLI_OK');
`,
  );
  const shellEnv = await installGitTools(f.state, prefix);
  const k = await fixture(t, { shellEnv });
  k.faux.setResponses([
    fauxAssistantMessage([fauxToolCall('bash', { command: 'gh api /user' })], {
      stopReason: 'toolUse',
    }),
    fauxAssistantMessage([fauxText('profile CLI finished')]),
  ]);
  await k.kernel.execute({
    type: 'input',
    conversationId: 1,
    text: 'scripted profile CLI fixture',
    mode: 'reject',
  });
  const view = await eventually(
    () => k.kernel.snapshot(),
    value => !busy(value) && messages(value).length >= 3,
  );
  assert.ok(
    messages(view).some(
      message =>
        message.role === 'toolResult' &&
        message.toolName === 'bash' &&
        JSON.stringify(message.content).includes('DURABLE_PROFILE_GITHUB_CLI_OK'),
    ),
  );
  assert.ok(!JSON.stringify(view).includes(TOKEN));
});

test('GitHub API is authenticated, secret-free and separate from durable conversations', async t => {
  const f = await setup(t);
  const k = await fixture(t, { demo: false });
  const controller = withGitHub(k.kernel, f.github);
  const bridge = await createBridge(controller, 'test-github-bridge', 0, undefined, f.github);
  t.after(() => bridge.close());
  const headers = { 'x-pi-token': 'test-github-bridge', 'content-type': 'application/json' };
  const before = await controller.snapshot();
  assert.equal((await fetch(bridge.url + '/api/github')).status, 401);
  assert.equal((await fetch(bridge.url + '/api/github?token=no', { headers })).status, 400);
  const post = action =>
    fetch(bridge.url + '/api/github', { method: 'POST', headers, body: JSON.stringify(action) });
  assert.equal((await post({ type: 'save', revision: 0, token: TOKEN })).status, 200);
  const view = await controller.snapshot();
  assert.equal(view.github.connected, true);
  assert.deepEqual(view.conversation, before.conversation);
  assert.ok(!JSON.stringify(view).includes(TOKEN));
  assert.ok(
    !JSON.stringify(await (await fetch(bridge.url + '/api/github', { headers })).json()).includes(
      TOKEN,
    ),
  );
  for (const file of ['/github.json', '/runtime/github.ts', '/bin/git-askpass.cjs']) {
    assert.equal((await fetch(bridge.url + file)).status, 404);
  }
  assert.deepEqual(
    await controller.execute({ type: 'input', conversationId: 1, text: '/github', mode: 'steer' }),
    { kind: 'dialog', dialog: 'github' },
  );
  await assert.rejects(
    controller.execute({
      type: 'input',
      conversationId: 1,
      text: `/github ${TOKEN}`,
      mode: 'steer',
    }),
  );
  assert.deepEqual((await controller.snapshot()).conversation, before.conversation);
});

test(
  'GitHub mobile dialog masks and clears PAT, preserves drafts and confirms disconnect',
  { skip: !process.env.PI_TEST_CHROME },
  async t => {
    const f = await setup(t);
    const k = await fixture(t, { demo: false });
    const controller = withGitHub(k.kernel, f.github);
    const bridge = await createBridge(controller, 'test-github-ui', 0, undefined, f.github);
    const { chromium } = await import('playwright-core');
    const browser = await chromium.launch({
      executablePath: process.env.PI_TEST_CHROME,
      headless: true,
    });
    try {
      const page = await browser.newPage({ viewport: { width: 360, height: 730 } });
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      await page.goto(bridge.url + '/#token=test-github-ui');
      const editor = page.locator('#message');
      await page.waitForFunction(() => !document.getElementById('message').disabled);
      await editor.fill('/github');
      await page.getByRole('button', { name: '送信', exact: true }).click();
      const input = page.locator('#github-token');
      await input.waitFor();
      assert.equal(await input.getAttribute('type'), 'password');
      await page.waitForFunction(() => !document.getElementById('github-token').disabled);
      await input.fill(TOKEN);
      await page.getByRole('button', { name: '閉じる', exact: true }).click();
      await editor.fill('保持するdraft 👩‍💻');
      await page.locator('#menu').click();
      await page.getByRole('button', { name: 'GitHub認証を設定', exact: true }).click();
      assert.equal(await input.inputValue(), '');
      await input.fill(TOKEN);
      await page.getByRole('button', { name: 'PATを確認して保存', exact: true }).click();
      await page.getByText(/@test-user/).waitFor();
      assert.equal(await input.inputValue(), '');
      await page.getByRole('button', { name: 'GitHub認証を解除', exact: true }).click();
      await page.getByRole('button', { name: '閉じる', exact: true }).click();
      await page.getByRole('heading', { name: 'GitHub認証', exact: true }).waitFor();
      assert.equal(f.github.summary().connected, true);
      await page.getByRole('button', { name: 'GitHub認証を解除', exact: true }).click();
      await page.getByRole('button', { name: '認証を解除する', exact: true }).click();
      await eventually(
        () => f.github.summary(),
        value => !value.connected,
      );
      await page.getByRole('button', { name: '閉じる', exact: true }).click();
      assert.equal(await editor.inputValue(), '保持するdraft 👩‍💻');
      assert.equal(k.faux.state.callCount, 0);
      assert.deepEqual(errors, []);
      assert.ok(!JSON.stringify(await controller.snapshot()).includes(TOKEN));
      assert.equal(
        await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
        true,
      );
    } finally {
      await browser.close();
      await bridge.close();
    }
  },
);
