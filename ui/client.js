// Transport only: no agent state reducer and no automatic mutation retries.
export class Client {
  constructor(token, { streamIdleMs = 35_000 } = {}) {
    this.token = token;
    this.abort = new AbortController();
    this.streamIdleMs = streamIdleMs;
    this.stream = null;
    this.cancelStream = null;
  }

  async request(url, action) {
    const response = await fetch(url, {
      method: action === undefined ? 'GET' : 'POST',
      headers: { 'content-type': 'application/json', 'x-pi-token': this.token },
      body: action === undefined ? undefined : JSON.stringify(action),
      signal: this.abort.signal,
    });

    const result = await response.json();
    if (!response.ok) throw new Error(result.message ?? '操作に失敗しました。');
    return result;
  }

  action(action) {
    return this.request('/api/action', action);
  }

  auth(action) {
    return this.request('/api/auth', action);
  }

  github(action) {
    return this.request('/api/github', action);
  }

  view() {
    return this.request('/api/view');
  }

  reconnect() {
    // Only replace the read-only stream; never cancel or repeat a pending POST.
    this.cancelStream?.();
  }

  async watch(onView, onConnection) {
    let delay = 250;
    while (!this.abort.signal.aborted) {
      const stream = new AbortController();
      this.stream = stream;
      let reader;
      let idleTimer;
      const cancel = () => {
        stream.abort();
        void reader?.cancel().catch(() => {});
      };
      this.cancelStream = cancel;
      const touch = () => {
        clearTimeout(idleTimer);
        idleTimer = setTimeout(cancel, this.streamIdleMs);
      };
      this.abort.signal.addEventListener('abort', cancel, { once: true });
      touch();
      try {
        onConnection('connecting');
        const response = await fetch('/api/events', {
          headers: { 'x-pi-token': this.token },
          signal: stream.signal,
        });
        if (response.status === 401) {
          onConnection('unauthorized');
          return;
        }
        if (!response.ok || !response.body) throw new Error('Connection failed');

        reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        let hydrated = false;
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          touch(); // Server heartbeats also prove the stream is still delivering bytes.
          buffer += decoder.decode(value, { stream: true });
          if (buffer.length > 8_000_000) throw new Error('Snapshot too large');

          let end;
          while ((end = buffer.indexOf('\n\n')) !== -1) {
            const event = buffer.slice(0, end);
            buffer = buffer.slice(end + 2);
            if (!event.startsWith('event: snapshot\n')) continue;

            const data = event
              .split('\n')
              .filter(line => line.startsWith('data: '))
              .map(line => line.slice(6))
              .join('\n');
            onView(JSON.parse(data));
            if (!hydrated) {
              hydrated = true;
              onConnection('connected');
            }
            delay = 250;
          }
        }
      } catch {
        if (this.abort.signal.aborted) return;
      } finally {
        clearTimeout(idleTimer);
        this.abort.signal.removeEventListener('abort', cancel);
        stream.abort();
        if (reader) {
          await reader.cancel().catch(() => {});
          reader.releaseLock();
        }
        if (this.stream === stream) {
          this.stream = null;
          this.cancelStream = null;
        }
      }

      if (this.abort.signal.aborted) return;
      onConnection('disconnected');
      await new Promise(resolve => {
        const timer = setTimeout(done, delay);
        const signal = this.abort.signal;

        function done() {
          clearTimeout(timer);
          signal.removeEventListener('abort', done);
          resolve();
        }

        signal.addEventListener('abort', done, { once: true });
        if (signal.aborted) done();
      });
      delay = Math.min(delay * 2, 4000);
    }
  }

  dispose() {
    this.abort.abort();
  }
}
