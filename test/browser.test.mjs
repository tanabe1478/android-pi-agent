import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { once } from 'node:events';
import { promisify } from 'node:util';
import { readFile, writeFile, stat, symlink } from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';

import { WebSocket, WebSocketServer } from 'ws';
import { createPreview, validatePreviewURL, parsePreviewOpen } from '../runtime/browser-preview.ts';
import { createBridge } from '../runtime/bridge.ts';
import { createCDPProxy } from '../runtime/browser-cdp.ts';
import { installGitTools } from '../runtime/cli.ts';
import { fixture } from './helpers.mjs';

const secret = 'T'.repeat(43);
const stopServer = server =>
  new Promise(resolve => {
    server.closeAllConnections();
    server.close(resolve);
  });

async function socketFixture(t, directory) {
  const peers = new Set();
  const wss = new WebSocketServer({ noServer: true });
  const server = http.createServer((request, response) => {
    assert.equal(request.headers['x-pi-token'], undefined);
    response.setHeader('content-type', 'application/json');
    response.end(
      JSON.stringify({
        webSocketDebuggerUrl: 'ws://private/devtools/browser/test-id',
        devtoolsFrontendUrl: 'bypass',
      }),
    );
  });
  server.on('upgrade', (request, socket, head) => {
    assert.equal(request.headers['x-pi-token'], undefined);
    wss.handleUpgrade(request, socket, head, peer => {
      peers.add(peer);
      peer.on('message', (data, binary) => peer.send(data, { binary }));
    });
  });
  const socketPath = path.join(directory, 'preview.sock');
  server.listen(socketPath);
  await once(server, 'listening');
  t.after(async () => {
    for (const peer of peers) peer.terminate();
    wss.close();
    await stopServer(server);
  });
  return { socketPath, server };
}

test('preview URLs and request objects reject remote, bridge, OAuth, userinfo and malformed input', () => {
  for (const url of [
    'https://127.0.0.1:8080/',
    'http://remote:8080/',
    'http://127.0.0.1/',
    'http://127.0.0.1:0/',
    'http://127.0.0.1:1455/',
    'http://127.0.0.1:9000/',
    'http://user:pass@localhost:8080/',
    'file:///tmp/a',
    'intent:x',
    'http://[::1]:8080/',
    'invalid',
  ])
    assert.throws(
      () => validatePreviewURL(url, 9000),
      error => error.code === 'preview_url',
    );
  assert.equal(
    validatePreviewURL('http://localhost:8080/project', 9000),
    'http://localhost:8080/project',
  );
  for (const value of [null, [], { url: 'x', token: secret }, { url: 1 }, {}])
    assert.throws(() => parsePreviewOpen(value));
});

test('preview requests are private, single-publication and cannot overwrite pending or linked metadata', async t => {
  const f = await fixture(t);
  const preview = createPreview(f.stateDir, process.pid);
  const results = await Promise.allSettled([
    preview.open('http://localhost:8080/', 9000),
    preview.open('http://localhost:8081/', 9000),
  ]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  const file = path.join(f.stateDir, 'preview-request.json');
  const before = await readFile(file, 'utf8');
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  const record = JSON.parse(before);
  assert.equal(record.parentPid, process.pid);
  assert.equal(record.runtimePid, process.pid);
  assert.match(record.id, /^[a-f0-9-]{36}$/);
  await assert.rejects(
    preview.open('http://localhost:8082/', 9000),
    error => error.code === 'preview_pending',
  );
  assert.equal(await readFile(file, 'utf8'), before);
  preview.close();
  await assert.rejects(
    preview.open('http://localhost:8082/', 9000),
    error => error.code === 'closed',
  );
  const other = createPreview(f.workspace, process.pid);
  await symlink(file, path.join(f.workspace, 'preview-request.json'));
  await assert.rejects(other.open('http://localhost:8082/', 9000));
  assert.equal(await readFile(file, 'utf8'), before);
});

test('preview debugger metadata is fail-closed for another owner, runtime, main target or dead process', async t => {
  const f = await fixture(t);
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)']);
  t.after(() => child.kill());
  const preview = createPreview(f.stateDir, process.pid);
  const file = path.join(f.stateDir, 'preview-state.json');
  const record = {
    version: 1,
    parentPid: process.pid,
    runtimePid: process.pid,
    pid: child.pid,
    available: true,
    debugging: true,
    url: 'http://localhost:8080/',
  };
  await writeFile(file, JSON.stringify(record));
  assert.equal((await preview.snapshot(9000)).available, true);
  assert.equal(await preview.socketPath(9000), '\0webview_devtools_remote_' + child.pid);
  for (const changed of [
    { parentPid: 0 },
    { runtimePid: 0 },
    { pid: process.pid },
    { url: 'http://localhost:9000/' },
    { available: false },
  ]) {
    await writeFile(file, JSON.stringify({ ...record, ...changed }));
    assert.equal((await preview.snapshot(9000)).available, false);
    await assert.rejects(preview.socketPath(9000));
  }
  child.kill();
  await once(child, 'exit');
  await writeFile(file, JSON.stringify(record));
  assert.equal((await preview.snapshot(9000)).available, false);
});

test('browser HTTP and WebSocket share header/Host/Origin guards and rewrite only approved debugger paths', async t => {
  const f = await fixture(t);
  const unix = await socketFixture(t, f.directory);
  const preview = createPreview(f.stateDir, process.pid);
  preview.socketPath = async () => unix.socketPath;
  const bridge = await createBridge(f.kernel, secret, 0, undefined, undefined, preview);
  t.after(() => bridge.close());
  const headers = { 'x-pi-token': secret };
  assert.equal((await fetch(bridge.url + '/api/browser/status')).status, 401);
  assert.equal(
    (
      await fetch(bridge.url + '/api/browser/status', {
        headers: { ...headers, origin: 'http://localhost:8080' },
      })
    ).status,
    403,
  );
  // Fetch replaces Host; use raw HTTP to actually test the hostile Host header.
  const hostileHost = await new Promise((resolve, reject) => {
    http
      .get(
        bridge.url + '/api/browser/status',
        {
          agent: false,
          headers: { ...headers, host: 'evil:1234' },
        },
        response => {
          response.resume();
          response.once('end', () => resolve(response.statusCode));
        },
      )
      .once('error', reject);
  });
  assert.equal(hostileHost, 403);
  assert.equal((await fetch(bridge.url + '/api/browser/status?token=x', { headers })).status, 400);
  for (const url of ['/api/browser/cdp/json/anything', '/api/browser/cdp/json/version?x=1'])
    assert.ok((await fetch(bridge.url + url, { headers })).status >= 400);
  const metadata = await (
    await fetch(bridge.url + '/api/browser/cdp/json/version', { headers })
  ).json();
  assert.equal(metadata.devtoolsFrontendUrl, undefined);
  assert.equal(
    metadata.webSocketDebuggerUrl,
    bridge.url.replace('http:', 'ws:') + '/api/browser/cdp/devtools/browser/test-id',
  );
  for (const options of [
    {},
    { headers: { ...headers, origin: 'http://localhost:8080' } },
    { headers: { ...headers, host: 'evil:1234' } },
  ]) {
    const peer = new WebSocket(metadata.webSocketDebuggerUrl, options);
    await once(peer, 'error');
    peer.terminate();
  }
  for (const suffix of ['?token=' + secret, '?x=1']) {
    const peer = new WebSocket(metadata.webSocketDebuggerUrl + suffix, { headers });
    await once(peer, 'error');
    peer.terminate();
  }
  const peer = new WebSocket(metadata.webSocketDebuggerUrl, { headers });
  await once(peer, 'open');
  const returned = once(peer, 'message');
  peer.send('fixture message');
  assert.equal(String((await returned)[0]), 'fixture message');
  const disconnected = once(peer, 'close');
  await bridge.close();
  await disconnected;
  assert.equal(f.faux.state.callCount, 0);
});

test('CDP discovery rejects oversized or unsafe discovery without forwarding raw debugger links', async t => {
  const f = await fixture(t);
  const server = http.createServer((_request, response) =>
    response.end('x'.repeat(1024 * 1024 + 1)),
  );
  const file = path.join(f.directory, 'large.sock');
  server.listen(file);
  await once(server, 'listening');
  const proxy = createCDPProxy(async () => file);
  t.after(async () => {
    proxy.close();
    await stopServer(server);
  });
  await assert.rejects(
    proxy.discovery('/json/version', 9999),
    error => error.code === 'preview_debugger',
  );
  await assert.rejects(
    proxy.discovery('/json/private', 9999),
    error => error.code === 'preview_route',
  );
});

test('private pi-browser launcher uses scoped readiness and never starts another agent', async t => {
  const f = await fixture(t);
  const prefix = path.join(f.directory, 'usr');
  const env = await installGitTools(f.stateDir, prefix);
  const launcher = path.join(f.stateDir, 'bin/pi-browser');
  assert.equal((await stat(launcher)).mode & 0o777, 0o700);
  const run = promisify(execFile);
  assert.match(
    (await run(launcher, ['--help'], { env: { ...process.env, ...env } })).stdout,
    /pi-browser open/,
  );
  await writeFile(
    path.join(f.stateDir, 'bridge.json'),
    JSON.stringify({ version: 1, port: 1, token: secret }),
  );
  await assert.rejects(run(launcher, ['status'], { env: { ...process.env, ...env } }), error => {
    assert.ok(!error.stdout.includes(secret) && !error.stderr.includes(secret));
    assert.match(error.stderr, /pi-browser failed/);
    return true;
  });
});
