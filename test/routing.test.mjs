import assert from 'node:assert/strict';
import test from 'node:test';

const { pick, usable } = await import('../dist/routing/pick.js');
const { isQuotaError, cooldownMs } = await import('../dist/routing/quota-error.js');
const { Router } = await import('../dist/routing/router.js');

const codex = (id, extra = {}) => ({
  type: 'oauth',
  methodID: 'chatgpt-browser',
  access: `access-${id}`,
  metadata: { accountID: `acct-${id}` },
  ...extra,
});

/** A fake OpenCode credential store. `activate` must never be called by the router. */
function world({ ids = ['A', 'B', 'C'], active = 'A', order = ids, values } = {}) {
  const state = { ids, active, order, values: values ?? Object.fromEntries(ids.map((id) => [id, codex(id)])), now: 1_000_000, resolves: [] };
  const deps = {
    connections: async () => ({ ids: state.ids, active: state.active }),
    order: async (list) => state.order.filter((id) => list.includes(id)),
    resolve: async (id) => {
      state.resolves.push(id);
      return state.values[id];
    },
    now: () => state.now,
  };
  return { state, router: new Router(deps) };
}

const quota = { type: 'provider.quota', status: 429, response: { body: '{"error":{"type":"usage_limit_reached","resets_in_seconds":120}}' } };

test('pick keeps the manual selection while usable and falls back by priority', () => {
  const base = { order: ['C', 'B', 'A'], active: 'A', excluded: new Set(), coolingUntil: () => undefined, now: 0 };
  assert.equal(pick(base), 'A');
  assert.equal(pick({ ...base, excluded: new Set(['A']) }), 'C');
  assert.equal(pick({ ...base, coolingUntil: (id) => (id === 'A' || id === 'C' ? 10 : undefined) }), 'B');
  // Nothing usable: surface the manual selection's upstream error instead of "no account".
  assert.equal(pick({ ...base, coolingUntil: () => 10 }), 'A');
  assert.deepEqual(usable({ ...base, coolingUntil: (id) => (id === 'C' ? 10 : undefined) }), ['A', 'B']);
});

test('quota errors are recognised and their reset hint sets the cooldown', () => {
  assert.equal(isQuotaError(quota), true);
  assert.equal(isQuotaError({ status: 402 }), true);
  assert.equal(isQuotaError({ type: 'provider.invalid-request', status: 400 }), false);
  assert.equal(cooldownMs(quota), 120_000);
  assert.equal(cooldownMs({ response: { body: '{"error":{"resets_at":1100}}' } }, 1_000_000), 100_000);
  assert.equal(cooldownMs({ status: 429 }), 5 * 60_000);
});

test('requests use the active credential while it has quota', async () => {
  const { router } = world();
  const route = await router.route('s1');
  assert.deepEqual(route, {
    credentialID: 'A',
    headers: { authorization: 'Bearer access-A', 'chatgpt-account-id': 'acct-A' },
  });
});

test('a quota error retries through the first usable account by priority', async () => {
  const { state, router } = world({ order: ['C', 'B', 'A'] });
  assert.equal((await router.route('s1')).credentialID, 'A');
  assert.equal(await router.failed('s1', quota), true);
  assert.equal((await router.route('s1')).credentialID, 'C');
  assert.equal(state.active, 'A', 'fallback never changes the active credential');
  // C runs out too: next by priority.
  assert.equal(await router.failed('s1', quota), true);
  assert.equal((await router.route('s1')).credentialID, 'B');
});

test('when every account is out of quota the error surfaces instead of retrying', async () => {
  const { router } = world({ ids: ['A', 'B'] });
  await router.route('s1');
  assert.equal(await router.failed('s1', quota), true);
  assert.equal((await router.route('s1')).credentialID, 'B');
  assert.equal(await router.failed('s1', quota), false);
});

test('with three accounts out of quota the error surfaces after trying each once', async () => {
  const { router } = world({ order: ['B', 'C', 'A'] });
  const tried = [];
  for (let attempt = 0; attempt < 5; attempt++) {
    const route = await router.route('s1');
    tried.push(route.credentialID);
    if (!(await router.failed('s1', quota))) break;
  }
  assert.deepEqual(tried, ['A', 'B', 'C']);
});

test('a credential that cannot be resolved is skipped instead of failing the request', async () => {
  const { state, router } = world({ order: ['B', 'C', 'A'] });
  const original = router.deps.resolve;
  router.deps.resolve = async (id) => {
    if (id === 'B') throw new Error('refresh token revoked');
    return original(id);
  };
  await router.route('s1');
  assert.equal(await router.failed('s1', quota), true);
  assert.equal((await router.route('s1')).credentialID, 'C');
  assert.equal(state.active, 'A');
});

test('non-quota errors keep OpenCode\'s own retry decision', async () => {
  const { router } = world();
  await router.route('s1');
  assert.equal(await router.failed('s1', { type: 'provider.overloaded', status: 503 }), false);
  assert.equal(router.coolingDown('A'), false);
});

test('the cooldown is shared across sessions but exclusions are per session', async () => {
  const { router } = world({ order: ['A', 'B', 'C'] });
  await Promise.all([router.route('s1'), router.route('s2')]);
  assert.equal(await router.failed('s1', quota), true);
  // s2 is a different execution: it also avoids A (shared cooldown fact)…
  assert.equal((await router.route('s2')).credentialID, 'B');
  // …and its own failure on B does not leak into s1's exclusions.
  assert.equal(await router.failed('s2', { status: 429 }), true);
  assert.equal((await router.route('s1')).credentialID, 'C');
  assert.equal((await router.route('s2')).credentialID, 'C');
});

test('concurrent sessions keep their routed credential while another falls back', async () => {
  const { state, router } = world({ order: ['B', 'A', 'C'] });
  // Both sessions are routed through A concurrently.
  const [r1, r2] = await Promise.all([router.route('s1'), router.route('s2')]);
  assert.equal(r1.credentialID, 'A');
  assert.equal(r2.credentialID, 'A');
  // s1 runs out of quota and retries through B; s2's in-flight request keeps A.
  assert.equal(await router.failed('s1', quota), true);
  assert.equal((await router.route('s1')).credentialID, 'B');
  assert.equal(router.current('s2'), 'A');
  assert.equal(state.active, 'A');
});

test('a request routed while another session hits quota sees the newest cooldown', async () => {
  const { router } = world({ order: ['B', 'A', 'C'] });
  await router.route('s1');
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const original = router.deps.resolve;
  let held = false;
  router.deps.resolve = async (id) => {
    if (!held && id === 'A') {
      held = true;
      await gate;
    }
    return original(id);
  };
  const pending = router.route('s2');
  assert.equal(await router.failed('s1', quota), true);
  release();
  assert.equal((await pending).credentialID, 'B');
  assert.equal((await router.route('s1')).credentialID, 'B');
});

test('ending an execution clears only that session and cooldowns expire', async () => {
  const { state, router } = world();
  await router.route('s1');
  await router.route('s2');
  await router.failed('s1', quota);
  router.end('s1');
  assert.equal(router.sessionCount(), 1);
  assert.equal(router.current('s1'), undefined);
  assert.equal(router.current('s2'), 'A');
  // A new execution in s1 still avoids A until its cooldown expires.
  assert.equal((await router.route('s1')).credentialID, 'B');
  state.now += 121_000;
  assert.equal((await router.route('s1')).credentialID, 'A');
});

test('only ChatGPT OAuth credentials are used for fallback', async () => {
  const { router } = world({
    ids: ['A', 'K', 'B'],
    order: ['K', 'B', 'A'],
    values: { A: codex('A'), K: { type: 'key', key: 'sk-test' }, B: codex('B') },
  });
  await router.route('s1');
  assert.equal(await router.failed('s1', quota), true);
  assert.equal((await router.route('s1')).credentialID, 'B');
});

test('requests are left alone when the active credential is not ChatGPT OAuth', async () => {
  const { router } = world({ values: { A: { type: 'key', key: 'sk-test' }, B: codex('B'), C: codex('C') } });
  assert.equal(await router.route('s1'), undefined);
  assert.equal(await router.failed('s1', quota), false);
});

test('the account header falls back to the token claims', async () => {
  const claims = Buffer.from(JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: 'acct-jwt' } })).toString('base64url');
  const jwt = `h.${claims}.s`;
  const { router } = world({ ids: ['A'], values: { A: { type: 'oauth', methodID: 'chatgpt-headless', access: jwt } } });
  const route = await router.route('s1');
  assert.equal(route.headers['chatgpt-account-id'], 'acct-jwt');
});
