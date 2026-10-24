import type { APIRoute } from 'astro';
import { handleMpesaReversalResult } from '@/lib/payments/service';
import { getPaymentDeps, json, log } from '@/lib/server/payments';

export const prerender = false;

/** Safaricom posts reversal (refund) results to .../result, and timeouts to .../timeout. */
export const POST: APIRoute = async ({ params, request }) => {
  const deps = getPaymentDeps();
  const kind = params['kind'];
  if (!deps.config.mpesa || params['secret'] !== deps.config.mpesa.callbackSecret || (kind !== 'result' && kind !== 'timeout')) {
    return json(404, { error: 'not_found' });
  }
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json(400, { ResultCode: 1, ResultDesc: 'Invalid JSON' });
  }
  try {
    const outcome = await handleMpesaReversalResult(deps, body, kind);
    log('info', 'M-Pesa reversal result handled', { kind, outcome });
  } catch (err) {
    log('error', 'M-Pesa reversal result error', { error: (err as Error).message });
    return json(500, { ResultCode: 1, ResultDesc: 'Temporary error' });
  }
  return json(200, { ResultCode: 0, ResultDesc: 'Accepted' });
};
