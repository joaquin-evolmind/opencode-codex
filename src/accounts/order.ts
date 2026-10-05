/**
 * Pure helpers for the fallback priority order: an ordered list of OpenCode
 * credential IDs. The order never decides which credential is active.
 */
export type MoveDirection = 'up' | 'down';

/** Keep known IDs in their stored order, drop unknown ones, append new ones. */
export function reconcile(
  order: readonly string[],
  ids: readonly string[],
): string[] {
  const known = new Set(ids);
  const seen = new Set<string>();
  const result: string[] = [];
  for (const id of order) {
    if (!known.has(id) || seen.has(id)) continue;
    seen.add(id);
    result.push(id);
  }
  for (const id of ids) {
    if (seen.has(id)) continue;
    seen.add(id);
    result.push(id);
  }
  return result;
}

export function moved(
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
