import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { once } from 'node:events';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, writeFile } from 'node:fs/promises';

import { chromium } from 'playwright-core';
import { WebSocket, WebSocketServer } from 'ws';
import { createBridge } from '../runtime/bridge.ts';
import { createPreview } from '../runtime/browser-preview.ts';
import { publishBridge } from '../runtime/host-channel.ts';
import { installGitTools } from '../runtime/cli.ts';
import { fixture } from './helpers.mjs';

const closeServer = server =>
  new Promise(resolve => {
    server.closeAllConnections();
    server.close(resolve);
  });

test(
  'pi-browser over authenticated CDP snapshots only visible controls, clicks and captures public PNG without viewport changes',
  {
    skip: !process.env.PI_TEST_CHROME,
    timeout: 30000,
  },
  async t => {
    const f = await fixture(t);
    const reservation = http.createServer();
    reservation.listen(0, '127.0.0.1');
    await once(reservation, 'listening');
    const chromePort = reservation.address().port;
    await closeServer(reservation);
    const project = http.createServer((_request, response) => {
      response.setHeader('content-type', 'text/html');
      response.end(
        '<meta name="viewport" content="width=device-width,initial-scale=1"><title>Public fixture</title>' +
          '<button onclick="this.textContent=\'Clicked\'">Test button</button>' +
          '<input type="password" aria-label="Fixture password" value="FAUX_SECRET_NOT_FOR_SNAPSHOT">' +
          '<h1 hidden>HIDDEN_FIXTURE</h1>',
      );
    });
    project.listen(0, '127.0.0.1');
    await once(project, 'listening');
    const url = `http://127.0.0.1:${project.address().port}/`;
    const context = await chromium.launchPersistentContext(path.join(f.directory, 'profile'), {
      executablePath: process.env.PI_TEST_CHROME,
      headless: true,
      viewport: null,
      args: [`--remote-debugging-port=${chromePort}`, '--window-size=393,800'],
    });
    const page = context.pages()[0];
    await page.goto(url);
    const before = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
    const metadata = await (await fetch(`http://127.0.0.1:${chromePort}/json/version`)).json();
    const wss = new WebSocketServer({ noServer: true });
    const peers = new Set();
    const unix = http.createServer((_request, response) => response.end(JSON.stringify(metadata)));
    unix.on('upgrade', (request, socket, head) =>
      wss.handleUpgrade(request, socket, head, client => {
        const upstream = new WebSocket(metadata.webSocketDebuggerUrl);
        peers.add(client);
        peers.add(upstream);
        const pending = [];
        client.on('message', (data, binary) => {
          if (upstream.readyState === WebSocket.OPEN) upstream.send(data, { binary });
          else pending.push([data, binary]);
        });
        upstream.on('open', () => {
          for (const [data, binary] of pending) upstream.send(data, { binary });
        });
        upstream.on('message', (data, binary) => {
          if (client.readyState === WebSocket.OPEN) client.send(data, { binary });
        });
        upstream.on('error', () => client.terminate());
        client.on('close', () => upstream.terminate());
        upstream.on('close', () => client.terminate());
      }),
    );
    const socketPath = path.join(f.directory, 'chrome.sock');
    unix.listen(socketPath);
    await once(unix, 'listening');
    const preview = createPreview(f.stateDir, process.pid);
    preview.socketPath = async () => socketPath;
    const token = 'B'.repeat(43);
    const bridge = await createBridge(f.kernel, token, 0, undefined, undefined, preview);
    await publishBridge(f.stateDir, { port: bridge.port, token, parentPid: process.pid });
    t.after(async () => {
      await bridge.close();
      for (const peer of peers) peer.terminate();
      wss.close();
      await context.close();
      await closeServer(unix);
      await closeServer(project);
    });
    const env = await installGitTools(f.stateDir, path.join(f.directory, 'usr'));
    const launcher = path.join(f.stateDir, 'bin/pi-browser');
    const run = promisify(execFile);
    const options = { cwd: f.workspace, env: { ...process.env, ...env } };
    const snapshot = (await run(launcher, ['snapshot'], options)).stdout;
    const result = JSON.parse(snapshot);
    assert.equal(result.title, 'Public fixture');
    assert.equal(result.horizontalOverflow, false);
    assert.ok(result.elements.some(element => element.label === 'Test button'));
    assert.ok(
      !snapshot.includes('FAUX_SECRET') &&
        !snapshot.includes('HIDDEN_FIXTURE') &&
        !snapshot.includes(token),
    );
    const script = path.join(f.workspace, 'verify.mjs');
    await writeFile(
      script,
      `export default async ({ page }) => { await page.getByRole('button', { name: 'Test button' }).click(); };`,
    );
    await run(launcher, ['run', script], options);
    assert.equal(await page.getByRole('button').textContent(), 'Clicked');
    const image = path.join(f.workspace, 'public-preview.png');
    await run(launcher, ['screenshot', image], options);
    assert.ok(
      (await readFile(image)).subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])),
    );
    assert.deepEqual(
      await page.evaluate(() => ({ width: innerWidth, height: innerHeight })),
      before,
    );
    await writeFile(
      script,
      `export default async () => { throw new Error('${token} FAUX_PRIVATE_SCRIPT_ERROR'); };`,
    );
    await assert.rejects(run(launcher, ['run', script], options), error => {
      assert.ok(
        !error.stderr.includes(token) && !error.stderr.includes('FAUX_PRIVATE_SCRIPT_ERROR'),
      );
      return true;
    });
    assert.equal(f.faux.state.callCount, 0);
  },
);
