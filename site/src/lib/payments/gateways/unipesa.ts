import { createHmac, timingSafeEqual } from 'node:crypto';
import type { UnipesaConfig } from '../config';
import { ProviderError, requestJson, type FetchLike } from '../http';
import type { CheckoutInput, Gateway, GatewayResult } from './types';

/**
 * Unipesa: a hosted payment page (hpp.unipesa.tech) for mobile money and cards in East and Central Africa.
 * Every request and callback is signed: HMAC-SHA512 over "key1value1key2value2…" in the order sent, lower-case hex.
 * Docs: https://docs.unipesa.tech/
 */

type Fields = Record<string, unknown>;

/** The string Unipesa signs. Nested objects are flattened the same way. */
export function unipesaSignatureString(fields: Fields, includeNestedKeys = true, depth = 0): string {
  if (depth > 16) return '';
  let out = '';
  for (const [k, v] of Object.entries(fields)) {
    if (k === 'signature' && depth === 0) continue;
    if (v !== null && typeof v === 'object') out += (includeNestedKeys ? k : '') + unipesaSignatureString(v as Fields, includeNestedKeys, depth + 1);
    else out += k + (v === null || v === undefined ? '' : String(v));
  }
  return out;
}

export function unipesaSign(fields: Fields, secret: string, includeNestedKeys = true): string {
  return createHmac('sha512', secret).update(unipesaSignatureString(fields, includeNestedKeys)).digest('hex').toLowerCase();
}

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a.toLowerCase());
  const y = Buffer.from(b.toLowerCase());
  return x.length === y.length && timingSafeEqual(x, y);
}

/** True when a callback was signed with our secret key. */
export function verifyUnipesa(fields: Fields, secret: string): boolean {
  const sig = fields['signature'];
  if (typeof sig !== 'string' || !/^[0-9a-f]{128}$/i.test(sig)) return false;
  // Unipesa's sample code flattens nested objects with their keys; accept the variant without them too.
  return safeEqual(unipesaSign(fields, secret, true), sig) || safeEqual(unipesaSign(fields, secret, false), sig);
}

/** Unipesa status codes: 0 initiated, 1 in progress, 2 success, 3 failed, 4 cancelled. */
export function mapUnipesa(fields: Fields): GatewayResult {
  const status = Number(fields['status']);
  const result = (fields['result'] ?? {}) as Fields;
  const provider = (fields['provider_result'] ?? {}) as Fields;
  const amount = fields['amount'] !== undefined ? Number(fields['amount']) : undefined;
  const base = {
    merchantRef: typeof fields['order_id'] === 'string' ? fields['order_id'] : undefined,
    amount: amount !== undefined && Number.isFinite(amount) ? amount : undefined,
    currency: typeof fields['currency'] === 'string' ? fields['currency'] : undefined,
    receipt: String(fields['transaction_ref'] ?? fields['transaction_id'] ?? '') || undefined,
  };
  if (status === 2) return { ...base, outcome: 'paid' };
  if (status === 3 || status === 4 || status === -1) {
    return { ...base, outcome: 'failed', reason: String(provider['message'] ?? result['message'] ?? 'The payment did not go through.') };
  }
  return { ...base, outcome: 'pending' };
}

export function createUnipesa(config: UnipesaConfig, fetchImpl: FetchLike = fetch): Gateway {
  return {
    id: 'unipesa',
    label: 'Unipesa',
    currency: 'KES',
    // Unipesa order ids allow letters, digits, "_", "-", ":" and ".", but its payment page wants letters and digits only.
    merchantRef: (ref, attempt) => `${ref.replace(/[^A-Za-z0-9]/g, '')}U${attempt}`,

    async startCheckout(input: CheckoutInput) {
      const fields: Record<string, string> = {
        merchant_id: config.merchantId,
        order_id: input.merchantRef,
        country: config.country,
        amount: input.amount.toFixed(2),
        currency: 'KES',
        ...(config.providerId ? { provider_id: config.providerId } : {}),
        operation: 'c2b',
        callback_url: config.notifyUrl,
        return_url: input.returnUrl,
        ...(input.email ? { email: input.email } : {}),
        name: input.name.slice(0, 60),
      };
      const signature = unipesaSign(fields, config.secretKey);
      const qs = new URLSearchParams({ ...fields, signature });
      return { redirectUrl: `${config.hppUrl}?${qs.toString()}`, providerRef: input.merchantRef };
    },

    async checkStatus(p) {
      if (!config.statusUrl) return undefined;
      const body: Record<string, string> = { merchant_id: config.merchantId, order_id: p.merchantRef };
      const url = config.statusUrl.replace('{merchant_id}', encodeURIComponent(config.merchantId));
      const res = await requestJson<Fields>('unipesa', fetchImpl, url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ ...body, signature: unipesaSign(body, config.secretKey) }),
      });
      if (typeof res['signature'] === 'string' && !verifyUnipesa(res, config.secretKey)) {
        throw new ProviderError('unipesa', 'Unipesa’s status reply had a wrong signature.');
      }
      return mapUnipesa(res);
    },

    readNotice({ body }) {
      if (String(body['merchant_id'] ?? '') !== config.merchantId) return null;
      if (!verifyUnipesa(body, config.secretKey)) return null;
      const result = mapUnipesa(body);
      return { merchantRef: result.merchantRef, txnId: typeof body['transaction_id'] === 'string' ? body['transaction_id'] : undefined, verified: result };
    },

    async ping() {
      if (!/^[\w-]{4,}$/.test(config.merchantId)) {
        throw new ProviderError('unipesa', 'The Unipesa merchant ID doesn’t look right.');
      }
      if (config.statusUrl) await this.checkStatus({ merchantRef: 'WZTESTCONNECTION', providerRef: '' });
    },
  };
}
