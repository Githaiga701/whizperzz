import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/** Reads a JSON file, or returns undefined if it doesn't exist yet. */
export function readJsonSync<T>(file: string): T | undefined {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as T;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw err;
  }
}

/**
 * Writes JSON via a temp file and rename, so a crash never leaves half a file.
 * Private files are made readable by the owner only (where the OS supports it).
 */
export function writeJsonSync(file: string, data: unknown, opts: { private?: boolean } = {}): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2), { encoding: 'utf8', mode: opts.private ? 0o600 : 0o644 });
  renameSync(tmp, file);
  if (opts.private) {
    try {
      chmodSync(file, 0o600);
    } catch {
      /* Windows ignores this; the data folder should still be kept private. */
    }
  }
}
