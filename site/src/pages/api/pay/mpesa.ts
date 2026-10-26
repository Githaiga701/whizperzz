import type { APIRoute } from 'astro';
import { startMpesa } from '@/lib/payments/service';
import { getPaymentDeps, handle, json, rateLimit, readJson } from '@/lib/server/payments';

export const prerender = false;

/** Sends an M-Pesa prompt to the guest's phone. Body: { ref, phone }. The amount always comes from the stored quote. */
export const POST: APIRoute = ({ request, locals }) =>
  handle(async () => {
    rateLimit(`pay:${locals.ip}`, 20, 60_000);
    const body = await readJson(request);
    const result = await startMpesa(getPaymentDeps(), body['ref'], body['phone']);
    return json(202, result);
  });
