import type { MpesaConfig } from './config';
import { ProviderError, requestJson, type FetchLike } from './http';

/* ---------- Daraja types (only the fields we use) ---------- */

export interface StkPushResponse {
  MerchantRequestID: string;
  CheckoutRequestID: string;
  ResponseCode: string;
  ResponseDescription: string;
  CustomerMessage: string;
}

export interface StkQueryResponse {
  ResponseCode: string;
  ResponseDescription: string;
  MerchantRequestID: string;
  CheckoutRequestID: string;
  ResultCode: string;
  ResultDesc: string;
}

interface CallbackItem {
  Name: string;
  Value?: string | number;
}

export interface StkCallbackBody {
  Body: {
    stkCallback: {
      MerchantRequestID: string;
      CheckoutRequestID: string;
      ResultCode: number;
      ResultDesc: string;
      CallbackMetadata?: { Item: CallbackItem[] };
    };
  };
}

export interface ReversalResponse {
  OriginatorConversationID: string;
  ConversationID: string;
  ResponseCode: string;
  ResponseDescription: string;
}

/** What Safaricom posts to the reversal ResultURL / QueueTimeOutURL. */
export interface ReversalResultBody {
  Result: {
    ResultType?: number;
    ResultCode: number | string;
    ResultDesc: string;
    OriginatorConversationID: string;
    ConversationID: string;
    TransactionID?: string;
  };
}

export type ReversalResult =
  | { ok: true; conversationId: string; originatorConversationId: string; transactionId: string | undefined }
  | { ok: false; conversationId: string; originatorConversationId: string; reason: string };

export function parseReversalResult(body: unknown): ReversalResult | null {
  const r = (body as ReversalResultBody | undefined)?.Result;
  if (!r || typeof r.ConversationID !== 'string' || r.ResultCode === undefined) return null;
  const ids = { conversationId: r.ConversationID, originatorConversationId: String(r.OriginatorConversationID ?? '') };
  if (String(r.ResultCode) === '0') return { ok: true, ...ids, transactionId: r.TransactionID };
  return { ok: false, ...ids, reason: r.ResultDesc || `Safaricom refused the reversal (code ${r.ResultCode}).` };
}

export type StkResult =
  | { ok: true; checkoutRequestId: string; amount: number; receipt: string; phone: string | undefined }
  | { ok: false; checkoutRequestId: string; resultCode: number; reason: string };

/* ---------- Helpers ---------- */

/** Daraja wants the time in Nairobi (UTC+3) as YYYYMMDDHHmmss. */
export function darajaTimestamp(now: Date): string {
  const eat = new Date(now.getTime() + 3 * 60 * 60 * 1000);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${eat.getUTCFullYear()}${p(eat.getUTCMonth() + 1)}${p(eat.getUTCDate())}${p(eat.getUTCHours())}${p(eat.getUTCMinutes())}${p(eat.getUTCSeconds())}`;
}

export function darajaPassword(shortcode: string, passkey: string, timestamp: string): string {
  return Buffer.from(`${shortcode}${passkey}${timestamp}`).toString('base64');
}

/**
 * Reads the JSON Safaricom posts to the callback URL.
 * Returns null when the body isn't an STK callback at all.
 */
export function parseStkCallback(body: unknown): StkResult | null {
  const cb = (body as StkCallbackBody | undefined)?.Body?.stkCallback;
  if (!cb || typeof cb.CheckoutRequestID !== 'string' || typeof cb.ResultCode !== 'number') return null;

  if (cb.ResultCode !== 0) {
    return { ok: false, checkoutRequestId: cb.CheckoutRequestID, resultCode: cb.ResultCode, reason: friendlyResult(cb.ResultCode, cb.ResultDesc) };
  }
  const items = cb.CallbackMetadata?.Item ?? [];
  const get = (name: string) => items.find((i) => i.Name === name)?.Value;
  const amount = Number(get('Amount'));
  const receipt = get('MpesaReceiptNumber');
  if (!Number.isFinite(amount) || typeof receipt !== 'string' || receipt === '') {
    return { ok: false, checkoutRequestId: cb.CheckoutRequestID, resultCode: -1, reason: 'Payment reported as successful but the details were incomplete.' };
  }
  const phone = get('PhoneNumber');
  return { ok: true, checkoutRequestId: cb.CheckoutRequestID, amount, receipt, phone: phone === undefined ? undefined : String(phone) };
}

/** Plain-language versions of the result codes guests actually hit. */
export function friendlyResult(code: number, fallback: string): string {
  switch (code) {
    case 1032:
      return 'The payment was cancelled on the phone.';
    case 1037:
      return 'The phone could not be reached. Check it is on and has signal, then try again.';
    case 1:
      return 'There isn’t enough balance in the M-Pesa account.';
    case 2001:
      return 'The M-Pesa PIN was wrong.';
    case 1019:
      return 'The payment request expired before it was completed.';
    case 1001:
      return 'Another M-Pesa transaction is in progress on this phone. Wait a minute and try again.';
    default:
      return fallback || 'The payment did not go through.';
  }
}

/* ---------- Client ---------- */

export interface StkPushInput {
  phone: string;
  amount: number;
  /** Shown on the guest's phone. Max 12 characters. */
  accountReference: string;
  /** Max 13 characters. */
  description: string;
}

export interface ReverseInput {
  /** The M-Pesa receipt number of the payment to reverse. */
  transactionId: string;
  amount: number;
  remarks: string;
}

export interface Daraja {
  stkPush(input: StkPushInput): Promise<StkPushResponse>;
  stkQuery(checkoutRequestId: string): Promise<StkQueryResponse>;
  /** Starts a reversal (refund). The result arrives later at the reversal ResultURL. */
  reverse(input: ReverseInput): Promise<ReversalResponse>;
  /** Signs in to check the keys work. */
  ping(): Promise<void>;
}

export function createDaraja(config: MpesaConfig, fetchImpl: FetchLike = fetch, now: () => Date = () => new Date()): Daraja {
  let cached: { token: string; expiresAt: number } | undefined;

  async function token(): Promise<string> {
    if (cached && cached.expiresAt > now().getTime()) return cached.token;
    const basic = Buffer.from(`${config.consumerKey}:${config.consumerSecret}`).toString('base64');
    const res = await requestJson<{ access_token?: string; expires_in?: string | number }>(
      'mpesa',
      fetchImpl,
      `${config.baseUrl}/oauth/v1/generate?grant_type=client_credentials`,
      { method: 'GET', headers: { Authorization: `Basic ${basic}` } },
    );
    if (!res.access_token) throw new ProviderError('mpesa', 'M-Pesa did not return an access token. Check the consumer key and secret.');
    const ttl = Number(res.expires_in ?? 3599);
    // Refresh a minute early so a token never expires mid-request.
    cached = { token: res.access_token, expiresAt: now().getTime() + Math.max(ttl - 60, 30) * 1000 };
    return cached.token;
  }

  function signed() {
    const timestamp = darajaTimestamp(now());
    return { BusinessShortCode: config.shortcode, Password: darajaPassword(config.shortcode, config.passkey, timestamp), Timestamp: timestamp };
  }

  async function post<T>(path: string, body: unknown): Promise<T> {
    return requestJson<T>('mpesa', fetchImpl, `${config.baseUrl}${path}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${await token()}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  return {
    async stkPush(input) {
      if (!Number.isInteger(input.amount) || input.amount < 1) {
        throw new ProviderError('mpesa', 'M-Pesa amounts must be whole shillings of at least 1.');
      }
      const till = config.tillNumber;
      const res = await post<StkPushResponse>('/mpesa/stkpush/v1/processrequest', {
        ...signed(),
        TransactionType: till ? 'CustomerBuyGoodsOnline' : 'CustomerPayBillOnline',
        Amount: input.amount,
        PartyA: input.phone,
        PartyB: till ?? config.shortcode,
        PhoneNumber: input.phone,
        CallBackURL: config.callbackUrl,
        AccountReference: input.accountReference.slice(0, 12),
        TransactionDesc: input.description.slice(0, 13),
      });
      if (res.ResponseCode !== '0' || !res.CheckoutRequestID) {
        throw new ProviderError('mpesa', `M-Pesa did not accept the request: ${res.ResponseDescription ?? 'unknown reason'}`, undefined, res);
      }
      return res;
    },
    async stkQuery(checkoutRequestId) {
      return post<StkQueryResponse>('/mpesa/stkpushquery/v1/query', { ...signed(), CheckoutRequestID: checkoutRequestId });
    },
    async reverse(input) {
      const rev = config.reversal;
      if (!rev) throw new ProviderError('mpesa', 'M-Pesa refunds need the initiator name and security credential in Settings.');
      const res = await post<ReversalResponse>('/mpesa/reversal/v1/request', {
        Initiator: rev.initiatorName,
        SecurityCredential: rev.securityCredential,
        CommandID: 'TransactionReversal',
        TransactionID: input.transactionId,
        Amount: input.amount,
        ReceiverParty: config.tillNumber ?? config.shortcode,
        RecieverIdentifierType: '11',
        ResultURL: rev.resultUrl,
        QueueTimeOutURL: rev.timeoutUrl,
        Remarks: (input.remarks || 'Refund').slice(0, 100).padEnd(2, '.'),
        Occasion: 'Whizperz refund',
      });
      if (res.ResponseCode !== '0' || !res.ConversationID) {
        throw new ProviderError('mpesa', `M-Pesa did not accept the reversal: ${res.ResponseDescription ?? 'unknown reason'}`, undefined, res);
      }
      return res;
    },
    async ping() {
      cached = undefined;
      await token();
    },
  };
}
