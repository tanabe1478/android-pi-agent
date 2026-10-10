import { markdown } from './markdown.js';
import { transcriptItems, toolTitle } from './presentation.js';

// pi-tui-inspired component boundaries: render/update, input and disposal.
// DOM controls own focus and IME; rendering never replaces the composer/editor.
export function element(tag, text, className) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
}

export function button(text, handler) {
  const node = element('button', text);
  node.type = 'button';
  node.addEventListener('click', handler);
  return node;
}

export function busyOf(view) {
  const live = view.conversation.docs['pi.live'] ?? {};
  return Boolean(live.run || live.compactions?.length);
}

export function activityOf(view) {
  const live = view.conversation.docs['pi.live'] ?? {};
  if (live.compactions?.length) return '文脈を要約しています…';
  if (live.generation?.retry) return 'モデル応答を再試行しています…';

  const tools = (live.tools ?? []).filter(tool => tool.status === 'running');
  if (tools.length) return `ツール実行中: ${tools.map(tool => tool.name).join(', ')}`;
  return live.run ? '回答を生成しています…' : '待機中';
}

function contentText(content) {
  return typeof content === 'string'
    ? content
    : (content ?? [])
        .filter(block => block.type === 'text')
        .map(block => block.text)
        .join('\n');
}

function renderMessage(message, fork, showThinking) {
  const node = element('article', undefined, `message ${message.role}`);
  node.setAttribute('aria-label', message.role === 'user' ? 'ユーザー入力' : 'Piの応答');

  if (message.role === 'user') {
    node.append(element('p', contentText(message.content), 'prompt-text'));
  } else {
    for (const block of Array.isArray(message.content) ? message.content : []) {
      if (block.type === 'text' && block.text) node.append(markdown(block.text));
      if (block.type === 'thinking' && block.thinking) {
        const details = element('details', undefined, 'thinking-block');
        details.open = showThinking;
        details.append(element('summary', 'Thinking…'), markdown(block.thinking));
        node.append(details);
      }
    }
    if (message.errorMessage || ['error', 'aborted', 'length'].includes(message.stopReason)) {
      node.classList.add('error');
      node.append(
        element(
          'p',
          message.errorMessage ??
            (message.stopReason === 'aborted' ? '停止しました。' : '応答が完了しませんでした。'),
        ),
      );
    }
  }

  if (fork) {
    const actions = element('details', undefined, 'message-actions');
    const summary = element('summary', '⋯');
    summary.setAttribute('aria-label', 'この入力の操作');
    actions.append(summary, button('ここから分岐', fork));
    node.append(actions);
  }
  return node;
}

function renderTool(item, expanded) {
  const { call, result, slot } = item;
  const state = result ? (result.isError ? 'error' : 'success') : (slot?.status ?? 'unknown');
  const node = element('article', undefined, `message tool ${state}`);
  const details = element('details', undefined, 'tool-details');
  const summary = element('summary');
  const title = element('strong', toolTitle(call));
  const label = result
    ? result.isError
      ? 'error'
      : 'done'
    : state === 'done'
      ? '終了（結果未取得）'
      : state === 'unknown'
        ? '結果未取得'
        : state;
  summary.append(title, element('span', label, 'tool-state'));
  details.open = expanded;
  const images = (Array.isArray(result?.content) ? result.content : []).filter(
    block =>
      block.type === 'image' &&
      ['image/png', 'image/jpeg', 'image/webp'].includes(block.mimeType) &&
      typeof block.data === 'string' &&
      block.data.length <= 11_184_812 &&
      block.data.length % 4 === 0 &&
      /^[A-Za-z0-9+/]*={0,2}$/.test(block.data),
  );
  const output = result ? contentText(result.content) : (slot?.output ?? '');
  const imageNote = images.length ? `画像 ${images.length}枚 · 展開して表示` : '';
  details.append(summary, element('pre', output || imageNote || '出力を待っています…'));
  for (const block of images) {
    const image = element('img', undefined, 'tool-image');
    image.alt = `read結果 (${block.mimeType})`;
    image.loading = 'lazy';
    image.decoding = 'async';
    image.src = `data:${block.mimeType};base64,${block.data}`;
    details.append(image);
  }
  if (call.arguments) {
    const args = element('details', undefined, 'tool-arguments');
    args.append(
      element('summary', '引数'),
      element('pre', JSON.stringify(call.arguments, null, 2)),
    );
    details.append(args);
  }
  const lines = output.split('\n');
  let preview = lines.slice(0, 4).join('\n').slice(0, 1200) || imageNote;
  if (lines.length > 4 || output.length > 1200) preview += '\n… タップして展開';
  node.append(details, element('pre', preview, 'tool-preview'));
  if (slot?.droppedLines || slot?.droppedBytes)
    node.append(element('p', '実行中の出力はruntimeの上限で一部省略されています。', 'tool-note'));
  return node;
}

export class Transcript {
  constructor(node, onFork) {
    this.node = node;
    this.onFork = onFork;
    this.cards = new Map();
    this.activeId = null;
    this.showThinking = true;
    this.expandTools = false;
  }

  toggleThinking() {
    this.showThinking = !this.showThinking;
    this.node.querySelectorAll('.thinking-block').forEach(node => {
      node.open = this.showThinking;
    });
  }

  toggleTools() {
    this.expandTools = !this.expandTools;
    this.node.querySelectorAll('.tool-details').forEach(node => {
      node.open = this.expandTools;
    });
  }

  render(view) {
    const follow = this.node.scrollHeight - this.node.scrollTop - this.node.clientHeight < 80;
    if (this.activeId !== view.activeId) {
      this.cards.clear();
      const intro = element('aside', undefined, 'startup');
      intro.append(element('strong', 'pi'), element('span', ' · Android / durable'));
      intro.append(element('p', '/ commands · Ctrl+Enter 送信 · Enter 改行'));
      this.node.replaceChildren(intro);
      this.activeId = view.activeId;
    }

    const items = transcriptItems(view);

    const kept = new Set();
    for (const item of items) {
      kept.add(item.key);
      const signature = JSON.stringify(item);
      let card = this.cards.get(item.key);
      if (!card || card.signature !== signature) {
        const open = card
          ? [...card.node.querySelectorAll('details')].map(details => details.open)
          : [];
        const node = item.call
          ? renderTool(item, this.expandTools)
          : renderMessage(
              item.message,
              item.entryId ? () => this.onFork(view.activeId, item.entryId) : null,
              this.showThinking,
            );
        node.querySelectorAll('details').forEach((details, index) => {
          if (open[index] !== undefined) details.open = open[index];
        });
        if (card) card.node.replaceWith(node);
        card = { node, signature };
        this.cards.set(item.key, card);
      }
      this.node.append(card.node);
    }

    for (const [key, card] of this.cards)
      if (!kept.has(key)) {
        card.node.remove();
        this.cards.delete(key);
      }

    if (follow)
      requestAnimationFrame(() => {
        this.node.scrollTop = this.node.scrollHeight;
      });
  }

  dispose() {
    this.cards.clear();
    this.node.replaceChildren();
  }
}

export class Dialog {
  constructor(node) {
    this.node = node;
    this.title = node.querySelector('h2');
    this.body = node.querySelector('#dialog-body');
    this.closeButton = node.querySelector('#dialog-close');
    this.finish = null;

    this.onClose = () => {
      if (node.open) return;
      this.finish?.();
      this.finish = null;
      if (this.returnFocus?.isConnected) this.returnFocus.focus();
    };

    this.closeButton.addEventListener('click', () => node.close());
    node.addEventListener('close', this.onClose);
  }

  show(title, nodes) {
    this.finish?.();
    this.finish = null;
    this.title.textContent = title;
    this.body.replaceChildren(...nodes);

    if (!this.node.open) {
      this.returnFocus = document.activeElement;
      this.node.showModal();
    }
  }

  close() {
    this.node.close();
  }

  confirm(message, label = 'リセットする') {
    return new Promise(resolve => {
      this.show('操作を確認', [
        element('p', message),
        button(label, () => {
          this.finish = null;
          this.close();
          resolve(true);
        }),
      ]);
      this.finish = () => resolve(false);
    });
  }

  input(title, initial = '') {
    return new Promise(resolve => {
      const input = element('input');
      input.value = initial;
      input.maxLength = 120;
      input.setAttribute('aria-label', title);

      this.show(title, [
        input,
        button('保存', () => {
          if (!input.value.trim()) return;
          this.finish = null;
          this.close();
          resolve(input.value.trim());
        }),
      ]);
      this.finish = () => resolve(null);
      input.focus();
    });
  }

  dispose() {
    this.onClose();
    this.node.close();
    this.node.removeEventListener('close', this.onClose);
  }
}
