import * as accounts from '../accounts/index.js';
import type { Account } from '../accounts/types.js';
import { refresh as refreshTokens } from '../oauth/index.js';
import { identify } from '../oauth/jwt.js';

const REFRESH_SKEW_MS = 60_000;

const inflight = new Map<string, Promise<Account>>();

function abortError(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException('Aborted', 'AbortError');
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw abortError(signal);
}

function abortable<T>(
  promise: Promise<T>,
  signal: AbortSignal | undefined,
): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(abortError(signal));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(abortError(signal));
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(resolve, reject).finally(() => {
      signal.removeEventListener('abort', onAbort);
    });
  });
}

export function isFresh(account: Account, now = Date.now()): boolean {
  return !!account.access && account.expires - REFRESH_SKEW_MS > now;
}

function validateIdentity(
  account: Account,
  identity: ReturnType<typeof identify>,
): void {
  if (
    account.subject &&
    identity.subject &&
    identity.subject !== account.subject
  ) {
    throw new Error('Refreshed token OAuth subject does not match the account');
  }
  if (
    account.accountId &&
    identity.accountId &&
    identity.accountId !== account.accountId
  ) {
    throw new Error('Refreshed token workspace does not match the account');
  }
}

function validateTokenAgreement(
  idIdentity: ReturnType<typeof identify>,
  accessIdentity: ReturnType<typeof identify>,
): void {
  if (
    idIdentity.subject &&
    accessIdentity.subject &&
    idIdentity.subject !== accessIdentity.subject
  ) {
    throw new Error('Refreshed token OAuth subjects contradict each other');
  }
  if (
    idIdentity.accountId &&
    accessIdentity.accountId &&
    idIdentity.accountId !== accessIdentity.accountId
  ) {
    throw new Error('Refreshed token workspace claims contradict each other');
  }
}

export async function ensure(
  account: Account,
  signal?: AbortSignal,
  now = Date.now(),
): Promise<Account> {
  if (isFresh(account, now)) return account;
  const existing = inflight.get(account.id);
  if (existing) return abortable(existing, signal);

  const refresh = (async () => {
    throwIfAborted(signal);
    const tokens = await refreshTokens(account.refresh, signal);
    const idIdentity = identify({
      id_token: tokens.id_token,
      access_token: '',
    });
    const accessIdentity = identify({ access_token: tokens.access_token });
    validateTokenAgreement(idIdentity, accessIdentity);
    validateIdentity(account, idIdentity);
    validateIdentity(account, accessIdentity);
    const expires = now + (tokens.expires_in ?? 3600) * 1000;
    const refreshToken = tokens.refresh_token ?? account.refresh;
    await accounts.updateTokens(account.id, {
      access: tokens.access_token,
      refresh: refreshToken,
      expires,
    });
    return {
      ...account,
      access: tokens.access_token,
      refresh: refreshToken,
      expires,
    };
  })().finally(() => inflight.delete(account.id));

  inflight.set(account.id, refresh);
  return abortable(refresh, signal);
}
