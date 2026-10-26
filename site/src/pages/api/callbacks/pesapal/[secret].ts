import type { APIRoute } from 'astro';
import { timingSafeEqual } from 'node:crypto';
import { ipAllowed } from '@/lib/payments/ip';
import { parsePesapalIpn } from '@/lib/payments/pesapal';
import { handlePesapalIpn } from '@/lib/payments/service';
import { getPaymentDeps, json, log, rateLimit } from '@/lib/server/payments';

export const prerender = false;

const MAX_BODY_BYTES = 16 * 1024;

function sameSecret(a: string | undefined, b: string): boolean {
  if (!a) return false;
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/**
 * Pesapal's IPN. It only says "this order changed"; the status is always fetched from Pesapal's API
 * (GetTransactionStatus) and checked against the booking before anything is marked paid.
 */
async function respond(secret: string | undefined, ip: string, fields: Record<string, unknown>): Promise<Response> {
  try {
    rateLimit(`callback:${ip}`, 120, 60_000);
  } catch {
    return json(429, { error: 'rate_limited' });
  }
  const deps = getPaymentDeps();
  if (!deps.config.pesapal || !sameSecret(secret, deps.config.pesapal.callbackSecret)) return json(404, { error: 'not_found' });
  if (!ipAllowed(ip, deps.config.pesapal.callbackIps)) {
    log('warn', 'Pesapal IPN from an address not on the allow-list', { ip });
    return json(403, { error: 'forbidden' });
  }
  const ipn = parsePesapalIpn(fields);
  if (!ipn) return json(400, { status: 400, message: 'Missing OrderTrackingId or OrderMerchantReference' });
  const { body } = await handlePesapalIpn(deps, ipn);
  return json(200, body);
}

/** Registered as POST; GET is accepted too in case it was registered that way in Pesapal's dashboard. */
export const POST: APIRoute = async ({ params, request, locals }) => {
  if (Number(request.headers.get('content-length') ?? 0) > MAX_BODY_BYTES) return json(413, { error: 'too_large' });
  const raw = await request.text();
  if (raw.length > MAX_BODY_BYTES) return json(413, { error: 'too_large' });
  let fields: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) fields = parsed as Record<string, unknown>;
  } catch {
    fields = Object.fromEntries(new URLSearchParams(raw));
  }
  return respond(params['secret'], locals.ip, fields);
};

export const GET: APIRoute = ({ params, url, locals }) => respond(params['secret'], locals.ip, Object.fromEntries(url.searchParams));
