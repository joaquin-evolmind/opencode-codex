import { promises as fs } from 'node:fs';
import path from 'node:path';

/**
 * A small JSON document shared by the TUI and the server processes. Reads are
 * cached by a stat signature, so callers can re-read on every use cheaply and
 * still observe writes made by another process. Writes are atomic renames.
 */
export class JsonFile<T> {
  private cached: T | undefined;
  private signature: string | undefined;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly target: () => string,
    private readonly decode: (raw: unknown) => T | undefined,
    private readonly empty: () => T,
  ) {}

  file(): string {
    return this.target();
  }

  private async stamp(): Promise<string> {
    try {
      // ctime is excluded: a chmod would otherwise look like a content change.
      const stat = await fs.stat(this.target(), { bigint: true });
      return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}`;
    } catch {
      return 'missing';
    }
  }

  async read(): Promise<T> {
    const signature = await this.stamp();
    if (this.cached !== undefined && signature === this.signature) {
      return this.cached;
    }
    let value: T | undefined;
    try {
      value = this.decode(JSON.parse(await fs.readFile(this.target(), 'utf8')));
    } catch {
      value = undefined;
    }
    this.cached = value ?? this.empty();
    this.signature = signature;
    return this.cached;
  }

  /** Read-modify-write, serialized within this process. */
  update(change: (current: T) => T): Promise<T> {
    const run = this.queue.catch(() => undefined).then(async () => {
      const next = change(await this.read());
      await this.write(next);
      return next;
    });
    this.queue = run;
    return run;
  }

  private async write(value: T): Promise<void> {
    const target = this.target();
    await fs.mkdir(path.dirname(target), { recursive: true });
    const tmp = `${target}.${process.pid}.${Date.now()}.tmp`;
    try {
      await fs.writeFile(tmp, JSON.stringify(value, null, 2), { mode: 0o600 });
      await fs.rename(tmp, target);
    } finally {
      await fs.rm(tmp, { force: true }).catch(() => undefined);
    }
    this.cached = value;
    this.signature = await this.stamp();
  }
}
