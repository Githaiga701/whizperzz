import { describe, expect, it, vi } from 'vitest';
import { loadPaymentConfig } from '@/lib/payments/config';
import { createDaraja, darajaPassword, darajaTimestamp, friendlyResult, parseStkCallback } from '@/lib/payments/mpesa';
import { ProviderError } from '@/lib/payments/http';
import { FULL_ENV, clock, stkCallback } from '../helpers';

const config = loadPaymentConfig(FULL_ENV).mpesa!;

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

/** A fetch that answers Daraja's endpoints and records every call. */
function fakeFetch(overrides: Record<string, () => Response> = {}) {
  const calls: { url: string; init: RequestInit | undefined }[] = [];
  const fn = vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    const path = new URL(url).pathname;
    if (overrides[path]) return overrides[path]();
    if (path === '/oauth/v1/generate') return jsonResponse({ access_token: 'tok-1', expires_in: '3599' });
    if (path === '/mpesa/stkpush/v1/processrequest')
      return jsonResponse({ MerchantRequestID: 'm', CheckoutRequestID: 'ws_CO_1', ResponseCode: '0', ResponseDescription: 'ok', CustomerMessage: 'ok' });
    if (path === '/mpesa/stkpushquery/v1/query')
      return jsonResponse({ ResponseCode: '0', ResponseDescription: 'ok', MerchantRequestID: 'm', CheckoutRequestID: 'ws_CO_1', ResultCode: '0', ResultDesc: 'ok' });
    return jsonResponse({}, 404);
  });
  return { fn, calls };
}

describe('darajaTimestamp', () => {
  it('uses Nairobi time (UTC+3)', () => {
    expect(darajaTimestamp(new Date('2026-10-23T21:05:09Z'))).toBe('20261024000509');
  });
});

describe('darajaPassword', () => {
  it('is base64 of shortcode + passkey + timestamp', () => {
    const pw = darajaPassword('174379', 'key', '20261023120000');
    expect(Buffer.from(pw, 'base64').toString()).toBe('174379key20261023120000');
  });
});

describe('createDaraja', () => {
  it('sends a Paybill STK push with the right fields', async () => {
    const t = clock('2026-10-23T09:00:00Z');
    const { fn, calls } = fakeFetch();
    const daraja = createDaraja(config, fn, t.now);
    const res = await daraja.stkPush({ phone: '254712345678', amount: 85000, accountReference: 'WZ-ABCDEFGHJK', description: 'Whizperz trip payment' });
    expect(res.CheckoutRequestID).toBe('ws_CO_1');

    const auth = calls[0]!;
    expect(auth.url).toContain('/oauth/v1/generate?grant_type=client_credentials');
    expect((auth.init?.headers as Record<string, string>)['Authorization']).toBe(`Basic ${Buffer.from('ck:cs').toString('base64')}`);

    const push = calls[1]!;
    expect((push.init?.headers as Record<string, string>)['Authorization']).toBe('Bearer tok-1');
    const body = JSON.parse(String(push.init?.body));
    expect(body).toMatchObject({
      BusinessShortCode: '174379',
      Timestamp: '20261023120000',
      TransactionType: 'CustomerPayBillOnline',
      Amount: 85000,
      PartyA: '254712345678',
      PartyB: '174379',
      PhoneNumber: '254712345678',
      CallBackURL: 'https://whizperz.test/api/callbacks/mpesa/mpesa-cb-secret',
      AccountReference: 'WZ-ABCDEFGHJ',
      TransactionDesc: 'Whizperz trip',
    });
    expect(body.Password).toBe(darajaPassword('174379', 'passkey', '20261023120000'));
  });

  it('uses Buy Goods with the till number when a till is set', async () => {
    const { fn, calls } = fakeFetch();
    const daraja = createDaraja({ ...config, tillNumber: '5551234' }, fn);
    await daraja.stkPush({ phone: '254712345678', amount: 10, accountReference: 'WZ', description: 'x' });
    const body = JSON.parse(String(calls[1]!.init?.body));
    expect(body.TransactionType).toBe('CustomerBuyGoodsOnline');
    expect(body.PartyB).toBe('5551234');
    expect(body.BusinessShortCode).toBe('174379');
  });

  it('reuses the access token until it is about to expire', async () => {
    const t = clock();
    const { fn, calls } = fakeFetch();
    const daraja = createDaraja(config, fn, t.now);
    await daraja.stkQuery('a');
    await daraja.stkQuery('b');
    expect(calls.filter((c) => c.url.includes('oauth')).length).toBe(1);
    t.advance(3600 * 1000);
    await daraja.stkQuery('c');
    expect(calls.filter((c) => c.url.includes('oauth')).length).toBe(2);
  });

  it('refuses amounts M-Pesa cannot take', async () => {
    const { fn } = fakeFetch();
    const daraja = createDaraja(config, fn);
    await expect(daraja.stkPush({ phone: '254712345678', amount: 10.5, accountReference: 'x', description: 'x' })).rejects.toThrow(/whole shillings/);
    await expect(daraja.stkPush({ phone: '254712345678', amount: 0, accountReference: 'x', description: 'x' })).rejects.toThrow(ProviderError);
    expect(fn).not.toHaveBeenCalled();
  });

  it('raises a ProviderError with Daraja’s message on an error reply', async () => {
    const { fn } = fakeFetch({
      '/mpesa/stkpush/v1/processrequest': () => jsonResponse({ requestId: 'r', errorCode: '400.002.02', errorMessage: 'Bad Request - Invalid PhoneNumber' }, 400),
    });
    const daraja = createDaraja(config, fn);
    const err = await daraja.stkPush({ phone: '254712345678', amount: 1, accountReference: 'x', description: 'x' }).catch((e) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect(err.message).toContain('Invalid PhoneNumber');
    expect(err.status).toBe(400);
  });

  it('raises when Daraja does not accept the request', async () => {
    const { fn } = fakeFetch({
      '/mpesa/stkpush/v1/processrequest': () => jsonResponse({ ResponseCode: '1', ResponseDescription: 'Rejected', CheckoutRequestID: '' }),
    });
    await expect(createDaraja(config, fn).stkPush({ phone: '254712345678', amount: 1, accountReference: 'x', description: 'x' })).rejects.toThrow(/Rejected/);
  });

  it('raises a clear error when credentials are wrong', async () => {
    const { fn } = fakeFetch({ '/oauth/v1/generate': () => jsonResponse({ errorMessage: 'Invalid Authentication passed' }, 400) });
    await expect(createDaraja(config, fn).stkQuery('x')).rejects.toThrow(/Invalid Authentication/);
  });

  it('raises when the token reply has no token', async () => {
    const { fn } = fakeFetch({ '/oauth/v1/generate': () => jsonResponse({}) });
    await expect(createDaraja(config, fn).stkQuery('x')).rejects.toThrow(/access token/);
  });

  it('handles network failures and non-JSON replies', async () => {
    const down = vi.fn(async () => {
      throw new TypeError('fetch failed');
    });
    await expect(createDaraja(config, down).stkQuery('x')).rejects.toThrow(/Could not reach mpesa/);
    const html = vi.fn(async () => new Response('<html>Bad gateway</html>', { status: 502 }));
    await expect(createDaraja(config, html).stkQuery('x')).rejects.toThrow(/isn't JSON/);
  });
});

describe('parseStkCallback', () => {
  it('reads a successful payment', () => {
    expect(parseStkCallback(stkCallback('ws_CO_9', { amount: 500, receipt: 'ABC123' }))).toEqual({
      ok: true,
      checkoutRequestId: 'ws_CO_9',
      amount: 500,
      receipt: 'ABC123',
      phone: '254712345678',
    });
  });

  it('reads a cancelled payment with a friendly reason', () => {
    const r = parseStkCallback(stkCallback('ws_CO_9', { code: 1032 }));
    expect(r).toMatchObject({ ok: false, resultCode: 1032, reason: 'The payment was cancelled on the phone.' });
  });

  it('treats a success with missing details as a failure', () => {
    const body = stkCallback('ws_CO_9');
    body.Body.stkCallback.CallbackMetadata!.Item = [{ Name: 'Amount', Value: 1 }];
    expect(parseStkCallback(body)).toMatchObject({ ok: false, resultCode: -1 });
  });

  it.each([null, undefined, {}, { Body: {} }, { Body: { stkCallback: { ResultCode: '0' } } }, 'text'])('ignores %j', (body) => {
    expect(parseStkCallback(body)).toBeNull();
  });
});

describe('friendlyResult', () => {
  it('explains common codes and falls back to Daraja’s text', () => {
    expect(friendlyResult(1, '')).toMatch(/balance/);
    expect(friendlyResult(2001, '')).toMatch(/PIN/);
    expect(friendlyResult(1037, '')).toMatch(/reached/);
    expect(friendlyResult(9999, 'Something odd')).toBe('Something odd');
    expect(friendlyResult(9999, '')).toMatch(/did not go through/);
  });
});

describe('explaining M-Pesa failures', async () => {
  const { explainMpesaError, mpesaCallbackProblem } = await import('@/lib/payments/service');
  const { loadPaymentConfig } = await import('@/lib/payments/config');
  const keys = { MPESA_CONSUMER_KEY: 'k', MPESA_CONSUMER_SECRET: 's', MPESA_SHORTCODE: '174379', MPESA_PASSKEY: 'p', MPESA_CALLBACK_SECRET: 'cb' };

  it('flags a site address Safaricom cannot reach', () => {
    expect(mpesaCallbackProblem(loadPaymentConfig({ ...keys }))).toMatch(/localhost:4321/);
    expect(mpesaCallbackProblem(loadPaymentConfig({ ...keys, SITE_URL: 'http://tours.example.com' }))).toBeTruthy();
    expect(mpesaCallbackProblem(loadPaymentConfig({ ...keys, SITE_URL: 'https://tours.example.com' }))).toBeUndefined();
    // A local fake M-Pesa (the tests) can call a local site.
    expect(mpesaCallbackProblem(loadPaymentConfig({ ...keys, MPESA_BASE_URL: 'http://127.0.0.1:9' }))).toBeUndefined();
  });

  it('turns Safaricom errors into what to fix', () => {
    expect(explainMpesaError("Site address is http://localhost:4321, which Safaricom can't reach")).toMatch(/Site address/);
    expect(explainMpesaError('mpesa error: Invalid Access Token')).toMatch(/consumer key and secret/);
    expect(explainMpesaError('mpesa error: Bad Request - Invalid CallBackURL')).toMatch(/callback address/);
    expect(explainMpesaError('mpesa error: Merchant does not exist')).toMatch(/shortcode, passkey/);
    expect(explainMpesaError('mpesa error: Bad Request - Invalid TransactionType')).toMatch(/till number/);
    expect(explainMpesaError('Could not reach mpesa: fetch failed')).toMatch(/couldn’t connect/);
  });
});

describe('till numbers in the sandbox', () => {
  const keys = { SITE_URL: 'https://tours.example.com', MPESA_CONSUMER_KEY: 'k', MPESA_CONSUMER_SECRET: 's', MPESA_PASSKEY: 'p', MPESA_CALLBACK_SECRET: 'cb', MPESA_TILL_NUMBER: '5432100' };
  it('sets the till aside on test Paybill 174379, so prompts still go out', () => {
    const c = loadPaymentConfig({ ...keys, MPESA_SHORTCODE: '174379' });
    expect(c.mpesa?.tillNumber).toBeUndefined();
    expect(c.warnings.join(' ')).toMatch(/till number is ignored in the sandbox/);
  });
  it('keeps the till when live', () => {
    const c = loadPaymentConfig({ ...keys, MPESA_SHORTCODE: '7654321', PAYMENTS_MODE: 'production' });
    expect(c.mpesa?.tillNumber).toBe('5432100');
  });
});
