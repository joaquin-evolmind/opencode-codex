/** @jsxImportSource @opentui/solid */
// Run with: bun --preload @opentui/solid/preload test/tui-plugin.fixture.tsx
// Exercises the shipped dist/tui.js with a fake OpenCode 2 TUI context.
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { RGBA } from '@opentui/core';
import { testRender } from '@opentui/solid';

const dataHome = await fs.mkdtemp(path.join(os.tmpdir(), 'opencode-codex-tui-'));
process.env.XDG_DATA_HOME = dataHome;
const codexDir = path.join(dataHome, 'opencode', 'codex');
await fs.mkdir(codexDir, { recursive: true });
await fs.writeFile(
  path.join(codexDir, 'usage.json'),
  JSON.stringify({
    version: 1,
    accounts: {
      A: { fetchedAt: 1, planType: 'plus', windows: [{ windowMinutes: 300, usedPercent: 40, resetAtMs: Date.now() + 3_600_000 }] },
      B: { fetchedAt: 1, planType: 'pro', windows: [{ windowMinutes: 300, usedPercent: 10, resetAtMs: Date.now() + 3_600_000 }] },
    },
  }),
);

const { default: plugin } = await import('../dist/tui.js');
const priority = await import('../dist/accounts/priority.js');

const jwt = (email: string) => `h.${Buffer.from(JSON.stringify({ email })).toString('base64url')}.s`;
const credentials = [
  { id: 'A', integrationID: 'openai', label: 'OAuth', active: true, value: { type: 'oauth', methodID: 'chatgpt-browser', access: jwt('alpha@example.com'), metadata: { accountID: 'acct-A' } } },
  { id: 'B', integrationID: 'openai', label: 'OAuth', active: false, value: { type: 'oauth', methodID: 'chatgpt-browser', access: jwt('beta@example.com'), metadata: { accountID: 'acct-B' } } },
];

const color = RGBA.fromHex('#888888');
const scale = Object.fromEntries([100, 200, 300, 400, 500, 600, 700, 800, 900].map((step) => [step, color]));
const theme = {
  text: { base: color, muted: color },
  hue: { accent: scale, interactive: scale, neutral: scale },
  border: { base: color },
};

const claims: Array<Record<string, any>> = [];
const layers: any[] = [];
const listeners = new Map<string, () => void>();
const activated: string[] = [];
const toasts: any[] = [];
const dialog = { shown: undefined as undefined | (() => any), cleared: 0, size: undefined as unknown };

const context: any = {
  theme,
  ui: {
    slot: (claim: Record<string, any>) => {
      claims.push(claim);
      return () => undefined;
    },
    toast: { show: (toast: any) => toasts.push(toast) },
    dialog: {
      show: (render: () => any) => { dialog.shown = render; },
      set: (options: any) => { dialog.size = options.size; },
      clear: () => { dialog.cleared += 1; },
      alert: async () => undefined,
    },
  },
  keymap: { layer: (layer: () => any) => layers.push(layer()) },
  data: {
    on: (type: string, handler: () => void) => {
      listeners.set(type, handler);
      return () => listeners.delete(type);
    },
  },
  client: {
    credential: {
      list: async () => credentials.map((c) => ({ ...c })),
      activate: async ({ credentialID }: { credentialID: string }) => {
        activated.push(credentialID);
        for (const c of credentials) c.active = c.id === credentialID;
      },
    },
  },
};

assert.equal(plugin.id, 'opencode-codex');
const cleanup = await plugin.setup(context);
await new Promise((resolve) => setTimeout(resolve, 50));

// Slots: V2 paths replacing V1 sidebar_content and session_prompt_right.
const byTarget = (target: string) => claims.find((claim) => claim.append === target);
assert.ok(byTarget('sidebar.content'), 'sidebar.content claim');
assert.ok(byTarget('prompt.footer.status'), 'prompt.footer.status claim');
assert.ok(byTarget('app'), 'app claim for the command layer');
assert.ok(listeners.has('credential.switched'));
assert.ok(listeners.has('credential.updated'));

// /accounts command registered from the app slot.
assert.equal(byTarget('app')!.render(), null);
const command = layers[0].commands[0];
assert.equal(layers[0].mode, 'global');
assert.equal(command.slash.name, 'accounts');
assert.equal(command.palette, true);

// Sidebar renders active quota and the pooled quota.
{
  const { renderOnce, captureCharFrame, renderer } = await testRender(() => byTarget('sidebar.content')!.render({ sessionID: 's1' }), { width: 60, height: 12 });
  await renderOnce();
  const frame = captureCharFrame();
  assert.match(frame, /Quota/);
  assert.match(frame, /All Quota/);
  assert.match(frame, /5h · 60%/);
  renderer.destroy();
}

// Prompt status shows the active account and plan.
{
  const { renderOnce, captureCharFrame, renderer } = await testRender(() => byTarget('prompt.footer.status')!.render({ mode: 'normal', showDetails: false }), { width: 60, height: 2 });
  await renderOnce();
  assert.match(captureCharFrame(), /alpha@example\.com · Plus/);
  renderer.destroy();
}

// /accounts: Ctrl+Down reorders only; Down + Enter activates only.
await command.run();
assert.ok(dialog.shown, 'dialog shown');
assert.equal(dialog.size, 'large');
{
  const { renderOnce, captureCharFrame, mockInput, renderer } = await testRender(() => dialog.shown!(), { width: 80, height: 20 });
  await renderOnce();
  assert.match(captureCharFrame(), /1\. alpha@example\.com/);
  assert.match(captureCharFrame(), /2\. beta@example\.com/);

  mockInput.pressArrow('down', { ctrl: true });
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.deepEqual(await priority.order(['A', 'B']), ['B', 'A']);
  assert.deepEqual(activated, [], 'reordering never activates');
  await renderOnce();
  assert.match(captureCharFrame(), /1\. beta@example\.com/);

  // The cursor follows the moved account: Enter now activates A, not the first row.
  mockInput.pressEnter();
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.deepEqual(activated, ['A'], 'cursor stays on the moved account');
  renderer.destroy();
}
await command.run();
{
  const { renderOnce, captureCharFrame, mockInput, renderer } = await testRender(() => dialog.shown!(), { width: 80, height: 20 });
  await renderOnce();
  assert.match(captureCharFrame(), /1\. beta@example\.com/);
  // The active account (A, second row) is highlighted; move up to B and press Enter.
  mockInput.pressArrow('up');
  await renderOnce();
  mockInput.pressEnter();
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.deepEqual(activated, ['A', 'B']);
  assert.deepEqual(await priority.order(['A', 'B']), ['B', 'A'], 'activation never reorders');
  assert.equal(dialog.cleared, 2);
  renderer.destroy();
}

await cleanup();
await fs.rm(dataHome, { recursive: true, force: true });
console.log('tui fixture ok');
process.exit(0);
