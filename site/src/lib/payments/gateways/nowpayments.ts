import { createHmac, timingSafeEqual } from 'node:crypto';
import type { NowPaymentsConfig } from '../config';
import { ProviderError, requestJson, type FetchLike } from '../http';
import type { CheckoutInput, Gateway, GatewayResult } from './types';

/**
 * Crypto payments through NOWPayments: an invoice page where the guest picks a coin (USDT, BTC, ETH…).
 * The price is set in US dollars. NOWPayments signs every IPN with HMAC-SHA512 over the body with its
 * keys sorted, using the IPN secret key. We also re-read the payment from the API before believing it.
 * Docs: https://documenter.getpostman.com/view/7907941/2s93JusNJt
 */

interface InvoiceResponse {
  id?: string | number;
  invoice_url?: string;
  order_id?: string;
}

export interface NowPayment {
  payment_id?: string | number;
  invoice_id?: string | number;
  payment_status?: string;
  order_id?: string;
  price_amount?: number | string;
  price_currency?: string;
  pay_amount?: number | string;
  actually_paid?: number | string;
  pay_currency?: string;
  outcome_amount?: number | string;
  outcome_currency?: string;
}

function sortDeep(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortDeep);
  if (v && typeof v === 'object') {
    return Object.fromEntries(
      Object.keys(v as object)
        .sort()
        .map((k) => [k, sortDeep((v as Record<string, unknown>)[k])]),
    );
  }
  return v;
}

export function nowPaymentsSignature(body: unknown, ipnSecret: string): string {
  return createHmac('sha512', ipnSecret).update(JSON.stringify(sortDeep(body))).digest('hex');
}

export function verifyNowPayments(body: unknown, header: string | null, ipnSecret: string): boolean {
  if (!header || !/^[0-9a-f]{128}$/i.test(header)) return false;
  const a = Buffer.from(nowPaymentsSignature(body, ipnSecret));
  const b = Buffer.from(header.toLowerCase());
  return a.length === b.length && timingSafeEqual(a, b);
}

/** finished = paid. partially_paid = they sent too little. failed / expired / refunded = didn't happen. */
export function mapNowPayment(p: NowPayment): GatewayResult {
  const status = String(p.payment_status ?? '').toLowerCase();
  const amount = p.price_amount !== undefined ? Number(p.price_amount) : undefined;
  const base = {
    merchantRef: p.order_id,
    amount: amount !== undefined && Number.isFinite(amount) ? amount : undefined,
    currency: p.price_currency?.toUpperCase(),
    receipt: p.payment_id !== undefined ? String(p.payment_id) : undefined,
    method: p.pay_currency ? `${p.pay_currency.toUpperCase()}${p.actually_paid !== undefined ? ` ${p.actually_paid}` : ''}` : undefined,
  };
  if (status === 'finished') return { ...base, outcome: 'paid' };
  if (status === 'partially_paid') {
    return { ...base, outcome: 'underpaid', reason: `Only part of the crypto amount arrived (${p.actually_paid ?? '?'} of ${p.pay_amount ?? '?'} ${p.pay_currency?.toUpperCase() ?? ''}).` };
  }
  if (status === 'failed' || status === 'expired' || status === 'refunded') {
    return { ...base, outcome: 'failed', reason: status === 'expired' ? 'The crypto payment window expired. Please try again.' : `The crypto payment ${status}.` };
  }
  return { ...base, outcome: 'pending' };
}

export function createNowPayments(config: NowPaymentsConfig, fetchImpl: FetchLike = fetch): Gateway {
  const headers = { 'x-api-key': config.apiKey, 'Content-Type': 'application/json', Accept: 'application/json' };
  return {
    id: 'crypto',
    label: 'Crypto',
    currency: 'USD',
    merchantRef: (ref, attempt) => `${ref}-C${attempt}`,

    async startCheckout(input: CheckoutInput) {
      const res = await requestJson<InvoiceResponse>('crypto', fetchImpl, `${config.baseUrl}/invoice`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          price_amount: input.amount,
          price_currency: 'usd',
          order_id: input.merchantRef,
          order_description: input.description.slice(0, 200),
          ipn_callback_url: config.notifyUrl,
          success_url: input.returnUrl,
          cancel_url: input.returnUrl,
          is_fixed_rate: true,
          is_fee_paid_by_user: false,
        }),
      });
      if (!res.invoice_url || res.id === undefined) throw new ProviderError('crypto', 'NOWPayments didn’t return an invoice link.', undefined, res);
      return { redirectUrl: res.invoice_url, providerRef: String(res.id) };
    },

    async checkStatus(p) {
      // Payments can only be looked up by the payment id NOWPayments sends with its first notification.
      if (!p.txnId) return undefined;
      const res = await requestJson<NowPayment>('crypto', fetchImpl, `${config.baseUrl}/payment/${encodeURIComponent(p.txnId)}`, { method: 'GET', headers });
      return mapNowPayment(res);
    },

    readNotice({ body, headers: h }) {
      if (!verifyNowPayments(body, h.get('x-nowpayments-sig'), config.ipnSecret)) return null;
      const p = body as NowPayment;
      return { merchantRef: p.order_id, txnId: p.payment_id !== undefined ? String(p.payment_id) : undefined, verified: mapNowPayment(p) };
    },

    async ping() {
      // Needs a valid API key.
      await requestJson<unknown>('crypto', fetchImpl, `${config.baseUrl}/merchant/coins`, { method: 'GET', headers });
    },
  };
}
