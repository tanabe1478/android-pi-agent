import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, unlink, lstat, symlink } from 'node:fs/promises';
import path from 'node:path';

import { captureViewport } from '../runtime/browser-image.ts';
import { createCapture } from '../runtime/browser-capture.ts';
import { createBridge } from '../runtime/bridge.ts';
import { createPreview } from '../runtime/browser-preview.ts';
import { fixture, eventually } from './helpers.mjs';

const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const state = async () => ({ available: true, pid: 123, url: 'http://localhost:8080/' });

async function answer(directory, request, changes = {}) {
  await writeFile(path.join(directory, `.preview-image-${request.id}.png`), png, { mode: 0o600 });
  await writeFile(
    path.join(directory, `.preview-image-${request.id}.json`),
    JSON.stringify({
      version: 1,
      id: request.id,
      parentPid: 10,
      runtimePid: 11,
      pid: 123,
      renderer: 'webview-hardware',
      ok: true,
      ...changes,
    }),
  );
}

async function requested(directory) {
  return eventually(
    async () => {
      try {
        return JSON.parse(await readFile(path.join(directory, 'preview-capture.json'), 'utf8'));
      } catch {
        return undefined;
      }
    },
    value => Boolean(value),
  );
}

test('native capture is one owner-bound foreground request with bounded PNG and owned cleanup', async t => {
  const f = await fixture(t);
  const capture = createCapture(f.stateDir, 10, 11, state);
  const pending = capture.capture(9000);
  const request = await requested(f.stateDir);
  assert.equal(request.previewPid, 123);
  assert.equal(request.parentPid, 10);
  assert.equal(request.runtimePid, 11);
  assert.equal((await lstat(path.join(f.stateDir, 'preview-capture.json'))).mode & 511, 384);
  await assert.rejects(capture.capture(9000), error => error.code === 'preview_busy');
  await answer(f.stateDir, request);
  assert.deepEqual(await pending, png);
  await assert.rejects(lstat(path.join(f.stateDir, 'preview-capture.json')));
  await assert.rejects(lstat(path.join(f.stateDir, `.preview-image-${request.id}.png`)));
});

test('native capture preserves another pending request and rejects background or stale replies', async t => {
  const f = await fixture(t);
  const file = path.join(f.stateDir, 'preview-capture.json');
  await writeFile(file, JSON.stringify({ id: 'not-ours' }));
  const capture = createCapture(f.stateDir, 10, 11, state);
  await assert.rejects(capture.capture(9000), error => error.code === 'preview_pending');
  assert.equal(JSON.parse(await readFile(file, 'utf8')).id, 'not-ours');
  await unlink(file);
  const hidden = createCapture(f.stateDir, 10, 11, async () => ({ available: false }));
  await assert.rejects(hidden.capture(9000), error => error.code === 'preview_unavailable');
  const pending = capture.capture(9000);
  const request = await requested(f.stateDir);
  await answer(f.stateDir, request, { runtimePid: 99 });
  await assert.rejects(pending, error => error.code === 'preview_capture');
});

test('native capture rejects old software-renderer results without accepting a partial image', async t => {
  const f = await fixture(t);
  const capture = createCapture(f.stateDir, 10, 11, state);
  const pending = capture.capture(9000);
  const request = await requested(f.stateDir);
  await answer(f.stateDir, request, { renderer: 'webview-software' });
  await assert.rejects(pending, error => error.code === 'preview_capture');
  await assert.rejects(lstat(path.join(f.stateDir, `.preview-image-${request.id}.png`)));
});

test('native timeout/shutdown do not replay capture and linked image results cannot be read', async t => {
  const f = await fixture(t);
  const capture = createCapture(f.stateDir, 10, 11, state, 30);
  await assert.rejects(capture.capture(9000), error => error.code === 'preview_timeout');
  await assert.rejects(lstat(path.join(f.stateDir, 'preview-capture.json')));
  const pending = capture.capture(9000);
  const request = await requested(f.stateDir);
  capture.close();
  await assert.rejects(pending);
  await assert.rejects(capture.capture(9000), error => error.code === 'closed');
  const other = createCapture(f.stateDir, 10, 11, state);
  const redirected = other.capture(9000);
  const next = await requested(f.stateDir);
  await answer(f.stateDir, next);
  await unlink(path.join(f.stateDir, `.preview-image-${next.id}.png`));
  await symlink(
    path.join(f.stateDir, 'session.sqlite'),
    path.join(f.stateDir, `.preview-image-${next.id}.png`),
  );
  await assert.rejects(redirected, error => error.code === 'preview_capture');
  assert.ok(await lstat(path.join(f.stateDir, 'session.sqlite')));
});

test('native screenshot HTTP is authenticated, accepts no path argument and returns PNG only', async t => {
  const f = await fixture(t);
  const preview = createPreview(f.stateDir, process.pid);
  let calls = 0;
  preview.capture = async () => {
    calls++;
    return png;
  };
  const bridge = await createBridge(f.kernel, 'capture-token', 0, undefined, undefined, preview);
  t.after(() => bridge.close());
  const route = bridge.url + '/api/browser/screenshot';
  assert.equal((await fetch(route, { method: 'POST' })).status, 401);
  const headers = { 'x-pi-token': 'capture-token', 'content-type': 'application/json' };
  assert.equal(
    (await fetch(route, { method: 'POST', headers, body: '{"path":"private"}' })).status,
    400,
  );
  const response = await fetch(route, { method: 'POST', headers, body: '{}' });
  assert.equal(response.headers.get('content-type'), 'image/png');
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), png);
  assert.equal(calls, 1);
  assert.equal(f.faux.state.callCount, 0);
});

test('native source confines hardware rendering to the preview view and cancels on background', async () => {
  // Source boundary guard, not an Android rendering or lifecycle execution test.
  const directory = '../android/app/src/main/java/io/github/tanabe1478/androidpi/';
  const source = await readFile(
    new URL(directory + 'PreviewCapture.java', import.meta.url),
    'utf8',
  );
  const activity = await readFile(
    new URL(directory + 'PreviewActivity.java', import.meta.url),
    'utf8',
  );
  assert.match(source, /view\.postVisualStateCallback/);
  assert.match(source, /ImageReader\.newInstance/);
  assert.match(source, /surface\.lockHardwareCanvas\(\)/);
  assert.match(source, /view\.draw\(canvas\)/);
  assert.match(source, /foreground\.getAsBoolean\(\)/);
  assert.doesNotMatch(source, /getWindow\s*\(|PixelCopy|MediaProjection|takeScreenshot/);
  assert.match(activity, /onPause\(\)\s*\{[^}]*capture\.cancel\(\)/);
  assert.match(activity, /onDestroy\(\)\s*\{[^}]*capture\.cancel\(\)/);
});

test('desktop capture keeps Playwright viewport PNG with an explicit timeout', async () => {
  let options;
  const page = {
    async screenshot(value) {
      options = value;
      return png;
    },
  };
  assert.deepEqual(await captureViewport(page, 1234), png);
  assert.deepEqual(options, { type: 'png', timeout: 1234 });
});
