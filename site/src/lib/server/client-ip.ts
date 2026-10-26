/**
 * The visitor's IP address, used for rate limits and login lockouts.
 *
 * On cPanel the site runs behind Apache + Passenger, which talks to the app over a local socket,
 * so the socket address is missing or always 127.0.0.1. There the real address comes from the
 * X-Forwarded-For header, using the LAST entry: the one our own proxy added (earlier entries
 * can be typed in by anyone).
 */
export function behindProxy(env: Record<string, string | undefined> = process.env): boolean {
  return Boolean(env['PASSENGER_APP_ENV'] || env['IN_PASSENGER'] || env['BEHIND_PROXY'] === '1');
}

export function clientIp(ctx: { request: Request; readonly clientAddress?: string }, env: Record<string, string | undefined> = process.env): string {
  let socket: string | undefined;
  try {
    socket = ctx.clientAddress;
  } catch {
    // Astro throws when the address isn't available (e.g. a Unix socket).
  }
  const forwarded = ctx.request.headers
    .get('x-forwarded-for')
    ?.split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const proxied = forwarded?.at(-1) ?? ctx.request.headers.get('x-real-ip')?.trim();
  if (behindProxy(env) && proxied) return proxied;
  return socket || proxied || 'unknown';
}
