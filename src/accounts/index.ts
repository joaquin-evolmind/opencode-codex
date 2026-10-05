import * as selectors from './selectors.js';
import * as state from './state.js';
import * as storage from './storage.js';
import * as preferences from './preferences.js';
import * as selection from './selection.js';
import type { Account, Store, Usage } from './types.js';

export async function load(): Promise<Store> {
  return state.load();
}

export async function reload(): Promise<Store> {
  return state.reload();
}

/** Pick up changes another process persisted since this process last read. */
export async function refresh(): Promise<Store> {
  return state.refresh();
}

export function snapshot(): Store {
  return state.snapshot();
}

export function list(store?: Store): Account[] {
  return selectors.list(store ?? snapshot());
}

export function find(id: string, store?: Store): Account | undefined {
  return selectors.find(store ?? snapshot(), id);
}

export function active(store?: Store): Account | undefined {
  return selectors.active(store ?? snapshot());
}

export function displayName(account: Account): string {
  if (account.label) return account.label;
  if (account.email) return account.email;
  if (account.accountId) return `Codex account …${account.accountId.slice(-8)}`;
  return 'Codex account';
}

/**
 * Pick the account to send the next request through. Active-first with
 * rate-limit fallback. Returns the active even if it's rate-limited when no
 * other eligible account exists, so the caller surfaces the upstream error
 * rather than a phantom "no account".
 */
export function pick(
  options: selectors.PickOptions | number = Date.now(),
): Account | undefined {
  const normalized = typeof options === 'number' ? { now: options } : options;
  return selection.pick(snapshot(), normalized);
}

export function order(): string[] {
  return preferences.snapshot();
}

export function reorder(ids: readonly string[]): Promise<string[]> {
  return preferences.replacePrepared(ids, state.prepareForPreferenceTransaction);
}

export function preferencesFile(): string {
  return preferences.file();
}

export async function save(
  account: Account,
  options: { activate?: boolean } = {},
): Promise<Store> {
  return state.mutate((s) => {
    const idx = s.accounts.findIndex((a) => a.id === account.id);
    if (idx >= 0) {
      const existing = s.accounts[idx]!;
      s.accounts[idx] = {
        ...existing,
        ...account,
        label: account.label ?? existing.label,
        email: account.email ?? existing.email,
        addedAt: existing.addedAt,
        usage: existing.usage,
      };
    } else {
      s.accounts.push(account);
    }
    if (options.activate || !s.active) s.active = account.id;
  });
}

export async function remove(id: string): Promise<Store> {
  return state.mutate((s) => {
    s.accounts = s.accounts.filter((a) => a.id !== id);
    if (s.active === id) s.active = s.accounts[0]?.id;
  });
}

export async function activate(id: string): Promise<Store> {
  return state.mutate((s) => {
    if (s.accounts.some((a) => a.id === id)) s.active = id;
  });
}

export async function rateLimit(id: string, untilMs: number): Promise<Store> {
  return state.mutateRuntime((s) => {
    const account = s.accounts.find((a) => a.id === id);
    if (account) account.rateLimitUntilMs = untilMs;
  });
}

export async function clearRateLimit(id: string): Promise<Store> {
  return state.mutateRuntime((s) => {
    const account = s.accounts.find((a) => a.id === id);
    if (account) account.rateLimitUntilMs = undefined;
  });
}

export async function touch(id: string): Promise<void> {
  await state.mutateRuntime((s) => {
    const account = s.accounts.find((a) => a.id === id);
    if (account) account.lastUsedAt = Date.now();
  });
}

export async function updateTokens(
  id: string,
  tokens: { access: string; refresh: string; expires: number; email?: string },
): Promise<Store> {
  return state.mutate((s) => {
    const account = s.accounts.find((a) => a.id === id);
    if (account) {
      account.access = tokens.access;
      account.refresh = tokens.refresh;
      account.expires = tokens.expires;
      account.email = tokens.email ?? account.email;
    }
  });
}

export async function updateUsage(id: string, usage: Usage): Promise<Store> {
  return state.mutateRuntime((s) => {
    const account = s.accounts.find((a) => a.id === id);
    if (account) account.usage = usage;
  });
}

export function subscribe(listener: (store: Store) => void): () => void {
  return state.subscribe(listener);
}

export function file(): string {
  return storage.file();
}

export type { Account, Store, Usage, UsageWindow } from './types.js';
