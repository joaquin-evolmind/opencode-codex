import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const dataHome = await fs.mkdtemp(path.join(os.tmpdir(), 'opencode-codex-server-'));
process.env.XDG_DATA_HOME = dataHome;
const codexDir = path.join(dataHome, 'opencode', 'codex');

const { default: plugin, refreshUsage, routerDeps } = await import('../dist/server.js');

const usagePayload = {
  plan_type: 'pro',
  rate_limit: {
    primary_window: { used_percent: 25, limit_window_seconds: 18_000, reset_after_seconds: 600 },
    secondary_window: { used_percent: 50, limit_window_seconds: 604_800, reset_after_seconds: 86_400 },
  },
};

/** A fake OpenCode server plugin context backed by in-memory credentials. */
function fakeContext({ ids = ['A', 'B', 'C'], active = 'A' } = {}) {
  const values = Object.fromEntries(
    ids.map((id) => [id, { type: 'oauth', methodID: 'chatgpt-browser', access: `access-${id}`, refresh: `refresh-${id}`, expires: Date.now() + 3_600_000, metadata: { accountID: `acct-${id}` } }]),
  );
  const hooks = new Map();
  const disposed = [];
  const events = [];
  let wake;
  let stopped = false;
  const calls = { activate: 0, resolve: [] };
  const ctx = {
    integration: {
      get: async ({ integrationID }) => {
        assert.equal(integrationID, 'openai');
        return { location: {}, data: { id: 'openai', name: 'OpenAI', methods: [], connections: ids.map((id) => ({ type: 'credential', id, label: 'OAuth', method: 'oauth' })) } };
      },
      connection: {
        active: async (integrationID) => (integrationID === 'openai' ? { type: 'credential', id: state.active, label: 'OAuth', method: 'oauth' } : undefined),
        resolve: async (connection) => {
          calls.resolve.push(connection.id);
          return values[connection.id];
        },
        status: async () => {},
      },
    },
    // A plugin must never activate credentials; this spy proves it.
    credential: { activate: async () => { calls.activate += 1; } },
    session: {
      hook: async (name, callback, options) => {
        hooks.set(name, { callback, options });
        return { dispose: async () => { disposed.push(name); } };
      },
    },
    event: {
      subscribe: ({ signal } = {}) => ({
        async *[Symbol.asyncIterator]() {
          signal?.addEventListener('abort', () => { stopped = true; wake?.(); });
          while (!stopped) {
            if (events.length === 0) await new Promise((resolve) => { wake = resolve; });
            while (events.length) yield events.shift();
          }
        },
      }),
    },
  };
  const state = { active };
  const emit = async (event) => {
    events.push(event);
    wake?.();
    await new Promise((resolve) => setImmediate(resolve));
  };
  return { ctx, hooks, disposed, emit, state, calls, values, isStopped: () => stopped };
}

async function withFetch(handler, run) {
  const original = globalThis.fetch;
  globalThis.fetch = handler;
  try {
    return await run();
  } finally {
    globalThis.fetch = original;
  }
}

const quotaError = { type: 'provider.quota', status: 429, response: { body: '{"error":{"type":"usage_limit_reached","resets_in_seconds":60}}' } };
const usageFetch = async () => new Response(JSON.stringify(usagePayload), { status: 200 });

test('the server entry is a valid OpenCode 2 plugin definition', () => {
  assert.equal(plugin.id, 'opencode-codex');
  assert.equal(typeof plugin.setup, 'function');
  assert.equal(Object.keys(plugin).sort().join(','), 'id,setup');
});

test('setup registers OpenAI-scoped request hooks and cleans them up', async () => {
  const world = fakeContext();
  const cleanup = await withFetch(usageFetch, () => plugin.setup(world.ctx));
  assert.deepEqual([...world.hooks.keys()].sort(), ['experimental.ws.handshake', 'http.request', 'retry']);
  for (const { options } of world.hooks.values()) assert.deepEqual(options, { providerID: 'openai' });
  await cleanup();
  assert.deepEqual(world.disposed.sort(), ['experimental.ws.handshake', 'http.request', 'retry']);
  assert.equal(world.isStopped(), true);
});

test('WebSocket handshakes carry the routed credential and quota retries switch accounts', async () => {
  const world = fakeContext();
  const cleanup = await withFetch(usageFetch, () => plugin.setup(world.ctx));
  const handshake = world.hooks.get('experimental.ws.handshake').callback;
  const retry = world.hooks.get('retry').callback;
  try {
    const first = { sessionID: 's1', url: 'wss://example.test/responses', headers: { authorization: 'Bearer native' } };
    await handshake(first);
    assert.equal(first.headers.authorization, 'Bearer access-A');
    assert.equal(first.headers['chatgpt-account-id'], 'acct-A');

    const decision = { sessionID: 's1', error: quotaError, attempt: 2, decision: { retry: false } };
    await retry(decision);
    assert.deepEqual(decision.decision, { retry: true, delay: 0 });

    const second = { sessionID: 's1', url: 'wss://example.test/responses', headers: {} };
    await handshake(second);
    assert.equal(second.headers.authorization, 'Bearer access-B');
    assert.equal(second.headers['chatgpt-account-id'], 'acct-B');
    assert.equal(world.state.active, 'A');
    assert.equal(world.calls.activate, 0);
  } finally {
    await cleanup();
  }
});

test('HTTP requests carry the routed credential', async () => {
  const world = fakeContext();
  const cleanup = await withFetch(usageFetch, () => plugin.setup(world.ctx));
  try {
    const request = new Request('https://chatgpt.com/backend-api/codex/responses', { method: 'POST', headers: { authorization: 'Bearer native' } });
    const input = { sessionID: 's1', request };
    await world.hooks.get('http.request').callback(input);
    assert.equal(input.request.headers.get('authorization'), 'Bearer access-A');
    assert.equal(input.request.headers.get('chatgpt-account-id'), 'acct-A');
  } finally {
    await cleanup();
  }
});

test('non-quota errors keep OpenCode\'s retry decision', async () => {
  const world = fakeContext();
  const cleanup = await withFetch(usageFetch, () => plugin.setup(world.ctx));
  try {
    await world.hooks.get('experimental.ws.handshake').callback({ sessionID: 's1', headers: {} });
    const decision = { sessionID: 's1', error: { type: 'provider.overloaded', status: 503 }, attempt: 2, decision: { retry: true, delay: 2000 } };
    await world.hooks.get('retry').callback(decision);
    assert.deepEqual(decision.decision, { retry: true, delay: 2000 });
  } finally {
    await cleanup();
  }
});

test('request hooks fail open when OpenCode lookups fail', async () => {
  const world = fakeContext();
  const cleanup = await withFetch(usageFetch, () => plugin.setup(world.ctx));
  try {
    world.ctx.integration.get = async () => { throw new Error('store unavailable'); };
    const headers = { authorization: 'Bearer native' };
    await world.hooks.get('experimental.ws.handshake').callback({ sessionID: 's1', headers });
    assert.equal(headers.authorization, 'Bearer native');
    const decision = { sessionID: 's1', error: quotaError, attempt: 2, decision: { retry: false } };
    await world.hooks.get('retry').callback(decision);
    assert.deepEqual(decision.decision, { retry: false });
  } finally {
    await cleanup();
  }
});

test('fallback follows the persisted priority order', async () => {
  await fs.mkdir(codexDir, { recursive: true });
  await fs.writeFile(path.join(codexDir, 'priority.json'), JSON.stringify({ version: 2, order: ['C', 'B', 'A'] }));
  const world = fakeContext();
  const cleanup = await withFetch(usageFetch, () => plugin.setup(world.ctx));
  try {
    const handshake = world.hooks.get('experimental.ws.handshake').callback;
    await handshake({ sessionID: 's1', headers: {} });
    await world.hooks.get('retry').callback({ sessionID: 's1', error: quotaError, attempt: 2, decision: { retry: false } });
    const next = { sessionID: 's1', headers: {} };
    await handshake(next);
    assert.equal(next.headers.authorization, 'Bearer access-C');
  } finally {
    await cleanup();
    await fs.rm(path.join(codexDir, 'priority.json'), { force: true });
  }
});

test('session state is dropped when its execution ends or the session is deleted', async () => {
  const world = fakeContext();
  const cleanup = await withFetch(usageFetch, () => plugin.setup(world.ctx));
  try {
    const handshake = world.hooks.get('experimental.ws.handshake').callback;
    const retry = world.hooks.get('retry').callback;
    await handshake({ sessionID: 's1', headers: {} });
    await retry({ sessionID: 's1', error: quotaError, attempt: 2, decision: { retry: false } });
    await world.emit({ type: 'session.execution.failed', data: { sessionID: 's1' } });
    // Without session state there is nothing to fall back from: OpenCode decides.
    const late = { sessionID: 's1', error: quotaError, attempt: 3, decision: { retry: false } };
    await retry(late);
    assert.deepEqual(late.decision, { retry: false });

    await handshake({ sessionID: 's2', headers: {} });
    await world.emit({ type: 'session.deleted', data: { sessionID: 's2' } });
    const afterDelete = { sessionID: 's2', error: quotaError, attempt: 2, decision: { retry: false } };
    await retry(afterDelete);
    assert.deepEqual(afterDelete.decision, { retry: false });
  } finally {
    await cleanup();
  }
});

test('session cleanup keeps working after the event stream ends', async () => {
  const world = fakeContext();
  let subscriptions = 0;
  const subscribe = world.ctx.event.subscribe;
  world.ctx.event.subscribe = (options) => {
    subscriptions += 1;
    // The first stream ends immediately, as on a reconnect.
    if (subscriptions === 1) return { async *[Symbol.asyncIterator]() {} };
    return subscribe(options);
  };
  const cleanup = await withFetch(usageFetch, () => plugin.setup(world.ctx));
  try {
    await new Promise((resolve) => setTimeout(resolve, 1_200));
    assert.equal(subscriptions, 2);
    const handshake = world.hooks.get('experimental.ws.handshake').callback;
    await handshake({ sessionID: 's1', headers: {} });
    await world.hooks.get('retry').callback({ sessionID: 's1', error: quotaError, attempt: 2, decision: { retry: false } });
    await world.emit({ type: 'session.execution.failed', data: { sessionID: 's1' } });
    const late = { sessionID: 's1', error: quotaError, attempt: 3, decision: { retry: false } };
    await world.hooks.get('retry').callback(late);
    assert.deepEqual(late.decision, { retry: false });
  } finally {
    await cleanup();
  }
});

test('quota usage is fetched only for ChatGPT credentials and never wiped by an empty list', async () => {
  const world = fakeContext({ ids: ['A', 'K'] });
  world.values.K = { type: 'oauth', methodID: 'other-oauth', access: 'other-token' };
  const seen = [];
  const fetchStub = async (_url, init) => {
    seen.push(init.headers.authorization);
    return new Response(JSON.stringify(usagePayload));
  };
  await refreshUsage(routerDeps(world.ctx), undefined, fetchStub);
  assert.deepEqual(seen, ['Bearer access-A']);
  const empty = fakeContext({ ids: [] });
  await refreshUsage(routerDeps(empty.ctx), undefined, fetchStub);
  const usage = JSON.parse(await fs.readFile(path.join(codexDir, 'usage.json'), 'utf8'));
  assert.deepEqual(Object.keys(usage.accounts), ['A']);
});

test('quota usage is written for the TUI without any token', async () => {
  const world = fakeContext({ ids: ['A', 'B'] });
  const seen = [];
  await refreshUsage(routerDeps(world.ctx), undefined, async (url, init) => {
    seen.push({ url: String(url), authorization: init.headers.authorization, account: init.headers['ChatGPT-Account-Id'] });
    return new Response(JSON.stringify(usagePayload), { status: 200 });
  });
  assert.deepEqual(seen.map((call) => call.authorization).sort(), ['Bearer access-A', 'Bearer access-B']);
  assert.ok(seen.every((call) => call.url === 'https://chatgpt.com/backend-api/wham/usage'));
  const raw = await fs.readFile(path.join(codexDir, 'usage.json'), 'utf8');
  assert.equal(raw.includes('access-'), false);
  assert.equal(raw.includes('refresh-'), false);
  const usage = JSON.parse(raw);
  assert.deepEqual(Object.keys(usage.accounts).sort(), ['A', 'B']);
  assert.equal(usage.accounts.A.planType, 'pro');
  assert.deepEqual(usage.accounts.A.windows.map((w) => w.windowMinutes), [300, 10080]);
  assert.equal(((await fs.stat(path.join(codexDir, 'usage.json'))).mode & 0o777), 0o600);
});

test('usage for removed credentials is forgotten', async () => {
  const world = fakeContext({ ids: ['A'] });
  await refreshUsage(routerDeps(world.ctx), undefined, async () => new Response(JSON.stringify(usagePayload)));
  const usage = JSON.parse(await fs.readFile(path.join(codexDir, 'usage.json'), 'utf8'));
  assert.deepEqual(Object.keys(usage.accounts), ['A']);
});

test.after(async () => {
  await fs.rm(dataHome, { recursive: true, force: true });
});
