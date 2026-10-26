import type { PesapalConfig } from './config';
import { ProviderError, requestJson, type FetchLike } from './http';

/* ---------- Pesapal API 3 types (only the fields we use) ---------- */

interface PesapalError {
  error?: { error_type?: string; code?: string; message?: string } | null;
  status?: string;
}

export interface SubmitOrderResponse extends PesapalError {
  order_tracking_id: string;
  merchant_reference: string;
  redirect_url: string;
}

export interface TransactionStatusResponse extends PesapalError {
  payment_method?: string;
  amount: number;
  created_date?: string;
  confirmation_code?: string;
  /** Masked card number or phone number. */
  payment_account?: string;
  payment_status_description?: string;
  description?: string;
  /** 0 invalid, 1 completed, 2 failed, 3 reversed. */
  status_code: number;
  merchant_reference: string;
  currency: string;
}

export interface RegisterIpnResponse extends PesapalError {
  url: string;
  ipn_id: string;
}

export interface IpnListItem {
  url: string;
  ipn_id: string;
  created_date?: string;
}

/** What Pesapal sends to the IPN URL (as JSON body or query string). */
export interface PesapalIpn {
  OrderTrackingId: string;
  OrderMerchantReference: string;
  OrderNotificationType: string;
}

export type PesapalOutcome = 'paid' | 'failed' | 'pending';

export function mapPesapalStatus(statusCode: number): PesapalOutcome {
  if (statusCode === 1) return 'paid';
  if (statusCode === 2 || statusCode === 3) return 'failed';
  return 'pending';
}

export function parsePesapalIpn(input: Record<string, unknown>): PesapalIpn | null {
  const id = input['OrderTrackingId'];
  const ref = input['OrderMerchantReference'];
  if (typeof id !== 'string' || id === '' || typeof ref !== 'string' || ref === '') return null;
  return {
    OrderTrackingId: id,
    OrderMerchantReference: ref,
    OrderNotificationType: typeof input['OrderNotificationType'] === 'string' ? (input['OrderNotificationType'] as string) : 'IPNCHANGE',
  };
}

/* ---------- Client ---------- */

export interface SubmitOrderInput {
  merchantReference: string;
  amount: number;
  description: string;
  callbackUrl: string;
  /** Where "Cancel" on Pesapal's page goes. */
  cancellationUrl?: string | undefined;
  email: string | undefined;
  phone: string | undefined;
  firstName: string;
}

export interface RefundInput {
  confirmationCode: string;
  amount: number;
  username: string;
  remarks: string;
}

export interface RefundResponse extends PesapalError {
  message?: string;
}

export interface Pesapal {
  registerIpn(url: string): Promise<RegisterIpnResponse>;
  /** The IPN addresses already registered on this Pesapal account. */
  ipnList(): Promise<IpnListItem[]>;
  submitOrder(input: SubmitOrderInput): Promise<SubmitOrderResponse>;
  transactionStatus(orderTrackingId: string): Promise<TransactionStatusResponse>;
  /** Asks Pesapal to refund. The merchant still approves it in the Pesapal dashboard. */
  refund(input: RefundInput): Promise<RefundResponse>;
  /** Signs in to check the keys work. */
  ping(): Promise<void>;
}

function check<T extends PesapalError>(res: T, what: string): T {
  if (res.error && (res.error.message || res.error.code)) {
    throw new ProviderError('pesapal', `Pesapal ${what} failed: ${res.error.message || res.error.code}`, undefined, res.error);
  }
  return res;
}

/** Pesapal order ids: letters, digits, "-", "_", "." and ":", at most 50. */
export const PESAPAL_REF = /^[A-Za-z0-9._:-]{1,50}$/;

/** Pesapal descriptions: at most 100 characters; keep to plain text. */
export function pesapalDescription(text: string): string {
  return text.replace(/[<>"'`\\]/g, '').replace(/\s+/g, ' ').trim().slice(0, 100) || 'Whizperz booking';
}

function statusOk(res: { status?: unknown; error?: unknown }): boolean {
  const code = res.status ?? (typeof res.error === 'number' || typeof res.error === 'string' ? res.error : undefined);
  return code === undefined || String(code) === '200';
}

export function createPesapal(config: PesapalConfig, fetchImpl: FetchLike = fetch, now: () => Date = () => new Date()): Pesapal {
  let cached: { token: string; expiresAt: number } | undefined;

  async function token(): Promise<string> {
    if (cached && cached.expiresAt > now().getTime()) return cached.token;
    const res = check(
      await requestJson<{ token?: string; expiryDate?: string } & PesapalError>('pesapal', fetchImpl, `${config.baseUrl}/api/Auth/RequestToken`, {
        method: 'POST',
        headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
        body: JSON.stringify({ consumer_key: config.consumerKey, consumer_secret: config.consumerSecret }),
      }),
      'sign-in',
    );
    if (!res.token) throw new ProviderError('pesapal', 'Pesapal did not return a token. Check the consumer key and secret.');
    // Tokens last at most 5 minutes. Renew a minute early (sooner if Pesapal says it expires sooner).
    const said = res.expiryDate ? Date.parse(res.expiryDate.endsWith('Z') ? res.expiryDate : `${res.expiryDate}Z`) : NaN;
    const fourMinutes = now().getTime() + 4 * 60 * 1000;
    cached = { token: res.token, expiresAt: Number.isFinite(said) ? Math.min(fourMinutes, said - 60_000) : fourMinutes };
    return cached.token;
  }

  async function call<T extends PesapalError>(method: 'GET' | 'POST', path: string, what: string, body?: unknown): Promise<T> {
    const init: RequestInit = {
      method,
      headers: { Accept: 'application/json', 'Content-Type': 'application/json', Authorization: `Bearer ${await token()}` },
    };
    if (body !== undefined) init.body = JSON.stringify(body);
    return check(await requestJson<T>('pesapal', fetchImpl, `${config.baseUrl}${path}`, init), what);
  }

  return {
    async registerIpn(url) {
      const res = await call<RegisterIpnResponse>('POST', '/api/URLSetup/RegisterIPN', 'IPN registration', { url, ipn_notification_type: 'POST' });
      if (!res.ipn_id) throw new ProviderError('pesapal', 'Pesapal did not return an IPN id.', undefined, res);
      return res;
    },
    async ipnList() {
      const res = (await call<PesapalError>('GET', '/api/URLSetup/GetIpnList', 'IPN list')) as unknown as IpnListItem[] | { data?: IpnListItem[] };
      const items = Array.isArray(res) ? res : (res.data ?? []);
      return items.filter((x) => typeof x?.url === 'string' && typeof x?.ipn_id === 'string');
    },
    async submitOrder(input) {
      if (!config.ipnId) throw new ProviderError('pesapal', 'PESAPAL_IPN_ID is not set. Run npm run pesapal:register-ipn first.');
      if (!input.email && !input.phone) throw new ProviderError('pesapal', 'Pesapal needs an email address or phone number for the payer.');
      if (!PESAPAL_REF.test(input.merchantReference)) throw new ProviderError('pesapal', 'Invalid Pesapal order reference.');
      if (!(input.amount > 0)) throw new ProviderError('pesapal', 'Pesapal amounts must be more than zero.');
      const res = await call<SubmitOrderResponse>('POST', '/api/Transactions/SubmitOrderRequest', 'order', {
        id: input.merchantReference,
        currency: 'KES',
        amount: input.amount,
        description: pesapalDescription(input.description),
        callback_url: input.callbackUrl,
        ...(input.cancellationUrl ? { cancellation_url: input.cancellationUrl } : {}),
        redirect_mode: 'TOP_WINDOW',
        notification_id: config.ipnId,
        billing_address: {
          email_address: input.email ?? '',
          phone_number: input.phone ?? '',
          country_code: 'KE',
          first_name: input.firstName,
        },
      });
      if (!res.redirect_url || !res.order_tracking_id) throw new ProviderError('pesapal', 'Pesapal did not return a checkout link.', undefined, res);
      if (!/^https:\/\//.test(res.redirect_url) && !/^http:\/\/(127\.0\.0\.1|localhost)[:/]/.test(res.redirect_url)) {
        throw new ProviderError('pesapal', 'Pesapal returned a checkout link that isn’t https.', undefined, res);
      }
      return res;
    },
    transactionStatus(orderTrackingId) {
      return call<TransactionStatusResponse>(
        'GET',
        `/api/Transactions/GetTransactionStatus?orderTrackingId=${encodeURIComponent(orderTrackingId)}`,
        'status check',
      );
    },
    async refund(input) {
      const res = await call<RefundResponse>('POST', '/api/Transactions/RefundRequest', 'refund', {
        confirmation_code: input.confirmationCode,
        amount: input.amount.toFixed(2),
        username: input.username,
        remarks: input.remarks.slice(0, 200) || 'Refund',
      });
      if (!statusOk(res)) {
        throw new ProviderError('pesapal', `Pesapal refused the refund: ${res.message ?? `status ${res.status}`}`, undefined, res);
      }
      return res;
    },
    async ping() {
      cached = undefined;
      await token();
    },
  };
}
