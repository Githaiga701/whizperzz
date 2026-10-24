import type { APIRoute } from 'astro';
import { handleMpesaCallback } from '@/lib/payments/service';
import { getPaymentDeps, json, log } from '@/lib/server/payments';

export const prerender = false;

/** Safaricom posts the STK result here. The secret in the URL keeps strangers out. */
export const POST: APIRoute = async ({ params, request }) => {
  const deps = getPaymentDeps();
  if (!deps.config.mpesa || params['secret'] !== deps.config.mpesa.callbackSecret) {
    return json(404, { error: 'not_found' });
  }
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json(400, { ResultCode: 1, ResultDesc: 'Invalid JSON' });
  }
  try {
    const outcome = await handleMpesaCallback(deps, body);
    log('info', 'M-Pesa callback handled', { outcome });
  } catch (err) {
    log('error', 'M-Pesa callback error', { error: (err as Error).message });
    // Ask Safaricom to retry.
    return json(500, { ResultCode: 1, ResultDesc: 'Temporary error' });
  }
  return json(200, { ResultCode: 0, ResultDesc: 'Accepted' });
};
