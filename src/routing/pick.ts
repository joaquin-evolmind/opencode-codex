export interface PickInput {
  /** Credential IDs in fallback priority order. */
  order: readonly string[];
  /** OpenCode's active credential: the explicit manual selection. */
  active?: string;
  /** Credentials this execution must not use again (already failed). */
  excluded: ReadonlySet<string>;
  /** Quota cooldown deadline per credential, if any. */
  coolingUntil: (id: string) => number | undefined;
  now: number;
}

function eligible(input: PickInput): (id: string) => boolean {
  return (id) => !input.excluded.has(id) && !((input.coolingUntil(id) ?? 0) > input.now);
}

/**
 * Manual selection first while it is usable, then the first usable credential
 * by priority. When none is usable, return the manual selection (or the first
 * non-excluded one) so the caller surfaces the upstream error instead of a
 * phantom "no account".
 */
export function pick(input: PickInput): string | undefined {
  const usable = eligible(input);
  if (input.active && usable(input.active)) return input.active;
  const fallback = input.order.find(usable);
  if (fallback) return fallback;
  if (input.active && !input.excluded.has(input.active)) return input.active;
  return input.order.find((id) => !input.excluded.has(id));
}

/** Usable candidates in the order pick() would try them. */
export function usable(input: PickInput): string[] {
  const ok = eligible(input);
  const first = input.active && ok(input.active) ? [input.active] : [];
  return [...first, ...input.order.filter((id) => ok(id) && id !== input.active)];
}
