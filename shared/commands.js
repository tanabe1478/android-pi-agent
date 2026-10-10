// One command catalogue for backend dispatch, help and UI completion.
export const COMMANDS = Object.freeze([
  { name: 'help', description: '使える操作を表示' },
  { name: 'model', description: 'モデルを選択' },
  { name: 'thinking', description: '思考レベルを選択' },
  { name: 'login', description: 'ChatGPT認証を開く（実モード）' },
  { name: 'new', description: '会話を新規作成' },
  { name: 'resume', description: '会話を切り替え' },
  { name: 'name', description: '会話名を変更' },
  { name: 'compact', description: '文脈を要約（モデル利用あり）' },
  { name: 'clear', description: '確認して文脈をリセット' },
  { name: 'abort', description: '実行と入力キューを停止' },
]);

/** @param {string} text
 * @returns {{type:'text', text:string} | {type:'command', name:string, args:string}} */
export function parseInput(text) {
  if (text.startsWith('//')) return { type: 'text', text: text.slice(1) };

  const match = text.match(/^\/([^\s]+)(?:\s+([\s\S]*))?$/);
  if (!match) return { type: 'text', text };

  return { type: 'command', name: match[1].toLowerCase(), args: (match[2] ?? '').trim() };
}

/** @param {string} text */
export function suggestions(text) {
  if (!text.startsWith('/') || text.startsWith('//') || /\s/.test(text)) return [];

  const query = text.slice(1).toLowerCase();
  return COMMANDS.filter(command => command.name.startsWith(query));
}
