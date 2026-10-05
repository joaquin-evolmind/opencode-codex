import path from 'node:path';
import { dataDir } from '../paths.js';
import { JsonFile } from './json-file.js';
import { moved, reconcile, type MoveDirection } from './order.js';

/**
 * Fallback priority: OpenCode credential IDs, first tried first. It holds no
 * tokens and never selects the active credential; OpenCode owns that.
 */
interface PriorityDocument {
  version: 2;
  order: string[];
}

const document = new JsonFile<PriorityDocument>(
  () => path.join(dataDir(), 'priority.json'),
  (raw) => {
    const value = raw as Partial<PriorityDocument> | null;
    if (!value || value.version !== 2 || !Array.isArray(value.order)) return;
    if (!value.order.every((id) => typeof id === 'string')) return;
    return { version: 2, order: value.order };
  },
  () => ({ version: 2, order: [] }),
);

export function file(): string {
  return document.file();
}

/** The stored order reconciled against the credentials that exist now. */
export async function order(ids: readonly string[]): Promise<string[]> {
  return reconcile((await document.read()).order, ids);
}

/** Swap one credential with its neighbour and persist. Returns the new order. */
export async function move(
  ids: readonly string[],
  id: string,
  direction: MoveDirection,
): Promise<string[]> {
  const next = await document.update((current) => {
    const base = reconcile(current.order, ids);
    return { version: 2, order: moved(base, id, direction) ?? base };
  });
  return reconcile(next.order, ids);
}
