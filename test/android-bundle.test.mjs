import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

import { eventually } from './helpers.mjs';

const bundle = process.env.PI_TEST_ANDROID_BUNDLE;

test(
  'packaged production-only app boots and reopens the same durable profile',
  { skip: !bundle },
  async t => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'android-pi-bundle-test-'));
    const workspace = path.join(root, 'work');
    const state = path.join(root, 'state');
    await mkdir(workspace);
    execFileSync('tar', ['xzf', path.resolve(bundle), '-C', root]);
    const sdk = execFileSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        "await import('@earendil-works/pi-ai/api/openai-responses'); console.log('TEST_SDK_LOAD_OK');",
      ],
      { cwd: path.join(root, 'app'), encoding: 'utf8' },
    );
    assert.match(sdk, /TEST_SDK_LOAD_OK/);
    let current;
    t.after(async () => {
      if (current) {
        current.child.kill('SIGKILL');
        await current.exit;
      }
      await rm(root, { recursive: true, force: true });
    });

    async function start(demo = true) {
      const child = spawn(
        process.execPath,
        [
          path.join(root, 'app/runtime/main.ts'),
          ...(demo ? ['--demo'] : []),
          '--bridge-file',
          '--parent-pid',
          String(process.pid),
          '--state',
          state,
          '--workspace',
          workspace,
        ],
        { stdio: ['ignore', 'pipe', 'pipe'] },
      );
      let output = '';
      child.stdout.on('data', chunk => {
        output += chunk;
      });
      child.stderr.on('data', chunk => {
        output += chunk;
      });
      const exit = new Promise(resolve => child.once('exit', resolve));
      current = { child, exit };
      const ready = await eventually(
        async () => {
          try {
            return JSON.parse(await readFile(path.join(state, 'bridge.json'), 'utf8'));
          } catch {
            return null;
          }
        },
        value => value?.pid === child.pid,
      );
      assert.ok(!output.includes(ready.token));
      const url = `http://127.0.0.1:${ready.port}`;
      const headers = { 'x-pi-token': ready.token };
      const snapshot = async () => {
        const response = await fetch(url + '/api/view', { headers });
        assert.equal(response.status, 200);
        return response.json();
      };
      return { url, headers, snapshot, child, exit };
    }

    const first = await start();
    let response = await fetch(first.url + '/api/action', {
      method: 'POST',
      headers: { ...first.headers, 'content-type': 'application/json' },
      body: JSON.stringify({
        type: 'input',
        conversationId: 1,
        text: 'packaged fixture',
        mode: 'steer',
      }),
    });
    assert.equal(response.status, 200);
    await eventually(
      first.snapshot,
      view =>
        !view.conversation.docs['pi.live']?.run &&
        view.conversation.entries.some(entry =>
          entry.model?.some(message => message.role === 'assistant'),
        ),
    );
    first.child.kill('SIGTERM');
    assert.equal(await first.exit, 0);

    const second = await start();
    const view = await second.snapshot();
    assert.equal(view.demo, true);
    assert.match(JSON.stringify(view.conversation.entries), /packaged fixture/);
    const selected = view.conversation.docs['pi.agent'].model;
    assert.ok(
      view.models.some(
        model => model.provider === selected.provider && model.modelId === selected.modelId,
      ),
    );
    assert.equal((await fetch(second.url + '/runtime/main.ts')).status, 404);
    second.child.kill('SIGTERM');
    assert.equal(await second.exit, 0);

    // Switching the host to real mode must neither erase nor silently change the saved faux session.
    const third = await start(false);
    const real = await third.snapshot();
    assert.equal(real.demo, false);
    assert.equal(real.auth.connected, false);
    assert.match(JSON.stringify(real.conversation.entries), /packaged fixture/);
    assert.deepEqual(real.conversation.docs['pi.agent'].model, selected);
    assert.ok(real.models.some(model => model.provider === 'openai'));
    assert.equal((await fetch(third.url + '/auth.js')).status, 200);
    third.child.kill('SIGTERM');
    assert.equal(await third.exit, 0);
    current = null;
  },
);
