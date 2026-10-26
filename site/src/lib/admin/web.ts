import { behindProxy } from '@/lib/server/client-ip';
import type { AstroCookies } from 'astro';
import { createSessionValue, SESSION_COOKIE, SESSION_HOURS } from './session';
import { passwordVersion, type AdminUser } from './users';

/* ---------- Flash messages (shown once after a form is submitted) ---------- */

export interface Flash {
  kind: 'ok' | 'error';
  text: string;
}

const FLASH_COOKIE = 'wz_flash';

export function setFlash(cookies: AstroCookies, kind: Flash['kind'], text: string): void {
  cookies.set(FLASH_COOKIE, Buffer.from(JSON.stringify({ kind, text: text.slice(0, 400) })).toString('base64url'), {
    path: '/admin',
    httpOnly: true,
    sameSite: 'lax',
    maxAge: 60,
  });
}

export function takeFlash(cookies: AstroCookies): Flash | undefined {
  const raw = cookies.get(FLASH_COOKIE)?.value;
  if (!raw) return undefined;
  cookies.delete(FLASH_COOKIE, { path: '/admin' });
  try {
    const f = JSON.parse(Buffer.from(raw, 'base64url').toString()) as Flash;
    return (f.kind === 'ok' || f.kind === 'error') && typeof f.text === 'string' ? f : undefined;
  } catch {
    return undefined;
  }
}

/* ---------- Requests ---------- */

/** True when the browser is talking to us over https (directly or through a proxy). */
export function isHttps(request: Request, url: URL): boolean {
  return url.protocol === 'https:' || request.headers.get('x-forwarded-proto')?.split(',')[0]?.trim() === 'https';
}

/** Blocks other websites from submitting forms to the admin (CSRF). */
export function sameOrigin(request: Request): boolean {
  const source = request.headers.get('origin') ?? request.headers.get('referer');
  if (!source || source === 'null') return false;
  let sourceHost: string;
  try {
    sourceHost = new URL(source).host;
  } catch {
    return false;
  }
  const host = request.headers.get('x-forwarded-host')?.split(',')[0]?.trim() || request.headers.get('host');
  return Boolean(host) && sourceHost === host;
}

/** A request coming straight from this computer, not through a proxy. */
export function isLocalRequest(request: Request, clientAddress: string): boolean {
  // Behind cPanel's proxy every request comes from 127.0.0.1, so "local" can't be trusted there.
  if (behindProxy()) return false;
  if (request.headers.get('x-forwarded-for') || request.headers.get('forwarded')) return false;
  return ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(clientAddress);
}

export function startSession(cookies: AstroCookies, key: Buffer, user: AdminUser, secure: boolean): void {
  cookies.set(SESSION_COOKIE, createSessionValue(key, user.username, passwordVersion(user)), {
    path: '/',
    httpOnly: true,
    sameSite: 'lax',
    secure,
    maxAge: SESSION_HOURS * 3600,
  });
}

export function endSession(cookies: AstroCookies): void {
  cookies.delete(SESSION_COOKIE, { path: '/' });
}

/** Only allow redirects back into the admin after login. */
export function safeNext(next: string | null): string {
  return next && /^\/admin(\/[\w\-./]*)?$/.test(next) && !next.includes('..') ? next : '/admin/';
}

export function str(form: FormData, key: string): string {
  const v = form.get(key);
  return typeof v === 'string' ? v : '';
}

export function formObject(form: FormData, keys: readonly string[]): Record<string, string> {
  return Object.fromEntries(keys.map((k) => [k, str(form, k)]));
}
