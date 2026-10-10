import test from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '../ui/client.js';

const frame = view =>
  new TextEncoder().encode(`event: snapshot\ndata: ${JSON.stringify(view)}\n\n`);
const waitFor = async predicate => {
  const deadline = Date.now() + 3000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('Transport condition timed out');
    await new Promise(resolve => setTimeout(resolve, 5));
  }
};

function fixture(t, options) {
  const original = globalThis.fetch;
  const client = new Client('fixture-only-token', options);
  let watching;
  t.after(async () => {
    client.dispose();
    await watching;
    globalThis.fetch = original;
  });
  return {
    client,
    watch(onView, onConnection = () => {}) {
      watching = client.watch(onView, onConnection);
      return watching;
    },
  };
}

function streamResponse(onStart, onCancel = () => {}) {
  return new Response(new ReadableStream({ start: onStart, cancel: onCancel }), {
    headers: { 'content-type': 'text/event-stream' },
  });
}

test('connected means a complete snapshot, not just response headers or heartbeats', async t => {
  const f = fixture(t);
  let source;
  globalThis.fetch = async () =>
    streamResponse(controller => {
      source = controller;
    });
  const connections = [];
  const views = [];
  f.watch(
    view => views.push(view),
    state => connections.push(state),
  );
  await waitFor(() => source);
  source.enqueue(new TextEncoder().encode(': heartbeat\n\n'));
  const value = frame({ revision: 1, text: '日本語' });
  const split = value.indexOf(0xe6) + 1; // Split a multibyte Japanese character.
  source.enqueue(value.slice(0, split));
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(connections.includes('connected'), false);
  source.enqueue(value.slice(split));
  await waitFor(() => views.length === 1);
  assert.deepEqual(views, [{ revision: 1, text: '日本語' }]);
  assert.equal(connections.at(-1), 'connected');
});

test('a silent stream is cancelled and rehydrated by GET, without replaying mutations', async t => {
  const f = fixture(t, { streamIdleMs: 40 });
  const requests = [];
  let cancelled = 0;
  globalThis.fetch = async (url, options) => {
    requests.push({ url, options });
    if (requests.length === 1)
      return streamResponse(
        () => {},
        () => {
          cancelled++;
        },
      );
    return streamResponse(controller => {
      controller.enqueue(frame({ revision: 2 }));
    });
  };
  const views = [];
  f.watch(view => views.push(view));
  await waitFor(() => views.length === 1);
  assert.equal(requests[0].options.signal.aborted, true);
  assert.equal(cancelled, 1);
  assert.ok(requests.every(request => request.url === '/api/events'));
  assert.deepEqual(views, [{ revision: 2 }]);
});

test('foreground reconnect replaces only SSE, not a pending POST', async t => {
  const f = fixture(t);
  let streams = 0;
  let posts = 0;
  let resolvePost;
  let postSignal;
  globalThis.fetch = async (url, options) => {
    if (url === '/api/action') {
      posts++;
      postSignal = options.signal;
      return new Promise(resolve => {
        resolvePost = resolve;
      });
    }
    streams++;
    return streamResponse(controller => {
      controller.enqueue(frame({ revision: streams }));
    });
  };
  const views = [];
  f.watch(view => views.push(view));
  await waitFor(() => views.length === 1);
  const submission = f.client.action({ type: 'input', conversationId: 1, text: 'fixture' });
  await waitFor(() => resolvePost);
  f.client.reconnect();
  await waitFor(() => views.length === 2);
  assert.equal(postSignal.aborted, false);
  assert.equal(posts, 1);
  resolvePost(new Response(JSON.stringify({ kind: 'accepted', operationId: 9 })));
  assert.deepEqual(await submission, { kind: 'accepted', operationId: 9 });
});

test('disposing a reader clears its lease and does not start another connection', async t => {
  const f = fixture(t);
  let requests = 0;
  let cancelled = 0;
  globalThis.fetch = async () => {
    requests++;
    return streamResponse(
      controller => {
        controller.enqueue(frame({ revision: 1 }));
      },
      () => {
        cancelled++;
      },
    );
  };
  const views = [];
  const watching = f.watch(view => views.push(view));
  await waitFor(() => views.length === 1);
  f.client.dispose();
  await watching;
  assert.equal(cancelled, 1);
  assert.equal(requests, 1);
  assert.equal(f.client.stream, null);
});

test('a failed POST is never replayed by transport', async t => {
  const f = fixture(t);
  let requests = 0;
  globalThis.fetch = async () => {
    requests++;
    throw new Error('fixture transport failure');
  };
  await assert.rejects(f.client.action({ type: 'input', conversationId: 1, text: 'fixture' }));
  assert.equal(requests, 1);
});
