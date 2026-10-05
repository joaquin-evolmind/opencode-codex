import { CHATGPT_METHOD_IDS } from '../config.js';
import { identify } from '../identity.js';
import { pick, usable } from './pick.js';
import { cooldownMs, isQuotaError, type SessionErrorLike } from './quota-error.js';

/** The subset of an OpenCode credential value the router needs. */
export interface CredentialValue {
  type: string;
  methodID?: string;
  access?: string;
  metadata?: Record<string, unknown>;
}

export interface RouterDeps {
  /** OpenAI credential IDs and the active one, as OpenCode reports them now. */
  connections(): Promise<{ ids: string[]; active?: string }>;
  /** Fallback priority order reconciled with `ids`. */
  order(ids: readonly string[]): Promise<string[]>;
  /** Resolve a credential by ID without activating it; OpenCode refreshes it. */
  resolve(id: string): Promise<CredentialValue | undefined>;
  now(): number;
}

export interface Route {
  credentialID: string;
  headers: Record<string, string>;
}

interface SessionRoute {
  /** Credential the session's current request was routed through. */
  current?: string;
  /** Credentials that failed during this execution. */
  excluded: Set<string>;
}

type CodexCredential = CredentialValue & { access: string };

/** A credential that cannot be resolved (revoked, removed, failed refresh) is skipped. */
async function safely<T>(load: () => Promise<T>): Promise<T | undefined> {
  try {
    return await load();
  } catch {
    return undefined;
  }
}

function isCodex(value: CredentialValue | undefined): value is CodexCredential {
  return (
    value?.type === 'oauth' &&
    typeof value.methodID === 'string' &&
    CHATGPT_METHOD_IDS.has(value.methodID) &&
    typeof value.access === 'string' &&
    value.access.length > 0
  );
}

function headersFor(value: CodexCredential): Record<string, string> {
  const fromMetadata = value.metadata?.accountID;
  const accountId =
    typeof fromMetadata === 'string' ? fromMetadata : identify(value.access).accountId;
  return {
    authorization: `Bearer ${value.access}`,
    ...(accountId ? { 'chatgpt-account-id': accountId } : {}),
  };
}

/**
 * Chooses the ChatGPT credential for each request. The manual selection is
 * OpenCode's active credential and is never changed here: fallback only
 * overrides one request's headers. State is per session (one execution at a
 * time) plus a shared, monotonic quota cooldown per credential.
 */
export class Router {
  private readonly sessions = new Map<string, SessionRoute>();
  private readonly cooldowns = new Map<string, number>();

  constructor(private readonly deps: RouterDeps) {}

  private session(sessionID: string): SessionRoute {
    let route = this.sessions.get(sessionID);
    if (!route) {
      route = { excluded: new Set() };
      this.sessions.set(sessionID, route);
    }
    return route;
  }

  private coolingUntil = (id: string): number | undefined => this.cooldowns.get(id);

  /** Headers for this session's next request, or undefined to leave it alone. */
  async route(sessionID: string): Promise<Route | undefined> {
    const state = this.session(sessionID);
    state.current = undefined;
    const { ids, active } = await this.deps.connections();
    if (!active) return undefined;
    const activeValue = await this.deps.resolve(active);
    // Only act while OpenCode routes OpenAI through ChatGPT (Codex) OAuth.
    if (!isCodex(activeValue)) return undefined;
    const order = await this.deps.order(ids);
    const skipped = new Set(state.excluded);
    for (let i = 0; i <= order.length; i++) {
      const id = pick({ order, active, excluded: skipped, coolingUntil: this.coolingUntil, now: this.deps.now() });
      if (!id) return undefined;
      const value = id === active ? activeValue : await safely(() => this.deps.resolve(id));
      if (!isCodex(value)) {
        skipped.add(id);
        continue;
      }
      state.current = id;
      return { credentialID: id, headers: headersFor(value) };
    }
    return undefined;
  }

  /**
   * React to a failed request. Returns true when the request should be retried
   * now through another credential; false keeps OpenCode's own decision.
   */
  async failed(sessionID: string, error: SessionErrorLike | undefined): Promise<boolean> {
    if (!isQuotaError(error)) return false;
    const state = this.sessions.get(sessionID);
    const used = state?.current;
    if (!state || !used) return false;
    const now = this.deps.now();
    this.cooldowns.set(used, now + cooldownMs(error, now));
    state.excluded.add(used);
    const { ids, active } = await this.deps.connections();
    const order = await this.deps.order(ids);
    for (const id of usable({ order, active, excluded: state.excluded, coolingUntil: this.coolingUntil, now })) {
      if (isCodex(await safely(() => this.deps.resolve(id)))) return true;
      state.excluded.add(id);
    }
    return false;
  }

  /** Credential the session's latest request was routed through, if any. */
  current(sessionID: string): string | undefined {
    return this.sessions.get(sessionID)?.current;
  }

  /** Forget a session's execution state (execution ended or session deleted). */
  end(sessionID: string): void {
    this.sessions.delete(sessionID);
  }

  /** Test and diagnostics helpers. */
  sessionCount(): number {
    return this.sessions.size;
  }

  coolingDown(id: string): boolean {
    return (this.cooldowns.get(id) ?? 0) > this.deps.now();
  }
}
