import { vi } from 'vitest';
import { loadPaymentConfig, type PaymentConfig } from '@/lib/payments/config';
import type { Daraja, StkPushResponse, StkQueryResponse } from '@/lib/payments/mpesa';
import type { Pesapal, TransactionStatusResponse } from '@/lib/payments/pesapal';
import type { PaymentDeps, PaymentEvent } from '@/lib/payments/service';
import { QuoteStore, memoryPersistence } from '@/lib/payments/store';
import { ProviderError } from '@/lib/payments/http';

export const FULL_ENV = {
  PAYMENTS_MODE: 'sandbox',
  SITE_URL: 'https://whizperz.test',
  ADMIN_TOKEN: 'admin-secret-token',
  MPESA_CONSUMER_KEY: 'ck',
  MPESA_CONSUMER_SECRET: 'cs',
  MPESA_SHORTCODE: '174379',
  MPESA_PASSKEY: 'passkey',
  MPESA_CALLBACK_SECRET: 'mpesa-cb-secret',
  MPESA_INITIATOR_NAME: 'apiop',
  MPESA_SECURITY_CREDENTIAL: 'encrypted-cred',
  PESAPAL_CONSUMER_KEY: 'pk',
  PESAPAL_CONSUMER_SECRET: 'ps',
  PESAPAL_CALLBACK_SECRET: 'pesapal-cb-secret',
  PESAPAL_IPN_ID: 'ipn-123',
};

/** A clock tests can move forward. */
export function clock(start = '2026-10-23T09:00:00.000Z') {
  let t = Date.parse(start);
  return {
    now: () => new Date(t),
    advance: (ms: number) => {
      t += ms;
    },
  };
}

export function stkPushOk(id = 'ws_CO_001'): StkPushResponse {
  return {
    MerchantRequestID: 'm-001',
    CheckoutRequestID: id,
    ResponseCode: '0',
    ResponseDescription: 'Success. Request accepted for processing',
    CustomerMessage: 'Success. Request accepted for processing',
  };
}

export function stkQueryResult(code: string, id = 'ws_CO_001'): StkQueryResponse {
  return {
    ResponseCode: '0',
    ResponseDescription: 'The service request has been accepted successsfully',
    MerchantRequestID: 'm-001',
    CheckoutRequestID: id,
    ResultCode: code,
    ResultDesc: code === '0' ? 'The service request is processed successfully.' : 'Request cancelled by user',
  };
}

export function stkCallback(id: string, opts: { code?: number; amount?: number; receipt?: string } = {}) {
  const code = opts.code ?? 0;
  return {
    Body: {
      stkCallback: {
        MerchantRequestID: 'm-001',
        CheckoutRequestID: id,
        ResultCode: code,
        ResultDesc: code === 0 ? 'The service request is processed successfully.' : 'Request cancelled by user',
        ...(code === 0
          ? {
              CallbackMetadata: {
                Item: [
                  { Name: 'Amount', Value: opts.amount ?? 85000 },
                  { Name: 'MpesaReceiptNumber', Value: opts.receipt ?? 'TJN5X1Y2Z3' },
                  { Name: 'Balance' },
                  { Name: 'TransactionDate', Value: 20261023120102 },
                  { Name: 'PhoneNumber', Value: 254712345678 },
                ],
              },
            }
          : {}),
      },
    },
  };
}

export function pesapalStatus(over: Partial<TransactionStatusResponse> = {}): TransactionStatusResponse {
  return {
    payment_method: 'Visa',
    amount: 85000,
    confirmation_code: 'PSP-CONF-1',
    payment_status_description: 'Completed',
    description: '',
    status_code: 1,
    merchant_reference: 'WZ-XXXXXX-1',
    currency: 'KES',
    status: '200',
    error: null,
    ...over,
  };
}

export function fakeDaraja() {
  return {
    stkPush: vi.fn<Daraja['stkPush']>(async () => stkPushOk()),
    stkQuery: vi.fn<Daraja['stkQuery']>(async (id: string) => stkQueryResult('0', id)),
    reverse: vi.fn<Daraja['reverse']>(async () => ({
      OriginatorConversationID: 'orig-001',
      ConversationID: 'AG_001',
      ResponseCode: '0',
      ResponseDescription: 'Accept the service request successfully.',
    })),
    ping: vi.fn<Daraja['ping']>(async () => undefined),
  };
}

export function fakePesapal() {
  return {
    registerIpn: vi.fn<Pesapal['registerIpn']>(async (url: string) => ({ url, ipn_id: 'ipn-123' })),
    submitOrder: vi.fn<Pesapal['submitOrder']>(async (input) => ({
      order_tracking_id: `track-${input.merchantReference}`,
      merchant_reference: input.merchantReference,
      redirect_url: `https://cybqa.pesapal.com/iframe?OrderTrackingId=track-${input.merchantReference}`,
    })),
    transactionStatus: vi.fn<Pesapal['transactionStatus']>(async () => pesapalStatus()),
    refund: vi.fn<Pesapal['refund']>(async () => ({ status: '200', message: 'Refund request successfully' })),
    ping: vi.fn<Pesapal['ping']>(async () => undefined),
  };
}

export const processingError = () => new ProviderError('mpesa', 'mpesa error: The transaction is being processed', 500);

export function makeDeps(opts: { env?: Record<string, string | undefined>; mpesa?: boolean; pesapal?: boolean } = {}) {
  const config: PaymentConfig = loadPaymentConfig(opts.env ?? FULL_ENV);
  const time = clock();
  const persistence = memoryPersistence();
  const daraja = fakeDaraja();
  const pesapal = fakePesapal();
  const logs: { level: string; message: string; data?: Record<string, unknown> }[] = [];
  const notify = vi.fn<(e: PaymentEvent) => Promise<void>>(async () => undefined);
  const deps: PaymentDeps = {
    config,
    store: new QuoteStore(persistence),
    daraja: opts.mpesa === false ? undefined : daraja,
    pesapal: opts.pesapal === false ? undefined : pesapal,
    now: time.now,
    log: (level, message, data) => {
      logs.push(data ? { level, message, data } : { level, message });
    },
    notify,
  };
  return { deps, time, daraja, pesapal, persistence, logs, notify };
}
