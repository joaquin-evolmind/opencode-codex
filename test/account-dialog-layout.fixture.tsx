/** @jsxImportSource @opentui/solid */
import assert from 'node:assert/strict';
import { SelectRenderable } from '@opentui/core';
import { testRender } from '@opentui/solid';
import { AccountsDialog } from '../src/tui/dialog.js';

const store = {
  version: 1 as const,
  active: 'opaque-a',
  accounts: [
    {
      id: 'opaque-a',
      email: 'alpha@example.com',
      refresh: 'refresh-a',
      access: 'access-a',
      expires: 1,
      addedAt: 1,
    },
    {
      id: 'opaque-b',
      email: 'beta@example.com',
      refresh: 'refresh-b',
      access: 'access-b',
      expires: 1,
      addedAt: 1,
    },
    {
      id: 'opaque-c',
      email: 'gamma@example.com',
      refresh: 'refresh-c',
      access: 'access-c',
      expires: 1,
      addedAt: 1,
    },
  ],
};

const dialog = {
  clear() {},
  replace() {},
  setSize() {},
  size: 'large' as const,
  depth: 1,
  open: true,
};
const api = {
  ui: {
    dialog,
    Dialog: (props: { children?: unknown }) => <box>{props.children}</box>,
    toast() {},
  },
  theme: { current: { text: '#ffffff', textMuted: '#888888' } },
};

const rendered = await testRender(
  () => (
    <AccountsDialog
      api={api as never}
      store={store}
      order={['opaque-a', 'opaque-b', 'opaque-c']}
    />
  ),
  { width: 80, height: 16 },
);
await rendered.renderOnce();
const frame = rendered.captureCharFrame();
const select = rendered.renderer.root
  .getChildren()[0]
  ?.getChildren()[0]
  ?.getChildren()
  .find((child) => child instanceof SelectRenderable);
rendered.renderer.destroy();

assert.ok(select instanceof SelectRenderable);
assert.equal(select.options.length, 3);
assert.ok(select.height >= 6, `expected Select height >= 6, got ${select.height}`);
assert.match(frame, /1\. alpha@example\.com/);
assert.match(frame, /2\. beta@example\.com/);
assert.match(frame, /3\. gamma@example\.com/);
