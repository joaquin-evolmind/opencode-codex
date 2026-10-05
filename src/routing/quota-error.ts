/** The error shape OpenCode passes to the `retry` session hook. */
export interface SessionErrorLike {
  type?: string;
  status?: number;
  response?: { body?: string };
}

const DEFAULT_COOLDOWN_MS = 5 * 60_000;
const MAX_COOLDOWN_MS = 24 * 60 * 60_000;
const QUOTA_BODY = /usage_limit_reached|usage_limit_exceeded|insufficient_quota/;

/** True when the account behind the request ran out of quota. */
export function isQuotaError(error: SessionErrorLike | undefined): boolean {
  if (!error) return false;
  if (error.type === 'provider.quota') return true;
  if (error.status === 429 || error.status === 402) return true;
  return QUOTA_BODY.test(error.response?.body ?? '');
}

/** How long to avoid the credential, from the reset hint in the error body. */
export function cooldownMs(error: SessionErrorLike | undefined, now = Date.now()): number {
  let parsed: { error?: { resets_in_seconds?: unknown; resets_at?: unknown } } | undefined;
  try {
    parsed = JSON.parse(error?.response?.body ?? '');
  } catch {
    parsed = undefined;
  }
  const inSeconds = parsed?.error?.resets_in_seconds;
  if (typeof inSeconds === 'number' && inSeconds > 0) {
    return Math.min(inSeconds * 1000, MAX_COOLDOWN_MS);
  }
  const at = parsed?.error?.resets_at;
  if (typeof at === 'number' && at > 0) {
    const atMs = at > 1e12 ? at : at * 1000;
    if (atMs > now) return Math.min(atMs - now, MAX_COOLDOWN_MS);
  }
  return DEFAULT_COOLDOWN_MS;
}
