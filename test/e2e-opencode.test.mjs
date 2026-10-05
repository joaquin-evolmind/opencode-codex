// Opt-in end-to-end test against a real OpenCode 2 binary, fully isolated:
// temporary HOME/XDG directories and database, fake credentials, fake upstream.
//   OPENCODE_BIN=/path/to/opencode BUN_BIN=/path/to/bun node --test test/e2e-opencode.test.mjs
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { promises as fs, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const bin = process.env.OPENCODE_BIN;
const PASSWORD = 'e2e-only';

async function waitFor(check, timeoutMs = 30_000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if (await check().catch(() => false)) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error('timed out');
}

test('OpenCode 2 loads the plugin directory and routes per session with quota fallback', { skip: !bin && 'set OPENCODE_BIN to run' }, async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'opencode-codex-e2e-'));
  const log = path.join(home, 'upstream.jsonl');
  const upstreamPort = 47700 + Math.floor(Math.random() * 200);
  const serverPort = upstreamPort + 300;
  const env = {
    PATH: '/usr/bin:/bin',
    HOME: home,
    XDG_CONFIG_HOME: path.join(home, '.config'),
    XDG_DATA_HOME: path.join(home, '.local/share'),
    XDG_STATE_HOME: path.join(home, '.local/state'),
    XDG_CACHE_HOME: path.join(home, '.cache'),
    OPENCODE_SERVER_PASSWORD: PASSWORD,
    FAKE_CODEX_UPSTREAM: `http://127.0.0.1:${upstreamPort}`,
  };
  await fs.mkdir(path.join(env.XDG_CONFIG_HOME, 'opencode'), { recursive: true });
  await fs.writeFile(
    path.join(env.XDG_CONFIG_HOME, 'opencode', 'opencode.json'),
    JSON.stringify({ plugin: [path.join(root, 'dist'), path.join(root, 'test/fixtures/redirect-plugin')] }),
  );
  const upstream = spawn(process.env.BUN_BIN ?? 'bun', [path.join(root, 'test/fixtures/fake-codex-upstream.ts')], {
    env: { ...env, SPIKE_LOG: log, SPIKE_UPSTREAM_PORT: String(upstreamPort) },
    stdio: 'ignore',
  });
  const server = spawn(bin, ['serve', '--hostname', '127.0.0.1', '--port', String(serverPort)], { env, stdio: 'ignore' });
  t.after(async () => {
    server.kill();
    upstream.kill();
    await fs.rm(home, { recursive: true, force: true });
  });

  const base = `http://127.0.0.1:${serverPort}`;
  const auth = `Basic ${Buffer.from(`opencode:${PASSWORD}`).toString('base64')}`;
  const call = async (method, route, body) => {
    const response = await fetch(base + route, { method, headers: { 'content-type': 'application/json', authorization: auth }, body: body && JSON.stringify(body) });
    const text = await response.text();
    if (!response.ok) throw new Error(`${method} ${route} -> ${response.status} ${text.slice(0, 300)}`);
    let json;
    try { json = JSON.parse(text); } catch { return text; }
    return json?.data ?? json;
  };
  await waitFor(async () => (await fetch(`${base}/api/credential`, { headers: { authorization: auth } })).ok);

  const oauth = (name) => ({ type: 'oauth', methodID: 'chatgpt-browser', access: `fake-access-${name}`, refresh: `fake-refresh-${name}`, expires: Date.now() + 86_400_000, metadata: { accountID: `acct-${name}` } });
  // A is active and runs out of quota inside the socket; priority says B, then C.
  const A = await call('POST', '/api/credential', { integrationID: 'openai', label: 'A', value: { ...oauth('A'), access: 'fake-access-A-wsquota' }, activate: true });
  const C = await call('POST', '/api/credential', { integrationID: 'openai', label: 'C', value: oauth('C'), activate: false });
  const B = await call('POST', '/api/credential', { integrationID: 'openai', label: 'B', value: oauth('B'), activate: false });
  await call('POST', `/api/credential/${A.id}/activate`, {});
  const codexDir = path.join(env.XDG_DATA_HOME, 'opencode', 'codex');
  await fs.mkdir(codexDir, { recursive: true });
  await fs.writeFile(path.join(codexDir, 'priority.json'), JSON.stringify({ version: 2, order: [B.id, C.id, A.id] }));
  await new Promise((resolve) => setTimeout(resolve, 1500));

  const model = { providerID: 'openai', id: 'gpt-5.5' };
  const run = async (title) => {
    const session = await call('POST', '/api/session', { title, model });
    await call('POST', `/api/session/${session.id}/prompt`, { text: `ping ${title}` });
    await call('POST', `/api/experimental/session/${session.id}/wait`, {});
    return session.id;
  };
  const activeLabel = async () => (await call('GET', '/api/credential')).filter((c) => c.integrationID === 'openai' && c.active).map((c) => c.label);

  const first = await run('falls-back');
  const [second, third] = await Promise.all([run('concurrent-1'), run('concurrent-2')]);
  assert.deepEqual(await activeLabel(), ['A'], 'fallback never changes the active credential');

  const events = readFileSync(log, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  const handshakes = (session) => events.filter((e) => e.kind === 'ws.handshake' && e.session === session).map((e) => e.authorization);
  // The first session tried A (manual selection), hit quota, and retried through B by priority.
  assert.deepEqual(handshakes(first), ['Bearer fake-access-A-wsquota', 'Bearer fake-access-B']);
  // A is cooling down: concurrent sessions go straight to B, each with its own socket.
  assert.deepEqual(handshakes(second), ['Bearer fake-access-B']);
  assert.deepEqual(handshakes(third), ['Bearer fake-access-B']);
  assert.ok(events.filter((e) => e.kind === 'ws.handshake' && e.session === second).every((e) => e.account === 'acct-B'));
});
