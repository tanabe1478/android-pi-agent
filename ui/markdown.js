import { Lexer } from './vendor/marked.js';

// Reuse Marked's GFM lexer, as Pi does. Never turn model text into HTML or load remote images.
function node(tag, text) {
  const result = document.createElement(tag);
  if (text !== undefined) result.textContent = text;
  return result;
}

function decoded(text) {
  const named = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
  return (text ?? '').replace(/&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (match, value) => {
    if (!value.startsWith('#')) return named[value.toLowerCase()] ?? match;
    const code =
      value[1].toLowerCase() === 'x'
        ? Number.parseInt(value.slice(2), 16)
        : Number.parseInt(value.slice(1), 10);
    return code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff)
      ? String.fromCodePoint(code)
      : match;
  });
}

export function safeLink(value) {
  try {
    if (/[\u0000-\u0020\u007f]/.test(value)) return undefined;
    const url = new URL(value);
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password)
      return undefined;
    return url.href;
  } catch {
    return undefined;
  }
}

function inline(parent, tokens, depth = 0) {
  if (depth > 32) return;
  for (const token of tokens ?? []) {
    if (token.type === 'br') {
      parent.append(node('br'));
    } else if (token.type === 'codespan') {
      parent.append(node('code', decoded(token.text)));
    } else if (['strong', 'em', 'del', 'link'].includes(token.type)) {
      const href = token.type === 'link' ? safeLink(token.href) : undefined;
      const child = node(token.type === 'link' ? (href ? 'a' : 'span') : token.type);
      if (href) {
        child.href = href;
        child.target = '_blank';
        child.rel = 'noopener noreferrer';
        child.referrerPolicy = 'no-referrer';
      }
      inline(child, token.tokens, depth + 1);
      parent.append(child);
    } else if (token.type === 'image') {
      parent.append(node('span', `[画像: ${decoded(token.text)}]`));
    } else if (token.tokens) {
      inline(parent, token.tokens, depth + 1);
    } else {
      parent.append(
        document.createTextNode(
          token.type === 'html' ? token.raw : decoded(token.text ?? token.raw),
        ),
      );
    }
  }
}

function blocks(parent, tokens, depth = 0) {
  if (depth > 32) return;
  for (const token of tokens ?? []) {
    if (['space', 'def'].includes(token.type)) continue;
    if (token.type === 'code') {
      const pre = node('pre');
      pre.append(node('code', token.text));
      parent.append(pre);
    } else if (token.type === 'hr') {
      parent.append(node('hr'));
    } else if (token.type === 'blockquote') {
      const quote = node('blockquote');
      blocks(quote, token.tokens, depth + 1);
      parent.append(quote);
    } else if (token.type === 'list') {
      const list = node(token.ordered ? 'ol' : 'ul');
      if (token.ordered) list.start = token.start;
      for (const item of token.items) {
        const row = node('li');
        if (item.task) row.append(document.createTextNode(item.checked ? '☑ ' : '☐ '));
        blocks(row, item.tokens, depth + 1);
        list.append(row);
      }
      parent.append(list);
    } else if (token.type === 'table') {
      const scroll = node('div');
      scroll.className = 'table-scroll';
      scroll.tabIndex = 0;
      scroll.setAttribute('aria-label', '表（横スクロール）');
      const table = node('table');
      const head = node('thead');
      const body = node('tbody');
      const row = (cells, tag) => {
        const result = node('tr');
        cells.forEach((cell, index) => {
          const value = node(tag);
          if (['left', 'center', 'right'].includes(token.align[index]))
            value.className = `align-${token.align[index]}`;
          inline(value, cell.tokens);
          result.append(value);
        });
        return result;
      };
      head.append(row(token.header, 'th'));
      token.rows.forEach(cells => body.append(row(cells, 'td')));
      table.append(head, body);
      scroll.append(table);
      parent.append(scroll);
    } else if (token.type === 'html') {
      parent.append(node('pre', token.raw));
    } else {
      const tag = token.type === 'heading' ? `h${token.depth}` : 'p';
      const paragraph = node(tag);
      inline(paragraph, token.tokens ?? [{ type: 'text', text: token.text }]);
      parent.append(paragraph);
    }
  }
}

export function markdown(text) {
  const result = node('div');
  result.className = 'markdown';
  try {
    blocks(result, Lexer.lex(text, { gfm: true }));
  } catch {
    // Incomplete streaming syntax and parser failures must still leave readable plain text.
    result.replaceChildren(node('p', text));
  }
  return result;
}
