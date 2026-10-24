import type { APIRoute } from 'astro';
import { timingSafeEqual } from 'node:crypto';
import type { GatewayId } from '@/lib/payments/gateways';
import { handleGatewayNotice } from '@/lib/payments/service';
import { getPaymentDeps, json, log, rateLimit } from './payments';

function sameSecret(a: string | undefined, b: string | undefined): boolean {
  if (!a || !b) return false;
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

async function readBody(request: Request): Promise<{ raw: string; body: Record<string, unknown> }> {
  const raw = await request.text();
  if (!raw) return { raw, body: {} };
  try {
    const parsed: unknown = JSON.parse(raw);
    return { raw, body: parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {} };
  } catch {
    // Some gateways post form fields instead of JSON.
    return { raw, body: Object.fromEntries(new URLSearchParams(raw)) };
  }
}

/**
 * The notify address for iPOS Pay, Unipesa or NOWPayments: /api/callbacks/<gateway>/<secret>.
 * The secret in the address keeps strangers out; the payment itself is still confirmed with the gateway.
 */
export function gatewayCallback(id: GatewayId): { POST: APIRoute; GET: APIRoute } {
  const run: APIRoute = async ({ params, request, url, clientAddress }) => {
    try {
      rateLimit(`callback:${clientAddress}`, 120, 60_000);
    } catch {
      return json(429, { error: 'rate_limited' });
    }
    const deps = getPaymentDeps();
    const cfg = id === 'ipos' ? deps.config.ipos : id === 'unipesa' ? deps.config.unipesa : deps.config.crypto;
    if (!cfg || !sameSecret(params['secret'], cfg.callbackSecret)) return json(404, { error: 'not_found' });
    const { raw, body } = request.method === 'GET' ? { raw: '', body: Object.fromEntries(url.searchParams) as Record<string, unknown> } : await readBody(request);
    try {
      const outcome = await handleGatewayNotice(deps, id, { headers: request.headers, body, raw });
      log('info', `${id} callback handled`, { outcome });
      // Always 200 once it's ours, so the gateway stops retrying; bad signatures are logged and ignored.
      return json(200, { status: 'ok' });
    } catch (err) {
      log('error', `${id} callback failed`, { error: (err as Error).message });
      // 500 asks the gateway to try again later.
      return json(500, { status: 'error' });
    }
  };
  return { POST: run, GET: run };
}
