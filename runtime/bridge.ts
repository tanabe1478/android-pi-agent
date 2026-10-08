import http from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { AppController, AppView } from './contracts.ts';
import { AppError, parseAction } from './protocol.ts';
import { parseAuthAction, type Authentication } from './auth.ts';

export async function createBridge(
  controller: AppController,
  token: string,
  port = 0,
  auth?: Authentication,
) {
  const root = fileURLToPath(new URL('../', import.meta.url));
  const streams = new Set<http.ServerResponse>();

  let refreshTimer: ReturnType<typeof setTimeout> | undefined;
  let refreshing = false;
  let dirty = false;
  let closed = false;

  const encode = (view: AppView) => `event: snapshot\ndata: ${JSON.stringify(view)}\n\n`;
  const write = (response: http.ServerResponse, frame: string) => {
    // A slow client must reconnect to a fresh snapshot, not accumulate unbounded history.
    if (response.destroyed || response.writableEnded) return;
    if (response.writableLength > 512 * 1024) {
      response.destroy();
      return;
    }
    response.write(frame);
  };

  async function refresh() {
    refreshTimer = undefined;
    if (refreshing) {
      dirty = true;
      return;
    }
    refreshing = true;
    try {
      const frame = encode(await controller.snapshot());
      for (const response of streams) write(response, frame);
    } catch {
      for (const response of streams) response.destroy();
    } finally {
      refreshing = false;
      if (dirty) {
        dirty = false;
        schedule();
      }
    }
  }

  function schedule() {
    if (!closed && !refreshTimer) refreshTimer = setTimeout(() => void refresh(), 30);
  }
  const unsubscribe = controller.subscribe(schedule);

  function json(response: http.ServerResponse, status: number, value: unknown) {
    response.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    });
    response.end(JSON.stringify(value));
  }

  function authenticated(request: http.IncomingMessage) {
    const supplied = request.headers['x-pi-token'];
    if (typeof supplied !== 'string') return false;
    const left = Buffer.from(supplied);
    const right = Buffer.from(token);
    return left.length === right.length && timingSafeEqual(left, right);
  }

  async function body(request: http.IncomingMessage) {
    if (!request.headers['content-type']?.startsWith('application/json'))
      throw new AppError('invalid_action', 'JSON形式で送信してください。');

    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of request) {
      size += chunk.length;
      if (size > 80_000) throw new AppError('invalid_action', '入力が大きすぎます。');
      chunks.push(chunk);
    }

    try {
      return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
    } catch {
      throw new AppError('invalid_action', 'JSON形式が正しくありません。');
    }
  }

  const server = http.createServer(async (request, response) => {
    response.setHeader('x-content-type-options', 'nosniff');
    response.setHeader('referrer-policy', 'no-referrer');

    const address = server.address();
    if (!address || typeof address === 'string') return json(response, 503, { error: 'not_ready' });
    const origins = [`http://127.0.0.1:${address.port}`, `http://localhost:${address.port}`];
    const origin = request.headers.origin;
    if (
      !origins.some(value => value.slice(7) === request.headers.host) ||
      (origin && !origins.includes(origin))
    )
      return json(response, 403, { error: 'origin' });

    let url: URL;
    try {
      url = new URL(request.url ?? '/', origins[0]);
    } catch {
      return json(response, 400, { error: 'url' });
    }

    try {
      if (url.pathname.startsWith('/api/')) {
        if (!authenticated(request)) return json(response, 401, { error: 'auth' });
        if (url.searchParams.has('token')) return json(response, 400, { error: 'query_token' });

        if (url.pathname === '/api/view' && request.method === 'GET')
          return json(response, 200, await controller.snapshot());

        if (url.pathname === '/api/action' && request.method === 'POST')
          return json(response, 200, await controller.execute(parseAction(await body(request))));

        if (url.pathname === '/api/auth' && auth) {
          if (request.method === 'GET') return json(response, 200, auth.snapshot());
          if (request.method === 'POST') {
            auth.execute(parseAuthAction(await body(request)));
            return json(response, 200, { kind: 'done' });
          }
        }

        if (url.pathname === '/api/events' && request.method === 'GET') {
          if (streams.size >= 8) return json(response, 429, { error: 'clients' });
          // Global invalidation is already subscribed. Register only after the initial
          // read, so a broadcast cannot write data before the SSE headers.
          const frame = encode(await controller.snapshot());
          if (response.destroyed) return;
          if (streams.size >= 8) return json(response, 429, { error: 'clients' });
          response.writeHead(200, {
            'content-type': 'text/event-stream',
            'cache-control': 'no-store',
            'x-accel-buffering': 'no',
          });
          streams.add(response);
          response.on('close', () => streams.delete(response));
          write(response, frame);
          schedule(); // Read again to cover any commit during initial hydration.
          return;
        }

        return json(response, 404, { error: 'not_found' });
      }

      if (request.method !== 'GET' && request.method !== 'HEAD')
        return json(response, 405, { error: 'method' });

      const files: Record<string, string> = {
        '/': 'ui/index.html',
        '/app.js': 'ui/app.js',
        '/components.js': 'ui/components.js',
        '/client.js': 'ui/client.js',
        '/auth.js': 'ui/auth.js',
        '/style.css': 'ui/style.css',
        '/shared/commands.js': 'shared/commands.js',
      };
      const file = files[url.pathname];
      if (!file) return json(response, 404, { error: 'not_found' });

      const bytes = await readFile(path.join(root, file));
      const types: Record<string, string> = {
        '.html': 'text/html',
        '.js': 'text/javascript',
        '.css': 'text/css',
      };
      response.writeHead(200, {
        'content-type': `${types[path.extname(file)]}; charset=utf-8`,
        'cache-control': 'no-store',
        'content-security-policy':
          "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
      });
      response.end(request.method === 'HEAD' ? undefined : bytes);
    } catch (error) {
      if (response.headersSent) {
        response.destroy();
        return;
      }
      json(response, error instanceof AppError ? 400 : 500, {
        error: error instanceof AppError ? error.code : 'internal',
        message: error instanceof AppError ? error.message : '操作に失敗しました。',
      });
    }
  });

  server.requestTimeout = 15_000;
  server.headersTimeout = 10_000;
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });

  const address = server.address() as { port: number };
  const heartbeat = setInterval(() => {
    for (const response of streams) write(response, ': heartbeat\n\n');
  }, 15_000);
  heartbeat.unref();

  return {
    url: `http://127.0.0.1:${address.port}`,
    port: address.port,

    async close() {
      if (closed) return;
      closed = true;
      unsubscribe();
      clearInterval(heartbeat);
      if (refreshTimer) clearTimeout(refreshTimer);
      for (const response of streams) response.end();
      await new Promise<void>(resolve => server.close(() => resolve()));
    },
  };
}
