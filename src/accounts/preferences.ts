import { promises as fs } from 'node:fs';
import path from 'node:path';
import { dataDir } from '../paths.js';
import type { Store } from './types.js';

export interface Preferences {
  version: 1;
  accountOrder: string[];
  /** Account chosen explicitly in /accounts. Independent of accountOrder. */
  selectedAccount?: string;
}

let cached: Preferences | undefined;
let queue: Promise<void> = Promise.resolve();
let dirty = false;

interface TestHooks {
  beforePersist?: () => void | Promise<void>;
  beforeChmod?: () => void | Promise<void>;
  beforeTransaction?: (kind: string) => void | Promise<void>;
}

let testHooks: TestHooks = {};

function enqueue<T>(kind: string, operation: () => Promise<T>): Promise<T> {
  const current = queue.catch(() => undefined).then(async () => {
    await testHooks.beforeTransaction?.(kind);
    return operation();
  });
  queue = current.then(
    () => undefined,
    () => undefined,
  );
  return current;
}

export function file(): string {
  return path.join(dataDir(), 'preferences.json');
}

export function reconcile(order: readonly string[], store: Store): string[] {
  const existing = new Set(store.accounts.map((account) => account.id));
  const seen = new Set<string>();
  const result: string[] = [];
  for (const id of order) {
    if (!existing.has(id) || seen.has(id)) continue;
    seen.add(id);
    result.push(id);
  }
  for (const account of store.accounts) {
    if (seen.has(account.id)) continue;
    seen.add(account.id);
    result.push(account.id);
  }
  return result;
}

function migratedOrder(store: Store): string[] {
  const active = store.active && store.accounts.some((a) => a.id === store.active)
    ? store.active
    : undefined;
  return reconcile(active ? [active] : [], store);
}

async function readFile(): Promise<Preferences | undefined> {
  try {
    const parsed: unknown = JSON.parse(await fs.readFile(file(), 'utf8'));
    if (!parsed || typeof parsed !== 'object') return;
    const value = parsed as Partial<Preferences>;
    if (value.version !== 1 || !Array.isArray(value.accountOrder)) return;
    if (!value.accountOrder.every((id) => typeof id === 'string')) return;
    const selectedAccount =
      typeof value.selectedAccount === 'string' ? value.selectedAccount : undefined;
    return { version: 1, accountOrder: value.accountOrder, selectedAccount };
  } catch {
    return;
  }
}

/**
 * Keep every ID already in `order` (another process may know accounts this
 * process's store has not loaded yet) and append accounts the store adds.
 */
function mergeOrder(order: readonly string[], store: Store): string[] {
  const result = [...new Set(order)];
  const seen = new Set(result);
  for (const account of store.accounts) {
    if (!seen.has(account.id)) result.push(account.id);
  }
  return result;
}

/**
 * Another process may have changed the selection since this process last read
 * it. Order transactions keep the on-disk selection instead of a stale cache.
 * An ID unknown to this process's store is kept: pick() ignores it, and the
 * account may exist in credentials this process has not reloaded yet. Only the
 * accounts being removed stop being the selection.
 */
async function currentSelection(
  removed: ReadonlySet<string> | undefined,
): Promise<string | undefined> {
  const stored = await readFile();
  const selectedAccount = stored ? stored.selectedAccount : cached?.selectedAccount;
  return selectedAccount !== undefined && removed?.has(selectedAccount)
    ? undefined
    : selectedAccount;
}

type SelectionSource =
  | { kind: 'set'; id: string | undefined }
  | { kind: 'keep'; removed?: ReadonlySet<string> };

/** Write the file atomically and return the selection that was persisted. */
async function persist(
  accountOrder: readonly string[],
  source: SelectionSource,
): Promise<string | undefined> {
  await testHooks.beforePersist?.();
  const selectedAccount =
    source.kind === 'set' ? source.id : await currentSelection(source.removed);
  const target = file();
  await fs.mkdir(path.dirname(target), { recursive: true });
  const tmp = `${target}.${process.pid}.${Date.now()}.tmp`;
  try {
    await fs.writeFile(
      tmp,
      JSON.stringify({ version: 1, accountOrder, selectedAccount }, null, 2),
      { mode: 0o600 },
    );
    await fs.rename(tmp, target);
    await testHooks.beforeChmod?.();
    await fs.chmod(target, 0o600);
  } finally {
    await fs.rm(tmp, { force: true }).catch(() => undefined);
  }
  return selectedAccount;
}

function same(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((id, index) => id === b[index]);
}

export async function read(store: Store): Promise<string[]> {
  return enqueue('read', async () => {
    const stored = await readFile();
    const accountOrder = stored
      ? reconcile(stored.accountOrder, store)
      : migratedOrder(store);
    const selectedAccount = stored?.selectedAccount;
    try {
      if (!stored || !same(stored.accountOrder, accountOrder)) {
        await persist(accountOrder, { kind: 'set', id: selectedAccount });
      } else {
        await testHooks.beforeChmod?.();
        await fs.chmod(file(), 0o600);
      }
    } catch (error) {
      dirty = true;
      throw error;
    }
    cached = { version: 1, accountOrder, selectedAccount };
    dirty = false;
    return [...accountOrder];
  });
}

export function snapshot(): string[] {
  return [...(cached?.accountOrder ?? [])];
}

export function selected(): string | undefined {
  return cached?.selectedAccount;
}

export function replace(ids: readonly string[], store: Store): Promise<string[]> {
  return enqueue('replace', async () => {
    const accountOrder = reconcile(ids, store);
    let selectedAccount: string | undefined;
    try {
      selectedAccount = await persist(accountOrder, { kind: 'keep' });
    } catch (error) {
      dirty = true;
      throw error;
    }
    cached = { version: 1, accountOrder, selectedAccount };
    dirty = false;
    return [...accountOrder];
  });
}

export function replacePrepared(
  ids: readonly string[],
  prepareStore: () => Promise<Store>,
): Promise<string[]> {
  return enqueue('replacePrepared', async () => {
    const store = await prepareStore();
    const accountOrder = reconcile(ids, store);
    let selectedAccount: string | undefined;
    try {
      selectedAccount = await persist(accountOrder, { kind: 'keep' });
    } catch (error) {
      dirty = true;
      throw error;
    }
    cached = { version: 1, accountOrder, selectedAccount };
    dirty = false;
    return [...accountOrder];
  });
}

export function append(id: string, store: Store): Promise<string[]> {
  return enqueue('append', async () => {
    const accountOrder = reconcile([...(cached?.accountOrder ?? []), id], store);
    let selectedAccount: string | undefined;
    try {
      selectedAccount = await persist(accountOrder, { kind: 'keep' });
    } catch (error) {
      dirty = true;
      throw error;
    }
    cached = { version: 1, accountOrder, selectedAccount };
    dirty = false;
    return [...accountOrder];
  });
}

export function remove(id: string, store: Store): Promise<string[]> {
  return enqueue('remove', async () => {
    const accountOrder = reconcile(
      (cached?.accountOrder ?? []).filter((candidate) => candidate !== id),
      store,
    );
    let selectedAccount: string | undefined;
    try {
      selectedAccount = await persist(accountOrder, {
        kind: 'keep',
        removed: new Set([id]),
      });
    } catch (error) {
      dirty = true;
      throw error;
    }
    cached = { version: 1, accountOrder, selectedAccount };
    dirty = false;
    return [...accountOrder];
  });
}

/**
 * Apply account additions/removals from a credential write to the ON-DISK order,
 * so a reorder made by another process is not replaced by this process's cache.
 */
export function syncMembership(
  removed: readonly string[],
  added: readonly string[],
  store: Store,
): Promise<string[]> {
  return enqueue('syncMembership', async () => {
    const stored = await readFile();
    const gone = new Set(removed);
    const base = (stored?.accountOrder ?? cached?.accountOrder ?? []).filter(
      (id) => !gone.has(id),
    );
    const accountOrder = reconcile([...base, ...added], store);
    let selectedAccount: string | undefined;
    try {
      selectedAccount = await persist(accountOrder, { kind: 'keep', removed: gone });
    } catch (error) {
      dirty = true;
      throw error;
    }
    cached = { version: 1, accountOrder, selectedAccount };
    dirty = false;
    return [...accountOrder];
  });
}

/**
 * Persist the explicit /accounts selection (or clear it with undefined) without
 * touching the priority order. The on-disk order is kept so a reorder made by
 * another process is not overwritten by this process's cache.
 */
export function selectPrepared(
  id: string | undefined,
  prepareStore: () => Promise<Store>,
): Promise<string | undefined> {
  return enqueue('select', async () => {
    const store = await prepareStore();
    if (id !== undefined && !store.accounts.some((account) => account.id === id)) {
      throw new Error(`Unknown Codex account: ${id}`);
    }
    const stored = await readFile();
    const baseOrder = stored?.accountOrder ?? cached?.accountOrder;
    const accountOrder = baseOrder
      ? mergeOrder(baseOrder, store)
      : migratedOrder(store);
    try {
      await persist(accountOrder, { kind: 'set', id });
    } catch (error) {
      dirty = true;
      throw error;
    }
    cached = { version: 1, accountOrder, selectedAccount: id };
    dirty = false;
    return id;
  });
}

/** Test-only controls for deterministic persistence failure and sequencing tests. */
export const __testing = {
  setHooks(hooks: TestHooks): void {
    testHooks = hooks;
  },
  isDirty(): boolean {
    return dirty;
  },
  async reset(): Promise<void> {
    await queue;
    cached = undefined;
    dirty = false;
    testHooks = {};
  },
};
