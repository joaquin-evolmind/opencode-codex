import type { CodexAccount } from './types.js';

const GENERIC_LABELS = new Set(['oauth', 'api key', '']);

export function displayName(account: Pick<CodexAccount, 'label' | 'email' | 'accountId'>): string {
  if (!GENERIC_LABELS.has(account.label.trim().toLowerCase())) return account.label;
  if (account.email) return account.email;
  if (account.accountId) return `Codex account …${account.accountId.slice(-8)}`;
  return 'Codex account';
}
