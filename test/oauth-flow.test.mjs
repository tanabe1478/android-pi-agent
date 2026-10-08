import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { openAuthentication } from '../runtime/auth.ts';
import { openCredentials } from '../runtime/credentials.ts';
import { eventually } from './helpers.mjs';

async function callbackPortFree() {
  const server = http.createServer();
  return new Promise((resolve, reject) => {
    server.once('error', error => {
      if (error.code === 'EADDRINUSE') resolve(false);
      else reject(error);
    });
    server.listen(1455, '127.0.0.1', () => server.close(() => resolve(true)));
  });
}

async function callback(url) {
  return new Promise((resolve, reject) => {
    http
      .get(url, { agent: false }, response => {
        response.resume();
        response.once('end', () => resolve(response.statusCode));
      })
      .once('error', reject);
  });
}

test('built-in ChatGPT callback checks state, exchanges/refreshes through mocked network and closes on cancel', async t => {
  // Never interfere with a real host Pi login which already owns this provider's fixed port.
  if (!(await callbackPortFree())) {
    t.skip('OAuth callback port 1455 is already owned; preserved the existing login.');
    return;
  }
  process.env.PI_OAUTH_CALLBACK_HOST = '127.0.0.1';
  const state = await mkdtemp(path.join(os.tmpdir(), 'android-pi-oauth-test-'));
  const requests = [];
  // No remote traffic is permitted in this test, including unexpected provider requests.
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    assert.equal(String(url), 'https://auth.openai.com/api/accounts/oauth/token');
    const form = options.body;
    const grant = form.get('grant_type');
    requests.push(grant);
    assert.equal(form.get('client_id'), 'test-only-issued-client');
    assert.equal(form.get('resource'), 'https://api.openai.com/v1');
    if (grant === 'authorization_code') {
      assert.equal(form.get('code'), 'test-only-authorization-code');
      assert.ok(form.get('code_verifier'));
    } else {
      assert.equal(grant, 'refresh_token');
      assert.equal(form.get('refresh_token'), 'test-only-refresh-token');
    }
    return new Response(
      JSON.stringify({
        access_token: 'test-only-access-token',
        refresh_token: 'test-only-refresh-token',
        id_token: 'test-only-id-token',
        scope: 'openid offline_access chatgpt.tokens.use.direct',
        expires_in: 3600,
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  });
  const { auth, models } = await openAuthentication(state);
  t.after(async () => {
    await auth.close();
    await rm(state, { recursive: true, force: true });
  });

  auth.execute({ type: 'start' });
  const pending = await eventually(
    () => auth.snapshot(),
    value => Boolean(value.url && value.promptId),
  );
  const authorization = new URL(pending.url);
  assert.equal(
    authorization.searchParams.get('redirect_uri'),
    'http://127.0.0.1:1455/auth/callback',
  );
  assert.match(authorization.searchParams.get('ext_agent_host_id'), /^urn:uuid:/);
  const result = new URL(authorization.searchParams.get('redirect_uri'));
  result.search = new URLSearchParams({
    state: 'wrong-test-state',
    code: 'test-only-authorization-code',
    client_id: 'test-only-issued-client',
  }).toString();
  assert.equal(await callback(result), 400);
  assert.equal(auth.summary().status, 'pending');
  result.searchParams.set('state', authorization.searchParams.get('state'));
  assert.equal(await callback(result), 200);
  await eventually(
    () => auth.summary(),
    value => value.status === 'done',
  );
  assert.equal(auth.summary().connected, true);
  assert.deepEqual(requests, ['authorization_code']);
  assert.ok(!JSON.stringify(auth.snapshot()).includes('test-only-access-token'));
  assert.ok(await callbackPortFree());

  const store = await openCredentials(state);
  await store.modify('openai', async current => ({ ...current, expires: 1 }));
  await models.getAuth('openai');
  assert.deepEqual(requests, ['authorization_code', 'refresh_token']);

  auth.execute({ type: 'start' });
  const second = await eventually(
    () => auth.snapshot(),
    value => Boolean(value.url && value.promptId),
  );
  assert.notEqual(second.sessionId, pending.sessionId);
  auth.execute({ type: 'cancel', sessionId: second.sessionId });
  await eventually(
    () => auth.summary(),
    value => value.status === 'cancelled',
  );
  assert.ok(await callbackPortFree());
  assert.equal(auth.summary().connected, true);
});
