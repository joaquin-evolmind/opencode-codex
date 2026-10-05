import path from 'node:path';
import { dataDir } from '../paths.js';
import { JsonFile } from './json-file.js';
import type { Usage } from './types.js';

/** Quota snapshot written by the server and read by the TUI. No tokens. */
interface UsageDocument {
  version: 1;
  accounts: Record<string, Usage>;
}

const document = new JsonFile<UsageDocument>(
  () => path.join(dataDir(), 'usage.json'),
  (raw) => {
    const value = raw as Partial<UsageDocument> | null;
    if (!value || value.version !== 1 || typeof value.accounts !== 'object' || !value.accounts) return;
    return { version: 1, accounts: value.accounts };
  },
  () => ({ version: 1, accounts: {} }),
);

export function file(): string {
  return document.file();
}

export async function read(): Promise<Record<string, Usage>> {
  return (await document.read()).accounts;
}

/** Record usage for some credentials and forget credentials that no longer exist. */
export async function record(
  updates: Record<string, Usage>,
  existing: readonly string[],
): Promise<void> {
  const keep = new Set(existing);
  await document.update((current) => {
    const accounts: Record<string, Usage> = {};
    for (const [id, usage] of Object.entries({ ...current.accounts, ...updates })) {
      if (keep.has(id)) accounts[id] = usage;
    }
    return { version: 1, accounts };
  });
}
