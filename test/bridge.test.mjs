import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

import { createBridge } from '../runtime/bridge.ts';
import { fixture } from './helpers.mjs';

async function bridgeFixture(t) {
  const f = await fixture(t);
  const token = 'fixture-header-only-token';
  const bridge = await createBridge(f.kernel, token);

  // Registered after kernel teardown: explicitly close transport before its storage.
  const originalClose = f.kernel.close;
  f.kernel.close = async () => {
    await bridge.close();
    await originalClose();
  };
  return { ...f, bridge, token };
}

test('loopback API requires headers, rejects query tokens, hostile origins and invalid actions', async t => {
  const { bridge, token } = await bridgeFixture(t);
  const headers = { 'x-pi-token': token };
  assert.equal((await fetch(bridge.url + '/api/view')).status, 401);
  assert.equal((await fetch(bridge.url + '/api/view?token=' + token)).status, 401);
  assert.equal((await fetch(bridge.url + '/api/view?token=' + token, { headers })).status, 400);
  assert.equal(
    (
      await fetch(bridge.url + '/api/view', {
        headers: { ...headers, origin: 'https://attacker.invalid' },
      })
    ).status,
    403,
  );

  // Fetch overwrites Host; use raw HTTP to actually exercise DNS-rebinding defence.
  const hostileHostStatus = await new Promise((resolve, reject) => {
    http
      .get(
        bridge.url + '/api/view',
        { agent: false, headers: { ...headers, host: 'attacker.invalid' } },
        response => {
          response.resume();
          response.once('end', () => resolve(response.statusCode));
        },
      )
      .once('error', reject);
  });
  assert.equal(hostileHostStatus, 403);

  const response = await fetch(bridge.url + '/api/action', {
    method: 'POST',
    headers: { ...headers, 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'new', conversationId: 1, unexpected: true }),
  });
  assert.equal(response.status, 400);

  const view = await (await fetch(bridge.url + '/api/view', { headers })).json();
  assert.equal(view.sessions.length, 1);
  assert.ok(!JSON.stringify(view).includes(token));

  assert.equal((await fetch(bridge.url + '/runtime/kernel.ts')).status, 404);
  const page = await fetch(bridge.url);
  assert.match(page.headers.get('content-security-policy'), /frame-ancestors 'none'/);
});

test('SSE hydrates a complete committed view, follows mutations and reconnects without replaying them', async t => {
  const { bridge, token } = await bridgeFixture(t);
  const headers = { 'x-pi-token': token };
  const readSnapshot = async reader => {
    let data = '';
    const deadline = AbortSignal.timeout(5000);
    while (!deadline.aborted) {
      const frame = await reader.read();
      assert.equal(frame.done, false);
      data += new TextDecoder().decode(frame.value);
      const end = data.indexOf('\n\n');
      if (end !== -1)
        return JSON.parse(
          data
            .slice(0, end)
            .split('\n')
            .find(line => line.startsWith('data: '))
            .slice(6),
        );
    }
    throw new Error('Missing SSE snapshot');
  };

  const response = await fetch(bridge.url + '/api/events', { headers });
  const reader = response.body.getReader();
  try {
    assert.equal((await readSnapshot(reader)).sessions.length, 1);

    const result = await fetch(bridge.url + '/api/action', {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'new', conversationId: 1, name: 'through transport' }),
    });
    assert.equal(result.status, 200);
    let changed;
    for (let i = 0; i < 5; i++) {
      changed = await readSnapshot(reader);
      if (changed.sessions.length === 2) break;
    }
    assert.equal(changed.sessions.length, 2);

    await reader.cancel();
    const reconnect = await fetch(bridge.url + '/api/events', { headers });
    const nextReader = reconnect.body.getReader();
    try {
      assert.equal((await readSnapshot(nextReader)).sessions.length, 2);
    } finally {
      await nextReader.cancel();
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
});
