import { randomUUID } from 'node:crypto';
import { chmod, mkdir, unlink } from 'node:fs/promises';
import path from 'node:path';

import { readPrivate, writePrivate } from './credentials.ts';
import type { AppController, GitHubSummary } from './contracts.ts';
import { AppError, invalid } from './protocol.ts';

export type GitHubAction =
  | { type: 'save'; revision: number; token: string }
  | { type: 'disconnect'; revision: number; confirmation?: string };

export type GitHubResult =
  | { kind: 'done' }
  | { kind: 'confirmation'; token: string; revision: number; message: string };

export interface GitHubAuthentication {
  summary(): GitHubSummary;
  snapshot(): GitHubSummary & { message: string };
  execute(action: GitHubAction): Promise<GitHubResult>;
  subscribe(listener: () => void): () => void;
  close(): Promise<void>;
}

export function parseGitHubAction(value: unknown): GitHubAction {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid();
  const action = value as Record<string, unknown>;
  const allowed =
    action.type === 'save'
      ? ['type', 'revision', 'token']
      : action.type === 'disconnect'
        ? ['type', 'revision', 'confirmation']
        : [];
  if (!allowed.length || Object.keys(action).some(key => !allowed.includes(key))) invalid();
  if (!Number.isSafeInteger(action.revision) || (action.revision as number) < 0) invalid();
  const revision = action.revision as number;
  if (action.type === 'save') {
    if (typeof action.token !== 'string' || action.token.length > 4096) invalid();
    const token = action.token.trim();
    if (!/^[A-Za-z0-9_]{16,4096}$/.test(token)) invalid();
    return { type: 'save', revision, token };
  }
  const confirmation = action.confirmation;
  if (
    confirmation !== undefined &&
    (typeof confirmation !== 'string' || !/^[0-9a-f-]{36}$/.test(confirmation))
  )
    invalid();
  return { type: 'disconnect', revision, confirmation: confirmation as string | undefined };
}

interface StoredGitHub {
  version: 1;
  token: string;
  user: string;
}

async function stored(file: string): Promise<StoredGitHub | undefined> {
  try {
    const value = (await readPrivate(file)) as StoredGitHub;
    if (
      value?.version !== 1 ||
      typeof value.token !== 'string' ||
      !/^[A-Za-z0-9_]{16,4096}$/.test(value.token) ||
      typeof value.user !== 'string' ||
      !/^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/.test(value.user)
    )
      throw new Error();
    return value;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw new AppError(
      'github_storage',
      'GitHub認証ファイルを読み込めません。削除せず確認してください。',
    );
  }
}

async function verify(token: string, fetcher: typeof fetch, signal: AbortSignal): Promise<string> {
  try {
    signal.throwIfAborted();
    const response = await fetcher('https://api.github.com/user', {
      headers: {
        authorization: `Bearer ${token}`,
        accept: 'application/vnd.github+json',
        'x-github-api-version': '2022-11-28',
        'user-agent': 'android-pi',
      },
      redirect: 'error',
      signal,
    });
    if (!response.ok || !response.body) throw new Error();
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > 32 * 1024) throw new Error();
        chunks.push(value);
      }
    } finally {
      await reader.cancel().catch(() => {});
    }
    const user = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { login?: unknown };
    if (typeof user.login !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/.test(user.login)) {
      throw new Error();
    }
    return user.login;
  } catch {
    throw new AppError(
      'github_verify',
      'GitHub認証を確認できません。通信・有効期限・権限を確認してください。',
    );
  }
}

// Profile-scoped credentials, not a conversation mutation or durable document. Tokens never
// enter AppView, tool arguments, model context, Git URLs/configuration or public errors.
export async function openGitHub(
  stateDir: string,
  options: { fetcher?: typeof fetch; timeoutMs?: number } = {},
): Promise<GitHubAuthentication> {
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  await chmod(stateDir, 0o700);
  const file = path.join(stateDir, 'github.json');
  let current = await stored(file);
  let revision = 0;
  let status: GitHubSummary['status'] = 'idle';
  let message = current ? '保存済みGitHub認証を利用できます。' : 'GitHub PATを保存してください。';
  let pending: Promise<GitHubResult> | undefined;
  let closed = false;
  const abort = new AbortController();
  const listeners = new Set<() => void>();
  let confirmation: { token: string; revision: number; expires: number } | undefined;

  function changed() {
    revision++;
    for (const listener of listeners) listener();
  }

  const summary = (): GitHubSummary => ({
    connected: Boolean(current),
    user: current?.user ?? null,
    status,
    revision,
  });

  async function mutate(action: GitHubAction): Promise<GitHubResult> {
    // Re-read before writing: corruption or a symlink must not be silently replaced.
    current = await stored(file);
    if (action.type === 'disconnect') {
      if (!current) return { kind: 'done' };
      if (!action.confirmation) {
        confirmation = { token: randomUUID(), revision, expires: Date.now() + 60_000 };
        return {
          kind: 'confirmation',
          token: confirmation.token,
          revision,
          message: '新アプリのGitHub PATを削除します。会話・ファイル・ChatGPT認証は保持します。',
        };
      }
      const ticket = confirmation;
      confirmation = undefined;
      if (
        !ticket ||
        ticket.token !== action.confirmation ||
        ticket.revision !== revision ||
        ticket.expires < Date.now()
      )
        throw new AppError('stale_github', '解除確認が古くなりました。');
      await unlink(file);
      current = undefined;
      status = 'idle';
      message = 'GitHub認証を解除しました。';
      changed();
      return { kind: 'done' };
    }

    confirmation = undefined;
    status = 'verifying';
    message = 'GitHub認証を確認しています…';
    changed();
    try {
      const signal = AbortSignal.any([
        abort.signal,
        AbortSignal.timeout(options.timeoutMs ?? 15_000),
      ]);
      const user = await verify(action.token, options.fetcher ?? fetch, signal);
      signal.throwIfAborted();
      // A failed reauthentication keeps the previous credential. Never persist raw HTTP errors.
      const next: StoredGitHub = { version: 1, token: action.token, user };
      await stored(file);
      signal.throwIfAborted();
      await writePrivate(file, next);
      current = next;
      status = 'done';
      message = 'GitHub認証を保存しました。利用可能なrepositoryはPATの権限に依存します。';
      return { kind: 'done' };
    } catch (error) {
      status = 'error';
      message = 'GitHub認証の更新に失敗しました。以前の認証は保持しています。';
      if (error instanceof AppError) throw error;
      throw new AppError('github_save', 'GitHub認証を保存できませんでした。');
    } finally {
      changed();
    }
  }

  return {
    summary,
    snapshot: () => ({ ...summary(), message }),
    execute(candidate) {
      if (closed) throw new AppError('closed', 'GitHub認証サービスは終了しています。');
      const action = parseGitHubAction(candidate);
      if (pending || action.revision !== revision) {
        throw new AppError(
          'stale_github',
          'GitHub認証状態が変わりました。確認してから操作してください。',
        );
      }
      const operation = mutate(action);
      pending = operation;
      void operation
        .finally(() => {
          pending = undefined;
        })
        .catch(() => {});
      return operation;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async close() {
      if (closed) return;
      closed = true;
      abort.abort();
      await pending?.catch(() => {});
      listeners.clear();
    },
  };
}

export function withGitHub(kernel: AppController, github: GitHubAuthentication): AppController {
  return {
    async snapshot() {
      return { ...(await kernel.snapshot()), github: github.summary() };
    },
    execute: action => kernel.execute(action),
    subscribe(listener) {
      const unwatchKernel = kernel.subscribe(listener);
      const unwatchGitHub = github.subscribe(listener);
      return () => {
        unwatchKernel();
        unwatchGitHub();
      };
    },
    async close() {
      try {
        await github.close();
      } finally {
        await kernel.close();
      }
    },
  };
}
