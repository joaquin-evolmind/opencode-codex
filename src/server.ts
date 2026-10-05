import type { Plugin } from '@opencode/plugin';
import * as priority from './accounts/priority.js';
import * as usageFile from './accounts/usage-file.js';
import type { Usage } from './accounts/types.js';
import { fetchUsage } from './codex/usage.js';
import { CHATGPT_METHOD_IDS, INTEGRATION_ID, PROVIDER_ID } from './config.js';
import { identify } from './identity.js';
import { Router, type CredentialValue, type RouterDeps } from './routing/router.js';

const USAGE_INTERVAL_MS = 5 * 60_000;
const USAGE_AFTER_EXECUTION_MS = 30_000;
const RESUBSCRIBE_MS = 1_000;
const SESSION_END = /^session\.(execution\.(succeeded|failed|interrupted)|deleted)$/;

type Context = Plugin.Context;

function sessionIDOf(event: unknown): string | undefined {
  const data = (event as { data?: { sessionID?: unknown } }).data;
  return typeof data?.sessionID === 'string' ? data.sessionID : undefined;
}

/** Bind the router to OpenCode's native credentials. */
export function routerDeps(ctx: Context, now: () => number = Date.now): RouterDeps {
  return {
    async connections() {
      const integration = await ctx.integration.get({ integrationID: INTEGRATION_ID });
      const ids = integration.data.connections.flatMap((connection) =>
        connection.type === 'credential' && connection.method === 'oauth' ? [connection.id] : [],
      );
      const active = await ctx.integration.connection.active(INTEGRATION_ID);
      return { ids, active: active?.type === 'credential' ? active.id : undefined };
    },
    order: (ids) => priority.order(ids),
    async resolve(id) {
      // Resolving never activates the credential; OpenCode refreshes it if needed.
      const value = await ctx.integration.connection.resolve({
        type: 'credential',
        id,
        label: '',
        method: 'oauth',
      });
      return value as CredentialValue | undefined;
    },
    now,
  };
}

/** Refresh the quota snapshot the TUI shows. Tokens come from OpenCode. */
export async function refreshUsage(
  deps: RouterDeps,
  only?: readonly string[],
  fetchImpl?: typeof fetch,
): Promise<void> {
  const { ids } = await deps.connections();
  const targets = only ? ids.filter((id) => only.includes(id)) : ids;
  const updates: Record<string, Usage> = {};
  await Promise.all(
    targets.map(async (id) => {
      const value = await deps.resolve(id).catch(() => undefined);
      if (value?.type !== 'oauth' || !CHATGPT_METHOD_IDS.has(value.methodID ?? '')) return;
      if (typeof value.access !== 'string') return;
      const fromMetadata = value.metadata?.accountID;
      const accountId =
        typeof fromMetadata === 'string' ? fromMetadata : identify(value.access).accountId;
      const usage = await fetchUsage({ access: value.access, accountId }, fetchImpl).catch(
        () => undefined,
      );
      if (usage) updates[id] = usage;
    }),
  );
  // An empty list may be transient; never wipe the snapshot because of it.
  if (ids.length > 0) await usageFile.record(updates, ids);
}

const plugin: Plugin.Plugin = {
  id: 'opencode-codex',
  async setup(ctx) {
    const deps = routerDeps(ctx);
    const router = new Router(deps);
    const stop = new AbortController();
    const scope = { providerID: PROVIDER_ID };
    const usageTimers = new Map<string, ReturnType<typeof setTimeout>>();
    // Fail open: on any lookup error leave the request to OpenCode's native routing.
    const routeSafely = (sessionID: string) => router.route(sessionID).catch(() => undefined);
    const refreshUsageOf = (ids?: readonly string[]): void =>
      void refreshUsage(deps, ids).catch(() => undefined);
    const refreshActive = async (): Promise<void> => {
      const { active } = await deps.connections();
      if (active) refreshUsageOf([active]);
    };

    const registrations = await Promise.all([
      ctx.session.hook(
        'experimental.ws.handshake',
        async (request) => {
          const route = await routeSafely(request.sessionID);
          if (route) Object.assign(request.headers, route.headers);
        },
        scope,
      ),
      ctx.session.hook(
        'http.request',
        async (request) => {
          const route = await routeSafely(request.sessionID);
          if (!route) return;
          for (const [name, value] of Object.entries(route.headers)) {
            request.request.headers.set(name, value);
          }
        },
        scope,
      ),
      ctx.session.hook(
        'retry',
        async (retry) => {
          const retryNow = await router.failed(retry.sessionID, retry.error).catch(() => false);
          if (retryNow) {
            retry.decision = { retry: true, delay: 0 };
          }
        },
        scope,
      ),
    ]);

    const scheduleUsage = (credentialID: string): void => {
      if (usageTimers.has(credentialID)) return;
      const timer = setTimeout(() => {
        usageTimers.delete(credentialID);
        refreshUsageOf([credentialID]);
      }, USAGE_AFTER_EXECUTION_MS);
      timer.unref?.();
      usageTimers.set(credentialID, timer);
    };

    // Per-session routing state lives for one execution. Resubscribe if the
    // stream ends before the plugin is disposed, so state is never left behind.
    void (async () => {
      while (!stop.signal.aborted) {
        try {
          for await (const event of ctx.event.subscribe({ signal: stop.signal })) {
            const type = (event as { type?: string }).type ?? '';
            if (!SESSION_END.test(type)) continue;
            const sessionID = sessionIDOf(event);
            if (!sessionID) continue;
            const used = router.current(sessionID);
            router.end(sessionID);
            if (used && type !== 'session.deleted') scheduleUsage(used);
          }
        } catch {
          // Fall through and resubscribe unless disposed.
        }
        if (!stop.signal.aborted) await new Promise((resolve) => setTimeout(resolve, RESUBSCRIBE_MS));
      }
    })();

    // Startup shows every account once; afterwards only accounts in use are
    // polled, so idle credentials are not refreshed just to display quota.
    refreshUsageOf();
    const interval = setInterval(() => void refreshActive().catch(() => undefined), USAGE_INTERVAL_MS);
    interval.unref?.();

    return async () => {
      stop.abort();
      clearInterval(interval);
      for (const timer of usageTimers.values()) clearTimeout(timer);
      usageTimers.clear();
      await Promise.all(registrations.map((registration) => registration.dispose()));
    };
  },
};

export default plugin;
