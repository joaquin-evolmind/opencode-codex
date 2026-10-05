import { displayName } from '../accounts/display.js';
import type { MoveDirection } from '../accounts/order.js';
import type { CodexAccount, Usage } from '../accounts/types.js';
import { CHATGPT_METHOD_IDS, INTEGRATION_ID } from '../config.js';
import { identify } from '../identity.js';

/** The subset of OpenCode's credential entry the TUI reads. */
export interface CredentialEntryLike {
  id: string;
  integrationID: string;
  label: string;
  active: boolean;
  value: { type: string; methodID?: string; access?: string; metadata?: Record<string, unknown> };
}

export interface AccountsViewDeps {
  /** OpenCode credentials (client.credential.list). */
  list(): Promise<CredentialEntryLike[]>;
  /** Make a credential OpenCode's active one (client.credential.activate). */
  activate(credentialID: string): Promise<void>;
  /** Fallback priority reconciled with the given credential IDs. */
  order(ids: readonly string[]): Promise<string[]>;
  /** Persist a priority move; returns the new order. */
  move(ids: readonly string[], id: string, direction: MoveDirection): Promise<string[]>;
  /** Latest quota snapshot by credential ID. */
  usage(): Promise<Record<string, Usage>>;
}

/** Keep only OpenCode's ChatGPT (Codex) credentials, without secrets, in priority order. */
export function toAccounts(
  entries: readonly CredentialEntryLike[],
  order: readonly string[],
  usage: Record<string, Usage>,
): CodexAccount[] {
  const byID = new Map<string, CodexAccount>();
  for (const entry of entries) {
    if (entry.integrationID !== INTEGRATION_ID) continue;
    if (entry.value.type !== 'oauth' || !CHATGPT_METHOD_IDS.has(entry.value.methodID ?? '')) continue;
    const claims = identify(entry.value.access);
    const fromMetadata = entry.value.metadata?.accountID;
    byID.set(entry.id, {
      id: entry.id,
      label: entry.label,
      active: entry.active,
      email: claims.email,
      accountId: typeof fromMetadata === 'string' ? fromMetadata : claims.accountId,
      usage: usage[entry.id],
    });
  }
  const ordered = order.flatMap((id) => (byID.has(id) ? [byID.get(id)!] : []));
  const listed = new Set(ordered.map((account) => account.id));
  return [...ordered, ...[...byID.values()].filter((account) => !listed.has(account.id))];
}

/** Display rows for /accounts: priority position, name and plan/quota summary. */
export function accountRows(accounts: readonly CodexAccount[]): Array<{
  id: string;
  title: string;
  description?: string;
}> {
  return accounts.map((account, index) => {
    const status: string[] = [];
    if (account.active) status.push('active');
    const plan = account.usage?.planType;
    if (plan) status.push(plan.toLowerCase().includes('pro') ? 'Pro' : plan.toLowerCase().includes('plus') ? 'Plus' : plan);
    const window5h = account.usage?.windows.find((w) => w.windowMinutes <= 600);
    if (window5h) status.push(`5h ${Math.round(Math.max(0, 100 - window5h.usedPercent))}%`);
    return {
      id: account.id,
      title: `${index + 1}. ${displayName(account)}`,
      description: status.join(' · ') || undefined,
    };
  });
}

/**
 * The TUI's view of Codex accounts. Activating and reordering are separate:
 * activate() never touches the priority, move() never changes the active one.
 */
export class AccountsView {
  private accounts: CodexAccount[] = [];
  private readonly listeners = new Set<() => void>();
  private pending: Promise<void> | undefined;
  private again = false;

  constructor(private readonly deps: AccountsViewDeps) {}

  snapshot(): readonly CodexAccount[] {
    return this.accounts;
  }

  active(): CodexAccount | undefined {
    return this.accounts.find((account) => account.active);
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * Reload credentials, priority and quota. A call made while a load is in
   * flight schedules one more load, so the result reflects any write that
   * happened after the in-flight load started.
   */
  refresh(): Promise<void> {
    if (this.pending) {
      this.again = true;
      return this.pending;
    }
    this.pending = (async () => {
      try {
        do {
          this.again = false;
          await this.load();
        } while (this.again);
      } finally {
        this.pending = undefined;
      }
    })();
    return this.pending;
  }

  private async load(): Promise<void> {
    const entries = await this.deps.list();
    const ids = entries.map((entry) => entry.id);
    const [order, usage] = await Promise.all([this.deps.order(ids), this.deps.usage()]);
    this.accounts = toAccounts(entries, order, usage);
    for (const listener of this.listeners) {
      try {
        listener();
      } catch {}
    }
  }

  /** Enter: make this credential OpenCode's active (manual) selection. */
  async activate(id: string): Promise<void> {
    await this.deps.activate(id);
    await this.refresh();
  }

  /** Ctrl+Up/Down: change only the fallback priority. Returns the new order. */
  async move(id: string, direction: MoveDirection): Promise<string[]> {
    const order = await this.deps.move(this.accounts.map((account) => account.id), id, direction);
    await this.refresh();
    return order;
  }
}
