import test from 'node:test';
import assert from 'node:assert/strict';
import { fauxAssistantMessage, fauxText } from '@earendil-works/pi-ai';
import { createBridge } from '../runtime/bridge.ts';
import { fixture, eventually, busy } from './helpers.mjs';

async function open(t) {
  const f = await fixture(t, { tokensPerSecond: 40 });
  const bridge = await createBridge(f.kernel, 'minimal-composer');
  const { chromium } = await import('playwright-core');
  const browser = await chromium.launch({
    executablePath: process.env.PI_TEST_CHROME,
    headless: true,
  });
  t.after(async () => {
    await browser.close();
    await bridge.close();
  });
  const page = await browser.newPage({ viewport: { width: 360, height: 403 } });
  await page.goto(bridge.url + '/#token=minimal-composer');
  await page.waitForFunction(() => !document.getElementById('message').disabled);
  return { f, page };
}

test(
  'composer has only editor/send, slash suggestions are typed, settings preserve draft and selection',
  {
    skip: !process.env.PI_TEST_CHROME,
  },
  async t => {
    const { f, page } = await open(t);
    const editor = page.locator('#message');
    assert.equal(await editor.getAttribute('placeholder'), '...');
    assert.equal((await page.locator('#app-header .logo').innerText()).trim(), 'pi android client');
    assert.equal(
      await page.locator('.logo').evaluate(node => getComputedStyle(node).fontSize),
      '16px',
    );
    const beforeScroll = await page.locator('#app-header').boundingBox();
    await page.evaluate(() => {
      const fixture = document.createElement('div');
      fixture.id = 'header-scroll-fixture';
      fixture.style.height = '2000px';
      document.getElementById('transcript').append(fixture);
      document.getElementById('transcript').scrollTop = 1000;
    });
    assert.ok(await page.locator('#transcript').evaluate(node => node.scrollTop > 0));
    const afterScroll = await page.locator('#app-header').boundingBox();
    assert.ok(afterScroll.y < beforeScroll.y - 900);
    assert.ok(afterScroll.y + afterScroll.height < 0);
    await page.evaluate(() => document.getElementById('header-scroll-fixture').remove());
    assert.equal(await page.locator('#composer button').count(), 1);
    assert.equal(await page.locator('#composer select').count(), 0);
    assert.equal(await page.locator('#menu, #command, #input-mode, #abort').count(), 0);
    assert.equal(await page.locator('footer button').count(), 1);
    await editor.fill('保持するdraft 👩‍💻');
    await editor.evaluate(node => node.setSelectionRange(2, 5));
    await page.locator('#settings-open').click();
    await page.getByRole('heading', { name: '設定', exact: true }).waitFor();
    assert.equal(await page.locator('#composer').isVisible(), false);
    await page.locator('#settings-back').click();
    assert.equal(await editor.inputValue(), '保持するdraft 👩‍💻');
    assert.deepEqual(
      await editor.evaluate(node => [node.selectionStart, node.selectionEnd]),
      [2, 5],
    );
    await editor.fill('/');
    assert.equal(await page.locator('#suggestions').isVisible(), true);
    await editor.fill('/se');
    await page.getByRole('button', { name: '/settings', exact: true }).click();
    assert.equal(await editor.inputValue(), '/settings ');
    await page.locator('#send').click();
    await page.getByRole('heading', { name: '設定', exact: true }).waitFor();
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('#settings-page').isVisible(), false);
    assert.equal(await editor.inputValue(), '');
    assert.equal(f.faux.state.callCount, 0);
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
      true,
    );
  },
);

test(
  'header model/thinking taps configure the durable conversation and preserve the draft',
  { skip: !process.env.PI_TEST_CHROME },
  async t => {
    const { f, page } = await open(t);
    const editor = page.locator('#message');
    assert.equal(await page.locator('#app-header #models, #app-header #thinking').count(), 2);
    assert.equal(await page.locator('footer #models, footer #thinking').count(), 0);
    await editor.fill('設定中も保持するdraft 👩‍💻');
    await editor.evaluate(node => node.setSelectionRange(2, 5));

    await page.locator('#thinking').click();
    await page.getByRole('heading', { name: '思考レベル', exact: true }).waitFor();
    await page.getByRole('button', { name: 'high', exact: true }).click();
    await page.waitForFunction(() => document.getElementById('thinking').textContent === 'high');
    assert.equal((await f.kernel.snapshot()).conversation.docs['pi.agent'].thinkingLevel, 'high');

    await page.locator('#models').click();
    await page.getByRole('heading', { name: 'モデルを選択', exact: true }).waitFor();
    const second = f.faux.getModel('second');
    await page
      .getByRole('button', { name: `${second.provider}/${second.id}`, exact: true })
      .click();
    await page.waitForFunction(() => document.getElementById('models').textContent === 'second');
    const agent = (await f.kernel.snapshot()).conversation.docs['pi.agent'];
    assert.deepEqual(agent.model, { provider: second.provider, modelId: second.id });
    assert.equal(await page.locator('#thinking').textContent(), agent.thinkingLevel);
    assert.equal(await editor.inputValue(), '設定中も保持するdraft 👩‍💻');
    assert.deepEqual(
      await editor.evaluate(node => [node.selectionStart, node.selectionEnd]),
      [2, 5],
    );
    assert.equal(f.faux.state.callCount, 0);

    await page.locator('#models').evaluate(node => {
      node.textContent = 'long-model-name-'.repeat(30);
    });
    await page.setViewportSize({ width: 320, height: 403 });
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
      true,
    );
    assert.equal(await page.locator('#composer button').count(), 1);
  },
);

test(
  'busy ordinary send is Steer, Alt+Enter is follow-up and slash abort stops without a persistent stop bar',
  {
    skip: !process.env.PI_TEST_CHROME,
    timeout: 30000,
  },
  async t => {
    const { f, page } = await open(t);
    f.faux.setResponses([fauxAssistantMessage([fauxText('long fixture '.repeat(300))])]);
    const inputs = [];
    await page.route('**/api/action', async route => {
      const body = route.request().postDataJSON();
      if (body.type === 'input') inputs.push(body);
      await route.continue();
    });
    const editor = page.locator('#message');
    await editor.fill('first fixture');
    await page.locator('#send').click();
    await eventually(() => f.kernel.snapshot(), busy);
    await editor.fill('steering fixture');
    await page.locator('#send').click();
    await page.waitForFunction(() => document.getElementById('message').value === '');
    await editor.fill('follow-up fixture');
    await page.keyboard.press('Alt+Enter');
    await page.waitForFunction(() => document.getElementById('message').value === '');
    await editor.fill('/abort');
    await page.locator('#send').click();
    await eventually(
      () => f.kernel.snapshot(),
      view => !busy(view),
    );
    assert.deepEqual(
      inputs.map(input => input.mode),
      ['steer', 'steer', 'followUp', 'steer'],
    );
    assert.equal(await page.locator('#abort, #input-mode').count(), 0);
    assert.ok(inputs.every(input => input.conversationId === 1));
  },
);
