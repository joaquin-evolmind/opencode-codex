import { promises as fs, watchFile } from 'node:fs';
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
let observedSignature: string | undefined;
let refreshing: Promise<Store> | undefined;

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

async function fileSignature(target: string): Promise<string> {
  try {
    // ctime is excluded on purpose: preferences.read() chmods the file on every
    // read, which would change ctime and force a reload on every request.
    const stat = await fs.stat(target, { bigint: true });
    return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}`;
  } catch {
    return 'missing';
  }
}

/** Identity of the shared files that feed the store: credentials + preferences. */
async function sharedSignature(): Promise<string> {
  const parts = await Promise.all([
    fileSignature(storage.file()),
    fileSignature(preferences.file()),
  ]);
  return parts.join('|');
}

/** Read the shared files, recording what was observed before reading them. */
async function readShared(): Promise<Store> {
  const signature = await sharedSignature();
  const fresh = applyRuntime(await storage.read());
  await preferences.read(fresh);
  observedSignature = signature;
  return fresh;
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
    const fresh = await readShared();
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
  if (!cached) cached = await readShared();
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
  cached = await readShared();
  startWatcher();
  return cached;
}

/**
 * Make the store current with changes written by another process (for example
 * an /accounts selection made in the TUI) before routing a request. Two stat
 * calls decide whether a full reload is needed, so idle requests stay cheap.
 */
export function refresh(): Promise<Store> {
  if (!cached) return load();
  // Concurrent requests share one check instead of reloading in parallel.
  refreshing ??= runRefresh().finally(() => {
    refreshing = undefined;
  });
  return refreshing;
}

function runRefresh(): Promise<Store> {
  // Run on the write queue so a reload never overwrites a newer mutate() result.
  const operation = writeQueue.catch(() => undefined).then(async () => {
    await watcherQueue;
    const unchanged =
      !preferences.__testing.isDirty() &&
      (await sharedSignature()) === observedSignature;
    if (!unchanged || !cached) cached = await readShared();
    startWatcher();
    return cached;
  });
  writeQueue = operation.then(
    () => undefined,
    () => undefined,
  );
  return operation;
}

/**
 * mutate() rewrites auth.json from the store it is given. Start from what is on
 * disk when another process changed it, or that process's accounts are lost.
 */
async function currentForWrite(): Promise<Store> {
  const current = await load();
  const signature = await sharedSignature();
  if (signature === observedSignature) return current;
  const fresh = applyRuntime(await storage.read());
  try {
    await preferences.read(fresh);
    observedSignature = signature;
  } catch {
    // Credentials are authoritative; the dirty preference read retries later.
  }
  cached = fresh;
  return fresh;
}

export function snapshot(): Store {
  return cached ? clone(cached) : storage.empty();
}

export async function mutate(
  fn: (store: Store) => void | Store,
): Promise<Store> {
  const write = writeQueue.catch(() => undefined).then(async () => {
    const current = await currentForWrite();
    const next = clone(current);
    const before = new Set(current.accounts.map((account) => account.id));
    const result = fn(next);
    const final = result ?? next;
    const mtimeMs = await storage.write(final);
    rememberRuntime(final);
    cached = applyRuntime(final);
    const after = new Set(final.accounts.map((account) => account.id));
    const removed = [...before].filter((id) => !after.has(id));
    const added = final.accounts
      .map((account) => account.id)
      .filter((id) => !before.has(id));
    try {
      await preferences.syncMembership(removed, added, final);
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
