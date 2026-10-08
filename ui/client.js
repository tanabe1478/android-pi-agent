// Transport only: no agent state reducer and no automatic mutation retries.
export class Client {
  constructor(token) { this.token = token; this.abort = new AbortController(); }
  async action(action) {
    const response = await fetch('/api/action', {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-pi-token': this.token },
      body: JSON.stringify(action), signal: this.abort.signal,
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.message ?? '操作に失敗しました。');
    return result;
  }
  async watch(onView, onConnection) {
    let delay = 250;
    while (!this.abort.signal.aborted) {
      try {
        onConnection('connecting');
        const response = await fetch('/api/events', { headers: { 'x-pi-token': this.token }, signal: this.abort.signal });
        if (response.status === 401) { onConnection('unauthorized'); return; }
        if (!response.ok || !response.body) throw new Error('Connection failed');
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        onConnection('connected');
        delay = 250;
        try {
          while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            if (buffer.length > 8_000_000) throw new Error('Snapshot too large');
            let end;
            while ((end = buffer.indexOf('\n\n')) !== -1) {
              const event = buffer.slice(0, end);
              buffer = buffer.slice(end + 2);
              if (!event.startsWith('event: snapshot\n')) continue;
              const data = event.split('\n').filter(line => line.startsWith('data: ')).map(line => line.slice(6)).join('\n');
              onView(JSON.parse(data));
            }
          }
        } finally { await reader.cancel().catch(() => {}); }
      } catch { if (this.abort.signal.aborted) return; }
      onConnection('disconnected');
      await new Promise(resolve => {
        const timer = setTimeout(done, delay);
        const signal = this.abort.signal;
        function done() { clearTimeout(timer); signal.removeEventListener('abort', done); resolve(); }
        signal.addEventListener('abort', done, { once: true });
        if (signal.aborted) done();
      });
      delay = Math.min(delay * 2, 4000);
    }
  }
  dispose() { this.abort.abort(); }
}
