import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { fauxProvider, fauxAssistantMessage, fauxText } from '@earendil-works/pi-ai';

import { installationId, openCredentials } from '../runtime/credentials.ts';
import {
  chatGPTAuthorizationURL,
  openAuthentication,
  parseAuthAction,
  withAuthentication,
} from '../runtime/auth.ts';
import { createBridge } from '../runtime/bridge.ts';
import { fixture, eventually, messages, busy } from './helpers.mjs';

const dummyCredential = () => ({
  type: 'oauth',
  access: 'test-only-access-not-a-real-token',
  refresh: 'test-only-refresh-not-a-real-token',
  expires: Date.now() + 3_600_000,
  clientId: 'test-only-client',
  scopes: ['chatgpt.tokens.use.direct'],
});

async function directory(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'android-pi-auth-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

function providerFixture(overrides = {}) {
  const faux = fauxProvider({
    provider: 'openai',
    models: [{ id: 'test-chat', reasoning: true }],
  });
  const provider = {
    ...faux.provider,
    auth: {
      oauth: {
        name: 'Test-only ChatGPT OAuth',
        async login(interaction, options) {
          assert.match(options.getDeviceId(), /^[0-9a-f-]{36}$/);
          interaction.notify({
            type: 'auth_url',
            url: 'https://auth.openai.com/api/accounts/authorize?state=test-only-state',
          });
          const answer = await interaction.prompt({
            type: 'manual_code',
            signal: interaction.signal,
          });
          if (answer !== 'test-only-callback') throw new Error('private-response-must-not-escape');
          return dummyCredential();
        },
        refresh: async () => dummyCredential(),
        toAuth: async credential => ({ apiKey: credential.access }),
        ...overrides,
      },
    },
  };
  return { provider, faux };
}

async function authFixture(t, options = {}) {
  const state = await directory(t);
  const p = providerFixture(options.oauth);
  const result = await openAuthentication(state, {
    provider: p.provider,
    timeoutMs: options.timeoutMs,
  });
  t.after(() => result.auth.close());
  return { ...result, ...p, state };
}

async function login(auth, answer = 'test-only-callback') {
  auth.execute({ type: 'start' });
  const state = await eventually(
    () => auth.snapshot(),
    value => Boolean(value.promptId),
  );
  auth.execute({ type: 'respond', sessionId: state.sessionId, promptId: state.promptId, answer });
  return eventually(
    () => auth.snapshot(),
    value => value.status !== 'pending',
  );
}

test('private OAuth storage serializes writes, retains provider fields and enumerates no secrets', async t => {
  const state = await directory(t);
  const store = await openCredentials(state);
  assert.deepEqual(await store.list(), []);
  await store.modify('openai', async () => dummyCredential());
  await Promise.all(
    Array.from({ length: 12 }, () =>
      store.modify('openai', async current => ({
        ...current,
        count: (current.count ?? 0) + 1,
      })),
    ),
  );
  const stored = await store.read('openai');
  assert.equal(stored.count, 12);
  assert.equal(stored.clientId, 'test-only-client');
  assert.deepEqual(await store.list(), [{ providerId: 'openai', type: 'oauth' }]);
  assert.equal((await stat(state)).mode & 0o777, 0o700);
  assert.equal((await stat(path.join(state, 'auth.json'))).mode & 0o777, 0o600);
  assert.deepEqual(await readdir(state), ['auth.json']);
  assert.deepEqual(await (await openCredentials(state)).read('openai'), stored);

  const cancelled = new AbortController();
  cancelled.abort();
  await assert.rejects(
    store.modify('openai', async () => dummyCredential(), { signal: cancelled.signal }),
  );
  assert.deepEqual(await store.read('openai'), stored);
});

test('corrupt or linked authentication is not erased and errors never echo private contents', async t => {
  const state = await directory(t);
  const store = await openCredentials(state);
  const file = path.join(state, 'auth.json');
  const privateText = '{private-response-must-not-escape';
  await writeFile(file, privateText);
  await assert.rejects(store.list(), error => !error.message.includes(privateText));
  assert.equal(await readFile(file, 'utf8'), privateText);
  await rm(file);
  const outside = path.join(state, 'other.json');
  await writeFile(outside, JSON.stringify({ openai: dummyCredential() }));
  await symlink(outside, file);
  await assert.rejects(store.read('openai'));
  assert.ok((await readFile(outside, 'utf8')).includes('test-only-access'));
});

test('installation identity is stable, private and is not regenerated when invalid', async t => {
  const state = await directory(t);
  const first = await installationId(state);
  assert.equal(await installationId(state), first);
  const file = path.join(state, 'installation.json');
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  await writeFile(file, '{private-response-must-not-escape');
  await assert.rejects(installationId(state), error => !error.message.includes('private-response'));
  assert.equal(await readFile(file, 'utf8'), '{private-response-must-not-escape');
});

test('auth protocol rejects unknown fields and stale session/prompt replies', async t => {
  for (const candidate of [
    null,
    [],
    { type: 'start', token: 'anything' },
    { type: 'logout' },
    { type: 'cancel', sessionId: 1 },
    { type: 'respond', sessionId: 'a', promptId: 'b', answer: '' },
  ]) {
    assert.throws(
      () => parseAuthAction(candidate),
      error => error.code === 'invalid_action',
    );
  }
  const { auth } = await authFixture(t);
  auth.execute({ type: 'start' });
  const state = await eventually(
    () => auth.snapshot(),
    value => Boolean(value.promptId),
  );
  auth.execute({ type: 'start' });
  assert.equal(auth.snapshot().sessionId, state.sessionId);
  assert.throws(() => auth.execute({ type: 'cancel', sessionId: 'other-session' }), /古く/);
  assert.throws(
    () =>
      auth.execute({
        type: 'respond',
        sessionId: state.sessionId,
        promptId: 'old',
        answer: 'answer',
      }),
    /終了/,
  );
  auth.execute({ type: 'cancel', sessionId: state.sessionId });
  await eventually(
    () => auth.snapshot(),
    value => value.status === 'cancelled',
  );
  assert.equal(auth.snapshot().url, undefined);
  assert.equal(auth.snapshot().promptId, undefined);
  assert.equal(auth.summary().connected, false);
});

test('login persists only through pi-ai, preserves old auth on failed reauthentication and times out', async t => {
  const f = await authFixture(t);
  assert.equal((await login(f.auth)).status, 'done');
  const json = JSON.stringify(f.auth.snapshot());
  assert.ok(!json.includes('test-only-access'));
  assert.ok(!json.includes('test-only-refresh'));
  assert.equal(f.auth.snapshot().url, undefined);
  assert.equal((await login(f.auth, 'wrong-answer')).status, 'error');
  assert.equal(f.auth.summary().connected, true);
  assert.ok(!JSON.stringify(f.auth.snapshot()).includes('private-response'));
  await f.auth.close();
  const reopened = await openAuthentication(f.state, { provider: f.provider });
  t.after(() => reopened.auth.close());
  assert.equal(reopened.auth.summary().connected, true);

  const bounded = await authFixture(t, { timeoutMs: 30 });
  bounded.auth.execute({ type: 'start' });
  await eventually(
    () => bounded.auth.snapshot(),
    value => value.status === 'timeout',
  );
  assert.equal(bounded.auth.summary().connected, false);
});

test('refresh is serialized by pi-ai and errors are redacted without credential or env fallback', async t => {
  let refreshes = 0;
  const f = await authFixture(t, {
    oauth: {
      async refresh(current) {
        refreshes++;
        await new Promise(resolve => setTimeout(resolve, 20));
        return { ...current, expires: Date.now() + 3_600_000, access: 'test-only-rotated-access' };
      },
    },
  });
  await login(f.auth);
  const store = await openCredentials(f.state);
  await store.modify('openai', async current => ({ ...current, expires: 1 }));
  await Promise.all([f.models.getAuth('openai'), f.models.getAuth('openai')]);
  assert.equal(refreshes, 1);
  assert.equal((await store.read('openai')).access, 'test-only-rotated-access');

  const broken = await authFixture(t, {
    oauth: {
      refresh: async () => {
        throw new Error('private-response-must-not-escape');
      },
    },
  });
  await login(broken.auth);
  const brokenStore = await openCredentials(broken.state);
  await brokenStore.modify('openai', async current => ({ ...current, expires: 1 }));
  await assert.rejects(
    broken.models.getAuth('openai'),
    error => !error.message.includes('private-response'),
  );
  assert.equal((await brokenStore.read('openai')).access, dummyCredential().access);
  assert.equal(await f.models.getAuth('unknown-provider'), undefined);
  const unauthenticated = await authFixture(t);
  assert.equal(await unauthenticated.models.checkAuth('openai'), undefined);
  assert.equal(await unauthenticated.models.getAuth('openai'), undefined);
});

test('authorization link allowlist rejects remote redirects, credentials and non-HTTPS schemes', async t => {
  assert.equal(
    chatGPTAuthorizationURL('https://auth.openai.com/api/accounts/authorize?state=test-only'),
    true,
  );
  for (const url of [
    'http://auth.openai.com/api/accounts/authorize',
    'https://auth.openai.com.attacker.invalid/api/accounts/authorize',
    'https://user:secret@auth.openai.com/api/accounts/authorize',
    'https://auth.openai.com:444/api/accounts/authorize',
    'https://auth.openai.com/api/accounts/authorize#private',
    'intent://anything',
  ])
    assert.equal(chatGPTAuthorizationURL(url), false);

  const unsafe = await authFixture(t, {
    oauth: {
      async login(interaction) {
        interaction.notify({ type: 'auth_url', url: 'https://attacker.invalid/' });
        assert.equal(interaction.signal.aborted, true);
        return dummyCredential();
      },
    },
  });
  unsafe.auth.execute({ type: 'start' });
  await eventually(
    () => unsafe.auth.summary(),
    value => value.status === 'error',
  );
  assert.equal(unsafe.auth.snapshot().url, undefined);
  assert.equal(unsafe.auth.summary().connected, false);
});

test('authenticated bridge keeps OAuth URLs out of AppView and durable, and gates model input/compaction', async t => {
  const a = await authFixture(t);
  const f = await fixture(t, {
    models: a.models,
    demo: false,
    initialModel: { provider: 'openai', modelId: 'test-chat' },
    authorizeModel: a.auth.assertModel,
  });
  const kernel = withAuthentication(f.kernel, a.auth);
  const bridge = await createBridge(kernel, 'test-only-bridge-header', 0, a.auth);
  t.after(() => bridge.close());
  const headers = { 'x-pi-token': 'test-only-bridge-header' };
  assert.equal((await fetch(bridge.url + '/api/auth')).status, 401);
  assert.equal((await fetch(bridge.url + '/api/auth?token=anything', { headers })).status, 400);
  assert.equal((await fetch(bridge.url + '/auth.json')).status, 404);
  assert.equal((await fetch(bridge.url + '/runtime/credentials.ts')).status, 404);
  for (const action of [
    { type: 'input', text: 'before login', mode: 'reject' },
    { type: 'compact' },
  ]) {
    await assert.rejects(
      kernel.execute({ ...action, conversationId: 1 }),
      error => error.code === 'login_required',
    );
  }
  assert.equal(messages(await kernel.snapshot()).length, 0);
  const post = async action =>
    fetch(bridge.url + '/api/auth', {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify(action),
    });
  assert.equal((await post({ type: 'start', extra: true })).status, 400);
  assert.equal((await post({ type: 'start' })).status, 200);
  const pending = await eventually(
    () => a.auth.snapshot(),
    value => Boolean(value.url),
  );
  const view = await kernel.snapshot();
  assert.equal(view.auth.status, 'pending');
  assert.ok(!JSON.stringify(view).includes(pending.url));
  assert.equal(
    (await (await fetch(bridge.url + '/api/auth', { headers })).json()).url,
    pending.url,
  );
  a.auth.execute({
    type: 'respond',
    sessionId: pending.sessionId,
    promptId: pending.promptId,
    answer: 'test-only-callback',
  });
  await eventually(
    () => a.auth.summary(),
    value => value.connected,
  );
  a.faux.setResponses([fauxAssistantMessage([fauxText('authenticated durable test response')])]);
  await kernel.execute({ type: 'input', conversationId: 1, text: 'after login', mode: 'reject' });
  const completed = await eventually(
    () => kernel.snapshot(),
    value => messages(value).length >= 2 && !busy(value),
  );
  assert.ok(messages(completed).some(message => message.role === 'assistant'));
  assert.equal(a.faux.state.callCount, 1);
  assert.ok(!JSON.stringify(completed).includes('test-only-access'));
  assert.ok(!JSON.stringify(completed).includes('test-only-refresh'));
});

test(
  'mobile auth UI cancels, masks manual input, hides authenticated login and retains menu reauth',
  { skip: !process.env.PI_TEST_CHROME },
  async t => {
    const a = await authFixture(t);
    const f = await fixture(t, {
      models: a.models,
      demo: false,
      initialModel: { provider: 'openai', modelId: 'test-chat' },
      authorizeModel: a.auth.assertModel,
    });
    const kernel = withAuthentication(f.kernel, a.auth);
    const bridge = await createBridge(kernel, 'test-only-browser-header', 0, a.auth);
    const { chromium } = await import('playwright-core');
    const browser = await chromium.launch({
      executablePath: process.env.PI_TEST_CHROME,
      headless: true,
    });
    try {
      const page = await browser.newPage({ viewport: { width: 360, height: 780 } });
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      await page.goto(bridge.url + '/#token=test-only-browser-header');
      await page.getByRole('button', { name: 'ChatGPTログイン', exact: true }).click();
      await page.getByRole('button', { name: 'ChatGPTログインを開始', exact: true }).click();
      await page.getByRole('link', { name: '外部ブラウザで続ける' }).waitFor();
      await page.getByRole('button', { name: 'ログインを取消', exact: true }).click();
      await page.getByText('ログインをキャンセルしました。', { exact: true }).waitFor();
      await page.getByRole('button', { name: 'ChatGPTログインを開始', exact: true }).click();
      const callback = page.locator('#oauth-callback');
      await callback.waitFor();
      assert.equal(await callback.getAttribute('type'), 'password');
      await callback.fill('test-only-callback');
      await page.getByRole('button', { name: '閉じる', exact: true }).click();
      await page.getByRole('button', { name: 'ChatGPTログイン', exact: true }).click();
      assert.equal(await callback.inputValue(), '');
      await callback.fill('test-only-callback');
      await page.getByRole('button', { name: 'callback URLを送る', exact: true }).click();
      await page.getByRole('button', { name: 'モデルを選ぶ', exact: true }).waitFor();
      await page.waitForFunction(() => document.getElementById('auth-bar').hidden);
      assert.equal(await page.locator('#auth-bar').isVisible(), false);
      await page.getByRole('button', { name: '閉じる', exact: true }).click();
      await page.locator('#menu').click();
      await page.getByRole('button', { name: 'ChatGPTを再認証', exact: true }).click();
      await page.getByRole('heading', { name: 'ChatGPT認証' }).waitFor();
      const dialogText = await page.locator('#dialog-body').textContent();
      assert.ok(!dialogText.includes('test-only-access'));
      assert.ok(!JSON.stringify(await kernel.snapshot()).includes('test-only-callback'));
      await page.getByRole('button', { name: '閉じる', exact: true }).click();
      const editor = page.getByRole('textbox', { name: 'メッセージ' });
      await editor.fill('復帰後も保持するdraft');
      const [read] = await Promise.all([
        page.waitForResponse(response => new URL(response.url()).pathname === '/api/view'),
        page.evaluate(() => document.dispatchEvent(new Event('visibilitychange'))),
      ]);
      await read.finished();
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(resolve)));
      assert.equal(await editor.inputValue(), '復帰後も保持するdraft');
      assert.deepEqual(errors, []);
      const layout = await page.evaluate(() => ({
        width: innerWidth,
        scroll: document.documentElement.scrollWidth,
      }));
      assert.ok(layout.scroll <= layout.width);
    } finally {
      await browser.close();
      await bridge.close();
    }
  },
);
