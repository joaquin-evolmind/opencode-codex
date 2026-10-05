import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

// The TUI and the Codex request hook can run in separate OpenCode processes.
// This file plays the request (server) process; `inOtherProcess` runs code in a
// real child Node process that shares only the data directory, like the TUI.

const dataHome = await fs.mkdtemp(path.join(os.tmpdir(), 'opencode-selection-test-'));
process.env.XDG_DATA_HOME = dataHome;
process.env.OPENCODE_CODEX_TRACE = '0';
process.env.OPENCODE_CODEX_DISABLE_ACCOUNT_WATCHER = '1';
const authPath = path.join(dataHome, 'opencode', 'auth.json');
const preferencesPath = path.join(dataHome, 'opencode', 'codex', 'preferences.json');
await fs.mkdir(path.dirname(authPath), { recursive: true });

const dist = pathToFileURL(
  path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'dist'),
).href;

function entry(id) {
  return {
    type: 'oauth',
    localId: id,
    refresh: `refresh-${id}`,
    access: `access-${id}`,
    expires: Date.now() + 3_600_000,
    label: `Account ${id}`,
  };
}

await fs.writeFile(
  authPath,
  JSON.stringify({
    'openai/a': entry('A'),
    'openai/b': entry('B'),
    'openai/c': entry('C'),
    openai: entry('A'),
  }),
);

const accounts = await import(`${dist}/accounts/index.js`);
const selection = await import(`${dist}/accounts/selection.js`);
const preferences = await import(`${dist}/accounts/preferences.js`);
const { chooseAccount } = await import(`${dist}/tui/account-priority.js`);
const { create: createCodexFetch } = await import(`${dist}/codex/fetch.js`);

function inOtherProcess(body) {
  const script = `
    const accounts = await import(${JSON.stringify(`${dist}/accounts/index.js`)});
    const selection = await import(${JSON.stringify(`${dist}/accounts/selection.js`)});
    const tui = await import(${JSON.stringify(`${dist}/tui/account-priority.js`)});
    await accounts.load();
    const result = await (async () => { ${body} })();
    process.stdout.write(JSON.stringify(result ?? null));
  `;
  const output = execFileSync(process.execPath, ['--input-type=module', '-e', script], {
    env: { ...process.env, XDG_DATA_HOME: dataHome },
    encoding: 'utf8',
  });
  return JSON.parse(output);
}

async function requestToken() {
  const originalFetch = globalThis.fetch;
  let authorization;
  globalThis.fetch = async (_input, init = {}) => {
    authorization = new Headers(init.headers).get('authorization');
    return new Response('{}', { status: 200 });
  };
  try {
    await createCodexFetch()('https://example.test/v1/responses', { method: 'POST' });
  } finally {
    globalThis.fetch = originalFetch;
  }
  return authorization;
}

async function storedPreferences() {
  return JSON.parse(await fs.readFile(preferencesPath, 'utf8'));
}

test('without a manual selection requests follow the first priority account', async () => {
  await accounts.load();
  await accounts.reorder(['C', 'A', 'B']);
  assert.equal(selection.id(), undefined);
  assert.equal(await requestToken(), 'Bearer access-C');
});

test('an /accounts choice routes the next request through that account', async () => {
  await chooseAccount('B');
  assert.equal(await requestToken(), 'Bearer access-B');
  assert.equal((await storedPreferences()).selectedAccount, 'B');
  const canonical = JSON.parse(await fs.readFile(authPath, 'utf8')).openai;
  assert.equal(canonical.access, 'access-B');
});

test('a choice made in another process reaches the warm request process', async () => {
  // Warm this process with B selected, then choose A in a separate process.
  assert.equal(await requestToken(), 'Bearer access-B');
  inOtherProcess(`await tui.chooseAccount('A');`);
  assert.equal(await requestToken(), 'Bearer access-A');
  assert.equal(selection.id(), 'A');
});

test('changing the manual selection never changes the persisted priority', async () => {
  const before = accounts.order();
  inOtherProcess(`await tui.chooseAccount('C');`);
  await accounts.refresh();
  assert.equal(selection.id(), 'C');
  assert.deepEqual(accounts.order(), before);
  assert.deepEqual((await storedPreferences()).accountOrder, before);
});

test('changing the priority never changes the manual selection', async () => {
  // Reorder in another process, then reorder here from a stale cache.
  inOtherProcess(`await accounts.reorder(['B', 'C', 'A']);`);
  await accounts.refresh();
  assert.equal(selection.id(), 'C');
  assert.deepEqual(accounts.order(), ['B', 'C', 'A']);

  inOtherProcess(`await tui.chooseAccount('A');`);
  await accounts.reorder(['A', 'B', 'C']);
  const stored = await storedPreferences();
  assert.deepEqual(stored.accountOrder, ['A', 'B', 'C']);
  assert.equal(stored.selectedAccount, 'A');
  assert.equal(selection.id(), 'A');
});

test('a rate-limited choice falls back by priority and recovers', async () => {
  await accounts.reorder(['C', 'B', 'A']);
  inOtherProcess(`await tui.chooseAccount('A');`);
  await accounts.refresh();
  await accounts.rateLimit('A', Date.now() + 60_000);
  assert.equal(await requestToken(), 'Bearer access-C');
  await accounts.rateLimit('C', Date.now() + 60_000);
  assert.equal(await requestToken(), 'Bearer access-B');
  assert.equal(selection.id(), 'A');
  assert.deepEqual(accounts.order(), ['C', 'B', 'A']);
  await accounts.clearRateLimit('A');
  await accounts.clearRateLimit('C');
  assert.equal(await requestToken(), 'Bearer access-A');
});

test('a new process observes the persisted selection and priority', async () => {
  const observed = inOtherProcess(`
    return {
      selected: selection.id(),
      order: accounts.order(),
      picked: accounts.pick().id,
    };
  `);
  assert.deepEqual(observed, { selected: 'A', order: ['C', 'B', 'A'], picked: 'A' });
});

test('clearing the selection returns routing to the priority order', async () => {
  inOtherProcess(`await selection.select(undefined);`);
  assert.equal(await requestToken(), 'Bearer access-C');
  assert.equal((await storedPreferences()).selectedAccount, undefined);
});

test('refresh reads shared files only after they change', async () => {
  const realReadFile = fs.readFile;
  let reads = 0;
  fs.readFile = (target, ...rest) => {
    if (target === authPath || target === preferencesPath) reads += 1;
    return realReadFile.call(fs, target, ...rest);
  };
  try {
    await accounts.refresh();
    reads = 0;
    await accounts.refresh();
    await accounts.refresh();
    assert.equal(reads, 0);
    inOtherProcess(`await tui.chooseAccount('B');`);
    await accounts.refresh();
    assert.ok(reads > 0);
    assert.equal(selection.id(), 'B');
  } finally {
    fs.readFile = realReadFile;
  }
});

test('a stale process selecting keeps accounts and order it has not loaded', async () => {
  // Another process adds D and puts it first; this process has not reloaded.
  inOtherProcess(`
    await accounts.save({
      id: 'D', refresh: 'refresh-D', access: 'access-D',
      expires: Date.now() + 3_600_000, label: 'Account D', addedAt: 1,
    });
    await accounts.reorder(['D', 'C', 'B', 'A']);
  `);
  assert.equal(accounts.find('D'), undefined);
  await selection.select('C');
  const stored = await storedPreferences();
  assert.deepEqual(stored.accountOrder, ['D', 'C', 'B', 'A']);
  assert.equal(stored.selectedAccount, 'C');
});

test('a credential write from a stale process keeps the other process changes', async () => {
  inOtherProcess(`await accounts.reorder(['A', 'D', 'C', 'B']);`);
  // activate() rewrites auth.json; it must not drop D or the newer order.
  await accounts.activate('C');
  const auth = JSON.parse(await fs.readFile(authPath, 'utf8'));
  assert.ok(Object.values(auth).some((value) => value.localId === 'D'));
  const stored = await storedPreferences();
  assert.deepEqual(stored.accountOrder, ['A', 'D', 'C', 'B']);
  assert.equal(stored.selectedAccount, 'C');
});

test('a refresh racing a token update never restores the old tokens', async () => {
  // Make refresh() reload, then hold it after reading auth.json (inside the
  // preference read) while a token rotation runs. The rotation must not finish
  // underneath the in-flight reload, or the reload would restore old tokens.
  inOtherProcess(`await tui.chooseAccount('A');`);
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  let entered;
  const readEntered = new Promise((resolve) => { entered = resolve; });
  preferences.__testing.setHooks({
    beforeTransaction: async (kind) => {
      if (kind !== 'read') return;
      preferences.__testing.setHooks({});
      entered();
      await held;
    },
  });
  const tokens = {
    access: 'access-A-rotated',
    refresh: 'refresh-A-rotated',
    expires: Date.now() + 3_600_000,
  };
  try {
    const refreshing = accounts.refresh();
    await readEntered;
    const rotating = accounts.updateTokens('A', tokens);
    const deadline = Date.now() + 300;
    while (Date.now() < deadline) {
      const auth = await fs.readFile(authPath, 'utf8');
      if (auth.includes('access-A-rotated')) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    release();
    await Promise.all([refreshing, rotating]);
  } finally {
    release();
    preferences.__testing.setHooks({});
  }
  assert.equal(accounts.find('A').access, 'access-A-rotated');
  assert.equal(await requestToken(), 'Bearer access-A-rotated');
});

test('removing the selected account clears the selection only', async () => {
  inOtherProcess(`await tui.chooseAccount('D');`);
  await accounts.remove('D');
  const stored = await storedPreferences();
  assert.equal(stored.selectedAccount, undefined);
  assert.deepEqual(stored.accountOrder, ['A', 'C', 'B']);
  assert.equal(await requestToken(), 'Bearer access-A-rotated');
});

test('rejects selecting an unknown account without changing state', async () => {
  const before = await storedPreferences();
  await assert.rejects(chooseAccount('missing'), /Unknown Codex account/);
  assert.deepEqual(await storedPreferences(), before);
});

test.after(async () => {
  await fs.rm(dataHome, { recursive: true, force: true });
});
