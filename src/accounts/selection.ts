import * as selectors from './selectors.js';
import * as preferences from './preferences.js';
import * as state from './state.js';
import type { Account, Store } from './types.js';

const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of listeners) {
    try {
      listener();
    } catch {}
  }
}

/**
 * The explicit /accounts selection. It is persisted in preferences.json because
 * the TUI and the Codex request hook can run in separate processes.
 */
export function id(): string | undefined {
  return preferences.selected();
}

export async function select(accountID: string | undefined): Promise<void> {
  const before = id();
  await preferences.selectPrepared(
    accountID,
    state.prepareForPreferenceTransaction,
  );
  if (before !== accountID) notify();
}

export function active(store: Store): Account | undefined {
  const selectedID = id();
  if (selectedID) {
    const found = selectors.find(store, selectedID);
    if (found) return found;
  }
  return selectors.active(store);
}

export function pick(
  store: Store,
  options: selectors.PickOptions = {},
): Account | undefined {
  const now = options.now ?? Date.now();
  const exclude = options.exclude;
  const isEligible = (account: Account) =>
    (!exclude?.has(account.id) &&
      (!account.rateLimitUntilMs || account.rateLimitUntilMs <= now));
  const selectedID = id();
  const manual = selectedID ? selectors.find(store, selectedID) : undefined;
  if (manual && isEligible(manual)) return manual;
  const ordered = preferences
    .snapshot()
    .map((id) => selectors.find(store, id))
    .filter((account): account is Account => !!account);
  const fallback = ordered.find(isEligible);
  if (fallback) return fallback;
  if (manual && !exclude?.has(manual.id)) return manual;
  return ordered.find((account) => !exclude?.has(account.id));
}

export function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
