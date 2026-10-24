import type { IposConfig } from '../config';
import { ProviderError, requestJson, type FetchLike } from '../http';
import type { CheckoutInput, Gateway, GatewayResult } from './types';

/**
 * iPOS Pay (iPOSpays by Dejavoo): a hosted card page.
 * 1. We ask for a payment page (amount in US cents) and send the guest there.
 * 2. iPOSpays sends the guest back and POSTs to our notify address.
 * 3. We always confirm with queryPaymentStatus before marking anything paid.
 * Docs: https://docs.ipospays.com/hosted-payment-page/apidocs
 */

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
    amount?: string | number;
    totalAmount?: string | number;
    cardType?: string;
    cardLast4Digit?: string;
    responseApprovalCode?: string;
    rrn?: string;
  };
}

/** iPOSpays reports amounts in cents ("1500") on some screens and dollars on others; accept either. */
export function iposAmount(raw: unknown, expectedUsd: number | undefined): number | undefined {
  if (raw === undefined || raw === null || raw === '') return undefined;
  const n = Number(String(raw).replace(/[$,\s]/g, ''));
  if (!Number.isFinite(n)) return undefined;
  if (expectedUsd !== undefined && Math.abs(n - Math.round(expectedUsd * 100)) < 0.5) return expectedUsd;
  return String(raw).includes('.') ? n : n / 100;
}

export function mapIposStatus(res: StatusResponse, expectedUsd?: number): GatewayResult | undefined {
  const r = res.iposHPResponse;
  if (!r) return undefined;
  const code = Number(r.responseCode);
  const msg = `${r.responseMessage ?? ''}`.trim();
  const amount = iposAmount(r.totalAmount ?? r.amount, expectedUsd);
  const base = {
    merchantRef: r.transactionReferenceId,
    amount,
    currency: 'USD',
    receipt: r.transactionId ?? r.responseApprovalCode,
    method: r.cardType ? `${r.cardType}${r.cardLast4Digit ? ` ••${r.cardLast4Digit}` : ''}` : undefined,
  };
  if (code === 200 && /success|approved/i.test(msg || 'successful')) return { ...base, outcome: 'paid' };
  if (/declin|cancel|reject|fail|void/i.test(msg) || (code >= 400 && code !== 404)) {
    return { ...base, outcome: 'failed', reason: r.errResponseMessage || msg || 'The card payment did not go through.' };
  }
  return { ...base, outcome: 'pending' };
}

export function createIpos(config: IposConfig, fetchImpl: FetchLike = fetch, now: () => Date = () => new Date()): Gateway {
  let cached: { token: string; expiresAt: number } | undefined;

  async function token(): Promise<string> {
    if (config.authToken) return config.authToken;
    if (cached && cached.expiresAt > now().getTime()) return cached.token;
    const res = await requestJson<{ responseCode?: string; responseMessage?: string; token?: string }>('ipos', fetchImpl, `${config.authUrl}/v1/authenticate-token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', apiKey: config.apiKey ?? '', secretKey: config.secretKey ?? '', TokenExpiryMinutes: '1440' },
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
    merchantRef: (ref, attempt) => `${ref}-I${attempt}`,

    async startCheckout(input: CheckoutInput) {
      const cents = Math.round(input.amount * 100);
      if (cents < 50) throw new ProviderError('ipos', 'iPOS Pay amounts must be at least USD 0.50.');
      const res = await requestJson<HppResponse>('ipos', fetchImpl, `${config.paymentUrl}/api/v3/external-payment-transaction`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', token: await token() },
        body: JSON.stringify({
          merchantAuthentication: { merchantId: config.tpn, transactionReferenceId: input.merchantRef },
          transactionRequest: { transactionType: 1, amount: String(cents), calculateFee: false, tipsInputPrompt: false, calculateTax: false },
          notificationOption: {
            notifyByRedirect: true,
            returnUrl: input.returnUrl,
            failureUrl: input.returnUrl,
            cancelUrl: input.returnUrl,
            notifyByPOST: true,
            postAPI: config.notifyUrl,
            authHeader: config.callbackSecret,
          },
          preferences: {
            integrationType: 1,
            avsVerification: false,
            eReceipt: Boolean(input.email),
            customerName: input.name.slice(0, 60),
            customerEmail: input.email ?? '',
            customerMobile: input.phone ? `+${input.phone}` : '',
            requestCardToken: false,
            sendPaymentLink: false,
            shortenURL: false,
            integrationVersion: 'v2',
          },
          personalization: { merchantName: 'Whizperz Tours & Safaris', description: input.description.slice(0, 100) },
        }),
      });
      if (!res.information || !/^https?:\/\//.test(res.information)) {
        const why = res.errors?.map((e) => e.message).filter(Boolean).join('; ') || res.message || 'no payment page returned';
        throw new ProviderError('ipos', `iPOS Pay didn’t open a payment page: ${why}`, undefined, res);
      }
      return { redirectUrl: res.information, providerRef: input.merchantRef };
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
      return mapIposStatus(res, p.amount) ?? { outcome: 'pending' };
    },

    readNotice({ body }) {
      // iPOSpays' notification only tells us which payment changed. Its contents are never trusted:
      // the status is always fetched from iPOSpays itself.
      const inner = (body['iposHPResponse'] ?? body) as Record<string, unknown>;
      const ref = inner['transactionReferenceId'];
      return typeof ref === 'string' && ref ? { merchantRef: ref } : null;
    },

    async ping() {
      cached = undefined;
      await token();
      if (config.authToken) {
        // A saved token can't be checked on its own; ask about a payment that doesn't exist.
        await this.checkStatus({ merchantRef: 'WZ-TEST-CONNECTION', providerRef: '' });
      }
    },
  };
}
