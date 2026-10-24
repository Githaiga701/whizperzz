import { describe, expect, it, vi } from 'vitest';
import { loadPaymentConfig } from '@/lib/payments/config';
import { createPesapal, mapPesapalStatus, parsePesapalIpn } from '@/lib/payments/pesapal';
import { FULL_ENV, clock, pesapalStatus } from '../helpers';

const config = loadPaymentConfig(FULL_ENV).pesapal!;

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function fakeFetch(overrides: Record<string, () => Response> = {}) {
  const calls: { url: string; init: RequestInit | undefined }[] = [];
  const fn = vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    const path = new URL(url).pathname.replace('/pesapalv3', '');
    if (overrides[path]) return overrides[path]();
    if (path === '/api/Auth/RequestToken') return jsonResponse({ token: 'ptok', expiryDate: '2026-10-23T09:05:00Z', error: null, status: '200' });
    if (path === '/api/Transactions/SubmitOrderRequest')
      return jsonResponse({ order_tracking_id: 'track-1', merchant_reference: 'WZ-ABCDEF-1', redirect_url: 'https://pay.test/x', error: null, status: '200' });
    if (path === '/api/Transactions/GetTransactionStatus') return jsonResponse(pesapalStatus());
    if (path === '/api/URLSetup/RegisterIPN') return jsonResponse({ url: 'u', ipn_id: 'new-ipn', error: null, status: '200' });
    return jsonResponse({}, 404);
  });
  return { fn, calls };
}

const order = {
  merchantReference: 'WZ-ABCDEF-1',
  amount: 85000,
  description: 'Wild to blue',
  callbackUrl: 'https://whizperz.test/pay/WZ-ABCDEF/?return=card',
  email: 'jane@example.com',
  phone: undefined,
  firstName: 'Jane',
};

describe('createPesapal', () => {
  it('signs in, then submits an order with the IPN id', async () => {
    const { fn, calls } = fakeFetch();
    const res = await createPesapal(config, fn).submitOrder(order);
    expect(res.redirect_url).toBe('https://pay.test/x');
    expect(calls[0]!.url).toBe('https://cybqa.pesapal.com/pesapalv3/api/Auth/RequestToken');
    expect(JSON.parse(String(calls[0]!.init?.body))).toEqual({ consumer_key: 'pk', consumer_secret: 'ps' });
    const body = JSON.parse(String(calls[1]!.init?.body));
    expect(body).toMatchObject({
      id: 'WZ-ABCDEF-1',
      currency: 'KES',
      amount: 85000,
      notification_id: 'ipn-123',
      callback_url: order.callbackUrl,
      billing_address: { email_address: 'jane@example.com', first_name: 'Jane', country_code: 'KE' },
    });
    expect((calls[1]!.init?.headers as Record<string, string>)['Authorization']).toBe('Bearer ptok');
  });

  it('caches the token for four minutes', async () => {
    const t = clock();
    const { fn, calls } = fakeFetch();
    const p = createPesapal(config, fn, t.now);
    await p.transactionStatus('a');
    t.advance(3 * 60_000);
    await p.transactionStatus('b');
    expect(calls.filter((c) => c.url.includes('RequestToken')).length).toBe(1);
    t.advance(2 * 60_000);
    await p.transactionStatus('c');
    expect(calls.filter((c) => c.url.includes('RequestToken')).length).toBe(2);
  });

  it('encodes the tracking id in the status request', async () => {
    const { fn, calls } = fakeFetch();
    await createPesapal(config, fn).transactionStatus('a b&c');
    expect(calls[1]!.url).toContain('orderTrackingId=a%20b%26c');
    expect(calls[1]!.init?.method).toBe('GET');
  });

  it('turns Pesapal error objects (sent with HTTP 200) into errors', async () => {
    const { fn } = fakeFetch({
      '/api/Transactions/SubmitOrderRequest': () =>
        jsonResponse({ error: { error_type: 'api_error', code: 'invalid_notification_id', message: 'Invalid notification id' }, status: '500' }),
    });
    await expect(createPesapal(config, fn).submitOrder(order)).rejects.toThrow(/Invalid notification id/);
  });

  it('reports bad credentials clearly', async () => {
    const { fn } = fakeFetch({
      '/api/Auth/RequestToken': () => jsonResponse({ token: null, error: { code: 'invalid_consumer_key_or_secret_provided', message: '' }, status: '500' }),
    });
    await expect(createPesapal(config, fn).transactionStatus('x')).rejects.toThrow(/invalid_consumer_key/);
  });

  it('will not submit without an IPN id or payer contact', async () => {
    const { fn } = fakeFetch();
    await expect(createPesapal({ ...config, ipnId: undefined }, fn).submitOrder(order)).rejects.toThrow(/PESAPAL_IPN_ID/);
    await expect(createPesapal(config, fn).submitOrder({ ...order, email: undefined })).rejects.toThrow(/email address or phone/);
    expect(fn).not.toHaveBeenCalled();
  });

  it('registers an IPN as POST', async () => {
    const { fn, calls } = fakeFetch();
    const res = await createPesapal(config, fn).registerIpn('https://whizperz.test/ipn');
    expect(res.ipn_id).toBe('new-ipn');
    expect(JSON.parse(String(calls[1]!.init?.body))).toEqual({ url: 'https://whizperz.test/ipn', ipn_notification_type: 'POST' });
  });

  it('caps the description at 100 characters', async () => {
    const { fn, calls } = fakeFetch();
    await createPesapal(config, fn).submitOrder({ ...order, description: 'x'.repeat(150) });
    expect(JSON.parse(String(calls[1]!.init?.body)).description).toHaveLength(100);
  });
});

describe('mapPesapalStatus', () => {
  it.each([
    [1, 'paid'],
    [2, 'failed'],
    [3, 'failed'],
    [0, 'pending'],
    [99, 'pending'],
  ] as const)('%i → %s', (code, outcome) => {
    expect(mapPesapalStatus(code)).toBe(outcome);
  });
});

describe('parsePesapalIpn', () => {
  it('reads the IPN fields', () => {
    expect(parsePesapalIpn({ OrderTrackingId: 't', OrderMerchantReference: 'm', OrderNotificationType: 'IPNCHANGE' })).toEqual({
      OrderTrackingId: 't',
      OrderMerchantReference: 'm',
      OrderNotificationType: 'IPNCHANGE',
    });
  });
  it('defaults the notification type', () => {
    expect(parsePesapalIpn({ OrderTrackingId: 't', OrderMerchantReference: 'm' })?.OrderNotificationType).toBe('IPNCHANGE');
  });
  it.each([{}, { OrderTrackingId: '' , OrderMerchantReference: 'm' }, { OrderTrackingId: 't' }, { OrderTrackingId: 1, OrderMerchantReference: 'm' }])('rejects %j', (input) => {
    expect(parsePesapalIpn(input)).toBeNull();
  });
});
