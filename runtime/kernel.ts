import { randomUUID } from 'node:crypto';
import { chmod, mkdir, realpath, stat } from 'node:fs/promises';
import path from 'node:path';

import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import type { AttachedReplicatedState } from '@earendil-works/chord';
import { clampThinkingLevel, getSupportedThinkingLevels, type Models } from '@earendil-works/pi-ai';
import {
  createRegistry,
  defineDoc,
  defineExtension,
  Harness,
  section,
  type Conversation,
  type ConversationId,
  type ConversationView,
  type EntryId,
  type HarnessSettings,
  type ModelRef,
  type SubmissionId,
} from '@earendil-works/pi-durable';
import { CodingTools } from '@earendil-works/pi-durable/tools';
import { NodeExecutionEnv } from '@earendil-works/pi-durable/env/node';
import { openNodeSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/node';

import { COMMANDS, parseInput } from '../shared/commands.js';
import type { Action, ActionResult, AppController, AppView } from './contracts.ts';
import { AppError, parseAction } from './protocol.ts';

const ctx = BACKGROUND_CONTEXT;

const Catalog = defineDoc({
  kind: 'android-pi.catalog',
  version: 1,
  scope: 'session',
  initial: () => ({
    activeId: 1,
    sessions: [] as { id: number; name: string; createdAt: number }[],
  }),
});

export interface OpenOptions {
  stateDir: string;
  workspace: string;
  models: Models;
  initialModel?: ModelRef;
  shellPath?: string;
  shellEnv?: NodeJS.ProcessEnv;
  settings?: HarnessSettings;
  demo?: boolean;
  authorizeModel?: (provider: string) => void;
}

// Inspired by upstream experimental/durable's DurableView / DurableController.
// The UI owns no agent, event reducer, session files or execution queue.
export async function openKernel(options: OpenOptions): Promise<AppController> {
  const workspace = await realpath(options.workspace);
  if (!(await stat(workspace)).isDirectory())
    throw new AppError('workspace', '作業場所がディレクトリではありません。');

  await mkdir(options.stateDir, { recursive: true, mode: 0o700 });
  await chmod(options.stateDir, 0o700);

  const envs = new Map<string, NodeExecutionEnv>();
  const registry = createRegistry();
  registry.install(CodingTools);
  registry.install(
    defineExtension({
      name: 'android-pi-context',
      sections: [
        section(
          'android_pi',
          () =>
            'Use the supplied coding tools and standard CLIs in the explicit workspace. Ask before installing packages, remote writes or pushes. Never read or display credentials. Android tools run within the app sandbox, not as root. Do not claim access to other apps or device settings.' +
            (options.shellEnv?.PI_ANDROID_STATE
              ? ' Android CLI setup: pi-pkg list; pi-pkg plan PACKAGE; pi-pkg install PACKAGE --yes. Honor existing owner authorization, otherwise ask before installation. gh uses the app-owned GitHub PAT after installation. If authentication is unavailable, ask the owner to configure it in the GitHub dialog; never inspect credentials, dump the environment, run gh auth token or put a token into a command.'
              : ''),
        ),
      ],
    }),
  );

  const storage = await openNodeSqliteStorage(path.join(options.stateDir, 'session.sqlite'));
  let harness: Awaited<ReturnType<typeof Harness.open>>;
  try {
    harness = await Harness.open(
      storage,
      {
        models: options.models,
        registry,
        settings: options.settings,
        env: ({ cwd = workspace }) => {
          let env = envs.get(cwd);
          if (!env) {
            env = new NodeExecutionEnv({
              cwd,
              shellPath: options.shellPath,
              shellEnv: options.shellEnv,
            });
            envs.set(cwd, env);
          }
          return env;
        },
        // Provider/tool error messages belong in durable entries. Do not log raw auth/provider payloads.
        onReport: () => {},
      },
      ctx,
    );
    await chmod(path.join(options.stateDir, 'session.sqlite'), 0o600);

    const root = await harness.root(ctx, {
      agent: { cwd: workspace, model: options.initialModel },
    });
    await harness.commit(async tx => {
      const catalog = await tx.doc(Catalog);
      if (!catalog.sessions.length) {
        catalog.sessions.push({ id: root.id, name: 'Main', createdAt: Date.now() });
        catalog.activeId = root.id;
      }
    }, ctx);
  } catch (error) {
    await storage.close(ctx);
    throw error;
  }

  const instanceId = randomUUID();
  const mounts = new Map<number, Promise<AttachedReplicatedState<ConversationView>>>();
  const listeners = new Set<() => void>();
  const confirmations = new Map<
    string,
    { conversationId: number; stamp: string; expires: number }
  >();

  let revision = 0;
  let closing = false;
  let queue: Promise<unknown> = Promise.resolve();
  let timer: ReturnType<typeof setTimeout> | undefined;

  const unsubscribe = harness.subscribeCommits(() => {
    revision++;
    // Commit callbacks may not read Session APIs or render. Publish invalidation later.
    if (!timer)
      timer = setTimeout(() => {
        timer = undefined;
        for (const listener of listeners) listener();
      }, 0);
  });

  async function conversation(id: number): Promise<Conversation> {
    const catalog = await harness.snapshot(Catalog, ctx);
    if (!catalog?.sessions.some(session => session.id === id))
      throw new AppError('not_found', '会話が見つかりません。');

    const found = await harness.conversation(id as ConversationId, ctx);
    if (!found) throw new AppError('not_found', '会話が見つかりません。');
    return found;
  }

  async function viewOf(target: Conversation): Promise<ConversationView> {
    let pending = mounts.get(target.id);
    if (!pending) {
      pending = target.viewState(ctx);
      mounts.set(target.id, pending);
      const attached = pending;
      void pending.catch(() => {
        if (mounts.get(target.id) === attached) mounts.delete(target.id);
      });
    }
    return (await pending).value;
  }

  async function requireIdle(target: Conversation): Promise<ConversationView> {
    const view = await viewOf(target);
    const live = view.docs['pi.live'] as { run?: unknown; compactions?: unknown[] } | undefined;
    const inbox = view.docs['pi.inbox'] as { items?: unknown[] } | undefined;

    if (live?.run || live?.compactions?.length || inbox?.items?.length)
      throw new AppError('busy', '実行と入力キューが完了してから操作してください。');
    return view;
  }

  const stamp = (view: ConversationView) =>
    JSON.stringify({
      entries: view.entries.map(entry => entry.id),
      agent: view.docs['pi.agent'],
    });

  function translate(action: Extract<Action, { type: 'input' }>): Action | ActionResult {
    const parsed = parseInput(action.text.trim());
    if (parsed.type === 'text') {
      if (parsed.text.startsWith('!'))
        throw new AppError('unsupported', '直接シェル入力は未対応です。モデルには送信しません。');
      return {
        ...action,
        text: action.text.trimStart().startsWith('//')
          ? action.text.replace('//', '/')
          : action.text,
      };
    }

    const { name, args } = parsed;
    if (!COMMANDS.some(command => command.name === name))
      throw new AppError('unknown_command', `未対応のコマンド: /${name}`);

    const conversationId = action.conversationId;
    switch (name) {
      case 'help':
        return { kind: 'dialog', dialog: 'help' };
      case 'login':
        if (options.demo) throw new AppError('unsupported', 'デモは実認証を使用しません。');
        return { kind: 'dialog', dialog: 'auth' };
      case 'github':
        if (options.demo) throw new AppError('unsupported', 'デモは実認証を使用しません。');
        if (args) throw new AppError('invalid_action', '/githubにPATを入力しないでください。');
        return { kind: 'dialog', dialog: 'github' };
      case 'abort':
        return { type: 'abort', conversationId };
      case 'clear':
        return { type: 'clear', conversationId };
      case 'new':
        return { type: 'new', conversationId, ...(args ? { name: args } : {}) };
      case 'name':
        return parseAction({ type: 'rename', conversationId, name: args });
      case 'resume':
        return args
          ? parseAction({ type: 'select', conversationId: Number(args) })
          : { kind: 'dialog', dialog: 'sessions' };
      case 'compact':
        return { type: 'compact', conversationId, ...(args ? { instructions: args } : {}) };
      case 'thinking':
        return args
          ? parseAction({ type: 'thinking', conversationId, level: args })
          : { kind: 'dialog', dialog: 'thinking' };
      case 'model': {
        if (!args) return { kind: 'dialog', dialog: 'models' };
        const slash = args.indexOf('/');
        if (slash < 1) throw new AppError('model', 'provider/model の形式で指定してください。');
        return parseAction({
          type: 'model',
          conversationId,
          model: { provider: args.slice(0, slash), modelId: args.slice(slash + 1) },
        });
      }
      default:
        throw new AppError('unsupported', '未対応のコマンドです。');
    }
  }

  async function perform(action: Action): Promise<ActionResult> {
    const target = await conversation(action.conversationId);

    if (action.type === 'input') {
      const translated = translate(action);
      if ('kind' in translated) return translated;
      if (translated.type !== 'input') return perform(translated);

      const agent = await target.agent(ctx);
      if (!agent.model) throw new AppError('no_model', 'モデルが設定されていません。');
      options.authorizeModel?.(agent.model.provider);
      const submitted = await target.submit(
        { type: 'input', content: translated.text, whenBusy: translated.mode },
        ctx,
      );
      return { kind: 'accepted', operationId: submitted.id };
    }

    switch (action.type) {
      case 'abort':
        await target.abort(ctx);
        return { kind: 'done' };
      case 'select':
        await harness.commit(async tx => {
          (await tx.doc(Catalog)).activeId = target.id;
        }, ctx);
        return { kind: 'done' };
      case 'rename':
        await harness.commit(async tx => {
          const catalog = await tx.doc(Catalog);
          const session = catalog.sessions.find(session => session.id === target.id)!;
          session.name = action.name.trim();
        }, ctx);
        return { kind: 'done' };
      case 'new': {
        const agent = await target.agent(ctx);
        await harness.createConversation(
          {
            ownership: { kind: 'ownerless' },
            agent: {
              cwd: agent.cwd ?? workspace,
              model: agent.model,
              thinkingLevel: agent.thinkingLevel,
            },
            init: async (tx, id) => {
              const catalog = await tx.doc(Catalog);
              catalog.sessions.push({
                id,
                name: action.name?.trim() ?? 'New session',
                createdAt: Date.now(),
              });
              catalog.activeId = id;
            },
          },
          ctx,
        );
        return { kind: 'done' };
      }
      case 'fork':
        await requireIdle(target);
        await target.fork(
          action.entryId as EntryId,
          {
            ownership: { kind: 'ownerless' },
            init: async (tx, id) => {
              const catalog = await tx.doc(Catalog);
              catalog.sessions.push({
                id,
                name: action.name?.trim() ?? 'Fork',
                createdAt: Date.now(),
              });
              catalog.activeId = id;
            },
          },
          ctx,
        );
        return { kind: 'done' };
      case 'model': {
        const model = options.models.getModel(action.model.provider, action.model.modelId);
        if (!model) throw new AppError('model', '登録されていないモデルです。');
        const agent = await target.agent(ctx);
        await target.configure(
          { model: action.model, thinkingLevel: clampThinkingLevel(model, agent.thinkingLevel) },
          ctx,
        );
        return { kind: 'done' };
      }
      case 'thinking': {
        const agent = await target.agent(ctx);
        const model =
          agent.model && options.models.getModel(agent.model.provider, agent.model.modelId);
        if (!model || !getSupportedThinkingLevels(model).includes(action.level))
          throw new AppError('thinking', 'このモデルでは利用できない思考レベルです。');
        await target.configure({ thinkingLevel: action.level }, ctx);
        return { kind: 'done' };
      }
      case 'compact': {
        const agent = await target.agent(ctx);
        if (!agent.model) throw new AppError('no_model', 'モデルが設定されていません。');
        options.authorizeModel?.(agent.model.provider);
        const id = await target.compact(action.instructions, ctx);
        return { kind: 'accepted', operationId: id };
      }
      case 'cancelQueued':
        await harness.abortSubmission(action.submissionId as SubmissionId, ctx, target.id);
        return { kind: 'done' };
      case 'clear': {
        const view = await requireIdle(target);

        // Expire outstanding tickets and keep this process-only interaction bounded.
        for (const [key, ticket] of confirmations)
          if (ticket.expires < Date.now()) confirmations.delete(key);

        if (!action.confirmation) {
          if (confirmations.size >= 32) confirmations.delete(confirmations.keys().next().value!);
          const token = randomUUID();
          confirmations.set(token, {
            conversationId: target.id,
            stamp: stamp(view),
            expires: Date.now() + 60_000,
          });
          return {
            kind: 'confirmation',
            conversationId: target.id,
            token,
            message: 'この会話の文脈をリセットします。履歴・ファイル・認証は削除しません。',
          };
        }

        const ticket = confirmations.get(action.confirmation);
        confirmations.delete(action.confirmation);
        if (
          !ticket ||
          ticket.conversationId !== target.id ||
          ticket.expires < Date.now() ||
          ticket.stamp !== stamp(view)
        )
          throw new AppError(
            'stale_confirmation',
            '会話が変化しました。もう一度確認してください。',
          );

        await target.reset(undefined, ctx);
        return { kind: 'done' };
      }
    }
  }

  const controller: AppController = {
    async snapshot() {
      if (closing) throw new AppError('closed', 'ランタイムは終了しています。');
      const catalog = (await harness.snapshot(Catalog, ctx))!;
      const target = await conversation(catalog.activeId);

      const view: AppView = {
        instanceId,
        revision,
        demo: Boolean(options.demo),
        activeId: catalog.activeId,
        sessions: catalog.sessions,
        models: options.models.getModels().map(model => ({
          provider: model.provider,
          modelId: model.id,
          name: model.name,
          thinkingLevels: getSupportedThinkingLevels(model),
        })),
        conversation: await viewOf(target),
      };
      return structuredClone(view);
    },

    execute(candidate) {
      if (closing) return Promise.reject(new AppError('closed', 'ランタイムは終了しています。'));

      let action: Action;
      try {
        action = parseAction(candidate);
      } catch (error) {
        return Promise.reject(error);
      }

      // Abort never waits behind model-admission/configuration commands.
      const input = action.type === 'input' ? parseInput(action.text.trim()) : undefined;
      if (action.type === 'abort' || (input?.type === 'command' && input.name === 'abort'))
        return perform({ type: 'abort', conversationId: action.conversationId });

      const operation = queue.then(() => perform(action));
      queue = operation.catch(() => {});
      return operation;
    },

    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    async close() {
      if (closing) return;
      closing = true;
      await queue;

      unsubscribe();
      if (timer) clearTimeout(timer);
      listeners.clear();
      confirmations.clear();

      for (const pending of mounts.values()) {
        try {
          (await pending).dispose();
        } catch {}
      }
      mounts.clear();

      try {
        await harness.close(ctx);
      } finally {
        for (const env of envs.values()) await env.cleanup(ctx);
      }
    },
  };

  harness.resume();
  return controller;
}
