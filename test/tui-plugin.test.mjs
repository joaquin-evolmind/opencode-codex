import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import test from 'node:test';

test('TUI plugin: V2 slots, /accounts command, rendering and key handling', () => {
  const output = execFileSync(
    process.env.BUN_BIN ?? 'bun',
    ['--preload', '@opentui/solid/preload', 'test/tui-plugin.fixture.tsx'],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 120_000 },
  );
  assert.match(output, /tui fixture ok/);
});
