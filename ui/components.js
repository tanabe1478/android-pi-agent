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

function renderMessage(message, fork) {
  const node = element(
    'article',
    undefined,
    `message ${message.role}${message.isError || message.errorMessage ? ' error' : ''}`,
  );
  node.append(
    element(
      'h3',
      message.role === 'user'
        ? 'あなた'
        : message.role === 'assistant'
          ? 'Pi'
          : (message.toolName ?? 'Tool'),
    ),
  );

  if (message.role === 'toolResult') {
    const details = element('details');
    details.append(
      element('summary', message.isError ? 'ツールエラー' : 'ツール結果'),
      element('pre', contentText(message.content)),
    );
    node.append(details);
  } else {
    const text = contentText(message.content);
    if (text) node.append(element('p', text));
    if (Array.isArray(message.content))
      for (const block of message.content) {
        if (block.type === 'thinking') {
          const details = element('details');
          details.append(element('summary', '思考'), element('pre', block.thinking));
          node.append(details);
        }
        if (block.type === 'toolCall') node.append(element('p', `→ ${block.name}`));
      }
    if (message.errorMessage) node.append(element('p', message.errorMessage));
  }

  if (fork) node.append(button('ここから分岐', fork));
  return node;
}

export class Transcript {
  constructor(node, onFork) {
    this.node = node;
    this.onFork = onFork;
    this.cards = new Map();
    this.activeId = null;
  }

  render(view) {
    const follow = this.node.scrollHeight - this.node.scrollTop - this.node.clientHeight < 80;
    if (this.activeId !== view.activeId) {
      this.cards.clear();
      this.node.replaceChildren();
      this.activeId = view.activeId;
    }

    const items = [];
    for (const entry of view.conversation.entries) {
      (entry.model ?? []).forEach((message, index) => {
        if (!['user', 'assistant', 'toolResult'].includes(message.role)) return;
        items.push({
          key: `${entry.id}:${index}`,
          message,
          entryId: message.role === 'user' ? entry.id : null,
        });
      });
    }

    const live = view.conversation.docs['pi.live'] ?? {};
    if (live.generation?.message) items.push({ key: 'live', message: live.generation.message });

    const kept = new Set();
    for (const item of items) {
      kept.add(item.key);
      const signature = JSON.stringify(item.message);
      let card = this.cards.get(item.key);
      if (!card || card.signature !== signature) {
        const open = card
          ? [...card.node.querySelectorAll('details')].map(details => details.open)
          : [];
        const node = renderMessage(
          item.message,
          item.entryId ? () => this.onFork(view.activeId, item.entryId) : null,
        );
        node.querySelectorAll('details').forEach((details, index) => {
          details.open = open[index] ?? false;
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

  confirm(message) {
    return new Promise(resolve => {
      this.show('操作を確認', [
        element('p', message),
        button('リセットする', () => {
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
