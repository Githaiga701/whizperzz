import type { APIRoute } from 'astro';
import { getQuoteStatus } from '@/lib/payments/service';
import { getPaymentDeps, handle, json, rateLimit } from '@/lib/server/payments';

export const prerender = false;

/** The pay page polls this while a guest is paying. GET ?ref=WZ-XXXXXX */
export const GET: APIRoute = ({ url, locals }) =>
  handle(async () => {
    rateLimit(`status:${locals.ip}`, 120, 60_000);
    const view = await getQuoteStatus(getPaymentDeps(), url.searchParams.get('ref'));
    return json(200, { status: view.status, message: view.message, receipt: view.receipt ?? null });
  });
