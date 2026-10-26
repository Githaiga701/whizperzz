import type { APIRoute } from 'astro';
import { bookPackage } from '@/lib/packages/booking';
import { getPackageStore } from '@/lib/server/packages';
import { getPaymentDeps, getRuntime, handle, json, rateLimit, readJson } from '@/lib/server/payments';

export const prerender = false;

/**
 * A guest books a journey from its page.
 * Body: { packageId, travelDate, adults, children, plan, method, name, email, phone }.
 * Returns { ref, next, warning? }. The price is worked out here, never taken from the browser.
 */
export const POST: APIRoute = ({ request, locals }) =>
  handle(async () => {
    rateLimit(`book:${locals.ip}`, 10, 60_000);
    const body = await readJson(request);
    const result = await bookPackage(getPaymentDeps(), getPackageStore(), getRuntime().booking, body);
    return json(201, result);
  });
