import { promises as fs } from 'node:fs';
import path from 'node:path';
import { dataDir } from '../paths.js';
import type { Store } from './types.js';

export interface Preferences {
  version: 1;
  accountOrder: string[];
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
    return { version: 1, accountOrder: value.accountOrder };
  } catch {
    return;
  }
}

async function persist(accountOrder: readonly string[]): Promise<void> {
  await testHooks.beforePersist?.();
  const target = file();
  await fs.mkdir(path.dirname(target), { recursive: true });
  const tmp = `${target}.${process.pid}.${Date.now()}.tmp`;
  try {
    await fs.writeFile(
      tmp,
      JSON.stringify({ version: 1, accountOrder }, null, 2),
      { mode: 0o600 },
    );
    await fs.rename(tmp, target);
    await testHooks.beforeChmod?.();
    await fs.chmod(target, 0o600);
  } finally {
    await fs.rm(tmp, { force: true }).catch(() => undefined);
  }
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
    try {
      if (!stored || !same(stored.accountOrder, accountOrder)) {
        await persist(accountOrder);
      } else {
        await testHooks.beforeChmod?.();
        await fs.chmod(file(), 0o600);
      }
    } catch (error) {
      dirty = true;
      throw error;
    }
    cached = { version: 1, accountOrder };
    dirty = false;
    return [...accountOrder];
  });
}

export function snapshot(): string[] {
  return [...(cached?.accountOrder ?? [])];
}

export function replace(ids: readonly string[], store: Store): Promise<string[]> {
  return enqueue('replace', async () => {
    const accountOrder = reconcile(ids, store);
    try {
      await persist(accountOrder);
    } catch (error) {
      dirty = true;
      throw error;
    }
    cached = { version: 1, accountOrder };
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
    try {
      await persist(accountOrder);
    } catch (error) {
      dirty = true;
      throw error;
    }
    cached = { version: 1, accountOrder };
    dirty = false;
    return [...accountOrder];
  });
}

export function append(id: string, store: Store): Promise<string[]> {
  return enqueue('append', async () => {
    const accountOrder = reconcile([...(cached?.accountOrder ?? []), id], store);
    try {
      await persist(accountOrder);
    } catch (error) {
      dirty = true;
      throw error;
    }
    cached = { version: 1, accountOrder };
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
    try {
      await persist(accountOrder);
    } catch (error) {
      dirty = true;
      throw error;
    }
    cached = { version: 1, accountOrder };
    dirty = false;
    return [...accountOrder];
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
