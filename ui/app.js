import { COMMANDS, suggestions } from '/shared/commands.js';
import { Client } from './client.js';
import { Transcript, Dialog, activityOf, busyOf, element, button } from './components.js';
import { AuthenticationPanel } from './auth.js';
import { GitHubPanel } from './github.js';
import { usageOf, formatTokens, shortPath } from './presentation.js';

const $ = id => document.getElementById(id);

const fragment = new URLSearchParams(location.hash.slice(1));
const token = fragment.get('token') ?? sessionStorage.getItem('pi.bridge-token');
if (fragment.has('token')) {
  sessionStorage.setItem('pi.bridge-token', token);
  history.replaceState(null, '', location.pathname);
}

const client = new Client(token ?? '');
const dialog = new Dialog($('dialog'));
const transcript = new Transcript($('transcript'), (conversationId, entryId) =>
  dispatch({ type: 'fork', conversationId, entryId }),
);

let view;
let sending = false;
let draftRevision = 0;
let connected = false;
let errorMessage = '';
let completionIndex = 0;

const authentication = new AuthenticationPanel(
  client,
  dialog,
  message => {
    errorMessage = message;
    status();
  },
  () => showDialog('models'),
);

const github = new GitHubPanel(client, dialog, message => {
  errorMessage = message;
  status();
});

function status() {
  $('status').classList.toggle('error', Boolean(errorMessage));
  $('status').textContent =
    errorMessage ||
    (!connected ? '再接続しています…' : view ? activityOf(view) : '接続しています…');
  $('message').disabled = !view || !connected;
  $('send').disabled = !view || !connected || sending;
  const busy = view && busyOf(view);
  $('abort').disabled = !connected || !busy;
  $('abort').hidden = !busy;
  $('composer').classList.toggle('busy', Boolean(busy));
}

function render(next) {
  // A foreground read can race SSE. Never replace a newer view from this same owner.
  if (
    next.instanceId === view?.instanceId &&
    (next.revision < view.revision ||
      (next.auth?.revision ?? 0) < (view.auth?.revision ?? 0) ||
      (next.github?.revision ?? 0) < (view.github?.revision ?? 0))
  )
    return;

  // Full committed views replace each other. No reconstruction from transient token events.
  view = next;

  $('mode-banner').hidden = !view.demo;
  $('auth-bar').hidden = !view.auth || view.auth.connected;
  authentication.render(view.auth);
  github.render(view.github);
  const session = view.sessions.find(session => session.id === view.activeId);
  $('sessions').textContent = session?.name ?? '会話';

  const agent = view.conversation.docs['pi.agent'] ?? {};
  $('models').textContent = agent.model?.modelId ?? 'モデル';
  $('models').title = agent.model
    ? `${agent.model.provider}/${agent.model.modelId}`
    : 'モデルを選択';
  $('thinking').textContent = agent.thinkingLevel ?? 'off';
  $('composer').dataset.thinking = agent.thinkingLevel ?? 'off';
  $('workspace').textContent = shortPath(agent.cwd);
  $('workspace').title = agent.cwd ?? '';
  const usage = usageOf(view);
  $('usage').textContent = `↑${formatTokens(usage.input)} ↓${formatTokens(usage.output)}`;
  $('usage').title =
    `累積使用量: input ${usage.input}, output ${usage.output}（context使用率ではありません）`;

  transcript.render(view);

  const queued = view.conversation.docs['pi.inbox']?.items ?? [];
  const conversationId = view.activeId;
  $('queue').replaceChildren(
    ...queued.map(item => {
      const row = element('div', undefined, 'queue-item');
      const text =
        typeof item.content === 'string' ? item.content : JSON.stringify(item.content ?? '');
      row.append(
        element('span', `${item.mode === 'followUp' ? '後で' : '割込み'}: ${text.slice(0, 100)}`),
      );
      if (item.mode !== 'write')
        row.append(
          button('取消', () =>
            dispatch({ type: 'cancelQueued', conversationId, submissionId: item.id }),
          ),
        );
      return row;
    }),
  );

  status();
}

async function dispatch(action) {
  try {
    errorMessage = '';
    const result = await client.action(action);

    if (result.kind === 'confirmation') {
      if (await dialog.confirm(result.message))
        await dispatch({
          type: 'clear',
          conversationId: result.conversationId,
          confirmation: result.token,
        });
    } else if (result.kind === 'dialog') showDialog(result.dialog, action.conversationId);

    status();
    return true;
  } catch (error) {
    errorMessage = error.message;
    status();
    return false;
  }
}

function showDialog(kind, conversationId = view?.activeId) {
  if (!view) return;

  if (kind === 'auth') {
    authentication.open();
  } else if (kind === 'github') {
    github.open();
  } else if (kind === 'usage') {
    const usage = usageOf(view);
    dialog.show('累積使用量', [
      element('p', `input ↑${usage.input} / output ↓${usage.output}`),
      element('p', `cache read ${usage.cacheRead} / write ${usage.cacheWrite}`),
      element('p', `reasoning ${usage.reasoning}（outputの内数）`),
      element('p', `参考cost $${usage.cost.toFixed(4)}（実際の請求額ではありません）`),
      element('p', 'pi.usageの確定累計です。context占有率はまだ取得していません。'),
    ]);
  } else if (kind === 'workspace') {
    dialog.show('作業ディレクトリ', [
      element('p', view.conversation.docs['pi.agent']?.cwd ?? ''),
      element('p', '現在は起動時のworkspaceを利用します。変更UIは未対応です。'),
    ]);
  } else if (kind === 'help') {
    dialog.show('操作一覧', [
      element('p', 'Enter 改行 · Ctrl/Cmd+Enter 送信 · Alt+Enter follow-up'),
      element('p', 'Ctrl+L モデル · Ctrl+T 思考表示 · Ctrl+O ツール展開 · Escape 停止'),
      ...COMMANDS.map(command => element('p', `/${command.name} — ${command.description}`)),
    ]);
  } else if (kind === 'models') {
    const search = element('input');
    search.setAttribute('aria-label', 'モデルを検索');
    search.placeholder = 'モデル名で絞り込み';
    const models = element('div', undefined, 'model-list');
    const catalog = [...view.models].sort((left, right) => {
      const preferred = model => (model.modelId === 'gpt-6.1-sol' ? 0 : 1);
      return preferred(left) - preferred(right) || left.modelId.localeCompare(right.modelId);
    });
    const updateModels = () => {
      const query = search.value.toLowerCase();
      models.replaceChildren(
        ...catalog
          .filter(model => `${model.provider}/${model.modelId}`.toLowerCase().includes(query))
          .map(model =>
            button(`${model.provider}/${model.modelId}`, async () => {
              dialog.close();
              await dispatch({
                type: 'model',
                conversationId,
                model: { provider: model.provider, modelId: model.modelId },
              });
            }),
          ),
      );
    };
    search.addEventListener('input', updateModels);
    updateModels();
    dialog.show('モデルを選択', [
      search,
      ...(view.demo
        ? []
        : [
            element(
              'p',
              '登録catalogです。ChatGPT認証での利用可否はモデルやアカウントに依存します。',
            ),
          ]),
      models,
    ]);
  } else if (kind === 'thinking') {
    const current = view.conversation.docs['pi.agent']?.model;
    const model = view.models.find(
      model => model.provider === current?.provider && model.modelId === current?.modelId,
    );
    dialog.show(
      '思考レベル',
      (model?.thinkingLevels ?? []).map(level =>
        button(level, async () => {
          dialog.close();
          await dispatch({ type: 'thinking', conversationId, level });
        }),
      ),
    );
  } else if (kind === 'sessions') {
    dialog.show('会話', [
      button('新しい会話', async () => {
        dialog.close();
        await dispatch({ type: 'new', conversationId });
      }),
      ...view.sessions.map(session =>
        button(session.name, async () => {
          dialog.close();
          await dispatch({ type: 'select', conversationId: session.id });
        }),
      ),
    ]);
  }
}

function resizeEditor() {
  const editor = $('message');
  editor.rows = innerHeight < 500 ? 1 : 2;
  editor.style.height = 'auto';
  const maximum = Number.parseFloat(getComputedStyle(editor).maxHeight);
  editor.style.height = `${Math.min(editor.scrollHeight, maximum)}px`;
}

function chooseCompletion(candidate) {
  $('message').value = `/${candidate.name} `;
  draftRevision++;
  $('message').focus();
  complete();
  resizeEditor();
}

function complete() {
  const items = suggestions($('message').value);
  completionIndex = 0;
  $('suggestions').hidden = !items.length;
  $('suggestions').replaceChildren(
    ...items.map((command, index) => {
      const row = button(`/${command.name}`, () => chooseCompletion(command));
      row.setAttribute('aria-label', `/${command.name}`);
      row.append(element('span', command.description, 'command-description'));
      row.classList.toggle('selected', index === completionIndex);
      return row;
    }),
  );
}

async function submit(mode = $('input-mode').value) {
  if (!view || sending || !connected) return;

  const text = $('message').value;
  if (!text.trim()) return;

  const conversationId = view.activeId;
  const admittedRevision = draftRevision;
  sending = true;
  status();

  const accepted = await dispatch({
    type: 'input',
    conversationId,
    text,
    mode,
  });

  // Even retyping identical text is a new draft; string equality alone loses it.
  if (accepted && draftRevision === admittedRevision && $('message').value === text) {
    $('message').value = '';
    complete();
    resizeEditor();
  }

  sending = false;
  status();
}

// Composer events: preserve native IME input and keep draft ownership in the UI.
$('composer').addEventListener('submit', event => {
  event.preventDefault();
  void submit();
});
$('message').addEventListener('input', () => {
  draftRevision++;
  complete();
  resizeEditor();
});
$('message').addEventListener('keydown', event => {
  if (event.isComposing || event.keyCode === 229) return;

  if (event.key === 'Enter' && (event.ctrlKey || event.metaKey || event.altKey)) {
    event.preventDefault();
    void submit(event.altKey ? 'followUp' : $('input-mode').value);
  }
  const items = suggestions($('message').value);
  if ($('suggestions').hidden || !items.length) return;
  if (['ArrowDown', 'ArrowUp'].includes(event.key)) {
    event.preventDefault();
    const direction = event.key === 'ArrowDown' ? 1 : -1;
    completionIndex = (completionIndex + direction + items.length) % items.length;
    [...$('suggestions').children].forEach((row, index) => {
      row.classList.toggle('selected', index === completionIndex);
      if (index === completionIndex) row.scrollIntoView({ block: 'nearest' });
    });
  }
  if (event.key === 'Tab') {
    event.preventDefault();
    chooseCompletion(items[completionIndex]);
  }
});

$('command').addEventListener('click', () => {
  // A touch shortcut must never replace an existing draft with a slash command.
  if ($('message').value) return showDialog('help');
  $('message').value = '/';
  draftRevision++;
  $('message').focus();
  complete();
  resizeEditor();
});
$('usage').addEventListener('click', () => showDialog('usage'));
$('workspace').addEventListener('click', () => showDialog('workspace'));

$('login').addEventListener('click', () => showDialog('auth'));
$('models').addEventListener('click', () => showDialog('models'));
$('thinking').addEventListener('click', () => showDialog('thinking'));
$('sessions').addEventListener('click', () => showDialog('sessions'));
$('abort').addEventListener(
  'click',
  () => view && dispatch({ type: 'abort', conversationId: view.activeId }),
);
$('menu').addEventListener('click', () => {
  if (!view) return;
  const conversationId = view.activeId;
  dialog.show('操作', [
    button('ヘルプ', () => showDialog('help', conversationId)),
    button('/model モデル', () => showDialog('models', conversationId)),
    button('/thinking 思考レベル', () => showDialog('thinking', conversationId)),
    button('/resume 会話', () => showDialog('sessions', conversationId)),
    button(transcript.showThinking ? '思考を折りたたむ' : '思考を表示', () => {
      transcript.toggleThinking();
      dialog.close();
    }),
    button(transcript.expandTools ? 'ツール結果を折りたたむ' : 'ツール結果を展開', () => {
      transcript.toggleTools();
      dialog.close();
    }),
    ...(view.auth
      ? [
          button(view.auth.connected ? 'ChatGPTを再認証' : 'ChatGPTログイン', () =>
            showDialog('auth'),
          ),
        ]
      : []),
    ...(view.github
      ? [
          button(view.github.connected ? 'GitHub認証を管理' : 'GitHub認証を設定', () =>
            showDialog('github'),
          ),
        ]
      : []),
    button('会話名を変更', async () => {
      const name = await dialog.input(
        '会話名',
        view.sessions.find(session => session.id === conversationId)?.name,
      );
      if (name) await dispatch({ type: 'rename', conversationId, name });
    }),
    button('文脈を要約', () => {
      dialog.close();
      void dispatch({ type: 'compact', conversationId });
    }),
    button('文脈をリセット', () => {
      void dispatch({ type: 'clear', conversationId });
    }),
    element('p', '拡張・skills・templates・MCP・添付は未対応です。'),
  ]);
});

window.addEventListener('keydown', event => {
  if (event.isComposing || event.keyCode === 229 || event.defaultPrevented || $('dialog').open)
    return;
  if ((event.ctrlKey || event.metaKey) && ['l', 'o', 't'].includes(event.key.toLowerCase())) {
    event.preventDefault();
    if (event.key.toLowerCase() === 'l') showDialog('models');
    if (event.key.toLowerCase() === 'o') transcript.toggleTools();
    if (event.key.toLowerCase() === 't') transcript.toggleThinking();
    return;
  }
  if (event.key !== 'Escape') return;
  if (!$('suggestions').hidden) {
    $('suggestions').hidden = true;
    return;
  }
  if (view && busyOf(view)) void dispatch({ type: 'abort', conversationId: view.activeId });
});

window.addEventListener('resize', resizeEditor);
window.visualViewport?.addEventListener('resize', resizeEditor);
resizeEditor();

// Reconnect reads fresh views; leaving the page disposes transport and components.
void client.watch(render, connection => {
  connected = connection === 'connected';
  if (connection === 'unauthorized')
    errorMessage = '認証できません。専用の起動リンクから開き直してください。';
  status();
});

// Returning from the OAuth browser refreshes state without reloading the composer or replaying input.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible' || client.abort.signal.aborted) return;
  void client
    .view()
    .then(render)
    .catch(() => {});
});

window.addEventListener(
  'pagehide',
  () => {
    authentication.dispose();
    github.dispose();
    client.dispose();
    transcript.dispose();
    dialog.dispose();
  },
  { once: true },
);
