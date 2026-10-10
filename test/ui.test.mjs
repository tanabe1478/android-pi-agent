import test from 'node:test';
import assert from 'node:assert/strict';

import { fauxAssistantMessage, fauxText } from '@earendil-works/pi-ai';

import { createBridge } from '../runtime/bridge.ts';
import { fixture, eventually, busy } from './helpers.mjs';

test(
  'foreground return replaces a held stream, preserves a draft and never resubmits input',
  { skip: !process.env.PI_TEST_CHROME },
  async t => {
    const f = await fixture(t, { tokensPerSecond: 60 });
    f.faux.setResponses([
      fauxAssistantMessage([fauxText('reconnected fixture response '.repeat(4))]),
    ]);
    const bridge = await createBridge(f.kernel, 'foreground-fixture-token');
    const { chromium } = await import('playwright-core');
    const browser = await chromium.launch({
      executablePath: process.env.PI_TEST_CHROME,
      headless: true,
    });
    try {
      const page = await browser.newPage({ viewport: { width: 360, height: 780 } });
      await page.addInitScript(() => {
        const original = window.fetch.bind(window);
        window.__fixtureStreams = 0;
        window.__fixturePosts = 0;
        window.fetch = async (url, options) => {
          if (url === '/api/action') window.__fixturePosts++;
          if (url === '/api/events' && ++window.__fixtureStreams === 1) {
            const response = await original('/api/view', { headers: options.headers });
            const view = await response.json();
            return new Response(
              new ReadableStream({
                start(controller) {
                  controller.enqueue(
                    new TextEncoder().encode(`event: snapshot\ndata: ${JSON.stringify(view)}\n\n`),
                  );
                },
                cancel() {
                  window.__fixtureStreamCancelled = true;
                },
              }),
              { headers: { 'content-type': 'text/event-stream' } },
            );
          }
          return original(url, options);
        };
      });
      await page.goto(bridge.url + '/#token=foreground-fixture-token');
      await page.waitForFunction(() => !document.getElementById('message').disabled);
      const editor = page.getByRole('textbox', { name: 'メッセージ' });
      await editor.fill('one fixture submission');
      await page.getByRole('button', { name: '送信', exact: true }).click();
      await eventually(
        () => f.kernel.snapshot(),
        view => !busy(view) && f.faux.state.callCount === 1,
      );
      await editor.fill('保持する日本語draft 👩‍💻');
      await editor.focus();
      await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
      await page.waitForFunction(
        () => window.__fixtureStreams >= 2 && !document.getElementById('send').disabled,
      );
      await page.waitForFunction(() =>
        document.getElementById('transcript').textContent.includes('reconnected fixture response'),
      );
      assert.equal(await editor.inputValue(), '保持する日本語draft 👩‍💻');
      assert.equal(await editor.evaluate(node => document.activeElement === node), true);
      assert.deepEqual(
        await page.evaluate(() => ({
          posts: window.__fixturePosts,
          cancelled: window.__fixtureStreamCancelled,
        })),
        { posts: 1, cancelled: true },
      );
      assert.equal(f.faux.state.callCount, 1);
    } finally {
      await browser.close();
      await bridge.close();
    }
  },
);

test(
  'mobile presentation completes commands, preserves the IME draft during streaming and confirms scoped clear',
  { skip: !process.env.PI_TEST_CHROME },
  async t => {
    const f = await fixture(t, { tokensPerSecond: 100 });
    f.faux.setResponses([
      fauxAssistantMessage([fauxText('streaming fixture response '.repeat(8))]),
    ]);
    const token = 'browser-fixture-token';
    const bridge = await createBridge(f.kernel, token);
    const { chromium } = await import('playwright-core');
    const browser = await chromium.launch({
      executablePath: process.env.PI_TEST_CHROME,
      headless: true,
    });

    try {
      const page = await browser.newPage({ viewport: { width: 360, height: 780 } });
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      await page.goto(bridge.url + '/#token=' + token);
      const editor = page.getByRole('textbox', { name: 'メッセージ' });
      await editor.waitFor();
      await page.waitForFunction(() => !document.getElementById('message').disabled);
      assert.equal(new URL(page.url()).hash, '');

      await editor.fill('/mo');
      await page.getByRole('button', { name: '/model', exact: true }).click();
      assert.equal(await editor.inputValue(), '/model ');

      await editor.fill('fixture prompt');
      await page.getByRole('button', { name: '送信', exact: true }).click();
      await page.waitForFunction(
        () =>
          !document.getElementById('send').disabled &&
          document.getElementById('message').value === '',
      );
      await editor.fill('日本語の入力中 👩‍💻');
      await editor.focus();
      await page.waitForFunction(() =>
        document.getElementById('transcript').textContent.includes('streaming fixture response'),
      );
      assert.equal(await editor.inputValue(), '日本語の入力中 👩‍💻');
      assert.equal(await editor.evaluate(node => document.activeElement === node), true);
      await page.waitForFunction(() => !document.getElementById('app').classList.contains('busy'));

      const beforeCalls = f.faux.state.callCount;
      await editor.fill('/not-supported');
      await page.getByRole('button', { name: '送信', exact: true }).click();
      await page.getByRole('status').filter({ hasText: '未対応のコマンド' }).waitFor();
      assert.equal(f.faux.state.callCount, beforeCalls);

      await editor.fill('/clear');
      await page.getByRole('button', { name: '送信', exact: true }).click();
      await page.getByRole('heading', { name: '操作を確認' }).waitFor();
      await page.getByRole('button', { name: '閉じる', exact: true }).click();
      assert.ok((await page.locator('#transcript').textContent()).includes('fixture prompt'));

      await editor.fill('/clear');
      await page.getByRole('button', { name: '送信', exact: true }).click();
      await page.getByRole('button', { name: 'リセットする', exact: true }).click();
      await page.waitForFunction(
        () => !document.getElementById('transcript').textContent.includes('fixture prompt'),
      );

      await page.locator('#settings-open').click();
      await page.getByRole('button', { name: '/resume 会話', exact: true }).click();
      await page.getByRole('button', { name: '新しい会話', exact: true }).click();
      await page.waitForFunction(
        () => document.getElementById('sessions').textContent === 'New session',
      );

      await page.locator('#settings-back').click();
      const layout = await page.evaluate(() => ({
        width: innerWidth,
        scroll: document.documentElement.scrollWidth,
      }));
      assert.ok(layout.scroll <= layout.width);
      assert.deepEqual(errors, []);
    } finally {
      await browser.close();
      await bridge.close();
    }
  },
);
