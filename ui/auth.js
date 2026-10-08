import { button, element } from './components.js';

// OAuth interaction is transient presentation state, never a conversation input or AppView secret.
export class AuthenticationPanel {
  constructor(client, dialog, onError, onModels) {
    this.client = client;
    this.dialog = dialog;
    this.onError = onError;
    this.onModels = onModels;
    this.summary = null;
    this.request = 0;
    this.sending = false;

    this.node = element('section', undefined, 'auth-panel');
    this.message = element('p', '認証状態を確認しています…');
    this.start = button('ChatGPTログインを開始', () => this.perform({ type: 'start' }));
    this.link = element('a', '外部ブラウザで続ける', 'auth-link');
    this.link.rel = 'noopener noreferrer';
    this.link.referrerPolicy = 'no-referrer';
    // Native WebView intercepts an ordinary main-frame link. Desktop keeps Pi in its current tab.
    if (!navigator.userAgent.includes('; wv')) this.link.target = '_blank';

    this.callback = element('input');
    this.callback.id = 'oauth-callback';
    this.callback.type = 'password';
    this.callback.maxLength = 8192;
    this.callback.autocomplete = 'off';
    this.callback.setAttribute('autocapitalize', 'none');
    this.callback.spellcheck = false;
    this.callback.setAttribute('aria-label', '手動callback URL');
    this.callback.placeholder = '完了しない場合だけ、最終callback URLを貼り付け';
    this.respond = button('callback URLを送る', () => {
      const state = this.state;
      const answer = this.callback.value;
      if (!answer.trim() || !state?.promptId) return;
      this.callback.value = '';
      void this.perform({
        type: 'respond',
        sessionId: state.sessionId,
        promptId: state.promptId,
        answer,
      });
    });
    this.cancel = button('ログインを取消', () => {
      if (this.state?.sessionId) {
        void this.perform({ type: 'cancel', sessionId: this.state.sessionId });
      }
    });
    this.models = button('モデルを選ぶ', onModels);
    this.note = element(
      'p',
      '認証情報はこのアプリのprivate保存先に保持します。旧アプリからは移行しません。5分で時間切れになります。',
    );
    this.node.append(
      this.message,
      this.start,
      this.link,
      this.callback,
      this.respond,
      this.cancel,
      this.models,
      this.note,
    );
    this.onClose = () => {
      this.callback.value = '';
    };
    dialog.node.addEventListener('close', this.onClose);
    this.update();
  }

  render(summary) {
    const changed = this.summary?.revision !== summary?.revision;
    this.summary = summary;
    if (changed && this.dialog.node.open && this.node.isConnected) void this.refresh();
  }

  open() {
    if (!this.summary) {
      this.dialog.show('認証', [element('p', 'fauxデモは実モデル認証を使いません。')]);
      return;
    }
    this.callback.value = '';
    this.dialog.show('ChatGPT認証', [this.node]);
    void this.refresh();
  }

  update() {
    const state = this.state;
    const pending = state?.status === 'pending';
    const promptKey = state?.promptId ?? null;
    if (promptKey !== this.promptKey) this.callback.value = '';
    this.promptKey = promptKey;

    this.message.textContent = state?.message ?? '認証状態を確認しています…';
    this.start.hidden = pending;
    this.start.textContent = state?.connected ? 'ChatGPTを再認証' : 'ChatGPTログインを開始';
    this.start.disabled = this.sending || !state;
    this.link.hidden = !pending || !state?.url;
    if (pending && state.url) this.link.href = state.url;
    else this.link.removeAttribute('href');
    this.callback.hidden = !pending || !state?.promptId;
    this.respond.hidden = this.callback.hidden;
    this.respond.disabled = this.sending;
    this.cancel.hidden = !pending;
    this.cancel.disabled = this.sending;
    this.models.hidden = !state?.connected || pending;
  }

  async refresh() {
    const request = ++this.request;
    try {
      const state = await this.client.auth();
      if (request !== this.request) return;
      this.state = state;
      this.update();
    } catch (error) {
      if (request === this.request) this.onError(error.message);
    }
  }

  async perform(action) {
    if (this.sending) return;
    this.sending = true;
    this.update();
    try {
      await this.client.auth(action);
    } catch (error) {
      this.onError(error.message);
    } finally {
      this.sending = false;
      // Read current state after success or a lost response; never replay the submitted mutation.
      await this.refresh();
      this.update();
    }
  }

  dispose() {
    this.request++;
    this.dialog.node.removeEventListener('close', this.onClose);
    this.callback.value = '';
    this.link.removeAttribute('href');
    this.node.remove();
  }
}
