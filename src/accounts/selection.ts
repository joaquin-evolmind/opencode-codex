import * as selectors from './selectors.js';
import * as preferences from './preferences.js';
import type { Account, Store } from './types.js';

let selectedID: string | undefined;
const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of listeners) {
    try {
      listener();
    } catch {}
  }
}

export function id(): string | undefined {
  return selectedID;
}

export function select(accountID: string | undefined): void {
  if (selectedID === accountID) return;
  selectedID = accountID;
  notify();
}

export function active(store: Store): Account | undefined {
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
