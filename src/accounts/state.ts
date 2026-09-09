import { watchFile } from 'node:fs';
import * as storage from './storage.js';
import * as preferences from './preferences.js';
import type { Account, Store } from './types.js';

const WATCH_INTERVAL_MS = 1000;

let cached: Store | undefined;
let writeQueue: Promise<void> = Promise.resolve();
const listeners = new Set<(store: Store) => void>();
let lastWrittenMtimeMs: number | undefined;
let watcherStarted = false;
let watcherQueue: Promise<void> = Promise.resolve();

type RuntimeFields = Pick<Account, 'usage' | 'rateLimitUntilMs' | 'lastUsedAt'>;

const runtime = new Map<string, RuntimeFields>();

function clone(store: Store): Store {
  return structuredClone(store);
}

function applyRuntime(store: Store): Store {
  return {
    ...store,
    accounts: store.accounts.map((account) => ({
      ...account,
      ...runtime.get(account.id),
    })),
  };
}

function rememberRuntime(store: Store): void {
  const present = new Set<string>();
  for (const account of store.accounts) {
    present.add(account.id);
    runtime.set(account.id, {
      usage: account.usage,
      rateLimitUntilMs: account.rateLimitUntilMs,
      lastUsedAt: account.lastUsedAt,
    });
  }
  for (const id of runtime.keys()) {
    if (!present.has(id)) runtime.delete(id);
  }
}

function notify(store: Store): void {
  for (const listener of listeners) {
    try {
      listener(clone(store));
    } catch {}
  }
}

function startWatcher(): void {
  if (process.env.OPENCODE_CODEX_DISABLE_ACCOUNT_WATCHER === '1') return;
  if (watcherStarted) return;
  watcherStarted = true;
  const watcher = watchFile(
    storage.file(),
    { interval: WATCH_INTERVAL_MS },
    (curr) => {
      if (curr.mtimeMs === 0) return;
      void processWatchedMtime(curr.mtimeMs).catch(() => undefined);
    },
  );
  watcher.unref();
}

function processWatchedMtime(mtimeMs: number): Promise<void> {
  const operation = watcherQueue.catch(() => undefined).then(async () => {
    if (mtimeMs === lastWrittenMtimeMs) return;
    const fresh = applyRuntime(await storage.read());
    await preferences.read(fresh);
    cached = fresh;
    lastWrittenMtimeMs = mtimeMs;
    notify(fresh);
  });
  watcherQueue = operation.then(
    () => undefined,
    () => undefined,
  );
  return operation;
}

export async function load(): Promise<Store> {
  if (cached && preferences.__testing.isDirty()) {
    await preferences.read(cached);
  }
  if (!cached) {
    const fresh = applyRuntime(await storage.read());
    await preferences.read(fresh);
    cached = fresh;
  }
  startWatcher();
  return cached;
}

export async function prepareForPreferenceTransaction(): Promise<Store> {
  if (!cached) cached = applyRuntime(await storage.read());
  startWatcher();
  return cached;
}

export async function reload(): Promise<Store> {
  await writeQueue;
  await watcherQueue;
  const fresh = applyRuntime(await storage.read());
  await preferences.read(fresh);
  cached = fresh;
  startWatcher();
  return cached;
}

export function snapshot(): Store {
  return cached ? clone(cached) : storage.empty();
}

export async function mutate(
  fn: (store: Store) => void | Store,
): Promise<Store> {
  const write = writeQueue.catch(() => undefined).then(async () => {
    const current = await load();
    const next = clone(current);
    const before = new Set(current.accounts.map((account) => account.id));
    const result = fn(next);
    const final = result ?? next;
    const mtimeMs = await storage.write(final);
    rememberRuntime(final);
    cached = applyRuntime(final);
    const after = new Set(final.accounts.map((account) => account.id));
    let order = preferences.snapshot();
    for (const id of before) {
      if (!after.has(id)) order = order.filter((candidate) => candidate !== id);
    }
    for (const account of final.accounts) {
      if (!before.has(account.id)) order.push(account.id);
    }
    try {
      await preferences.replace(order, final);
      lastWrittenMtimeMs = mtimeMs ?? lastWrittenMtimeMs;
    } catch {
      // Credentials are authoritative. The dirty preference transaction retries
      // deterministically on the next load, reload, or preference operation.
    }
    notify(cached);
    return cached;
  });
  writeQueue = write.then(
    () => undefined,
    () => undefined,
  );
  return write;
}

/** Test-only control for deterministic watcher sequencing tests. */
export const __testing = { processWatchedMtime };

export async function mutateRuntime(
  fn: (store: Store) => void | Store,
): Promise<Store> {
  const current = await load();
  const next = clone(current);
  const result = fn(next);
  const final = result ?? next;
  rememberRuntime(final);
  cached = applyRuntime(final);
  notify(cached);
  return cached;
}

export function subscribe(listener: (store: Store) => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
