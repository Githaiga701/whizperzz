import type { APIRoute } from 'astro';
import { isGatewayId } from '@/lib/payments/gateways';
import { PaymentError, startGateway } from '@/lib/payments/service';
import { getPaymentDeps, handle, json, rateLimit, readJson } from '@/lib/server/payments';

export const prerender = false;

/** Opens Paystack, iPOS Pay, Unipesa or crypto checkout. Body: { ref, method: "paystack" | "ipos" | "unipesa" | "crypto", email?, phone? }. Returns { redirectUrl }. */
export const POST: APIRoute = ({ request, locals }) =>
  handle(async () => {
    rateLimit(`pay:${locals.ip}`, 20, 60_000);
    const body = await readJson(request);
    if (!isGatewayId(body['method'])) throw new PaymentError(400, 'invalid_method', 'Choose how you’d like to pay.');
    const result = await startGateway(getPaymentDeps(), body['method'], body['ref'], { email: body['email'], phone: body['phone'] });
    return json(200, result);
  });
