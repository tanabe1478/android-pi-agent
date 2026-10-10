import { button, element } from './components.js';

// Only this masked profile dialog accepts a PAT. It never becomes a composer draft or input action.
export class GitHubPanel {
  constructor(client, dialog, onError) {
    this.client = client;
    this.dialog = dialog;
    this.onError = onError;
    this.request = 0;
    this.sending = false;
    this.disposed = false;
    this.node = element('section', undefined, 'auth-panel');
    this.message = element('p', 'GitHub認証状態を確認しています…');
    this.token = element('input');
    this.token.id = 'github-token';
    this.token.type = 'password';
    this.token.maxLength = 4096;
    this.token.autocomplete = 'off';
    this.token.setAttribute('autocapitalize', 'none');
    this.token.spellcheck = false;
    this.token.setAttribute('aria-label', 'GitHub PAT');
    this.token.placeholder = 'fine-grained PAT（必要なrepositoryだけ）';
    this.save = button('PATを確認して保存', () => {
      const token = this.token.value;
      this.token.value = '';
      if (token.trim()) void this.perform({ type: 'save', token });
    });
    this.disconnect = button('GitHub認証を解除', () => this.perform({ type: 'disconnect' }));
    this.node.append(
      this.message,
      this.token,
      this.save,
      this.disconnect,
      element(
        'p',
        '新アプリ専用のprivate保存先です。旧アプリからは移行しません。PATは会話・シェル・URLに貼らないでください。',
      ),
      element(
        'p',
        'gitは保存済みPATをHTTPS認証に利用します。ghはpi-pkg install gh --yesで追加できます。SSH認証とGitHub Enterpriseは未対応です。',
      ),
      element(
        'p',
        '同じアプリUIDで動くツールやコードからの隔離・暗号化ではありません。信頼できるコードだけ実行してください。',
      ),
    );
    this.onClose = () => {
      this.token.value = '';
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
    this.token.value = '';
    if (!this.summary) {
      this.dialog.show('GitHub認証', [element('p', 'デモは実認証を使用しません。')]);
      return;
    }
    this.dialog.show('GitHub認証', [this.node]);
    void this.refresh();
  }

  update() {
    const busy = this.sending || this.state?.status === 'verifying';
    this.message.textContent = this.state
      ? `${this.state.user ? `@${this.state.user} — ` : ''}${this.state.message}`
      : 'GitHub認証状態を確認しています…';
    this.save.disabled = busy || !this.state;
    this.token.disabled = busy;
    this.disconnect.hidden = !this.state?.connected;
    this.disconnect.disabled = busy;
  }

  async refresh() {
    const request = ++this.request;
    try {
      const state = await this.client.github();
      if (this.disposed || request !== this.request || state.revision < (this.state?.revision ?? 0))
        return;
      this.state = state;
      this.update();
    } catch (error) {
      if (!this.disposed && request === this.request) this.onError(error.message);
    }
  }

  async perform(action) {
    if (this.disposed || this.sending || !this.state) return;
    this.sending = true;
    this.update();
    try {
      const result = await this.client.github({ ...action, revision: this.state.revision });
      if (result.kind === 'confirmation' && !this.disposed && this.dialog.node.open) {
        if (await this.dialog.confirm(result.message, '認証を解除する')) {
          await this.client.github({
            type: 'disconnect',
            revision: result.revision,
            confirmation: result.token,
          });
        }
        if (!this.disposed && !this.dialog.node.open) this.dialog.show('GitHub認証', [this.node]);
      }
    } catch (error) {
      if (!this.disposed) this.onError(error.message);
    } finally {
      this.sending = false;
      // Lost responses are recovered with a read, never by resubmitting a PAT or deletion.
      await this.refresh();
      if (!this.disposed) this.update();
    }
  }

  dispose() {
    this.disposed = true;
    this.request++;
    this.token.value = '';
    this.dialog.node.removeEventListener('close', this.onClose);
    this.node.remove();
  }
}
