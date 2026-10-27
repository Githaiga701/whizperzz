import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { PAYSTACK_API_URL, type PaystackConfig } from '../config';
import { ProviderError, requestJson, type FetchLike } from '../http';
import { ipAllowed } from '../ip';
import type { CheckoutInput, Gateway, GatewayResult } from './types';

/**
 * Paystack (owned by Stripe; works for businesses registered in Kenya): cards, M-Pesa, Pesalink
 * and Apple Pay on Paystack's own checkout page, charged and settled in Kenyan shillings.
 *
 * How the site uses it:
 * 1. Our server asks Paystack for a checkout link (POST /transaction/initialize) with the amount
 *    taken from the quote, so the guest can't change it.
 * 2. The guest pays on Paystack's page and comes back to our pay page.
 * 3. A payment is only marked paid after our server asks Paystack directly
 *    (GET /transaction/verify/:reference) and the reference, currency and amount all match.
 * 4. Paystack's webhook (charge.success) makes this happen even if the guest closes the tab.
 *    Webhooks are believed only with a valid x-paystack-signature: HMAC-SHA512 of the raw body,
 *    made with our secret key. Optionally they must also come from Paystack's IP addresses.
 * Docs: https://paystack.com/docs/payments/accept-payments/ and https://paystack.com/docs/payments/webhooks/
 */

/** Paystack's published webhook addresses (same for test and live). */
export const PAYSTACK_WEBHOOK_IPS = ['52.31.139.75', '52.49.173.169', '52.214.14.220'] as const;

interface Envelope<T> {
  status?: boolean;
  message?: string;
  data?: T;
}

interface InitData {
  authorization_url?: string;
  access_code?: string;
  reference?: string;
}

export interface PaystackTransaction {
  id?: number | string;
  status?: string;
  reference?: string;
  /** In the smallest unit (cents). */
  amount?: number;
  currency?: string;
  gateway_response?: string;
  channel?: string;
  paid_at?: string | null;
  authorization?: { card_type?: string; last4?: string; brand?: string; channel?: string; mobile_money_number?: string } | null;
}

/** Paystack references: letters, digits, "-", "." and "=" only. */
export function paystackReference(quoteRef: string, attempt: number, suffix = randomBytes(3).toString('hex')): string {
  return `${quoteRef}-PS${attempt}-${suffix}`.replace(/[^A-Za-z0-9.=-]/g, '').slice(0, 100);
}

export function paystackSignature(raw: string, secretKey: string): string {
  return createHmac('sha512', secretKey).update(raw, 'utf8').digest('hex');
}

export function verifyPaystack(raw: string, header: string | null, secretKey: string): boolean {
  if (!header || !/^[0-9a-f]{128}$/i.test(header)) return false;
  const a = Buffer.from(paystackSignature(raw, secretKey));
  const b = Buffer.from(header.toLowerCase());
  return a.length === b.length && timingSafeEqual(a, b);
}

function methodLabel(t: PaystackTransaction): string | undefined {
  const a = t.authorization;
  const channel = (a?.channel ?? t.channel ?? '').toLowerCase();
  if (channel === 'card' && a) {
    const brand = (a.brand ?? a.card_type ?? 'Card').trim().toUpperCase();
    return a.last4 ? `${brand} ••${a.last4}` : brand;
  }
  if (channel === 'mobile_money') return 'M-Pesa';
  if (channel === 'bank_transfer' || channel === 'bank') return 'Bank transfer';
  if (channel === 'apple_pay') return 'Apple Pay';
  return channel ? channel.replace(/_/g, ' ') : undefined;
}

/** success = paid. failed / reversed = didn't happen. abandoned, ongoing, pending… = not finished yet. */
export function mapPaystack(t: PaystackTransaction): GatewayResult {
  const status = String(t.status ?? '').toLowerCase();
  const base = {
    merchantRef: t.reference,
    amount: typeof t.amount === 'number' && Number.isFinite(t.amount) ? t.amount / 100 : undefined,
    currency: t.currency?.toUpperCase(),
    receipt: t.id !== undefined ? `PSK-${t.id}` : undefined,
    method: methodLabel(t),
  };
  if (status === 'success') return { ...base, outcome: 'paid' };
  if (status === 'failed' || status === 'reversed') {
    return { ...base, outcome: 'failed', reason: t.gateway_response && t.gateway_response.length < 140 ? `Paystack: ${t.gateway_response}` : 'The payment did not go through.' };
  }
  // "abandoned" stays pending on purpose: the guest can still finish on Paystack's page, and the webhook then confirms it.
  return { ...base, outcome: 'pending' };
}

export function createPaystack(config: PaystackConfig, fetchImpl: FetchLike = fetch): Gateway {
  const headers = { Authorization: `Bearer ${config.secretKey}`, 'Content-Type': 'application/json', Accept: 'application/json' };

  async function call<T>(path: string, init: RequestInit): Promise<T> {
    const res = await requestJson<Envelope<T>>('paystack', fetchImpl, `${config.baseUrl}${path}`, { ...init, headers });
    if (res.status !== true || res.data === undefined) throw new ProviderError('paystack', `Paystack error: ${res.message ?? 'no data in reply'}`, undefined, res);
    return res.data;
  }

  return {
    id: 'paystack',
    label: 'Paystack',
    currency: 'KES',
    merchantRef: (ref, attempt) => paystackReference(ref, attempt),

    async startCheckout(input: CheckoutInput) {
      if (!input.email) throw new ProviderError('paystack', 'Paystack needs an email address.');
      const cancelUrl = `${input.returnUrl}${input.returnUrl.includes('?') ? '&' : '?'}cancelled=1`;
      const body: Record<string, unknown> = {
        email: input.email,
        amount: Math.round(input.amount * 100),
        currency: 'KES',
        reference: input.merchantRef,
        callback_url: input.returnUrl,
        metadata: {
          cancel_action: cancelUrl,
          booking: input.merchantRef,
          custom_fields: [
            { display_name: 'Booking', variable_name: 'booking', value: input.merchantRef },
            { display_name: 'Trip', variable_name: 'trip', value: input.description.slice(0, 120) },
          ],
        },
      };
      if (config.channels.length) body['channels'] = config.channels;
      const data = await call<InitData>('/transaction/initialize', { method: 'POST', body: JSON.stringify(body) });
      // Only ever send guests to an https page (the test servers run on plain http).
      const url = data.authorization_url;
      if (!url || !(/^https:\/\//.test(url) || (config.baseUrl !== PAYSTACK_API_URL && /^http:\/\//.test(url)))) {
        throw new ProviderError('paystack', 'Paystack didn’t return a checkout link.', undefined, data);
      }
      return { redirectUrl: url, providerRef: data.access_code ?? input.merchantRef };
    },

    async checkStatus(p) {
      if (!p.merchantRef) return undefined;
      const t = await call<PaystackTransaction>(`/transaction/verify/${encodeURIComponent(p.merchantRef)}`, { method: 'GET' });
      return mapPaystack(t);
    },

    readNotice({ raw, headers: h, body, ip }) {
      if (!ipAllowed(ip, config.callbackIps)) return null;
      if (!verifyPaystack(raw, h.get('x-paystack-signature'), config.secretKey)) return null;
      const event = String(body['event'] ?? '');
      const data = (body['data'] && typeof body['data'] === 'object' ? body['data'] : {}) as PaystackTransaction;
      if (!data.reference) return { merchantRef: undefined };
      // Only charge.success says anything about our payments; other events are acknowledged and ignored.
      if (event !== 'charge.success') return { merchantRef: data.reference };
      return { merchantRef: data.reference, txnId: data.id !== undefined ? String(data.id) : undefined, verified: mapPaystack(data) };
    },

    async ping() {
      // Any call that needs the secret key.
      await call<unknown>('/transaction?perPage=1', { method: 'GET' });
    },
  };
}
