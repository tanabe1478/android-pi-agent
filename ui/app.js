import { COMMANDS, suggestions } from '/shared/commands.js';
import { Client } from './client.js';
import { Transcript, Dialog, activityOf, busyOf, element, button } from './components.js';

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

function status() {
  $('status').classList.toggle('error', Boolean(errorMessage));
  $('status').textContent =
    errorMessage ||
    (!connected ? '再接続しています…' : view ? activityOf(view) : '接続しています…');
  $('message').disabled = !view || !connected;
  $('send').disabled = !view || !connected || sending;
  $('abort').disabled = !view || !connected || !busyOf(view);
}

function render(next) {
  // Full committed views replace each other. No reconstruction from transient token events.
  view = next;

  $('mode-banner').hidden = !view.demo;
  const session = view.sessions.find(session => session.id === view.activeId);
  $('sessions').textContent = session?.name ?? '会話';

  const agent = view.conversation.docs['pi.agent'] ?? {};
  $('models').textContent = agent.model?.modelId ?? 'モデル';
  $('models').title = agent.model
    ? `${agent.model.provider}/${agent.model.modelId}`
    : 'モデルを選択';
  $('thinking').textContent = agent.thinkingLevel ?? 'off';
  $('workspace').textContent = agent.cwd ?? '';

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

  if (kind === 'help') {
    dialog.show(
      '操作一覧',
      COMMANDS.map(command => element('p', `/${command.name} — ${command.description}`)),
    );
  } else if (kind === 'models') {
    dialog.show(
      'モデルを選択',
      view.models.map(model =>
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

function complete() {
  const items = suggestions($('message').value);
  $('suggestions').hidden = !items.length;
  $('suggestions').replaceChildren(
    ...items.map(command =>
      button(`/${command.name}`, () => {
        $('message').value = `/${command.name} `;
        draftRevision++;
        $('message').focus();
        complete();
      }),
    ),
  );
}

async function submit() {
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
    mode: $('input-mode').value,
  });

  // Even retyping identical text is a new draft; string equality alone loses it.
  if (accepted && draftRevision === admittedRevision && $('message').value === text) {
    $('message').value = '';
    complete();
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
});
$('message').addEventListener('keydown', event => {
  if (event.isComposing) return; // Never intercept Japanese/Chinese/Korean IME confirmation.

  if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
    event.preventDefault();
    void submit();
  }
  if (event.key === 'Tab') {
    const candidate = suggestions($('message').value)[0];
    if (candidate) {
      event.preventDefault();
      $('message').value = `/${candidate.name} `;
      draftRevision++;
      complete();
    }
  }
});

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
    element('p', '拡張・skills・templates・MCP・認証・添付は、この最初の実装では未対応です。'),
  ]);
});

window.addEventListener('keydown', event => {
  if (event.isComposing || event.key !== 'Escape' || $('dialog').open) return;
  if (!$('suggestions').hidden) {
    $('suggestions').hidden = true;
    return;
  }
  if (view && busyOf(view)) void dispatch({ type: 'abort', conversationId: view.activeId });
});

// Reconnect reads fresh views; leaving the page disposes transport and components.
void client.watch(render, connection => {
  connected = connection === 'connected';
  if (connection === 'unauthorized')
    errorMessage = '認証できません。専用の起動リンクから開き直してください。';
  status();
});

window.addEventListener(
  'pagehide',
  () => {
    client.dispose();
    transcript.dispose();
    dialog.dispose();
  },
  { once: true },
);
