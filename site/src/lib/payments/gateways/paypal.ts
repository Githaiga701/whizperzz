import { randomBytes } from 'node:crypto';
import { PAYPAL_URLS, type PayPalConfig } from '../config';
import { ProviderError, requestJson, type FetchLike } from '../http';
import type { CheckoutInput, Gateway, GatewayResult } from './types';

/**
 * PayPal, charged in US dollars (PayPal doesn't take Kenyan shillings). Guests pay with their PayPal account,
 * or with a card as a guest, on PayPal's own page. Two ways to set it up:
 *
 * API (client ID + secret from developer.paypal.com), the full version:
 * 1. Our server creates an order (POST /v2/checkout/orders) for the quote's amount, so the guest can't change it.
 * 2. The guest approves it on PayPal and comes back to our pay page (?token=<order id>).
 * 3. Our server captures the order (POST /v2/checkout/orders/:id/capture). It's marked paid only when PayPal's
 *    own reply says the capture COMPLETED, for this booking's reference, currency and amount.
 * 4. PayPal's webhook (CHECKOUT.ORDER.APPROVED, PAYMENT.CAPTURE.*) makes this happen even if the guest closes
 *    the tab. Webhooks are never believed on their own: each one only makes us ask PayPal's API directly.
 *
 * Email only (just your PayPal email address), the simple version:
 *   "Pay with PayPal" opens PayPal with your address and the exact dollar amount filled in. PayPal doesn't tell
 *   us about these payments, so the team confirms each one on the quote's page once it shows in PayPal.
 *
 * Docs: https://developer.paypal.com/docs/api/orders/v2/ and https://developer.paypal.com/api/rest/webhooks/
 */

interface Money {
  currency_code?: string;
  value?: string;
}

export interface PayPalCapture {
  id?: string;
  status?: string;
  amount?: Money;
  invoice_id?: string;
  custom_id?: string;
  status_details?: { reason?: string };
  supplementary_data?: { related_ids?: { order_id?: string } };
}

export interface PayPalOrder {
  id?: string;
  status?: string;
  links?: { href?: string; rel?: string }[];
  payment_source?: { paypal?: { email_address?: string }; card?: { brand?: string; last_digits?: string } };
  purchase_units?: {
    reference_id?: string;
    custom_id?: string;
    invoice_id?: string;
    amount?: Money;
    payments?: { captures?: PayPalCapture[] };
  }[];
}

/** PayPal invoice ids must be unique for ever, so each attempt gets its own: WZ-ABC123-PP1-a1b2c3. */
export function paypalReference(quoteRef: string, attempt: number, suffix = randomBytes(3).toString('hex')): string {
  return `${quoteRef}-PP${attempt}-${suffix}`.replace(/[^A-Za-z0-9-]/g, '').slice(0, 127);
}

function money(m: Money | undefined): number | undefined {
  const n = Number(m?.value);
  return m?.value !== undefined && Number.isFinite(n) ? n : undefined;
}

function methodLabel(o: PayPalOrder): string {
  const card = o.payment_source?.card;
  if (card) {
    const brand = (card.brand ?? 'Card').replace(/_/g, ' ').toUpperCase();
    return card.last_digits ? `${brand} ••${card.last_digits} (PayPal)` : `${brand} (PayPal)`;
  }
  return 'PayPal';
}

/** Reads an order: COMPLETED with a COMPLETED capture is paid. APPROVED is reported as 'approved' so it gets captured. */
export function mapPayPalOrder(o: PayPalOrder): GatewayResult & { approved?: boolean } {
  const unit = o.purchase_units?.[0];
  const capture = unit?.payments?.captures?.[0];
  const status = String(o.status ?? '').toUpperCase();
  const base = {
    merchantRef: capture?.invoice_id ?? unit?.invoice_id ?? unit?.custom_id ?? unit?.reference_id,
    amount: money(capture?.amount ?? unit?.amount),
    currency: (capture?.amount ?? unit?.amount)?.currency_code?.toUpperCase(),
    receipt: capture?.id,
    method: methodLabel(o),
  };
  if (capture) {
    const c = String(capture.status ?? '').toUpperCase();
    // Refunded later still means it was paid; refunds are recorded on the quote's page.
    if (c === 'COMPLETED' || c === 'REFUNDED' || c === 'PARTIALLY_REFUNDED') return { ...base, outcome: 'paid' };
    if (c === 'DECLINED' || c === 'FAILED') return { ...base, outcome: 'failed', reason: 'PayPal declined the payment. Please try again or choose another way to pay.' };
    // PENDING: PayPal is holding it (e.g. a bank-funded payment); its webhook tells us when it clears.
    return { ...base, outcome: 'pending' };
  }
  if (status === 'APPROVED') return { ...base, outcome: 'pending', approved: true };
  if (status === 'VOIDED') return { ...base, outcome: 'failed', reason: 'The PayPal payment was cancelled.' };
  // CREATED, PAYER_ACTION_REQUIRED, SAVED: the guest hasn't finished on PayPal's page yet.
  return { ...base, outcome: 'pending' };
}

/** The "pay to this email" link (PayPal Payments Standard): no keys needed, confirmed by hand. */
export function paypalEmailLink(checkoutUrl: string, email: string, input: CheckoutInput): string {
  const q = new URLSearchParams({
    cmd: '_xclick',
    business: email,
    item_name: input.description.slice(0, 127),
    item_number: input.merchantRef,
    invoice: input.merchantRef,
    amount: input.amount.toFixed(2),
    currency_code: 'USD',
    no_shipping: '1',
    return: input.returnUrl,
    cancel_return: `${input.returnUrl}${input.returnUrl.includes('?') ? '&' : '?'}cancelled=1`,
    rm: '1',
  });
  if (input.email) q.set('email', input.email);
  return `${checkoutUrl}?${q.toString()}`;
}

export function createPayPal(config: PayPalConfig, fetchImpl: FetchLike = fetch): Gateway {
  // Only the test suite's fake PayPal runs on plain http.
  const testServer = config.apiUrl !== PAYPAL_URLS.sandbox.api && config.apiUrl !== PAYPAL_URLS.production.api;

  if (config.mode === 'email') {
    return {
      id: 'paypal',
      label: 'PayPal',
      currency: 'USD',
      confirmedByHand: true,
      merchantRef: (ref, attempt) => paypalReference(ref, attempt),
      async startCheckout(input) {
        return { redirectUrl: paypalEmailLink(config.checkoutUrl, config.email!, input), providerRef: input.merchantRef };
      },
      // PayPal can't be asked about these: the team confirms them on the quote's page.
      async checkStatus() {
        return undefined;
      },
      readNotice() {
        return null;
      },
      async ping() {
        throw new ProviderError('paypal', 'With only an email address there is nothing to test online. Make a small test payment to yourself, or add API keys for automatic confirmation.');
      },
    };
  }

  let token: { value: string; until: number } | undefined;

  async function accessToken(): Promise<string> {
    if (token && Date.now() < token.until) return token.value;
    const basic = Buffer.from(`${config.clientId}:${config.clientSecret}`).toString('base64');
    const res = await requestJson<{ access_token?: string; expires_in?: number }>('paypal', fetchImpl, `${config.apiUrl}/v1/oauth2/token`, {
      method: 'POST',
      headers: { Authorization: `Basic ${basic}`, 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: 'grant_type=client_credentials',
    });
    if (!res.access_token) throw new ProviderError('paypal', 'PayPal didn’t give us an access token.');
    // Refresh a minute early.
    token = { value: res.access_token, until: Date.now() + Math.max(60, (res.expires_in ?? 600) - 60) * 1000 };
    return token.value;
  }

  async function call<T>(path: string, init: RequestInit & { requestId?: string }): Promise<T> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${await accessToken()}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
      Prefer: 'return=representation',
    };
    // Makes a retried create or capture safe: PayPal answers the same request id with the same result.
    if (init.requestId) headers['PayPal-Request-Id'] = init.requestId;
    return requestJson<T>('paypal', fetchImpl, `${config.apiUrl}${path}`, { ...init, headers });
  }

  const issue = (err: unknown): string | undefined => {
    const d = err instanceof ProviderError ? (err.detail as { details?: { issue?: string }[] } | undefined) : undefined;
    return d?.details?.[0]?.issue;
  };

  async function getOrder(id: string): Promise<PayPalOrder> {
    return call<PayPalOrder>(`/v2/checkout/orders/${encodeURIComponent(id)}`, { method: 'GET' });
  }

  return {
    id: 'paypal',
    label: 'PayPal',
    currency: 'USD',
    merchantRef: (ref, attempt) => paypalReference(ref, attempt),

    async startCheckout(input: CheckoutInput) {
      const cancelUrl = `${input.returnUrl}${input.returnUrl.includes('?') ? '&' : '?'}cancelled=1`;
      const order = await call<PayPalOrder>('/v2/checkout/orders', {
        method: 'POST',
        requestId: input.merchantRef,
        body: JSON.stringify({
          intent: 'CAPTURE',
          purchase_units: [
            {
              reference_id: input.merchantRef,
              custom_id: input.merchantRef,
              invoice_id: input.merchantRef,
              description: input.description.slice(0, 127),
              amount: { currency_code: 'USD', value: input.amount.toFixed(2) },
            },
          ],
          payment_source: {
            paypal: {
              ...(input.email ? { email_address: input.email } : {}),
              experience_context: {
                brand_name: config.brandName.slice(0, 127),
                shipping_preference: 'NO_SHIPPING',
                user_action: 'PAY_NOW',
                return_url: input.returnUrl,
                cancel_url: cancelUrl,
              },
            },
          },
        }),
      });
      const link = order.links?.find((l) => l.rel === 'payer-action' || l.rel === 'approve')?.href;
      // Only ever send guests to an https page (the test server runs on plain http).
      if (!order.id || !link || !(/^https:\/\//.test(link) || (testServer && /^http:\/\//.test(link)))) {
        throw new ProviderError('paypal', 'PayPal didn’t return a checkout link.', undefined, order);
      }
      return { redirectUrl: link, providerRef: order.id };
    },

    async checkStatus(p) {
      const orderId = p.providerRef || p.txnId;
      if (!orderId) return undefined;
      let order = await getOrder(orderId);
      let result = mapPayPalOrder(order);
      if (result.approved) {
        // The guest approved it on PayPal: take the money now. Safe to repeat thanks to the request id.
        try {
          order = await call<PayPalOrder>(`/v2/checkout/orders/${encodeURIComponent(orderId)}/capture`, { method: 'POST', requestId: `${orderId}-capture`, body: '{}' });
        } catch (err) {
          const why = issue(err);
          if (why === 'ORDER_ALREADY_CAPTURED') order = await getOrder(orderId);
          else if (why === 'INSTRUMENT_DECLINED' || why === 'PAYER_CANNOT_PAY' || why === 'PAYER_ACTION_REQUIRED') {
            return { ...result, approved: undefined, outcome: 'failed', reason: 'PayPal couldn’t take the payment from that account or card. Please try again with another one.' };
          } else throw err;
        }
        result = mapPayPalOrder(order);
      }
      const { approved: _approved, ...out } = result;
      return out;
    },

    readNotice({ body }) {
      // Never believed on its own: it only tells us which payment to ask PayPal about.
      const resource = (body['resource'] && typeof body['resource'] === 'object' ? body['resource'] : {}) as PayPalOrder & PayPalCapture;
      const event = String(body['event_type'] ?? '');
      if (event.startsWith('PAYMENT.CAPTURE.')) {
        return { merchantRef: resource.invoice_id ?? resource.custom_id, txnId: resource.supplementary_data?.related_ids?.order_id };
      }
      if (event.startsWith('CHECKOUT.ORDER.')) {
        const unit = resource.purchase_units?.[0];
        return { merchantRef: unit?.invoice_id ?? unit?.custom_id ?? unit?.reference_id, txnId: resource.id };
      }
      return { merchantRef: undefined };
    },

    async ping() {
      // Getting an access token proves the client ID and secret work.
      token = undefined;
      await accessToken();
    },
  };
}
