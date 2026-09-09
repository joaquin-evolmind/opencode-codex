import type { Account, Store } from './types.js';

export function list(store: Store): Account[] {
  return store.accounts;
}

export function find(store: Store, id: string): Account | undefined {
  return store.accounts.find((account) => account.id === id);
}

export function active(store: Store): Account | undefined {
  if (store.active) {
    const found = find(store, store.active);
    if (found) return found;
  }
  return store.accounts[0];
}

export interface PickOptions {
  now?: number;
  exclude?: ReadonlySet<string>;
}
