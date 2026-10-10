import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { mkdir } from 'node:fs/promises';

import { readPrivate } from './credentials.ts';
import { validatePreviewURL } from './browser-preview.ts';

async function bridge(stateDir: string) {
  try {
    const value = (await readPrivate(path.join(stateDir, 'bridge.json'))) as Record<
      string,
      unknown
    >;
    if (
      !value ||
      value.version !== 1 ||
      !Number.isInteger(value.port) ||
      Number(value.port) < 1 ||
      Number(value.port) > 65535 ||
      typeof value.token !== 'string' ||
      !/^[A-Za-z0-9_-]{43}$/.test(value.token)
    )
      throw new Error();
    return { port: Number(value.port), token: value.token };
  } catch {
    throw new Error('Android Pi bridge is not ready.');
  }
}

async function api(stateDir: string, route: string, body?: unknown) {
  const { port, token } = await bridge(stateDir);
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/browser/${route}`, {
      method: body ? 'POST' : 'GET',
      headers: { 'x-pi-token': token, 'content-type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(10000),
      redirect: 'error',
    });
    const result = await response.json();
    if (!response.ok) throw new Error();
    return result;
  } catch {
    throw new Error(
      'Preview request failed. Read pi-browser status; do not automatically repeat open or run.',
    );
  }
}

export async function connectPreview(stateDir: string) {
  // CDP attachment only. No browser installation, launch, platform spoofing or user profile.
  if (process.platform === 'android' && !process.env.PLAYWRIGHT_BROWSERS_PATH)
    process.env.PLAYWRIGHT_BROWSERS_PATH = path.join(stateDir, 'playwright-cache');
  const { chromium } = await import('playwright-core');
  const { port, token } = await bridge(stateDir);
  // isWebView is a pinned Playwright transport option, not in its public declarations.
  const options = {
    headers: { 'x-pi-token': token },
    timeout: 10000,
    noDefaults: true,
    isWebView: true,
  };
  const browser = await chromium.connectOverCDP(
    `ws://127.0.0.1:${port}/api/browser/cdp/devtools/browser`,
    options,
  );
  try {
    let page;
    for (let attempt = 0; attempt < 50; attempt++) {
      page = browser.contexts().flatMap(context => context.pages())[0];
      if (page) break;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    if (!page) throw new Error('No preview page.');
    validatePreviewURL(page.url(), port);
    page.setDefaultTimeout(10000);
    return { browser, page, chromium };
  } catch (error) {
    await browser.close();
    throw error;
  }
}

export async function browserCLI(args: string[], stateDir: string) {
  const [command, value, ...extra] = args;
  if (extra.length || (['status', 'snapshot'].includes(command) && value))
    throw new Error('Invalid arguments.');
  if (command === 'open') {
    if (!value) throw new Error('Missing project URL.');
    console.log(JSON.stringify(await api(stateDir, 'open', { url: value }), null, 2));
    return;
  }
  if (command === 'status') {
    console.log(JSON.stringify(await api(stateDir, 'status'), null, 2));
    return;
  }
  if (!['snapshot', 'screenshot', 'run'].includes(command)) {
    console.log('pi-browser open URL | status | snapshot | screenshot FILE.png | run SCRIPT.mjs');
    return;
  }
  const { browser, page, chromium } = await connectPreview(stateDir);
  try {
    if (command === 'screenshot') {
      if (!value || !value.endsWith('.png')) throw new Error('Expected FILE.png.');
      const file = path.resolve(value);
      await mkdir(path.dirname(file), { recursive: true });
      await page.screenshot({ path: file });
      console.log(file);
    } else if (command === 'snapshot') {
      const result = await page.evaluate(() => ({
        title: document.title,
        viewport: { width: innerWidth, height: innerHeight, dpr: devicePixelRatio },
        horizontalOverflow: document.documentElement.scrollWidth > innerWidth,
        elements: Array.from(
          document.querySelectorAll('button, a, input, textarea, select, [role], h1, h2, h3'),
        )
          .filter(
            element =>
              element.getBoundingClientRect().width && element.getBoundingClientRect().height,
          )
          .slice(0, 150)
          .map(element => ({
            tag: element.tagName.toLowerCase(),
            role: element.getAttribute('role'),
            label: (
              element.getAttribute('aria-label') ||
              (element instanceof HTMLElement ? element.innerText : '') ||
              element.getAttribute('placeholder') ||
              ''
            ).slice(0, 160),
            // No input values, hrefs, URL query/fragment, cookies, storage or hidden DOM.
          })),
      }));
      console.log(JSON.stringify(result, null, 2));
    } else {
      if (!value || !value.endsWith('.mjs')) throw new Error('Expected SCRIPT.mjs.');
      const script = await import(pathToFileURL(path.resolve(value)).href);
      if (typeof script.default !== 'function')
        throw new Error('Script must export a default function.');
      await script.default({ page, browser, chromium });
    }
  } finally {
    await browser.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const stateDir = process.env.PI_ANDROID_STATE;
  Promise.resolve()
    .then(() => {
      if (!stateDir || !path.isAbsolute(stateDir)) throw new Error();
      return browserCLI(process.argv.slice(2), stateDir);
    })
    .catch(() => {
      // CDP errors can include request headers; script exceptions can contain private page content.
      console.error(
        'pi-browser failed. Keep Preview open in a debug APK; check status, arguments and your script locally.',
      );
      process.exitCode = 1;
    });
}
