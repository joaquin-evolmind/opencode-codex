import * as accounts from '../accounts/index.js';
import * as selection from '../accounts/selection.js';
import type { Account, Store } from '../accounts/types.js';
import * as quota from '../quota/index.js';

export interface AccountRow {
  id: string;
  title: string;
  description?: string;
}

export type MoveDirection = 'up' | 'down';

export function orderedAccounts(
  store: Store,
  order: readonly string[],
): Account[] {
  const byID = new Map(store.accounts.map((account) => [account.id, account]));
  return order
    .map((id) => byID.get(id))
    .filter((account): account is Account => account !== undefined);
}

export function accountRows(
  store: Store,
  order: readonly string[],
  displayName: (account: Account) => string,
): AccountRow[] {
  return orderedAccounts(store, order).map((account, index) => {
    const status: string[] = [];
    const plan = quota.plan(account);
    if (plan) status.push(`(${plan})`);
    const window5h = account.usage?.windows.find((w) => w.windowMinutes <= 600);
    if (window5h) {
      const left = quota.left(window5h.usedPercent);
      if (left != null) status.push(`5h ${Math.round(left)}%`);
    }
    return {
      id: account.id,
      title: `${index + 1}. ${displayName(account)}`,
      description: status.join(' · ') || undefined,
    };
  });
}

export function movedOrder(
  order: readonly string[],
  id: string,
  direction: MoveDirection,
): string[] | undefined {
  const from = order.indexOf(id);
  const to = direction === 'up' ? from - 1 : from + 1;
  if (from < 0 || to < 0 || to >= order.length) return;
  const next = [...order];
  [next[from], next[to]] = [next[to]!, next[from]!];
  return next;
}

export async function persistMove(
  confirmedOrder: readonly string[],
  id: string,
  direction: MoveDirection,
  reorder: (ids: readonly string[]) => Promise<string[]>,
): Promise<string[]> {
  const next = movedOrder(confirmedOrder, id, direction);
  if (!next) return [...confirmedOrder];
  return reorder(next);
}

export interface ChooseResult {
  /** Set when routing uses the choice but OpenCode's auth mirror is stale. */
  mirrorError?: unknown;
}

/**
 * Persist an explicit /accounts choice so the request process routes through
 * it, then mirror it to OpenCode's canonical `openai` auth entry. Neither step
 * changes the persisted fallback priority. A failed selection rejects; a failed
 * mirror update is reported because routing already uses the new account.
 */
export async function chooseAccount(id: string): Promise<ChooseResult> {
  await selection.select(id);
  try {
    await accounts.activate(id);
  } catch (mirrorError) {
    return { mirrorError };
  }
  return {};
}
