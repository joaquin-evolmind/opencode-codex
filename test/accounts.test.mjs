import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const dataHome = await fs.mkdtemp(path.join(os.tmpdir(), 'opencode-codex-accounts-'));
process.env.XDG_DATA_HOME = dataHome;
const priorityPath = path.join(dataHome, 'opencode', 'codex', 'priority.json');
const dist = pathToFileURL(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'dist')).href;

const priority = await import(`${dist}/accounts/priority.js`);
const { reconcile, moved } = await import(`${dist}/accounts/order.js`);
const { AccountsView, toAccounts, accountRows } = await import(`${dist}/tui/accounts-view.js`);
const { displayName } = await import(`${dist}/accounts/display.js`);

function inOtherProcess(body) {
  const script = `
    const priority = await import(${JSON.stringify(`${dist}/accounts/priority.js`)});
    const result = await (async () => { ${body} })();
    process.stdout.write(JSON.stringify(result ?? null));
  `;
  return JSON.parse(
    execFileSync(process.execPath, ['--input-type=module', '-e', script], {
      env: { ...process.env, XDG_DATA_HOME: dataHome },
      encoding: 'utf8',
    }),
  );
}

const jwt = (claims) => `h.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.s`;
const entry = (id, extra = {}) => ({
  id,
  integrationID: 'openai',
  label: 'OAuth',
  active: false,
  value: {
    type: 'oauth',
    methodID: 'chatgpt-browser',
    access: jwt({ email: `${id.toLowerCase()}@example.com` }),
    refresh: `refresh-${id}`,
    metadata: { accountID: `acct-${id}` },
  },
  ...extra,
});

test('order reconciliation keeps stored order, drops unknown and appends new IDs', () => {
  assert.deepEqual(reconcile(['C', 'X', 'A', 'C'], ['A', 'B', 'C']), ['C', 'A', 'B']);
  assert.deepEqual(moved(['A', 'B', 'C'], 'B', 'up'), ['B', 'A', 'C']);
  assert.equal(moved(['A', 'B'], 'A', 'up'), undefined);
});

test('priority moves persist without tokens and with private permissions', async () => {
  assert.deepEqual(await priority.order(['A', 'B', 'C']), ['A', 'B', 'C']);
  assert.deepEqual(await priority.move(['A', 'B', 'C'], 'C', 'up'), ['A', 'C', 'B']);
  const raw = JSON.parse(await fs.readFile(priorityPath, 'utf8'));
  assert.deepEqual(raw, { version: 2, order: ['A', 'C', 'B'] });
  assert.equal((await fs.stat(priorityPath)).mode & 0o777, 0o600);
});

test('a priority change made by another process is observed on the next read', async () => {
  assert.deepEqual(await priority.order(['A', 'B', 'C']), ['A', 'C', 'B']);
  inOtherProcess(`await priority.move(['A', 'B', 'C'], 'B', 'up');`);
  assert.deepEqual(await priority.order(['A', 'B', 'C']), ['A', 'B', 'C']);
  // And the other direction: a new process sees what this one wrote.
  await priority.move(['A', 'B', 'C'], 'A', 'down');
  assert.deepEqual(inOtherProcess(`return priority.order(['A', 'B', 'C']);`), ['B', 'A', 'C']);
});

test('only native ChatGPT OAuth credentials become Codex accounts, without secrets', () => {
  const accounts = toAccounts(
    [
      entry('A', { active: true }),
      entry('B'),
      { id: 'K', integrationID: 'openai', label: 'API key', active: false, value: { type: 'key', key: 'sk-test' } },
      entry('G', { integrationID: 'openai/legacy' }),
      entry('O', { value: { type: 'oauth', methodID: 'oauth', access: 'x' } }),
    ],
    ['B', 'A'],
    { A: { fetchedAt: 1, planType: 'plus', windows: [{ windowMinutes: 300, usedPercent: 40, resetAtMs: 1 }] } },
  );
  assert.deepEqual(accounts.map((a) => a.id), ['B', 'A']);
  assert.equal(accounts[1].active, true);
  assert.equal(accounts[1].email, 'a@example.com');
  assert.equal(accounts[1].accountId, 'acct-A');
  assert.equal(JSON.stringify(accounts).includes('refresh-'), false);
  assert.equal(JSON.stringify(accounts).includes('sk-test'), false);
  assert.deepEqual(accountRows(accounts), [
    { id: 'B', title: '1. b@example.com', description: undefined },
    { id: 'A', title: '2. a@example.com', description: 'active · Plus · 5h 60%' },
  ]);
});

test('display names prefer custom labels, then email, then account ID', () => {
  assert.equal(displayName({ label: 'Work', email: 'w@example.com' }), 'Work');
  assert.equal(displayName({ label: 'OAuth', email: 'w@example.com' }), 'w@example.com');
  assert.equal(displayName({ label: 'OAuth', accountId: '1234567890abcdef' }), 'Codex account …90abcdef');
});

function fakeDeps(entries) {
  const calls = { activate: [], move: [] };
  let order = entries.map((e) => e.id);
  const deps = {
    list: async () => entries.map((e) => ({ ...e })),
    activate: async (id) => {
      calls.activate.push(id);
      for (const e of entries) e.active = e.id === id;
    },
    order: async (ids) => reconcile(order, ids),
    move: async (ids, id, direction) => {
      calls.move.push([id, direction]);
      order = moved(reconcile(order, ids), id, direction) ?? order;
      return order;
    },
    usage: async () => ({}),
  };
  return { deps, calls, order: () => order };
}

test('Enter activates the credential and never changes the priority', async () => {
  const entries = [entry('A', { active: true }), entry('B'), entry('C')];
  const { deps, calls, order } = fakeDeps(entries);
  const view = new AccountsView(deps);
  await view.refresh();
  await view.activate('C');
  assert.deepEqual(calls.activate, ['C']);
  assert.deepEqual(calls.move, []);
  assert.deepEqual(order(), ['A', 'B', 'C']);
  assert.equal(view.active().id, 'C');
});

test('Ctrl+Up/Down changes only the priority and never activates', async () => {
  const entries = [entry('A', { active: true }), entry('B'), entry('C')];
  const { deps, calls } = fakeDeps(entries);
  const view = new AccountsView(deps);
  await view.refresh();
  assert.deepEqual(await view.move('C', 'up'), ['A', 'C', 'B']);
  assert.deepEqual(calls.activate, []);
  assert.equal(view.active().id, 'A');
  assert.deepEqual(view.snapshot().map((a) => a.id), ['A', 'C', 'B']);
});

test('a refresh requested during a load reloads once more and shows the latest state', async () => {
  const entries = [entry('A', { active: true }), entry('B')];
  const { deps } = fakeDeps(entries);
  let lists = 0;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const view = new AccountsView({
    ...deps,
    list: async () => {
      lists += 1;
      if (lists === 1) await gate;
      return deps.list();
    },
  });
  const first = view.refresh();
  // A write lands while the first load is in flight, then more refreshes arrive.
  for (const e of entries) e.active = e.id === 'B';
  const followers = [view.refresh(), view.refresh()];
  release();
  await Promise.all([first, ...followers]);
  assert.equal(lists, 2, 'one extra load, not one per call');
  assert.equal(view.active().id, 'B');
});

test.after(async () => {
  await fs.rm(dataHome, { recursive: true, force: true });
});
