import { createHmac } from 'node:crypto';
import type { IposConfig } from '../config';
import { ProviderError, requestJson, type FetchLike } from '../http';
import type { CheckoutInput, Gateway, GatewayResult } from './types';

/**
 * iPOS Pay (iPOSpays by Dejavoo): a hosted card page, charged in US dollars.
 * Spec: https://docs.ipospays.com/hosted-payment-page/apidocs (UAT copy: uatdocs.ipospays.tech)
 *
 * 1. We ask iPOSpays for a payment page. The amount (in cents), our reference and the return
 *    addresses are fixed on their side, so the guest can't change them.
 * 2. iPOSpays sends the guest back and POSTs a notification to our secret notify address.
 *    That notification is only a hint: its contents are never trusted.
 * 3. Before marking anything paid we always ask iPOSpays' queryPaymentStatus API ourselves, and
 *    check the reference, the transaction type (sale) and the amount.
 *
 * Two ways to sign in, both from the iPOSpays merchant portal:
 * - Ecom token (Settings → Merchant Keys / Ecom Token → choose the TPN → Generate). Used as-is with HPP v1.
 * - API key + secret key: exchanged for a token at auth.ipospays.com, used with HPP v3.
 */

export const IPOS_RESPONSE = { success: 200, declined: 400, cancelled: 401, rejected: 402 } as const;

interface HppResponse {
  message?: string;
  information?: string;
  errors?: { field?: string; message?: string }[];
}

interface StatusResponse {
  iposHPResponse?: {
    responseCode?: number | string;
    responseMessage?: string;
    errResponseCode?: string;
    errResponseMessage?: string;
    transactionReferenceId?: string;
    transactionId?: string;
    transactionType?: number | string;
    amount?: string | number;
    totalAmount?: string | number;
    cardType?: string;
    cardLast4Digit?: string;
    responseApprovalCode?: string;
    rrn?: string;
  };
}

/** iPOSpays amounts are in cents ("65385" = USD 653.85). A value with a decimal point is read as dollars. */
export function iposAmount(raw: unknown, expectedUsd: number | undefined): number | undefined {
  if (raw === undefined || raw === null || raw === '') return undefined;
  const text = String(raw).replace(/[$,\s]/g, '');
  const n = Number(text);
  if (!Number.isFinite(n)) return undefined;
  if (text.includes('.')) return n;
  const dollars = n / 100;
  // A whole-dollar figure that equals the expected amount (e.g. "100" for USD 100) is also accepted.
  if (expectedUsd !== undefined && Math.abs(n - expectedUsd) < 0.005 && Math.abs(dollars - expectedUsd) >= 0.005) return n;
  return dollars;
}

export function mapIposStatus(res: StatusResponse, expectedUsd?: number): GatewayResult | undefined {
  const r = res.iposHPResponse;
  if (!r) return undefined;
  const code = Number(r.responseCode);
  const msg = `${r.responseMessage ?? ''}`.trim();
  const amount = iposAmount(r.amount ?? r.totalAmount, expectedUsd);
  const base = {
    merchantRef: r.transactionReferenceId,
    amount,
    currency: 'USD',
    receipt: r.transactionId || r.responseApprovalCode,
    method: r.cardType ? `${r.cardType}${r.cardLast4Digit ? ` ••${r.cardLast4Digit}` : ''}` : undefined,
  };
  if (code === IPOS_RESPONSE.success) {
    // Only a sale counts as a payment (2 = card validation, which charges nothing).
    if (r.transactionType !== undefined && String(r.transactionType) !== '1') {
      return { ...base, outcome: 'failed', reason: 'iPOSpays reported a card check, not a payment.' };
    }
    return { ...base, outcome: 'paid' };
  }
  if (code === IPOS_RESPONSE.declined || code === IPOS_RESPONSE.cancelled || code === IPOS_RESPONSE.rejected) {
    const why = r.errResponseMessage || msg;
    return {
      ...base,
      outcome: 'failed',
      reason: code === IPOS_RESPONSE.cancelled ? 'You cancelled the card payment.' : why ? `The card payment didn’t go through: ${why}` : 'The card payment didn’t go through.',
    };
  }
  return { ...base, outcome: 'pending' };
}

/** iPOSpays references: letters and digits only, at most 20. */
export function iposReference(quoteRef: string, attempt: number): string {
  return `${quoteRef.replace(/[^A-Za-z0-9]/g, '')}I${attempt}`.slice(0, 20);
}

/** iPOSpays' customerName: letters and spaces, at most 25. */
export function iposName(name: string): string {
  return name
    .normalize('NFKD')
    .replace(/[^A-Za-z ]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 25)
    .trim();
}

/** The value iPOSpays echoes to our notify address (letters and digits, at most 50). */
export function iposAuthHeader(callbackSecret: string): string {
  return createHmac('sha256', callbackSecret).update('ipos-notify').digest('hex').slice(0, 40);
}

export function createIpos(config: IposConfig, fetchImpl: FetchLike = fetch, now: () => Date = () => new Date()): Gateway {
  let cached: { token: string; expiresAt: number } | undefined;
  // The portal's Ecom token works with HPP v1; tokens from the API key work with HPP v3.
  const hppVersion = config.authToken ? 'v1' : 'v3';

  async function token(): Promise<string> {
    if (config.authToken) return config.authToken;
    if (cached && cached.expiresAt > now().getTime()) return cached.token;
    const creds = { apiKey: config.apiKey ?? '', secretKey: config.secretKey ?? '', TokenExpiryMinutes: 1440 };
    const res = await requestJson<{ responseCode?: string; responseMessage?: string; token?: string }>('ipos', fetchImpl, `${config.authUrl}/v1/authenticate-token`, {
      method: 'POST',
      // iPOSpays' docs show these both as headers and as a JSON body; send both.
      headers: { 'Content-Type': 'application/json', apiKey: creds.apiKey, secretKey: creds.secretKey, TokenExpiryMinutes: String(creds.TokenExpiryMinutes) },
      body: JSON.stringify(creds),
    });
    if (!res.token) throw new ProviderError('ipos', `iPOS Pay sign-in failed: ${res.responseMessage ?? 'no token returned'}`);
    // Tokens last 24 hours; renew after 23.
    cached = { token: res.token, expiresAt: now().getTime() + 23 * 3600_000 };
    return cached.token;
  }

  return {
    id: 'ipos',
    label: 'iPOS Pay',
    currency: 'USD',
    merchantRef: iposReference,

    async startCheckout(input: CheckoutInput) {
      const cents = Math.round(input.amount * 100);
      if (cents < 50) throw new ProviderError('ipos', 'iPOS Pay amounts must be at least USD 0.50.');
      if (cents > 99_999_999) throw new ProviderError('ipos', 'That amount is too large for one iPOS Pay payment.');
      if (!/^[A-Za-z0-9]{1,20}$/.test(input.merchantRef)) throw new ProviderError('ipos', 'Invalid iPOS Pay reference.');
      const name = iposName(input.name);
      const mobile = input.phone && /^\d{12}$/.test(input.phone) ? `+${input.phone}` : '';
      const res = await requestJson<HppResponse>('ipos', fetchImpl, `${config.paymentUrl}/api/${hppVersion}/external-payment-transaction`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', token: await token() },
        body: JSON.stringify({
          merchantAuthentication: { merchantId: /^\d+$/.test(config.tpn) ? Number(config.tpn) : config.tpn, transactionReferenceId: input.merchantRef },
          transactionRequest: {
            transactionType: 1,
            amount: String(cents),
            // The price is all-inclusive: no fee, tax or tip added on their page.
            calculateFee: false,
            tipsInputPrompt: false,
            calculateTax: false,
            expiry: 1,
          },
          notificationOption: {
            notifyByRedirect: true,
            returnUrl: input.returnUrl,
            failureUrl: input.returnUrl,
            cancelUrl: input.returnUrl,
            notifyByPOST: true,
            postAPI: config.notifyUrl,
            authHeader: iposAuthHeader(config.callbackSecret),
            notifyBySMS: false,
          },
          preferences: {
            integrationType: 1,
            avsVerification: false,
            eReceipt: Boolean(input.email),
            eReceiptInputPrompt: false,
            ...(name ? { customerName: name } : {}),
            ...(input.email ? { customerEmail: input.email } : {}),
            ...(mobile ? { customerMobile: mobile } : {}),
            requestCardToken: false,
            sendPaymentLink: false,
            shortenURL: false,
            integrationVersion: 'v2',
          },
          personalization: { merchantName: 'Whizperz Tours & Safaris', description: input.description.slice(0, 150) },
        }),
      });
      const url = res.information ?? '';
      // Only an https page (or a local test server) is ever shown to guests.
      if (!/^https:\/\/[^\s]+$/.test(url) && !/^http:\/\/(127\.0\.0\.1|localhost)[:/]/.test(url)) {
        const why = res.errors?.map((e) => `${e.field ? `${e.field}: ` : ''}${e.message ?? ''}`).filter(Boolean).join('; ') || res.message || 'no payment page returned';
        throw new ProviderError('ipos', `iPOS Pay didn’t open a payment page: ${why}`, undefined, res);
      }
      return { redirectUrl: url, providerRef: input.merchantRef };
    },

    async checkStatus(p) {
      const url = `${config.apiUrl}/v1/queryPaymentStatus?tpn=${encodeURIComponent(config.tpn)}&transactionReferenceId=${encodeURIComponent(p.merchantRef)}`;
      let res: StatusResponse;
      try {
        res = await requestJson<StatusResponse>('ipos', fetchImpl, url, { method: 'GET', headers: { Authorization: await token() } });
      } catch (err) {
        // "Not found" just means the guest hasn't paid yet.
        if (err instanceof ProviderError && err.status === 404) return { outcome: 'pending' };
        throw err;
      }
      const mapped = mapIposStatus(res, p.amount);
      if (mapped?.merchantRef && mapped.merchantRef !== p.merchantRef) {
        throw new ProviderError('ipos', 'iPOSpays answered about a different payment.');
      }
      return mapped ?? { outcome: 'pending' };
    },

    readNotice({ body }) {
      // The notification only tells us which payment to look up; the status always comes from iPOSpays' API.
      const inner = (body['iposHPResponse'] ?? body) as Record<string, unknown>;
      const ref = inner['transactionReferenceId'];
      return typeof ref === 'string' && /^[A-Za-z0-9]{1,20}$/.test(ref) ? { merchantRef: ref } : null;
    },

    async ping() {
      if (!/^\d{6,20}$/.test(config.tpn)) throw new ProviderError('ipos', 'The TPN should be the terminal number (digits only).');
      cached = undefined;
      await token();
      // Ask about a payment that doesn't exist: proves the token and TPN are accepted.
      await this.checkStatus({ merchantRef: 'WZCONNECTIONTEST', providerRef: '' });
    },
  };
}
