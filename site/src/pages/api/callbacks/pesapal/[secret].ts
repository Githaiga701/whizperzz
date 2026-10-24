import type { APIRoute } from 'astro';
import { parsePesapalIpn } from '@/lib/payments/pesapal';
import { handlePesapalIpn } from '@/lib/payments/service';
import { getPaymentDeps, json } from '@/lib/server/payments';

export const prerender = false;

async function respond(secret: string | undefined, fields: Record<string, unknown>): Promise<Response> {
  const deps = getPaymentDeps();
  if (!deps.config.pesapal || secret !== deps.config.pesapal.callbackSecret) return json(404, { error: 'not_found' });
  const ipn = parsePesapalIpn(fields);
  if (!ipn) return json(400, { status: 400, message: 'Missing OrderTrackingId or OrderMerchantReference' });
  const { body } = await handlePesapalIpn(deps, ipn);
  return json(200, body);
}

/** Pesapal's IPN. Registered as POST, but GET is accepted too in case it was registered that way. */
export const POST: APIRoute = async ({ params, request }) => {
  let fields: Record<string, unknown> = {};
  try {
    const parsed: unknown = await request.json();
    if (parsed && typeof parsed === 'object') fields = parsed as Record<string, unknown>;
  } catch {
    /* handled as missing fields */
  }
  return respond(params['secret'], fields);
};

export const GET: APIRoute = ({ params, url }) => respond(params['secret'], Object.fromEntries(url.searchParams));
