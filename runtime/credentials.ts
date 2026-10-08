import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { chmod, mkdir, open, rename, unlink } from 'node:fs/promises';
import path from 'node:path';

import type { AuthOperationOptions, Credential, CredentialStore } from '@earendil-works/pi-ai';

const MAXIMUM = 256 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function readPrivate(file: string): Promise<unknown> {
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile() || metadata.size > MAXIMUM) {
      throw new Error('Invalid private authentication file.');
    }
    await handle.chmod(0o600);
    // Bound the read even if trusted same-UID code changes the file after stat().
    const buffer = Buffer.alloc(MAXIMUM + 1);
    let size = 0;
    while (size < buffer.length) {
      const { bytesRead } = await handle.read(buffer, size, buffer.length - size, size);
      if (!bytesRead) break;
      size += bytesRead;
    }
    if (size > MAXIMUM) throw new Error('Invalid private authentication file.');
    return JSON.parse(buffer.subarray(0, size).toString('utf8')) as unknown;
  } finally {
    await handle.close();
  }
}

async function writePrivate(file: string, value: unknown): Promise<void> {
  const serialized = JSON.stringify(value);
  if (Buffer.byteLength(serialized) > MAXIMUM) {
    throw new Error('Authentication data is too large.');
  }
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    const handle = await open(temporary, 'wx', 0o600);
    try {
      await handle.writeFile(serialized);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, file);
  } finally {
    await unlink(temporary).catch(() => {});
  }
}

function credential(value: unknown): Credential {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Invalid stored credential.');
  }
  const candidate = value as Record<string, unknown>;
  if (
    candidate.type !== 'oauth' ||
    typeof candidate.access !== 'string' ||
    !candidate.access.trim() ||
    typeof candidate.refresh !== 'string' ||
    !candidate.refresh.trim() ||
    typeof candidate.expires !== 'number' ||
    !Number.isFinite(candidate.expires)
  ) {
    throw new Error('Invalid stored credential.');
  }
  // Preserve provider-owned fields such as clientId and scopes, without interpreting tokens.
  return candidate as Credential;
}

function missing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === 'ENOENT';
}

// One profile owner holds the Android flock. This queue serializes refresh/login/logout within
// that owner; it is not a cross-process file lock for standalone desktop invocations.
export async function openCredentials(stateDir: string): Promise<CredentialStore> {
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  await chmod(stateDir, 0o700);
  const file = path.join(stateDir, 'auth.json');
  let queue: Promise<unknown> = Promise.resolve();

  async function read(): Promise<Record<string, Credential>> {
    let value: unknown;
    try {
      value = await readPrivate(file);
    } catch (error) {
      if (missing(error)) return {};
      // Never include raw JSON, tokens, parser errors or filesystem paths in public errors.
      throw new Error(
        '認証ファイルを読み込めません。削除せず、privateな保存先を確認してください。',
      );
    }
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error('認証ファイルの形式が正しくありません。');
    }
    const result: Record<string, Credential> = Object.create(null);
    for (const [provider, entry] of Object.entries(value)) {
      if (provider !== 'openai') throw new Error('未対応の保存済み認証です。');
      result[provider] = credential(entry);
    }
    return result;
  }

  function serialized<T>(operation: () => Promise<T>, options?: AuthOperationOptions): Promise<T> {
    const pending = queue.then(async () => {
      options?.signal?.throwIfAborted();
      return operation();
    });
    queue = pending.catch(() => {});
    return pending;
  }

  function checkProvider(provider: string): void {
    if (provider !== 'openai') throw new Error('未対応の認証プロバイダーです。');
  }

  return {
    read(provider, options) {
      checkProvider(provider);
      return serialized(async () => structuredClone((await read())[provider]), options);
    },

    list(options) {
      return serialized(
        async () =>
          Object.entries(await read()).map(([providerId, entry]) => ({
            providerId,
            type: entry.type,
          })),
        options,
      );
    },

    modify(provider, update, options) {
      checkProvider(provider);
      return serialized(async () => {
        const entries = await read();
        const next = await update(structuredClone(entries[provider]));
        options?.signal?.throwIfAborted();
        if (next !== undefined) {
          entries[provider] = credential(next);
          await writePrivate(file, entries);
        }
        return structuredClone(entries[provider]);
      }, options);
    },

    delete(provider, options) {
      checkProvider(provider);
      return serialized(async () => {
        const entries = await read();
        delete entries[provider];
        options?.signal?.throwIfAborted();
        await writePrivate(file, entries);
      }, options);
    },
  };
}

export async function installationId(stateDir: string): Promise<string> {
  const file = path.join(stateDir, 'installation.json');
  try {
    const handle = await open(file, 'wx', 0o600);
    try {
      await handle.writeFile(JSON.stringify({ version: 1, id: randomUUID() }));
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
      throw new Error('インストール識別子を保存できません。');
    }
  }
  try {
    const value = (await readPrivate(file)) as { version?: unknown; id?: unknown };
    if (value.version === 1 && typeof value.id === 'string' && UUID.test(value.id)) {
      return value.id;
    }
  } catch {
    // Do not silently regenerate an installation identity or print private file contents.
  }
  throw new Error('保存済みインストール識別子が正しくありません。');
}
