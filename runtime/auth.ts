import { randomUUID } from 'node:crypto';

import { createModels, type Models, type Provider } from '@earendil-works/pi-ai';
import { openaiProvider } from '@earendil-works/pi-ai/providers/openai';
import type { AuthInteraction, AuthPrompt } from '@earendil-works/pi-ai';

import { installationId, openCredentials } from './credentials.ts';
import type { AppController, AuthSummary } from './contracts.ts';
import { AppError, invalid } from './protocol.ts';

export type AuthAction =
  | { type: 'start' }
  | { type: 'cancel'; sessionId: string }
  | { type: 'respond'; sessionId: string; promptId: string; answer: string };

export interface AuthView extends AuthSummary {
  sessionId?: string;
  url?: string;
  promptId?: string;
  message: string;
}

export interface Authentication {
  summary(): AuthSummary;
  snapshot(): AuthView;
  execute(action: AuthAction): void;
  assertModel(provider: string): void;
  subscribe(listener: () => void): () => void;
  close(): Promise<void>;
}

export function parseAuthAction(value: unknown): AuthAction {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid();
  const action = value as Record<string, unknown>;
  const extras: Record<string, string[]> = {
    start: [],
    cancel: ['sessionId'],
    respond: ['sessionId', 'promptId', 'answer'],
  };
  if (typeof action.type !== 'string' || !Object.hasOwn(extras, action.type)) invalid();
  if (Object.keys(action).some(key => !['type', ...extras[action.type as string]!].includes(key))) {
    invalid();
  }
  const text = (key: string, maximum: number) => {
    const result = action[key];
    if (
      typeof result !== 'string' ||
      !result.trim() ||
      result.length > maximum ||
      result.includes('\0')
    ) {
      invalid();
    }
    return result;
  };
  if (action.type === 'start') return { type: 'start' };
  const sessionId = text('sessionId', 128);
  if (action.type === 'cancel') return { type: 'cancel', sessionId };
  return {
    type: 'respond',
    sessionId,
    promptId: text('promptId', 128),
    answer: text('answer', 8192),
  };
}

export function chatGPTAuthorizationURL(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      url.origin === 'https://auth.openai.com' &&
      url.pathname === '/api/accounts/authorize' &&
      !url.username &&
      !url.password &&
      !url.hash
    );
  } catch {
    return false;
  }
}

interface LoginSession {
  id: string;
  controller: AbortController;
  url?: string;
  promptId?: string;
  respond?: (answer: string) => void;
  done?: Promise<void>;
}

export async function openAuthentication(
  stateDir: string,
  options: { provider?: Provider; timeoutMs?: number } = {},
): Promise<{ models: Models; auth: Authentication }> {
  const credentials = await openCredentials(stateDir);
  const deviceId = await installationId(stateDir);
  const provider = options.provider ?? openaiProvider();
  const oauth = provider.auth.oauth;
  if (provider.id !== 'openai' || !oauth) throw new Error('ChatGPT OAuth is required.');

  // Only this profile's OAuth credential is eligible. No API-key or ambient-auth fallback.
  const models = createModels({
    credentials,
    authContext: {
      env: async () => undefined,
      fileExists: async () => false,
    },
  });
  models.setProvider({
    ...provider,
    auth: {
      oauth: {
        ...oauth,
        async refresh(credential, signal) {
          try {
            return await oauth.refresh(
              credential,
              AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
            );
          } catch {
            // Provider error bodies can contain private values. Persist only the actionable diagnosis.
            throw new Error('ChatGPTの認証を更新できません。操作メニューから再認証してください。');
          }
        },
      },
    },
  });

  let connected = (await credentials.list()).some(entry => entry.providerId === 'openai');
  let status: AuthSummary['status'] = 'idle';
  let message = connected ? 'ChatGPTの認証を保存しています。' : 'ChatGPTにログインしてください。';
  let revision = 0;
  let session: LoginSession | undefined;
  let closed = false;
  const listeners = new Set<() => void>();

  function changed(): void {
    revision++;
    for (const listener of listeners) listener();
  }

  function summary(): AuthSummary {
    return { provider: 'openai', connected, status, revision };
  }

  function prompt(current: LoginSession, value: AuthPrompt): Promise<string> {
    return new Promise((resolve, reject) => {
      const signal = value.signal
        ? AbortSignal.any([value.signal, current.controller.signal])
        : current.controller.signal;
      const cleanup = () => {
        signal.removeEventListener('abort', abort);
        delete current.promptId;
        delete current.respond;
        changed();
      };
      const abort = () => {
        cleanup();
        reject(new Error('Login cancelled.'));
      };
      if (signal.aborted) {
        abort();
        return;
      }
      if (value.type !== 'manual_code') {
        reject(new Error('Unexpected ChatGPT login prompt.'));
        return;
      }
      current.promptId = randomUUID();
      current.respond = answer => {
        cleanup();
        resolve(answer);
      };
      signal.addEventListener('abort', abort, { once: true });
      changed();
    });
  }

  function start(): void {
    if (status === 'pending') return;
    const current: LoginSession = { id: randomUUID(), controller: new AbortController() };
    session = current;
    status = 'pending';
    message = 'ログインを準備しています…';
    changed();

    let timedOut = false;
    let unexpectedURL = false;
    const timer = setTimeout(() => {
      timedOut = true;
      current.controller.abort();
    }, options.timeoutMs ?? 300_000);
    timer.unref();

    const interaction: AuthInteraction = {
      signal: current.controller.signal,
      prompt: value => prompt(current, value),
      notify(event) {
        if (current.controller.signal.aborted) return;
        if (event.type === 'auth_url') {
          if (!chatGPTAuthorizationURL(event.url)) {
            // Let the provider enter its cancellation/finally path instead of throwing from notify.
            unexpectedURL = true;
            current.controller.abort();
            return;
          }
          current.url = event.url;
          message = '外部ブラウザでログインした後、このアプリに戻ってください。';
          changed();
        } else if (event.type === 'progress') {
          message = '認証を確認しています…';
          changed();
        }
      },
    };

    current.done = (async () => {
      try {
        // Models owns credential persistence and locked refresh; discard the secret return value.
        await models.login('openai', 'oauth', interaction, { getDeviceId: () => deviceId });
        connected = true;
        status = 'done';
        message = 'ChatGPTにログインしました。モデルを選んで依頼を送信できます。';
      } catch {
        status = unexpectedURL
          ? 'error'
          : current.controller.signal.aborted
            ? timedOut
              ? 'timeout'
              : 'cancelled'
            : 'error';
        message =
          status === 'timeout'
            ? 'ログインが時間切れになりました。もう一度開始してください。'
            : status === 'cancelled'
              ? 'ログインをキャンセルしました。'
              : 'ログインできませんでした。ネットワークとブラウザの案内を確認してください。別のPiでログイン中なら先に終了してください。';
      } finally {
        clearTimeout(timer);
        delete current.url;
        delete current.promptId;
        delete current.respond;
        changed();
      }
    })();
  }

  const auth: Authentication = {
    summary,

    snapshot() {
      return {
        ...summary(),
        message,
        ...(session ? { sessionId: session.id } : {}),
        ...(session?.url ? { url: session.url } : {}),
        ...(session?.promptId ? { promptId: session.promptId } : {}),
      };
    },

    execute(candidate) {
      if (closed) throw new AppError('closed', '認証サービスは終了しています。');
      const action = parseAuthAction(candidate);
      if (action.type === 'start') {
        start();
        return;
      }
      if (!session || session.id !== action.sessionId || status !== 'pending') {
        throw new AppError(
          'stale_login',
          'ログイン操作が古くなりました。現在の状態を確認してください。',
        );
      }
      if (action.type === 'cancel') {
        session.controller.abort();
        return;
      }
      if (!session.respond || session.promptId !== action.promptId) {
        throw new AppError(
          'stale_prompt',
          '入力待ちは終了しています。現在の状態を確認してください。',
        );
      }
      session.respond(action.answer);
    },

    assertModel(providerId) {
      if (providerId !== 'openai') {
        throw new AppError(
          'model',
          '実モデルを選択してください。以前のデモ会話は保存したままです。',
        );
      }
      if (!connected)
        throw new AppError('login_required', 'ChatGPTにログインしてから送信してください。');
    },

    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    async close() {
      if (closed) return;
      closed = true;
      session?.controller.abort();
      await session?.done;
      listeners.clear();
    },
  };
  return { models, auth };
}

export function withAuthentication(kernel: AppController, auth: Authentication): AppController {
  return {
    async snapshot() {
      return { ...(await kernel.snapshot()), auth: auth.summary() };
    },
    execute: action => kernel.execute(action),
    subscribe(listener) {
      const unwatchKernel = kernel.subscribe(listener);
      const unwatchAuth = auth.subscribe(listener);
      return () => {
        unwatchKernel();
        unwatchAuth();
      };
    },
    async close() {
      try {
        await auth.close();
      } finally {
        await kernel.close();
      }
    },
  };
}
