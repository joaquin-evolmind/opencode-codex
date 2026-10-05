import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const dataHome = await fs.mkdtemp(path.join(os.tmpdir(), 'opencode-priority-test-'));
process.env.XDG_DATA_HOME = dataHome;
process.env.OPENCODE_CODEX_TRACE = '0';
process.env.OPENCODE_CODEX_DISABLE_ACCOUNT_WATCHER = '1';
const authPath = path.join(dataHome, 'opencode', 'auth.json');
const preferencesPath = path.join(dataHome, 'opencode', 'codex', 'preferences.json');
await fs.mkdir(path.dirname(authPath), { recursive: true });

function entry(id, extra = {}) {
  return {
    type: 'oauth',
    localId: id,
    refresh: `refresh-${id}`,
    access: `access-${id}`,
    expires: Date.now() + 3_600_000,
    label: `Account ${id}`,
    ...extra,
  };
}

const initialAuth = {
  'openai/a': entry('A'),
  'openai/b': entry('B'),
  'openai/c': entry('C'),
  openai: entry('A'),
};
await fs.writeFile(authPath, JSON.stringify(initialAuth));

const accounts = await import('../dist/accounts/index.js');
const selection = await import('../dist/accounts/selection.js');
const preferences = await import('../dist/accounts/preferences.js');
const accountState = await import('../dist/accounts/state.js');
const { create: createCodexFetch } = await import('../dist/codex/fetch.js');

test('migrates legacy active first and persists versioned priority', async () => {
  const store = await accounts.load();
  assert.deepEqual(store.accounts.map((account) => account.id), ['A', 'B', 'C']);
  assert.deepEqual(accounts.order(), ['A', 'B', 'C']);
  assert.deepEqual(JSON.parse(await fs.readFile(preferencesPath, 'utf8')), {
    version: 1,
    accountOrder: ['A', 'B', 'C'],
  });
  assert.equal((await fs.stat(preferencesPath)).mode & 0o777, 0o600);
});

test('selects strict priority across cooldowns, expiry, and exclusions', async () => {
  const now = 10_000;
  assert.equal(accounts.pick(now).id, 'A');
  await accounts.rateLimit('A', now + 100);
  assert.equal(accounts.pick(now).id, 'B');
  await accounts.rateLimit('B', now + 100);
  assert.equal(accounts.pick(now).id, 'C');
  await accounts.rateLimit('C', now + 100);
  assert.equal(accounts.pick(now).id, 'A');
  assert.equal(accounts.pick(now + 101).id, 'A');
  assert.equal(accounts.pick({ now: now + 101, exclude: new Set(['A']) }).id, 'B');
});

test('manual selection wins, falls back without mutation, and recovers', async () => {
  const now = 20_000;
  await accounts.clearRateLimit('A');
  await accounts.clearRateLimit('B');
  selection.select('B');
  const beforeOrder = accounts.order();
  const beforeActive = accounts.snapshot().active;
  assert.equal(selection.pick(accounts.snapshot(), { now }).id, 'B');
  await accounts.rateLimit('B', now + 100);
  assert.equal(selection.pick(accounts.snapshot(), { now }).id, 'A');
  assert.equal(selection.id(), 'B');
  assert.equal(selection.pick(accounts.snapshot(), { now: now + 101 }).id, 'B');
  assert.deepEqual(accounts.order(), beforeOrder);
  assert.equal(accounts.snapshot().active, beforeActive);
});

test('reauth, refresh, delete, add, and reload preserve intended positions', async () => {
  await accounts.save({ ...accounts.find('B'), access: 'reauth-B' });
  assert.deepEqual(accounts.order(), ['A', 'B', 'C']);
  await accounts.updateTokens('B', {
    access: 'refreshed-B', refresh: 'refresh-B-next', expires: Date.now() + 7_200_000,
  });
  assert.deepEqual(accounts.order(), ['A', 'B', 'C']);
  await accounts.remove('B');
  assert.deepEqual(accounts.order(), ['A', 'C']);
  await accounts.save({
    id: 'D', refresh: 'refresh-D', access: 'access-D',
    expires: Date.now() + 3_600_000, addedAt: Date.now(),
  });
  assert.deepEqual(accounts.order(), ['A', 'C', 'D']);
  await accounts.save({
    id: 'E', refresh: 'refresh-E', access: 'access-E',
    expires: Date.now() + 3_600_000, addedAt: Date.now(),
  });
  assert.deepEqual(accounts.order(), ['A', 'C', 'D', 'E']);
  await accounts.reload();
  assert.deepEqual(accounts.order(), ['A', 'C', 'D', 'E']);
});

test('reconciles duplicate and missing IDs deterministically', async () => {
  await fs.writeFile(preferencesPath, JSON.stringify({
    version: 1,
    accountOrder: ['C', 'missing', 'C', 'A'],
  }));
  await accounts.reload();
  assert.deepEqual(accounts.order(), ['C', 'A', 'D', 'E']);
  assert.deepEqual(
    JSON.parse(await fs.readFile(preferencesPath, 'utf8')).accountOrder,
    ['C', 'A', 'D', 'E'],
  );
});

test('reorder changes only opaque priority IDs, not identity, metadata, or credentials', async () => {
  selection.select(undefined);
  const before = structuredClone(accounts.snapshot().accounts);
  const canonicalBefore = JSON.parse(await fs.readFile(authPath, 'utf8')).openai;
  await accounts.reorder(['D', 'A', 'unknown', 'D']);
  assert.deepEqual(accounts.order(), ['D', 'A', 'C', 'E']);
  assert.deepEqual(accounts.snapshot().accounts, before);
  assert.deepEqual(JSON.parse(await fs.readFile(authPath, 'utf8')).openai, canonicalBefore);
  assert.deepEqual(Object.keys(JSON.parse(await fs.readFile(preferencesPath, 'utf8'))), [
    'version', 'accountOrder',
  ]);
});

test('manual selection and persisted priority remain independent', async () => {
  selection.select('A');
  await accounts.reorder(['D', 'A', 'C', 'E']);
  assert.equal(selection.id(), 'A');

  const beforeOrder = accounts.order();
  selection.select('C');
  assert.deepEqual(accounts.order(), beforeOrder);
  selection.select(undefined);
});

test('plan and quota metadata never affect eligibility or order', async () => {
  const store = accounts.snapshot();
  store.accounts.find((account) => account.id === 'D').usage = {
    fetchedAt: Date.now(), planType: 'free', windows: [{ windowMinutes: 1, usedPercent: 100, resetAtMs: 0 }],
  };
  assert.equal(selection.pick(store).id, 'D');
  assert.deepEqual(accounts.order(), ['D', 'A', 'C', 'E']);
});

test('all request exclusions return undefined without changing selection state', () => {
  selection.select('A');
  const beforeOrder = accounts.order();
  const beforeActive = accounts.snapshot().active;
  assert.equal(
    selection.pick(accounts.snapshot(), {
      exclude: new Set(accounts.list().map((account) => account.id)),
    }),
    undefined,
  );
  assert.equal(selection.id(), 'A');
  assert.equal(accounts.snapshot().active, beforeActive);
  assert.deepEqual(accounts.order(), beforeOrder);
  selection.select(undefined);
});

test('migrates malformed and unsupported preferences without partial data', async () => {
  for (const invalid of ['{', JSON.stringify({ version: 2, accountOrder: ['E'] })]) {
    await fs.writeFile(preferencesPath, invalid);
    await accounts.reload();
    assert.deepEqual(accounts.order(), ['A', 'C', 'D', 'E']);
    assert.deepEqual(JSON.parse(await fs.readFile(preferencesPath, 'utf8')), {
      version: 1,
      accountOrder: ['A', 'C', 'D', 'E'],
    });
  }
});

test('recovers the persistence queue after one atomic rename failure', async () => {
  const before = await fs.readFile(preferencesPath, 'utf8');
  await fs.rm(preferencesPath);
  await fs.mkdir(preferencesPath);
  await assert.rejects(accounts.reorder(['E', 'D', 'C', 'A']));
  assert.deepEqual(accounts.order(), ['A', 'C', 'D', 'E']);
  assert.deepEqual(await fs.readdir(preferencesPath), []);
  await fs.rmdir(preferencesPath);
  await fs.writeFile(preferencesPath, before, { mode: 0o600 });
  await accounts.reorder(['E', 'D', 'C', 'A']);
  assert.deepEqual(accounts.order(), ['E', 'D', 'C', 'A']);
  assert.deepEqual(JSON.parse(await fs.readFile(preferencesPath, 'utf8')), {
    version: 1,
    accountOrder: ['E', 'D', 'C', 'A'],
  });

  const valid = await fs.readFile(preferencesPath, 'utf8');
  await fs.rm(preferencesPath);
  await fs.mkdir(preferencesPath);
  await accounts.updateTokens('A', {
    access: 'access-A-after-failure',
    refresh: 'refresh-A-after-failure',
    expires: Date.now() + 3_600_000,
  });
  assert.equal(accounts.find('A').access, 'access-A-after-failure');
  assert.equal(
    Object.values(JSON.parse(await fs.readFile(authPath, 'utf8')))
      .find((value) => value.localId === 'A')?.access,
    'access-A-after-failure',
  );
  await fs.rmdir(preferencesPath);
  await fs.writeFile(preferencesPath, valid, { mode: 0o600 });
  await accounts.reload();
  assert.deepEqual(accounts.order(), ['E', 'D', 'C', 'A']);
});

test('serializes complete preference transactions in FIFO order', async () => {
  let releaseFirst;
  const firstBlocked = new Promise((resolve) => { releaseFirst = resolve; });
  let persistCount = 0;
  preferences.__testing.setHooks({
    beforePersist: async () => {
      persistCount += 1;
      if (persistCount === 1) await firstBlocked;
    },
  });
  const store = accounts.snapshot();
  const first = preferences.replace(['A', 'C', 'D', 'E'], store);
  const second = preferences.replace(['C', 'E', 'D', 'A'], store);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(persistCount, 1);
  releaseFirst();
  await Promise.all([first, second]);
  preferences.__testing.setHooks({});
  assert.deepEqual(accounts.order(), ['C', 'E', 'D', 'A']);
  assert.deepEqual(JSON.parse(await fs.readFile(preferencesPath, 'utf8')).accountOrder,
    ['C', 'E', 'D', 'A']);
});

test('serializes stale preference read before a newer public reorder', async () => {
  await accounts.load();
  const initialOrder = accounts.list().map((account) => account.id);
  const targetOrder = [...initialOrder].reverse();
  await accounts.reorder(initialOrder);
  const store = accounts.snapshot();
  let releaseRead;
  const readBlocked = new Promise((resolve) => { releaseRead = resolve; });
  let markReadEntered;
  const readEntered = new Promise((resolve) => { markReadEntered = resolve; });
  const starts = [];
  preferences.__testing.setHooks({
    beforeTransaction: async (kind) => {
      starts.push(kind);
      if (kind === 'read') {
        markReadEntered();
        await readBlocked;
      }
    },
  });
  const read = preferences.read(store);
  let reorder;
  try {
    await readEntered;
    reorder = accounts.reorder(targetOrder);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(starts.includes('replacePrepared'), false);
    releaseRead();
    await Promise.all([read, reorder]);
    assert.ok(starts.indexOf('read') < starts.indexOf('replacePrepared'));
  } finally {
    releaseRead();
    await Promise.allSettled([read, ...(reorder ? [reorder] : [])]);
    preferences.__testing.setHooks({});
  }
  assert.deepEqual(accounts.order(), targetOrder);
  assert.deepEqual(
    JSON.parse(await fs.readFile(preferencesPath, 'utf8')).accountOrder,
    accounts.order(),
  );
});

test('linearizes public reorder before a later preference read', async () => {
  await accounts.load();
  const initialOrder = accounts.list().map((account) => account.id);
  const targetOrder = [initialOrder.at(-1), ...initialOrder.slice(0, -1)];
  const starts = [];
  let releaseReorder;
  const reorderBlocked = new Promise((resolve) => { releaseReorder = resolve; });
  let markReorderEntered;
  const reorderEntered = new Promise((resolve) => { markReorderEntered = resolve; });
  preferences.__testing.setHooks({
    beforeTransaction: async (kind) => {
      starts.push(kind);
      if (kind === 'replacePrepared') {
        markReorderEntered();
        await reorderBlocked;
      }
    },
  });
  const reorder = accounts.reorder(targetOrder);
  let read;
  try {
    await reorderEntered;
    read = preferences.read(accounts.snapshot());
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(starts.includes('read'), false);
    releaseReorder();
    await Promise.all([reorder, read]);
    assert.ok(starts.indexOf('replacePrepared') < starts.indexOf('read'));
  } finally {
    releaseReorder();
    await Promise.allSettled([reorder, ...(read ? [read] : [])]);
    preferences.__testing.setHooks({});
  }
  assert.deepEqual(accounts.order(), targetOrder);
  assert.deepEqual(
    JSON.parse(await fs.readFile(preferencesPath, 'utf8')).accountOrder,
    accounts.order(),
  );
});

test('does not publish cache before chmod succeeds and retries dirty state', async () => {
  const before = accounts.order();
  preferences.__testing.setHooks({ beforeChmod: () => { throw new Error('chmod failed'); } });
  await assert.rejects(accounts.reorder(['A', 'D', 'E', 'C']), /chmod failed/);
  assert.deepEqual(accounts.order(), before);
  assert.deepEqual(JSON.parse(await fs.readFile(preferencesPath, 'utf8')).accountOrder,
    ['A', 'D', 'E', 'C']);
  assert.equal(preferences.__testing.isDirty(), true);
  preferences.__testing.setHooks({});
  await accounts.load();
  assert.deepEqual(accounts.order(), ['A', 'D', 'E', 'C']);
  assert.equal(preferences.__testing.isDirty(), false);

  await fs.chmod(preferencesPath, 0o644);
  preferences.__testing.setHooks({ beforeChmod: () => { throw new Error('existing chmod failed'); } });
  await assert.rejects(accounts.reload(), /existing chmod failed/);
  assert.deepEqual(accounts.order(), ['A', 'D', 'E', 'C']);
  preferences.__testing.setHooks({});
  await accounts.reload();
  assert.equal((await fs.stat(preferencesPath)).mode & 0o777, 0o600);
});

test('leaves failed first preference initialization unpublished', async () => {
  const store = accounts.snapshot();
  await fs.rm(preferencesPath);
  await preferences.__testing.reset();
  preferences.__testing.setHooks({ beforePersist: () => { throw new Error('initial persist failed'); } });
  await assert.rejects(preferences.read(store), /initial persist failed/);
  assert.deepEqual(preferences.snapshot(), []);
  assert.equal(preferences.__testing.isDirty(), true);
  preferences.__testing.setHooks({});
  await preferences.read(store);
  assert.deepEqual(preferences.snapshot(), store.accounts.map((account) => account.id));
});

test('does not publish failed reconciliation and heals memory plus disk', async () => {
  const before = accounts.order();
  const unreconciled = ['C', 'missing', 'C', 'A'];
  await fs.writeFile(preferencesPath, JSON.stringify({
    version: 1,
    accountOrder: unreconciled,
  }));
  preferences.__testing.setHooks({
    beforePersist: () => { throw new Error('reconciliation persist failed'); },
  });
  await assert.rejects(accounts.reload(), /reconciliation persist failed/);
  assert.deepEqual(accounts.order(), before);
  assert.deepEqual(
    JSON.parse(await fs.readFile(preferencesPath, 'utf8')).accountOrder,
    unreconciled,
  );
  preferences.__testing.setHooks({});
  await accounts.reload();
  assert.deepEqual(accounts.order(), ['C', 'A', 'D', 'E']);
  assert.deepEqual(
    JSON.parse(await fs.readFile(preferencesPath, 'utf8')).accountOrder,
    accounts.order(),
  );
});

test('keeps durable auth success and heals deferred preferences', async () => {
  const beforeOrder = accounts.order();
  preferences.__testing.setHooks({ beforePersist: () => { throw new Error('deferred'); } });
  await accounts.save({
    id: 'F', refresh: 'refresh-F', access: 'access-F',
    expires: Date.now() + 3_600_000, addedAt: Date.now(),
  });
  assert.equal(accounts.find('F').access, 'access-F');
  assert.equal(
    Object.values(JSON.parse(await fs.readFile(authPath, 'utf8')))
      .find((value) => value.localId === 'F')?.access,
    'access-F',
  );
  assert.equal(preferences.__testing.isDirty(), true);
  assert.equal(accounts.order().includes('F'), false);
  preferences.__testing.setHooks({});
  await accounts.reload();
  assert.deepEqual(accounts.order(), [...beforeOrder, 'F']);
  assertEqualIDs(accounts.order());
});

test('serializes account mutations that would otherwise lose updates', async () => {
  await Promise.all([
    accounts.save({
      id: 'I', refresh: 'refresh-I', access: 'access-I',
      expires: Date.now() + 3_600_000, addedAt: Date.now(),
    }),
    accounts.save({
      id: 'J', refresh: 'refresh-J', access: 'access-J',
      expires: Date.now() + 3_600_000, addedAt: Date.now(),
    }),
  ]);
  assert.equal(accounts.find('I').id, 'I');
  assert.equal(accounts.find('J').id, 'J');
  const durable = Object.values(JSON.parse(await fs.readFile(authPath, 'utf8')));
  assert.ok(durable.some((value) => value.localId === 'I'));
  assert.ok(durable.some((value) => value.localId === 'J'));
  assertEqualIDs(accounts.order());
});

test('keeps successful account removal when preference synchronization fails', async () => {
  const beforeAccounts = accounts.list().map((account) => account.id);
  const removedID = 'I';
  assert.ok(beforeAccounts.includes(removedID));
  preferences.__testing.setHooks({
    beforePersist: () => { throw new Error('deferred removal preference'); },
  });
  await accounts.remove(removedID);
  assert.equal(accounts.find(removedID), undefined);
  const durableAfterRemoval = Object.values(
    JSON.parse(await fs.readFile(authPath, 'utf8')),
  );
  assert.equal(durableAfterRemoval.some((value) => value.localId === removedID), false);
  for (const id of beforeAccounts.filter((id) => id !== removedID)) {
    assert.equal(accounts.find(id)?.id, id);
  }
  assert.equal(accounts.order().includes(removedID), true);
  preferences.__testing.setHooks({});
  await preferences.__testing.reset();
  await accounts.reload();
  assert.equal(accounts.find(removedID), undefined);
  for (const id of beforeAccounts.filter((id) => id !== removedID)) {
    assert.equal(accounts.find(id)?.id, id);
  }
  assert.equal(accounts.order().includes(removedID), false);
  assertEqualIDs(accounts.list().map((account) => account.id));
  assertEqualIDs(accounts.order());
  assert.deepEqual(
    JSON.parse(await fs.readFile(preferencesPath, 'utf8')).accountOrder,
    accounts.order(),
  );
});

test('watcher retries failed mtimes and serializes overlapping reloads', async () => {
  const before = accounts.snapshot();
  const external = JSON.parse(await fs.readFile(authPath, 'utf8'));
  external['openai/G'] = entry('G');
  await fs.writeFile(authPath, JSON.stringify(external));
  preferences.__testing.setHooks({ beforePersist: () => { throw new Error('watch failed'); } });
  await assert.rejects(accountState.__testing.processWatchedMtime(10), /watch failed/);
  assert.deepEqual(accounts.snapshot(), before);
  preferences.__testing.setHooks({});
  await accountState.__testing.processWatchedMtime(10);
  assert.equal(accounts.find('G').id, 'G');

  let release;
  const blocked = new Promise((resolve) => { release = resolve; });
  let calls = 0;
  preferences.__testing.setHooks({ beforeChmod: async () => {
    calls += 1;
    if (calls === 1) await blocked;
  } });
  const first = accountState.__testing.processWatchedMtime(11);
  await new Promise((resolve) => setImmediate(resolve));
  external['openai/H'] = entry('H');
  await fs.writeFile(authPath, JSON.stringify(external));
  const second = accountState.__testing.processWatchedMtime(12);
  release();
  await Promise.all([first, second]);
  preferences.__testing.setHooks({});
  assertEqualIDs(accounts.order());
  assert.equal(accounts.find('H').id, 'H');
});

function assertEqualIDs(ids) {
  assert.equal(new Set(ids).size, ids.length);
}

test('timeout retries follow priority order with request exclusions', async () => {
  await accounts.reorder(['D', 'A', 'C', 'E']);
  selection.select(undefined);
  const beforeOrder = accounts.order();
  const beforeActive = accounts.snapshot().active;
  const beforeCanonical = JSON.parse(await fs.readFile(authPath, 'utf8')).openai;
  const originalFetch = globalThis.fetch;
  const attempted = [];
  globalThis.fetch = async (_input, init = {}) => {
    const access = new Headers(init.headers).get('authorization');
    attempted.push(access);
    if (attempted.length < 3) throw new DOMException('timeout', 'TimeoutError');
    return new Response('{}', { status: 200 });
  };
  try {
    await createCodexFetch()('https://example.test/v1/responses', { method: 'POST' });
    assert.deepEqual(attempted, [
      'Bearer access-D',
      'Bearer access-A-after-failure',
      'Bearer access-C',
    ]);
    assert.equal(selection.id(), undefined);
    assert.equal(accounts.snapshot().active, beforeActive);
    assert.deepEqual(accounts.order(), beforeOrder);
    assert.deepEqual(JSON.parse(await fs.readFile(authPath, 'utf8')).openai, beforeCanonical);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test.after(async () => {
  await fs.rm(dataHome, { recursive: true, force: true });
});
