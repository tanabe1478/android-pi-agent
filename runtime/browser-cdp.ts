import http from 'node:http';
import net from 'node:net';
import type { Duplex } from 'node:stream';
import type { EventEmitter } from 'node:events';

// Locked ws has no bundled declarations. Keep its untyped boundary confined to this adapter.
// @ts-expect-error No @types/ws in the offline dependency tree.
import { WebSocket, WebSocketServer } from 'ws';

import { AppError } from './protocol.ts';

type Peer = EventEmitter & {
  readyState: number;
  bufferedAmount: number;
  send(data: Buffer, options: { binary: boolean }): void;
  close(code?: number, reason?: string): void;
  terminate(): void;
};

const MAX_BYTES = 16 * 1024 * 1024;
export const validCDPPath = (route: string) =>
  /^\/(?:json\/(?:version|list)|devtools\/(?:browser(?:\/[a-zA-Z0-9-]+)?|page\/[a-zA-Z0-9-]+))$/.test(
    route,
  );

// socketPath is supplied by the native-owner checked preview service, never by an HTTP client.
export function createCDPProxy(socketPath: () => Promise<string>) {
  const webSockets = new WebSocketServer({
    noServer: true,
    maxPayload: MAX_BYTES,
    perMessageDeflate: false,
  });
  const peers = new Set<Peer>();
  const requests = new Set<http.ClientRequest>();
  let closed = false;
  let attaching = 0;
  let discovering = 0;

  return {
    async discovery(route: string, port: number) {
      if (closed || !validCDPPath(route) || !route.startsWith('/json/'))
        throw new AppError('preview_route', 'Unsupported CDP route.');
      if (discovering >= 4) throw new AppError('preview_clients', 'Too many debugger requests.');
      discovering++;
      try {
        const socket = await socketPath();
        if (closed) throw new AppError('closed', 'Preview debugger is closed.');
        const payload = await new Promise<unknown>((resolve, reject) => {
          const request = http.get(
            { socketPath: socket, path: route, headers: { host: '127.0.0.1' }, timeout: 5000 },
            response => {
              if (response.statusCode !== 200) {
                response.resume();
                reject(new Error());
                return;
              }
              const chunks: Buffer[] = [];
              let size = 0;
              response.on('data', (chunk: Buffer) => {
                size += chunk.length;
                if (size > 1024 * 1024) request.destroy(new Error());
                else chunks.push(chunk);
              });
              response.on('error', () => reject(new Error()));
              response.on('end', () => {
                try {
                  resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
                } catch {
                  reject(new Error());
                }
              });
            },
          );
          requests.add(request);
          request.on('close', () => requests.delete(request));
          request.on('timeout', () => request.destroy(new Error()));
          request.on('error', () => reject(new Error()));
        }).catch(() => {
          throw new AppError(
            'preview_debugger',
            'Preview debugger unavailable. Keep Preview open.',
          );
        });
        const rewrite = (value: unknown): unknown => {
          if (Array.isArray(value)) return value.map(rewrite);
          if (!value || typeof value !== 'object')
            throw new AppError('preview_debugger', 'Invalid debugger discovery.');
          const result = { ...value } as Record<string, unknown>;
          delete result.devtoolsFrontendUrl;
          delete result.webSocketDebuggerUrl;
          const source = (value as Record<string, unknown>).webSocketDebuggerUrl;
          if (typeof source === 'string') {
            try {
              const endpoint = new URL(source).pathname;
              if (validCDPPath(endpoint) && endpoint.startsWith('/devtools/'))
                result.webSocketDebuggerUrl = `ws://127.0.0.1:${port}/api/browser/cdp${endpoint}`;
            } catch {
              /* Never forward an unvalidated debugger URL. */
            }
          }
          return result;
        };
        return rewrite(payload);
      } finally {
        discovering--;
      }
    },

    async upgrade(request: http.IncomingMessage, socket: Duplex, head: Buffer, route: string) {
      if (
        closed ||
        !validCDPPath(route) ||
        !route.startsWith('/devtools/') ||
        peers.size / 2 + attaching >= 4
      ) {
        socket.destroy();
        return;
      }
      attaching++;
      try {
        const unix = await socketPath();
        if (closed || socket.destroyed) return socket.destroy();
        webSockets.handleUpgrade(request, socket, head, (client: Peer) => {
          const upstream: Peer = new WebSocket('ws://127.0.0.1' + route, {
            createConnection: () => net.connect({ path: unix }),
            handshakeTimeout: 5000,
            maxPayload: MAX_BYTES,
            perMessageDeflate: false,
          });
          peers.add(client);
          peers.add(upstream);
          const pending: [Buffer, boolean][] = [];
          let bytes = 0;
          const send = (peer: Peer, data: Buffer, binary: boolean) => {
            if (peer.bufferedAmount + data.length > MAX_BYTES) {
              client.terminate();
              upstream.terminate();
            } else peer.send(data, { binary });
          };
          client.on('message', (data: Buffer, binary: boolean) => {
            if (upstream.readyState === WebSocket.OPEN) send(upstream, data, binary);
            else if (upstream.readyState === WebSocket.CONNECTING) {
              bytes += data.length;
              if (bytes > MAX_BYTES) {
                client.terminate();
                upstream.terminate();
              } else pending.push([data, binary]);
            }
          });
          upstream.on('open', () => {
            for (const [data, binary] of pending) send(upstream, data, binary);
            pending.length = 0;
          });
          upstream.on('message', (data: Buffer, binary: boolean) => {
            if (client.readyState === WebSocket.OPEN) send(client, data, binary);
          });
          client.on('close', () => {
            peers.delete(client);
            upstream.terminate();
          });
          upstream.on('close', () => {
            peers.delete(upstream);
            client.close(1001, 'Preview disconnected');
          });
          client.on('error', () => upstream.terminate());
          upstream.on('error', () => client.close(1011, 'Preview debugger unavailable'));
        });
      } catch {
        socket.destroy();
      } finally {
        attaching--;
      }
    },

    close() {
      closed = true;
      for (const request of requests) request.destroy();
      for (const peer of peers) peer.terminate();
      webSockets.close();
    },
  };
}
