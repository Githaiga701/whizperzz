import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { readJsonSync, writeJsonSync } from '@/lib/files';
import { getRedis } from './redis';

/**
 * Where the site keeps its small saved documents (users, settings, journeys, the login key) and uploaded photos.
 *
 * - Files in DATA_DIR (cPanel, your computer): read and written directly.
 * - Upstash Redis (Vercel): each request starts by loading the documents in one round trip (`beginRequest`),
 *   reads come from that copy, and writes are sent straight away and finished before the response goes out
 *   (`endRequest`, called by src/middleware.ts). Quotes are not kept here: they have their own records with
 *   locking (see src/lib/payments/store.ts), because payments must never overwrite each other.
 */
export interface DocStore {
  read<T>(name: DocName): T | undefined;
  write(name: DocName, value: unknown, opts?: { private?: boolean }): void;
  /** The login-signing key, created once. */
  sessionKeyHex(): string;
}

export const DOC_NAMES = ['users.json', 'settings.json', 'packages.json'] as const;
export type DocName = (typeof DOC_NAMES)[number];
const SESSION_KEY = 'session.key';

/* ---------- Files ---------- */

class FileDocs implements DocStore {
  private cache = new Map<string, unknown>();
  constructor(private readonly dir: string) {}

  read<T>(name: DocName): T | undefined {
    if (!this.cache.has(name)) this.cache.set(name, readJsonSync<T>(join(this.dir, name)));
    const v = this.cache.get(name);
    return v === undefined ? undefined : (structuredClone(v) as T);
  }

  write(name: DocName, value: unknown, opts: { private?: boolean } = {}): void {
    writeJsonSync(join(this.dir, name), value, opts);
    this.cache.set(name, structuredClone(value));
  }

  sessionKeyHex(): string {
    const file = join(this.dir, SESSION_KEY);
    try {
      const hex = readFileSync(file, 'utf8').trim();
      if (/^[0-9a-f]{64}$/.test(hex)) return hex;
    } catch {
      /* create below */
    }
    mkdirSync(this.dir, { recursive: true });
    const hex = randomBytes(32).toString('hex');
    writeFileSync(file, hex, { mode: 0o600 });
    return hex;
  }
}

/* ---------- Redis ---------- */

class RedisDocs implements DocStore {
  private copy = new Map<string, string | null>();
  /** Writes still on their way to Redis, by name; a refresh must not replace these with older values. */
  private sending = new Map<string, Promise<unknown>>();
  private errors: unknown[] = [];
  private key = '';
  private loaded = false;
  private lastSettings: string | null | undefined;

  constructor(private readonly onSettingsChanged: () => void) {}

  async refresh(): Promise<void> {
    const r = getRedis();
    if (!r) throw new Error('Redis is not configured');
    const names = [...DOC_NAMES, SESSION_KEY];
    const values = await r.redis.mget<(string | null)[]>(...names.map(r.key));
    names.forEach((n, i) => {
      if (!this.sending.has(n)) this.copy.set(n, values[i] ?? null);
    });
    let hex = this.copy.get(SESSION_KEY);
    if (!hex || !/^[0-9a-f]{64}$/.test(hex)) {
      // First run anywhere: make the key, but keep whichever copy of the site saved one first.
      await r.redis.set(r.key(SESSION_KEY), randomBytes(32).toString('hex'), { nx: true });
      hex = await r.redis.get<string>(r.key(SESSION_KEY));
      this.copy.set(SESSION_KEY, hex);
    }
    this.key = hex ?? '';
    const settings = this.copy.get('settings.json') ?? null;
    if (this.loaded && settings !== this.lastSettings) this.onSettingsChanged();
    this.lastSettings = settings;
    this.loaded = true;
  }

  /** Waits for this request's writes. Throws if any failed, so the admin sees an error instead of a lost change. */
  async flush(): Promise<void> {
    await Promise.allSettled([...this.sending.values()]);
    const errors = this.errors.splice(0);
    if (errors.length) throw errors[0];
  }

  read<T>(name: DocName): T | undefined {
    const raw = this.copy.get(name);
    return raw ? (JSON.parse(raw) as T) : undefined;
  }

  write(name: DocName, value: unknown): void {
    const raw = JSON.stringify(value);
    this.copy.set(name, raw);
    if (name === 'settings.json') this.lastSettings = raw;
    this.send(name, (r) => r.redis.set(r.key(name), raw));
  }

  sessionKeyHex(): string {
    if (!this.key) throw new Error('Saved data was not loaded for this request');
    return this.key;
  }

  saveMedia(name: string, bytes: Uint8Array): void {
    this.send(`media/${name}`, (r) => r.redis.set(r.key(`media/${name}`), Buffer.from(bytes).toString('base64')));
  }

  async readMedia(name: string): Promise<Buffer | undefined> {
    const r = getRedis();
    const b64 = await r?.redis.get<string>(r.key(`media/${name}`));
    return b64 ? Buffer.from(b64, 'base64') : undefined;
  }

  private send(name: string, op: (r: NonNullable<ReturnType<typeof getRedis>>) => Promise<unknown>): void {
    const r = getRedis();
    if (!r) throw new Error('Redis is not configured');
    const p = op(r)
      .catch((err: unknown) => {
        this.errors.push(err);
      })
      .finally(() => {
        if (this.sending.get(name) === p) this.sending.delete(name);
      });
    this.sending.set(name, p);
  }
}

/* ---------- Choosing ---------- */

let remote: RedisDocs | undefined;
const settingsListeners: (() => void)[] = [];

/** True when saved data lives in Redis (Vercel) rather than files. */
export function usingRedis(): boolean {
  return Boolean(getRedis());
}

function redisDocs(): RedisDocs {
  remote ??= new RedisDocs(() => settingsListeners.forEach((fn) => fn()));
  return remote;
}

/** The document store for this data folder (or the shared Redis one). */
export function docsFor(dataDir: string): DocStore {
  return usingRedis() ? redisDocs() : new FileDocs(dataDir);
}

/** Called when another copy of the site saved new settings, so this copy rebuilds its payment setup. */
export function onSettingsChanged(fn: () => void): void {
  settingsListeners.push(fn);
}

/** Uploaded photos in Redis (on files they stay in DATA_DIR/uploads; see src/lib/packages/uploads.ts). */
export function saveMediaToRedis(name: string, bytes: Uint8Array): void {
  redisDocs().saveMedia(name, bytes);
}

export function readMediaFromRedis(name: string): Promise<Buffer | undefined> {
  return redisDocs().readMedia(name);
}

/** Loads saved documents for this request (Redis only; files need nothing). */
export async function beginRequest(): Promise<void> {
  if (usingRedis()) await redisDocs().refresh();
}

/** Finishes this request's writes (Redis only). */
export async function endRequest(): Promise<void> {
  if (remote) await remote.flush();
}
