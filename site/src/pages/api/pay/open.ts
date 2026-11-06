import type { APIRoute } from 'astro';
import { createOpenPayment } from '@/lib/payments/open-pay';
import { getPaymentDeps, getRuntime, handle, json, rateLimit, readJson } from '@/lib/server/payments';

export const prerender = false;

/**
 * The Make a payment page: the guest chooses the amount.
 * Body: { name, email, phone?, amount, currency: "KES" | "USD", note? }. Returns { ref, next, amountKes }.
 * Creates a quote within the limits set in Admin → Settings → Online booking; the guest then picks how to pay on its page.
 */
export const POST: APIRoute = ({ request, locals }) =>
  handle(async () => {
    // Each call creates a quote, so keep it low: a real guest makes one or two.
    rateLimit(`open-pay:${locals.ip}`, 5, 10 * 60_000);
    const body = await readJson(request);
    const result = await createOpenPayment(getPaymentDeps(), getRuntime().booking.openPay, body);
    return json(201, result);
  });
