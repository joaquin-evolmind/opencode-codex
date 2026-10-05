import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import test from 'node:test';

import {
  accountRows,
  movedOrder,
  orderedAccounts,
  persistMove,
} from '../dist/tui/account-priority.js';

const account = (id, email, planType, usedPercent) => ({
  id,
  email,
  refresh: `refresh-${id}`,
  access: `access-${id}`,
  expires: 1,
  addedAt: 1,
  usage: planType
    ? {
        fetchedAt: 1,
        planType,
        windows: [{ windowMinutes: 300, usedPercent, resetAtMs: 1 }],
      }
    : undefined,
});

const store = {
  version: 1,
  active: 'opaque-b',
  accounts: [
    account('opaque-a', 'a@example.com', 'pro', 10),
    account('opaque-b', 'b@example.com', 'plus', 20),
    account('opaque-c', 'c@example.com', 'team', 30),
  ],
};

test('account dialog allocates layout height to the account list', () => {
  execFileSync(
    'bun',
    [
      '--preload',
      '@opentui/solid/preload',
      'test/account-dialog-layout.fixture.tsx',
    ],
    { stdio: 'pipe' },
  );
});

test('displayed account order follows the persisted priority order', () => {
  const order = ['opaque-c', 'opaque-a', 'opaque-b'];
  assert.deepEqual(
    orderedAccounts(store, order).map((item) => item.id),
    order,
  );
});

test('moving an account produces the exact up and down reorder arrays', async () => {
  const calls = [];
  const reorder = async (ids) => {
    calls.push([...ids]);
    return [...ids];
  };
  await persistMove(
    ['opaque-a', 'opaque-b', 'opaque-c'],
    'opaque-b',
    'up',
    reorder,
  );
  await persistMove(
    ['opaque-a', 'opaque-b', 'opaque-c'],
    'opaque-b',
    'down',
    reorder,
  );
  assert.deepEqual(calls, [
    ['opaque-b', 'opaque-a', 'opaque-c'],
    ['opaque-a', 'opaque-c', 'opaque-b'],
  ]);
});

test('first cannot move up and last cannot move down', async () => {
  let calls = 0;
  const reorder = async () => {
    calls += 1;
    return [];
  };
  const order = ['opaque-a', 'opaque-b', 'opaque-c'];
  assert.deepEqual(await persistMove(order, 'opaque-a', 'up', reorder), order);
  assert.deepEqual(
    await persistMove(order, 'opaque-c', 'down', reorder),
    order,
  );
  assert.equal(calls, 0);
  assert.equal(movedOrder(order, 'missing', 'up'), undefined);
});

test('reorder rejection leaves the last confirmed UI order unchanged', async () => {
  const confirmed = ['opaque-a', 'opaque-b', 'opaque-c'];
  await assert.rejects(
    persistMove(confirmed, 'opaque-b', 'up', async () => {
      throw new Error('disk full');
    }),
    /disk full/,
  );
  assert.deepEqual(confirmed, ['opaque-a', 'opaque-b', 'opaque-c']);
});

test('metadata and quotas stay associated by opaque account ID', () => {
  const rows = accountRows(
    store,
    ['opaque-c', 'opaque-a', 'opaque-b'],
    (item) => item.email,
  );
  assert.deepEqual(rows, [
    {
      id: 'opaque-c',
      title: '1. c@example.com',
      description: '(team) · 5h 70%',
    },
    {
      id: 'opaque-a',
      title: '2. a@example.com',
      description: '(Pro) · 5h 90%',
    },
    {
      id: 'opaque-b',
      title: '3. b@example.com',
      description: '(Plus) · 5h 80%',
    },
  ]);
});

test('opaque IDs are hidden when readable identities exist', () => {
  const rows = accountRows(
    store,
    ['opaque-a', 'opaque-b', 'opaque-c'],
    (item) => item.email,
  );
  const visible = rows
    .map((row) => `${row.title} ${row.description}`)
    .join('\n');
  assert.doesNotMatch(visible, /opaque-/);
});
