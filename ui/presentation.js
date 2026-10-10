// Pure presentation helpers. Usage comes from pi.usage, not a second transcript ledger.
export function formatTokens(count) {
  if (count < 1000) return String(count);
  if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
  if (count < 1000000) return `${Math.round(count / 1000)}k`;
  return `${(count / 1000000).toFixed(1)}M`;
}

export function usageOf(view) {
  const result = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, cost: 0 };
  const usage = view.conversation.docs['pi.usage'] ?? {};
  for (const bucket of ['models', 'tools']) {
    for (const value of Object.values(usage[bucket] ?? {})) {
      for (const field of ['input', 'output', 'cacheRead', 'cacheWrite', 'reasoning']) {
        if (Number.isFinite(value[field]) && value[field] >= 0) result[field] += value[field];
      }
      if (Number.isFinite(value.cost?.total) && value.cost.total >= 0)
        result.cost += value.cost.total;
    }
  }
  return result;
}

export function shortPath(path) {
  if (!path) return 'workspace';
  const pieces = path.split('/').filter(Boolean);
  return pieces.length > 2 ? `…/${pieces.slice(-2).join('/')}` : path;
}

export function toolTitle(call) {
  const args = call.arguments ?? {};
  if (call.name === 'bash') return `$ ${args.command ?? ''}`;
  if (['read', 'write', 'edit'].includes(call.name)) {
    const range =
      call.name === 'read' && args.offset
        ? `:${args.offset}${args.limit ? `+${args.limit}` : ''}`
        : '';
    return `${call.name} ${args.path ?? ''}${range}`;
  }
  return `${call.name} ${JSON.stringify(args)}`;
}

export function transcriptItems(view) {
  const messages = [];
  for (const entry of view.conversation.entries) {
    (entry.model ?? []).forEach((message, index) => {
      messages.push({ key: `${entry.id}:${index}`, message, entryId: entry.id });
    });
  }
  const live = view.conversation.docs['pi.live'] ?? {};
  if (live.generation?.message) messages.push({ key: 'live', message: live.generation.message });

  const results = new Map();
  for (const { message } of messages) {
    if (message.role === 'toolResult') results.set(message.toolCallId, message);
  }
  const slots = new Map((live.tools ?? []).map(tool => [tool.callId, tool]));
  const calls = new Set();
  const items = [];
  for (const { key, message, entryId } of messages) {
    if (!['user', 'assistant', 'toolResult'].includes(message.role)) continue;
    if (message.role === 'toolResult') continue;
    const content = message.content;
    const hasBody =
      typeof content === 'string' ||
      content?.some(
        block =>
          (block.type === 'text' && block.text) || (block.type === 'thinking' && block.thinking),
      );
    if (
      message.role === 'user' ||
      hasBody ||
      message.errorMessage ||
      ['error', 'aborted', 'length'].includes(message.stopReason)
    ) {
      items.push({ key, message, entryId: message.role === 'user' ? entryId : null });
    }
    for (const call of Array.isArray(content) ? content : []) {
      if (call.type !== 'toolCall' || calls.has(call.id)) continue;
      calls.add(call.id);
      items.push({
        key: `tool:${call.id}`,
        call,
        result: results.get(call.id),
        slot: slots.get(call.id) ?? (key === 'live' ? { status: 'pending' } : undefined),
      });
    }
  }
  // Imported or incomplete history may have results without their earlier call.
  for (const [id, result] of results) {
    if (!calls.has(id)) items.push({ key: `tool:${id}`, call: { name: result.toolName }, result });
  }
  return items;
}
