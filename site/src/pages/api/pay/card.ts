import type { APIRoute } from 'astro';
import { startPesapal } from '@/lib/payments/service';
import { getPaymentDeps, handle, json, rateLimit, readJson } from '@/lib/server/payments';

export const prerender = false;

/** Opens a Pesapal checkout. Body: { ref, email?, phone? }. Returns { redirectUrl }. */
export const POST: APIRoute = ({ request, locals }) =>
  handle(async () => {
    rateLimit(`pay:${locals.ip}`, 20, 60_000);
    const body = await readJson(request);
    const result = await startPesapal(getPaymentDeps(), body['ref'], { email: body['email'], phone: body['phone'] });
    return json(200, result);
  });
