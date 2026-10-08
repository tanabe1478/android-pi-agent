import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

import { parentPid, publishBridge, removeBridge, watchParent } from '../runtime/host-channel.ts';
import { eventually } from './helpers.mjs';

async function directory(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'android-pi-host-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test('host metadata is private, atomic and cleanup cannot remove another owner record', async t => {
  const root = await directory(t);
  const file = path.join(root, 'bridge.json');
  await publishBridge(root, { port: 12345, token: 'fixture-token', parentPid: 42 });

  const record = JSON.parse(await readFile(file, 'utf8'));
  assert.equal(record.pid, process.pid);
  assert.equal(record.parentPid, 42);
  assert.equal(record.version, 1);
  assert.equal((await stat(file)).mode & 0o777, 0o600);

  await removeBridge(root, 'other-fixture-token');
  assert.equal(JSON.parse(await readFile(file, 'utf8')).port, 12345);
  await removeBridge(root, 'fixture-token');
  await assert.rejects(readFile(file), error => error.code === 'ENOENT');
});

test('parent IDs are strict and disappearance differs from permission denial', async () => {
  assert.equal(parentPid(undefined), undefined);
  assert.equal(parentPid('42'), 42);
  for (const value of ['0', '-1', '01', '1e2', 'NaN', '2147483648']) {
    assert.throws(() => parentPid(value));
  }

  let missing = 0;
  let probes = 0;
  let dispose;
  await new Promise(resolve => {
    dispose = watchParent(
      42,
      () => {
        missing++;
        dispose();
        resolve();
      },
      5,
      () => {
        probes++;
        throw Object.assign(new Error('fixture'), { code: probes === 1 ? 'EPERM' : 'ESRCH' });
      },
    );
  });
  assert.equal(missing, 1);
  assert.equal(probes, 2);
});

test('native-mode demo publishes readiness without logging its token and exits when its owner dies', async t => {
  const root = await directory(t);
  const workspace = path.join(root, 'work');
  const state = path.join(root, 'state');
  await mkdir(workspace);

  const owner = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  const child = spawn(
    process.execPath,
    [
      fileURLToPath(new URL('../runtime/main.ts', import.meta.url)),
      '--demo',
      '--bridge-file',
      '--parent-pid',
      String(owner.pid),
      '--workspace',
      workspace,
      '--state',
      state,
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
  let exited = false;
  let code;
  child.once('exit', value => {
    exited = true;
    code = value;
  });
  t.after(() => {
    owner.kill('SIGTERM');
    child.kill('SIGKILL');
  });

  const file = path.join(state, 'bridge.json');
  const ready = await eventually(
    async () => {
      try {
        return JSON.parse(await readFile(file, 'utf8'));
      } catch {
        return null;
      }
    },
    value => value?.version === 1,
  );
  assert.equal(ready.pid, child.pid);
  assert.equal(ready.parentPid, owner.pid);
  assert.ok(!output.includes(ready.token));
  const response = await fetch(`http://127.0.0.1:${ready.port}/api/view`, {
    headers: { 'x-pi-token': ready.token },
  });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).demo, true);

  owner.kill('SIGTERM');
  await eventually(
    async () => exited,
    value => value,
    5000,
  );
  assert.equal(code, 0);
  await assert.rejects(readFile(file), error => error.code === 'ENOENT');
  assert.ok((await stat(path.join(state, 'session.sqlite'))).isFile());
});
