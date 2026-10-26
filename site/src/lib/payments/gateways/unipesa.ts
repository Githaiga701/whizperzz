import { createHmac, timingSafeEqual } from 'node:crypto';
import type { UnipesaConfig } from '../config';
import { ProviderError, requestJson, type FetchLike } from '../http';
import type { CheckoutInput, Gateway, GatewayResult } from './types';
import { ipAllowed } from '../ip';

export { ipAllowed };

/**
 * Unipesa (https://docs.unipesa.tech/): mobile money and cards in Kenya, the DRC and Burundi.
 *
 * How the site uses it:
 * 1. The guest is sent to Unipesa's hosted payment page (HPP) with a signed link. The amount and
 *    order id are inside the signature, so the guest can't change them.
 * 2. Unipesa POSTs a signed result (callback) to our secret notify address. We accept it only if:
 *    the signature is valid for our secret key, it names our merchant id, it is about a payment we
 *    started, the amount matches, and (optionally) it came from one of Unipesa's IP addresses.
 * 3. If Unipesa gave us their status address, we also ask Unipesa directly before marking anything
 *    paid, and the pay page keeps asking while the guest waits.
 *
 * Signing (from Unipesa's docs): HMAC-SHA512 with the secret key over "key1value1key2value2…",
 * in the order the fields are sent, without the signature field, as lower-case hex.
 */

type Fields = Record<string, unknown>;

/** Unipesa status codes. */
export const UNIPESA_STATUS = { undefined: -1, initiated: 0, inProgress: 1, success: 2, failed: 3, cancelled: 4, partlyCancelled: 5, inTransit: 6 } as const;

/** Provider ids from Unipesa's docs (the ones that matter here). 14 is their simulator. */
export const UNIPESA_PROVIDERS: Record<string, string> = {
  '12': 'Safaricom M-Pesa (Kenya)',
  '29': 'Safaricom M-Pesa (Kenya)',
  '16': 'Airtel Money (Kenya)',
  '30': 'Airtel Money (Kenya)',
  '9': 'Vodacom M-Pesa (DRC)',
  '10': 'Orange Money (DRC)',
  '17': 'Airtel Money (DRC)',
  '19': 'Africell (DRC)',
  '11': 'Ecocash (Burundi)',
  '28': 'Lumicash (Burundi)',
  '5002': 'Equity Visa card (DRC)',
  '14': 'Unipesa simulator (testing)',
};

/** A value as PHP turns it into text when concatenating (Unipesa's reference code is PHP). */
function phpString(v: unknown): string {
  if (v === null || v === undefined || v === false) return '';
  if (v === true) return '1';
  return String(v);
}

/** The string Unipesa signs. Nested objects are flattened the same way, up to 16 levels. */
export function unipesaSignatureString(fields: Fields, includeNestedKeys = true, depth = 0): string {
  if (depth > 16) return '';
  let out = '';
  for (const [k, v] of Object.entries(fields)) {
    if (k === 'signature' && depth === 0) continue;
    if (v !== null && typeof v === 'object') out += (includeNestedKeys ? k : '') + unipesaSignatureString(v as Fields, includeNestedKeys, depth + 1);
    else out += k + phpString(v);
  }
  return out;
}

export function unipesaSign(fields: Fields, secret: string, includeNestedKeys = true): string {
  return createHmac('sha512', secret).update(unipesaSignatureString(fields, includeNestedKeys), 'utf8').digest('hex');
}

function safeEqualHex(a: string, b: string): boolean {
  const x = Buffer.from(a.toLowerCase());
  const y = Buffer.from(b.toLowerCase());
  return x.length === y.length && timingSafeEqual(x, y);
}

/**
 * Parses a JSON body twice: as normal values, and with every number kept exactly as written
 * ("100.00" stays "100.00"), because the sender signed the text it sent, not our reading of it.
 */
export function parseJsonKeepingNumbers(raw: string): { values: Fields; asWritten: Fields } | null {
  try {
    const values = JSON.parse(raw) as unknown;
    if (!values || typeof values !== 'object' || Array.isArray(values)) return null;
    const asWritten = JSON.parse(raw, function (this: unknown, _key: string, value: unknown, context?: { source?: string }) {
      return typeof value === 'number' && context?.source ? context.source : value;
    }) as Fields;
    return { values: values as Fields, asWritten };
  } catch {
    return null;
  }
}

/**
 * True when a callback was signed with our secret key. Unipesa's docs leave a few details open
 * (how numbers and nested objects are written), so the readings their reference code could produce
 * are all accepted. Every one of them still needs the secret key.
 */
export function verifyUnipesa(fields: Fields, secret: string, asWritten?: Fields): boolean {
  const sig = fields['signature'];
  if (typeof sig !== 'string' || !/^[0-9a-f]{128}$/i.test(sig)) return false;
  const candidates = asWritten ? [asWritten, fields] : [fields];
  for (const c of candidates) {
    if (safeEqualHex(unipesaSign(c, secret, true), sig) || safeEqualHex(unipesaSign(c, secret, false), sig)) return true;
  }
  return false;
}

/** Turns a Unipesa result (callback or status reply) into ours. */
export function mapUnipesa(fields: Fields): GatewayResult {
  const status = Number(fields['status']);
  const result = (fields['result'] ?? {}) as Fields;
  const provider = (fields['provider_result'] ?? {}) as Fields;
  const amount = fields['amount'] !== undefined && fields['amount'] !== '' ? Number(fields['amount']) : undefined;
  const providerName = UNIPESA_PROVIDERS[String(fields['provider_id'] ?? '')];
  const base = {
    merchantRef: typeof fields['order_id'] === 'string' ? fields['order_id'] : undefined,
    amount: amount !== undefined && Number.isFinite(amount) ? amount : undefined,
    currency: typeof fields['currency'] === 'string' ? fields['currency'].toUpperCase() : undefined,
    receipt: String(fields['transaction_ref'] || fields['transaction_id'] || '') || undefined,
    method: providerName?.replace(/ \(.*\)$/, ''),
  };
  if (status === UNIPESA_STATUS.success) return { ...base, outcome: 'paid' };
  if (status === UNIPESA_STATUS.failed || status === UNIPESA_STATUS.cancelled || status === UNIPESA_STATUS.undefined) {
    const why = String(provider['message'] || result['message'] || '');
    return { ...base, outcome: 'failed', reason: why && !/^success/i.test(why) ? why : 'The payment did not go through. Please try again.' };
  }
  // 0 initiated, 1 in progress, 5/6 (POS only) or anything new: keep waiting.
  return { ...base, outcome: 'pending' };
}

/** Fills {merchant_id} and {public_id} in an address Unipesa gave us. */
export function unipesaUrl(template: string, config: Pick<UnipesaConfig, 'merchantId' | 'publicId'>): string {
  return template.replaceAll('{merchant_id}', encodeURIComponent(config.merchantId)).replaceAll('{public_id}', encodeURIComponent(config.publicId ?? config.merchantId));
}

export function createUnipesa(config: UnipesaConfig, fetchImpl: FetchLike = fetch): Gateway {
  return {
    id: 'unipesa',
    label: 'Unipesa',
    currency: 'KES',
    // Unipesa's payment page accepts letters and digits only in order ids. Unique per attempt (idempotent on their side).
    merchantRef: (ref, attempt) => `${ref.replace(/[^A-Za-z0-9]/g, '')}U${attempt}`,

    async startCheckout(input: CheckoutInput) {
      if (!(input.amount > 0)) throw new ProviderError('unipesa', 'Unipesa amounts must be more than zero.');
      // Field order matters: it is the order the signature is made in.
      const fields: Record<string, string> = {
        merchant_id: config.merchantId,
        order_id: input.merchantRef,
        country: config.country,
        amount: input.amount.toFixed(2),
        currency: config.currency,
        ...(config.providerId ? { provider_id: config.providerId } : {}),
        operation: 'c2b',
        ...(config.payType ? { type: config.payType } : {}),
        callback_url: config.notifyUrl,
        return_url: input.returnUrl,
        email: input.email ?? '',
        name: input.name.slice(0, 60),
      };
      const signature = unipesaSign(fields, config.secretKey);
      const qs = new URLSearchParams({ ...fields, signature });
      return { redirectUrl: `${config.hppUrl}?${qs.toString()}`, providerRef: input.merchantRef };
    },

    async checkStatus(p) {
      if (!config.statusUrl) return undefined;
      const body: Record<string, string> = { merchant_id: config.merchantId, order_id: p.merchantRef };
      const res = await requestJson<Fields>('unipesa', fetchImpl, unipesaUrl(config.statusUrl, config), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ ...body, signature: unipesaSign(body, config.secretKey) }),
      });
      // A signed reply must verify. (Status replies over https from the address we chose are trusted either way.)
      if (typeof res['signature'] === 'string' && !verifyUnipesa(res, config.secretKey)) {
        throw new ProviderError('unipesa', 'Unipesa’s status reply had a wrong signature, so it was ignored.');
      }
      if (res['order_id'] !== undefined && res['order_id'] !== p.merchantRef) {
        throw new ProviderError('unipesa', 'Unipesa’s status reply was about a different order.');
      }
      return mapUnipesa(res);
    },

    readNotice({ body, raw, ip }) {
      if (!ipAllowed(ip, config.callbackIps)) return null;
      if (String(body['merchant_id'] ?? '') !== config.merchantId) return null;
      const parsed = raw.trim().startsWith('{') ? parseJsonKeepingNumbers(raw) : null;
      if (!verifyUnipesa(body, config.secretKey, parsed?.asWritten)) return null;
      // Only customer-to-merchant payments (17) or results without a type are payments to us.
      const op = body['operation_type'];
      if (op !== undefined && op !== '' && Number(op) !== 17) return null;
      const result = mapUnipesa(body);
      return {
        merchantRef: result.merchantRef,
        txnId: body['transaction_id'] !== undefined ? String(body['transaction_id']) : undefined,
        verified: result,
      };
    },

    async ping() {
      if (!/^[\w-]{4,}$/.test(config.merchantId)) throw new ProviderError('unipesa', 'The Unipesa merchant ID doesn’t look right.');
      if (config.secretKey.length < 8) throw new ProviderError('unipesa', 'The Unipesa secret key looks too short.');
      // With a status address, ask about an order that doesn't exist: any signed answer proves the keys work.
      if (config.statusUrl) {
        try {
          await this.checkStatus({ merchantRef: 'WZCONNECTIONTEST', providerRef: '' });
        } catch (err) {
          if (err instanceof ProviderError && err.status !== undefined && err.status < 500 && err.status !== 401 && err.status !== 403) return;
          throw err;
        }
      }
    },
  };
}
