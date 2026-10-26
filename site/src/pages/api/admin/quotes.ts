import type { APIRoute } from 'astro';
import { createQuote, payUrl } from '@/lib/payments/service';
import { getPaymentDeps, handle, json, rateLimit, readJson, requireAdmin } from '@/lib/server/payments';

export const prerender = false;

/** Lists quotes. Header: Authorization: Bearer <ADMIN_TOKEN> */
export const GET: APIRoute = ({ request, locals }) =>
  handle(async () => {
    rateLimit(`admin:${locals.ip}`, 30, 60_000);
    requireAdmin(request, locals);
    const deps = getPaymentDeps();
    return json(200, { quotes: await deps.store.list() });
  });

/** Creates a quote. Body: { guestName, description, amountKes, email?, phone? }. Returns the pay link to send the guest. */
export const POST: APIRoute = ({ request, locals }) =>
  handle(async () => {
    rateLimit(`admin:${locals.ip}`, 30, 60_000);
    const by = requireAdmin(request, locals);
    const deps = getPaymentDeps();
    const quote = await createQuote(deps, await readJson(request), by);
    return json(201, { quote, payUrl: payUrl(deps.config, quote.ref) });
  });
