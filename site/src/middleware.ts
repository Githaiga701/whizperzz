import type { APIContext, MiddlewareNext } from 'astro';
import { defineMiddleware } from 'astro:middleware';
import { readSessionValue, SESSION_COOKIE } from '@/lib/admin/session';
import { passwordVersion } from '@/lib/admin/users';
import { sameOrigin } from '@/lib/admin/web';
import { getRuntime } from '@/lib/server/payments';
import { clientIp } from '@/lib/server/client-ip';
import { beginRequest, endRequest } from '@/lib/storage/docs';

const OPEN_ADMIN_PAGES = ['/admin/login', '/admin/setup'];

/**
 * Guards the admin area: works out who is logged in, sends everyone else to the login (or first-run setup) page,
 * refuses form posts from other websites, and keeps admin pages out of caches and search engines.
 */
export const onRequest = defineMiddleware(async (ctx, next) => {
  // Pages built ahead of time have no visitor, so there are no request headers to read.
  if (ctx.isPrerendered) {
    ctx.locals.ip = 'unknown';
    return next();
  }
  ctx.locals.ip = clientIp(ctx);
  // Photos read their own bytes and need none of the saved documents, so skip that Redis round trip.
  if (ctx.url.pathname.startsWith('/media/')) return next();
  // Load saved data for this request (Redis on Vercel) and make sure every change is saved before replying.
  await beginRequest();
  try {
    return withPublicCaching(ctx, await guard(ctx, next));
  } finally {
    await endRequest();
  }
});

/**
 * Public pages are the same for every visitor, so the CDN (Vercel's edge) keeps a copy for a minute and keeps
 * serving it while it fetches a fresh one in the background. Visitors get pages from the edge near them instead of
 * waiting for the server, and admin changes still show within about a minute. Browsers always check back
 * (max-age=0), so nobody is stuck on an old page. Admin, API, pay links, errors and anything that sets a
 * cookie are never cached.
 */
const PRIVATE_PREFIXES = ['/admin', '/api/', '/pay/'];
function withPublicCaching(ctx: APIContext, res: Response): Response {
  const path = ctx.url.pathname;
  if (!['GET', 'HEAD'].includes(ctx.request.method)) return res;
  if (PRIVATE_PREFIXES.some((p) => path === p.replace(/\/$/, '') || path.startsWith(p))) return res;
  if (res.status !== 200 || res.headers.has('Cache-Control') || res.headers.has('Set-Cookie')) return res;
  if (!(res.headers.get('Content-Type') ?? '').includes('text/html')) return res;
  const value = 'public, max-age=0, s-maxage=60, stale-while-revalidate=86400';
  try {
    res.headers.set('Cache-Control', value);
    return res;
  } catch {
    const copy = new Response(res.body, res);
    copy.headers.set('Cache-Control', value);
    return copy;
  }
}

async function guard(ctx: APIContext, next: MiddlewareNext): Promise<Response> {
  const path = ctx.url.pathname;
  const adminPage = path === '/admin' || path.startsWith('/admin/');
  const adminApi = path.startsWith('/api/admin/');
  if (!adminPage && !adminApi) return next();

  if (adminPage && !['GET', 'HEAD'].includes(ctx.request.method) && !sameOrigin(ctx.request)) {
    return new Response('This form must be sent from the Whizperz admin itself.', { status: 403 });
  }

  const rt = getRuntime();
  const session = readSessionValue(rt.sessionKey, ctx.cookies.get(SESSION_COOKIE)?.value);
  if (session) {
    const user = rt.users.get(session.username);
    if (user && passwordVersion(user) === session.passwordVersion) ctx.locals.admin = user.username;
  }

  if (adminPage && !ctx.locals.admin && !OPEN_ADMIN_PAGES.some((p) => path.startsWith(p))) {
    if (!rt.users.hasUsers()) return ctx.redirect('/admin/setup/');
    return ctx.redirect(`/admin/login/?next=${encodeURIComponent(path)}`);
  }

  const res = await next();
  const headers: Record<string, string> = {
    'Cache-Control': 'no-store',
    'X-Frame-Options': 'DENY',
    'X-Robots-Tag': 'noindex, nofollow',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'same-origin',
  };
  try {
    for (const [k, v] of Object.entries(headers)) res.headers.set(k, v);
    return res;
  } catch {
    // Some responses have locked headers; copy them into a new one.
    const copy = new Response(res.body, res);
    for (const [k, v] of Object.entries(headers)) copy.headers.set(k, v);
    return copy;
  }
}
