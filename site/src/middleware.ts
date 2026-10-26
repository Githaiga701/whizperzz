import { defineMiddleware } from 'astro:middleware';
import { readSessionValue, SESSION_COOKIE } from '@/lib/admin/session';
import { passwordVersion } from '@/lib/admin/users';
import { sameOrigin } from '@/lib/admin/web';
import { getRuntime } from '@/lib/server/payments';
import { clientIp } from '@/lib/server/client-ip';

const OPEN_ADMIN_PAGES = ['/admin/login', '/admin/setup'];

/**
 * Guards the admin area: works out who is logged in, sends everyone else to the login (or first-run setup) page,
 * refuses form posts from other websites, and keeps admin pages out of caches and search engines.
 */
export const onRequest = defineMiddleware(async (ctx, next) => {
  ctx.locals.ip = clientIp(ctx);
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
});
