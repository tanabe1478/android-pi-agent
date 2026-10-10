import { constants } from 'node:fs';
import { lstat, open, unlink } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import { readPrivate, writePrivate } from './credentials.ts';
import { AppError } from './protocol.ts';
import { imageMimeType, MAX_IMAGE_BYTES } from './image-read.ts';

type State = { available: boolean; pid?: number; url?: string };

export function createCapture(
  stateDir: string,
  ownerPid: number,
  runtimePid: number,
  snapshot: (port: number) => Promise<State>,
  timeoutMs = 10000,
) {
  const requestFile = path.join(stateDir, 'preview-capture.json');
  let capturing = false;
  let closed = false;

  return {
    async capture(port: number): Promise<Buffer> {
      if (closed) throw new AppError('closed', 'Preview is closed.');
      if (capturing) throw new AppError('preview_busy', 'A preview capture is already running.');
      capturing = true;
      const id = randomUUID();
      const image = path.join(stateDir, `.preview-image-${id}.png`);
      const resultFile = path.join(stateDir, `.preview-image-${id}.json`);
      const marker = path.join(stateDir, `.preview-image-${id}.pending`);
      let markerCreated = false;
      let published = false;
      try {
        const state = await snapshot(port);
        if (!state.available || !state.pid || !state.url)
          throw new AppError('preview_unavailable', 'Keep Preview in the foreground.');
        try {
          await lstat(requestFile);
          throw new AppError(
            'preview_pending',
            'Inspect the pending native capture; do not automatically repeat it.',
          );
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }
        if (closed) throw new AppError('closed', 'Preview is closed.');
        const pending = await open(marker, 'wx', 0o600);
        markerCreated = true;
        await pending.close();
        const createdAt = Date.now();
        await writePrivate(requestFile, {
          version: 1,
          id,
          parentPid: ownerPid,
          runtimePid,
          previewPid: state.pid,
          url: state.url,
          createdAt,
        });
        published = true;
        while (!closed && Date.now() - createdAt < timeoutMs) {
          let value: Record<string, unknown> | undefined;
          try {
            value = (await readPrivate(resultFile)) as Record<string, unknown>;
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
          }
          if (value) {
            if (
              value.version !== 1 ||
              value.id !== id ||
              value.parentPid !== ownerPid ||
              value.runtimePid !== runtimePid ||
              value.pid !== state.pid ||
              value.renderer !== 'webview-hardware' ||
              value.ok !== true
            )
              throw new AppError('preview_capture', 'Native preview capture failed.');
            const handle = await open(image, constants.O_RDONLY | constants.O_NOFOLLOW);
            try {
              const info = await handle.stat();
              if (!info.isFile() || info.size > MAX_IMAGE_BYTES) throw new Error();
              await handle.chmod(0o600);
              const bytes = Buffer.alloc(MAX_IMAGE_BYTES + 1);
              let size = 0;
              while (size < bytes.length) {
                const read = await handle.read(bytes, size, bytes.length - size, size);
                if (!read.bytesRead) break;
                size += read.bytesRead;
              }
              const png = bytes.subarray(0, size);
              if (size > MAX_IMAGE_BYTES || imageMimeType(png) !== 'image/png') throw new Error();
              return png;
            } finally {
              await handle.close();
            }
          }
          await new Promise(resolve => setTimeout(resolve, 50));
        }
        throw new AppError(
          'preview_timeout',
          'Native capture did not complete. Do not automatically repeat it.',
        );
      } catch (error) {
        if (error instanceof AppError) throw error;
        throw new AppError('preview_capture', 'Native preview capture failed.');
      } finally {
        // Revoke the native publication lease before cleaning the nonce-bound outputs.
        if (markerCreated) await unlink(marker).catch(() => {});
        // Clean only this request's nonce-bound outputs, never another owner's capture.
        if (published) {
          const request = (await readPrivate(requestFile).catch(() => undefined)) as
            | { id?: string }
            | undefined;
          if (request?.id === id) await unlink(requestFile).catch(() => {});
          await unlink(image).catch(() => {});
          await unlink(resultFile).catch(() => {});
        }
        capturing = false;
      }
    },
    close() {
      closed = true;
    },
  };
}
