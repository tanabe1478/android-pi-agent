import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

import { fauxAssistantMessage, fauxText, fauxThinking } from '@earendil-works/pi-ai';
import { createBridge } from '../runtime/bridge.ts';
import { formatTokens, usageOf, shortPath, transcriptItems } from '../ui/presentation.js';
import { safeLink } from '../ui/markdown.js';
import { fixture } from './helpers.mjs';

const viewOf = (entries = [], live = {}, usage = {}) => ({
  activeId: 1,
  conversation: { entries, docs: { 'pi.live': live, 'pi.usage': usage } },
});
const entry = (id, message) => ({ id, model: [message] });
const call = { type: 'toolCall', id: 'call-1', name: 'read', arguments: { path: 'sample.txt' } };
const response = {
  role: 'toolResult',
  toolCallId: 'call-1',
  toolName: 'read',
  content: [{ type: 'text', text: 'one\ntwo\nthree\nfour\nfive' }],
  isError: false,
};

async function browserFixture(t) {
  const f = await fixture(t, { tokensPerSecond: 400 });
  const bridge = await createBridge(f.kernel, 'presentation-test-only');
  const { chromium } = await import('playwright-core');
  const browser = await chromium.launch({
    executablePath: process.env.PI_TEST_CHROME,
    headless: true,
  });
  t.after(async () => {
    await browser.close();
    await bridge.close();
  });
  const page = await browser.newPage({ viewport: { width: 360, height: 780 } });
  await page.goto(bridge.url + '/#token=presentation-test-only');
  await page.waitForFunction(() => !document.getElementById('message').disabled);
  return { f, page };
}

test('footer uses the durable cumulative ledger without double-counting reasoning or transcript usage', () => {
  const usage = {
    input: 1000,
    output: 200,
    cacheRead: 50,
    cacheWrite: 10,
    reasoning: 100,
    cost: { total: 0.03 },
  };
  const view = viewOf(
    [entry(1, { role: 'assistant', usage })],
    {},
    {
      models: { 'test/first': usage },
      tools: { custom: { input: 20, output: 10, reasoning: 2, cost: { total: 0.01 } } },
    },
  );
  const expected = {
    input: 1020,
    output: 210,
    cacheRead: 50,
    cacheWrite: 10,
    reasoning: 102,
    cost: 0.04,
  };
  assert.deepEqual(usageOf(view), expected);
  assert.deepEqual(usageOf(view), expected);
  assert.equal(formatTokens(1250), '1.3k');
  assert.equal(shortPath('/data/user/0/app/files/work'), '…/files/work');
});

test('tool calls and results form one stable row while committed live output becomes a result', () => {
  const entries = [entry(1, { role: 'assistant', content: [call] })];
  const running = transcriptItems(
    viewOf(entries, {
      tools: [{ callId: call.id, name: call.name, status: 'running', output: 'partial' }],
    }),
  );
  assert.equal(running.length, 1);
  assert.equal(running[0].key, 'tool:call-1');
  assert.equal(running[0].slot.output, 'partial');
  const finished = transcriptItems(viewOf([...entries, entry(2, response)]));
  assert.equal(finished.length, 1);
  assert.equal(finished[0].key, running[0].key);
  assert.equal(finished[0].result, response);
  assert.equal(transcriptItems(viewOf([entry(2, response)])).length, 1);
});

test('Markdown links cannot execute scripts, use credentials, or access non-HTTP schemes', () => {
  for (const value of [
    'javascript:alert(1)',
    'data:text/html,foo',
    'file:///private',
    'intent:foo',
    'https://user:password@example.com',
    'https://example.com/\nfoo',
    '/api/auth',
  ])
    assert.equal(safeLink(value), undefined);
  assert.equal(safeLink('https://example.com/document'), 'https://example.com/document');
});

test('vendored Marked lexer and full license match their documented source hashes', async () => {
  const files = [
    ['marked.js', '05e41134d075ad3a009a748d6c779c3d83cea9b942be911c2d9abade36d1dd31'],
    ['marked.LICENSE', '8e3a3f82f59a60958f56ca08f445647c32a4733dc7ca6c2c46f6eb898471ab9c'],
  ];
  for (const [name, hash] of files) {
    const bytes = await readFile(new URL(`../ui/vendor/${name}`, import.meta.url));
    assert.equal(createHash('sha256').update(bytes).digest('hex'), hash);
  }
});

test(
  'Markdown DOM renders structure while HTML, scripts and remote images stay inert',
  { skip: !process.env.PI_TEST_CHROME },
  async t => {
    const { page } = await browserFixture(t);
    const outcome = await page.evaluate(async () => {
      const { markdown } = await import('/markdown.js');
      const text =
        '# Heading\n\n**strong** and `code` &amp; 日本語\n\n- first\n- second\n\n```js\nconsole.log("<script>");\n```\n\n' +
        '| A | B |\n| --- | --- |\n| one | two |\n\n' +
        '<img src="https://example.invalid/private" onerror="window.injected=true">\n\n' +
        '[bad](javascript:alert(1)) ![remote](https://example.invalid/image)\n\n<script>window.injected=true</script>';
      const node = markdown(text);
      document.body.append(node);
      const result = {
        heading: node.querySelector('h1')?.textContent,
        bold: node.querySelector('strong')?.textContent,
        code: node.querySelector('pre code')?.textContent,
        list: node.querySelectorAll('li').length,
        table: node.querySelectorAll('table').length,
        decodedEntity: node.textContent.includes('& 日本語'),
        images: node.querySelectorAll('img').length,
        scripts: node.querySelectorAll('script').length,
        activeUnsafeLinks: node.querySelectorAll('a').length,
        injected: Boolean(window.injected),
      };
      node.remove();
      return result;
    });
    assert.deepEqual(outcome, {
      heading: 'Heading',
      bold: 'strong',
      code: 'console.log("<script>");',
      list: 2,
      table: 1,
      decodedEntity: true,
      images: 0,
      scripts: 0,
      activeUnsafeLinks: 0,
      injected: false,
    });
  },
);

test(
  'paired tool rows retain expansion across streaming updates and thinking has a separate toggle',
  { skip: !process.env.PI_TEST_CHROME },
  async t => {
    const { page } = await browserFixture(t);
    const input = viewOf([
      entry(1, { role: 'assistant', content: [{ type: 'thinking', thinking: 'planning' }, call] }),
      entry(2, response),
    ]);
    const result = await page.evaluate(async view => {
      const { Transcript } = await import('/components.js');
      const node = document.createElement('section');
      document.body.append(node);
      const transcript = new Transcript(node, () => {});
      transcript.render(view);
      const details = node.querySelector('.tool-details');
      details.open = true;
      view.conversation.entries[1].model[0].content[0].text += '\nsix';
      transcript.render(view);
      const retained = node.querySelector('.tool-details').open;
      transcript.toggleTools();
      transcript.toggleTools();
      transcript.toggleThinking();
      const result = {
        tools: node.querySelectorAll('.tool').length,
        retained,
        collapsed: !node.querySelector('.tool-details').open,
        thinkingCollapsed: !node.querySelector('.thinking-block').open,
        title: node.querySelector('.tool-details strong').textContent,
      };
      transcript.dispose();
      node.remove();
      return result;
    }, input);
    assert.deepEqual(result, {
      tools: 1,
      retained: true,
      collapsed: true,
      thinkingCollapsed: true,
      title: 'read sample.txt',
    });
  },
);

test(
  'tool images use bounded raster data URLs only and fit a narrow expanded row',
  {
    skip: !process.env.PI_TEST_CHROME,
  },
  async t => {
    const { page } = await browserFixture(t);
    const png =
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==';
    const view = viewOf([
      entry(1, { role: 'assistant', content: [call] }),
      entry(2, {
        ...response,
        content: [
          { type: 'image', mimeType: 'image/png', data: png },
          { type: 'image', mimeType: 'image/svg+xml', data: 'PHN2Zz4=' },
          { type: 'image', mimeType: 'image/png', data: 'https://example.com/private' },
          { type: 'image', mimeType: 'image/png', data: '\" onerror=\"alert(1)' },
        ],
      }),
    ]);
    const result = await page.evaluate(async view => {
      const { Transcript } = await import('/components.js');
      const node = document.createElement('section');
      document.body.append(node);
      const transcript = new Transcript(node, () => {});
      transcript.render(view);
      const note = node.querySelector('.tool-preview').textContent;
      transcript.toggleTools();
      const result = {
        images: node.querySelectorAll('img').length,
        dataOnly: node.querySelector('img').src.startsWith('data:image/png;base64,'),
        note,
        overflow: document.documentElement.scrollWidth > innerWidth,
        waiting: node.textContent.includes('出力を待っています'),
      };
      transcript.dispose();
      node.remove();
      return result;
    }, view);
    assert.deepEqual(result, {
      images: 1,
      dataOnly: true,
      note: '画像 1枚 · 展開して表示',
      overflow: false,
      waiting: false,
    });
  },
);

test(
  'Pi-like footer stays below the editor, shortcuts preserve drafts, and narrow keyboard layouts fit',
  { skip: !process.env.PI_TEST_CHROME },
  async t => {
    const { f, page } = await browserFixture(t);
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    const editor = page.locator('#message');
    await editor.fill('保持するdraft 👩‍💻');
    await page.locator('#settings-open').click();
    await page.getByRole('heading', { name: '設定', exact: true }).waitFor();
    await page.getByRole('button', { name: 'ヘルプ', exact: true }).click();
    await page.getByRole('heading', { name: '操作一覧' }).waitFor();
    await page.locator('#dialog-close').click();
    await page.locator('#settings-back').click();
    assert.equal(await editor.inputValue(), '保持するdraft 👩‍💻');
    await editor.focus();
    await page.keyboard.press('Control+l');
    await page.getByRole('heading', { name: 'モデルを選択' }).waitFor();
    await page.locator('#dialog-close').click();
    assert.equal(await editor.inputValue(), '保持するdraft 👩‍💻');
    await editor.fill('/mo');
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Tab');
    assert.equal(await editor.inputValue(), '/model ');
    await editor.fill('日本語');
    const before = f.faux.state.callCount;
    await editor.evaluate(node =>
      node.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'Enter',
          ctrlKey: true,
          isComposing: true,
          bubbles: true,
        }),
      ),
    );
    await page.keyboard.press('Enter');
    assert.equal(await editor.inputValue(), '日本語\n');
    assert.equal(f.faux.state.callCount, before);
    f.faux.setResponses([
      fauxAssistantMessage([
        fauxThinking('Plan briefly.'),
        fauxText('## Done\n\n**Pi-style** reply.'),
      ]),
    ]);
    await editor.fill('fixture prompt');
    await page.keyboard.press('Control+Enter');
    await page.locator('.assistant strong').filter({ hasText: 'Pi-style' }).waitFor();
    await page.waitForFunction(() => !document.getElementById('app').classList.contains('busy'));
    await page.keyboard.press('Control+t');
    assert.equal(await page.locator('.thinking-block').evaluate(node => node.open), false);
    await page.locator('#settings-open').click();
    await page.getByRole('button', { name: '累積使用量', exact: true }).click();
    await page
      .getByText('pi.usageの確定累計です。context占有率はまだ取得していません。', { exact: true })
      .waitFor();
    await page.locator('#dialog-close').click();
    await page.locator('#settings-back').click();
    for (const viewport of [
      { width: 320, height: 403 },
      { width: 360, height: 403 },
      { width: 360, height: 780 },
      { width: 980, height: 780 },
    ]) {
      await page.setViewportSize(viewport);
      const layout = await page.evaluate(() => ({
        width: innerWidth,
        scroll: document.documentElement.scrollWidth,
        editorBottom: document.getElementById('composer').getBoundingClientRect().bottom,
        footerTop: document.querySelector('footer').getBoundingClientRect().top,
        sendBottom: document.getElementById('send').getBoundingClientRect().bottom,
        footerBottom: document.querySelector('footer').getBoundingClientRect().bottom,
        transcriptHeight: document.getElementById('transcript').clientHeight,
        height: innerHeight,
      }));
      assert.ok(layout.scroll <= layout.width);
      assert.ok(layout.footerTop >= layout.editorBottom - 1);
      assert.ok(layout.sendBottom <= layout.height);
      assert.ok(layout.footerBottom <= layout.height + 1);
      assert.ok(layout.transcriptHeight > 60);
    }
    assert.deepEqual(errors, []);
  },
);
