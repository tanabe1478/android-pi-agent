import { lstat } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import { readPrivate, writePrivate } from './credentials.ts';
import { AppError } from './protocol.ts';
import { createCapture } from './browser-capture.ts';

export function validatePreviewURL(value: unknown, bridgePort: number): string {
  try {
    if (typeof value !== 'string' || value.length > 4096) throw new Error();
    const url = new URL(value);
    const port = Number(url.port);
    if (
      url.protocol !== 'http:' ||
      !['127.0.0.1', 'localhost'].includes(url.hostname) ||
      url.username ||
      url.password ||
      !url.port ||
      port < 1 ||
      port > 65535 ||
      port === 1455 ||
      port === bridgePort
    )
      throw new Error();
    return url.href;
  } catch {
    throw new AppError(
      'preview_url',
      'Preview requires a local HTTP project port, not the Pi or OAuth server.',
    );
  }
}

export function parsePreviewOpen(value: unknown): string {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).length !== 1 ||
    !('url' in value) ||
    typeof value.url !== 'string'
  ) {
    throw new AppError('invalid_action', 'Use {url: "http://127.0.0.1:PORT/"}.');
  }
  return value.url;
}

export function createPreview(stateDir: string, ownerPid: number, runtimePid = process.pid) {
  const requestFile = path.join(stateDir, 'preview-request.json');
  let opening = false;
  let closed = false;

  async function snapshot(bridgePort: number) {
    try {
      const value = (await readPrivate(path.join(stateDir, 'preview-state.json'))) as Record<
        string,
        unknown
      >;
      if (
        closed ||
        !value ||
        value.version !== 1 ||
        value.parentPid !== ownerPid ||
        value.runtimePid !== runtimePid ||
        !Number.isSafeInteger(value.pid) ||
        Number(value.pid) < 1 ||
        Number(value.pid) > 2_147_483_647 ||
        value.pid === ownerPid ||
        value.pid === runtimePid ||
        value.available !== true
      ) {
        return { available: false, debugging: false };
      }
      process.kill(Number(value.pid), 0);
      const url = validatePreviewURL(value.url, bridgePort);
      return { available: true, debugging: value.debugging === true, pid: Number(value.pid), url };
    } catch {
      return { available: false, debugging: false };
    }
  }

  const nativeCapture = createCapture(stateDir, ownerPid, runtimePid, snapshot);
  return {
    snapshot,
    capture: nativeCapture.capture,
    async open(value: unknown, bridgePort: number) {
      if (closed) throw new AppError('closed', 'Preview is closed.');
      const url = validatePreviewURL(value, bridgePort);
      if (opening) throw new AppError('preview_pending', 'A preview request is already pending.');
      opening = true;
      try {
        try {
          await lstat(requestFile);
          throw new AppError(
            'preview_pending',
            'A preview request is pending. Keep Android Pi in the foreground; do not automatically resubmit.',
          );
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }
        await writePrivate(requestFile, {
          version: 1,
          id: randomUUID(),
          url,
          parentPid: ownerPid,
          runtimePid,
          createdAt: Date.now(),
        });
        return { requested: true, message: 'Keep Android Pi in the foreground to open Preview.' };
      } catch (error) {
        if (error instanceof AppError) throw error;
        throw new AppError(
          'preview_request',
          'Could not publish preview request. Read status; do not automatically resubmit.',
        );
      } finally {
        opening = false;
      }
    },
    async socketPath(bridgePort: number) {
      const state = await snapshot(bridgePort);
      if (!state.available || !state.debugging || !state.pid)
        throw new AppError(
          'preview_unavailable',
          'Open Preview in a debug APK and keep it visible.',
        );
      return '\0webview_devtools_remote_' + state.pid;
    },
    close() {
      nativeCapture.close();
      closed = true;
    },
  };
}

export type Preview = ReturnType<typeof createPreview>;
