import { createHmac, timingSafeEqual } from 'node:crypto';
import { docsFor } from '@/lib/storage/docs';

export const SESSION_COOKIE = 'wz_admin';
export const SESSION_HOURS = 12;

/** The key that signs login cookies. Created once and kept with the saved data (data folder or Redis). */
export function loadSessionKey(dataDir: string): Buffer {
  return Buffer.from(docsFor(dataDir).sessionKeyHex(), 'hex');
}

function sign(key: Buffer, payload: string): string {
  return createHmac('sha256', key).update(payload).digest('base64url');
}

/** username + password version + expiry, signed. Nothing secret is inside, but it can't be forged or edited. */
export function createSessionValue(key: Buffer, username: string, passwordVersion: string, now = Date.now()): string {
  const payload = `${Buffer.from(username).toString('base64url')}.${passwordVersion}.${now + SESSION_HOURS * 3600_000}`;
  return `${payload}.${sign(key, payload)}`;
}

export interface SessionInfo {
  username: string;
  passwordVersion: string;
  expiresAt: number;
}

export function readSessionValue(key: Buffer, value: string | undefined, now = Date.now()): SessionInfo | undefined {
  if (!value) return undefined;
  const parts = value.split('.');
  if (parts.length !== 4) return undefined;
  const [user, pv, exp, mac] = parts as [string, string, string, string];
  const expected = Buffer.from(sign(key, `${user}.${pv}.${exp}`));
  const given = Buffer.from(mac);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return undefined;
  const expiresAt = Number(exp);
  if (!Number.isFinite(expiresAt) || expiresAt <= now) return undefined;
  return { username: Buffer.from(user, 'base64url').toString(), passwordVersion: pv, expiresAt };
}

/* ---------- Failed login tracking ---------- */

const failures = new Map<string, { count: number; until: number }>();
const MAX_FAILS = 5;
const LOCK_MS = 15 * 60_000;

/** Throws-free check used before verifying a password. Returns minutes left when locked. */
export function loginLockedFor(key: string, now = Date.now()): number {
  const f = failures.get(key);
  if (!f || f.count < MAX_FAILS) return 0;
  if (f.until <= now) {
    failures.delete(key);
    return 0;
  }
  return Math.ceil((f.until - now) / 60_000);
}

export function recordLoginFailure(key: string, now = Date.now()): void {
  const f = failures.get(key) ?? { count: 0, until: 0 };
  f.count++;
  f.until = now + LOCK_MS;
  failures.set(key, f);
}

export function clearLoginFailures(key: string): void {
  failures.delete(key);
}
