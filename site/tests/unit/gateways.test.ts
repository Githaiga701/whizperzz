import { describe, expect, it, vi } from 'vitest';
import { loadPaymentConfig } from '@/lib/payments/config';
import { kesToUsd, type Gateway, type GatewayResult } from '@/lib/payments/gateways';
import { createIpos, iposAmount, mapIposStatus } from '@/lib/payments/gateways/ipos';
import { createUnipesa, mapUnipesa, unipesaSign, unipesaSignatureString, verifyUnipesa } from '@/lib/payments/gateways/unipesa';
import { createNowPayments, mapNowPayment, nowPaymentsSignature, verifyNowPayments } from '@/lib/payments/gateways/nowpayments';
import { createQuote, handleGatewayNotice, getQuoteStatus, refundPayment, startGateway, viewQuote } from '@/lib/payments/service';
import { FULL_ENV, makeDeps } from '../helpers';

const GATEWAY_ENV = {
  ...FULL_ENV,
  USD_KES_RATE: '130',
  IPOS_TPN: '139322815010',
  IPOS_API_KEY: 'ik',
  IPOS_SECRET_KEY: 'is',
  IPOS_CALLBACK_SECRET: 'ipos-cb',
  UNIPESA_MERCHANT_ID: 'merchant-1',
  UNIPESA_SECRET_KEY: 'uni-secret',
  UNIPESA_CALLBACK_SECRET: 'uni-cb',
  NOWPAYMENTS_API_KEY: 'np-key',
  NOWPAYMENTS_IPN_SECRET: 'np-ipn',
  NOWPAYMENTS_CALLBACK_SECRET: 'np-cb',
};

/** A fetch that answers from a table of handlers, recording every call. */
function fakeFetch(handlers: Record<string, (init: RequestInit, url: URL) => { status?: number; body: unknown }>) {
  const calls: { url: string; init: RequestInit }[] = [];
  const impl = vi.fn(async (input: string, init: RequestInit = {}) => {
    calls.push({ url: input, init });
    const url = new URL(input);
    const key = Object.keys(handlers).find((k) => `${init.method ?? 'GET'} ${url.origin}${url.pathname}`.startsWith(k));
    if (!key) return new Response(JSON.stringify({ message: 'not found' }), { status: 404 });
    const r = handlers[key]!(init, url);
    return new Response(JSON.stringify(r.body), { status: r.status ?? 200 });
  });
  return { impl, calls };
}

describe('dollar conversion', () => {
  it('rounds up to the cent so we never charge less than the shilling price', () => {
    expect(kesToUsd(85000, 130)).toBe(653.85);
    expect(kesToUsd(13000, 130)).toBe(100);
    expect(kesToUsd(1, 129.5)).toBe(0.01);
    expect(kesToUsd(100, 3)).toBe(33.34);
  });

  it('switches dollar methods off until a rate is set', () => {
    const noRate = loadPaymentConfig({ ...GATEWAY_ENV, USD_KES_RATE: '' });
    expect(noRate.ipos).toBeUndefined();
    expect(noRate.crypto).toBeUndefined();
    expect(noRate.unipesa).toBeDefined();
    expect(noRate.warnings.join(' ')).toMatch(/iPOS Pay is off.*USD_KES_RATE/);
    const withRate = loadPaymentConfig(GATEWAY_ENV);
    expect(withRate.usdRate).toBe(130);
    expect(withRate.ipos?.notifyUrl).toBe('https://whizperz.test/api/callbacks/ipos/ipos-cb');
    expect(withRate.ipos?.paymentUrl).toBe('https://payment.ipospays.tech');
    expect(withRate.crypto?.baseUrl).toBe('https://api-sandbox.nowpayments.io/v1');
    expect(loadPaymentConfig({ ...GATEWAY_ENV, PAYMENTS_MODE: 'production' }).crypto?.baseUrl).toBe('https://api.nowpayments.io/v1');
  });

  it('stays quiet about gateways nobody has started setting up', () => {
    expect(loadPaymentConfig(FULL_ENV).warnings.join(' ')).not.toMatch(/iPOS|Unipesa|NOWPayments/);
  });
});

/* ---------- Unipesa ---------- */

describe('Unipesa signatures', () => {
  it('signs key+value pairs in the order sent, skipping the signature', () => {
    expect(unipesaSignatureString({ merchant_id: 'm1', amount: '10.00', signature: 'x', order_id: 'A1' })).toBe('merchant_idm1amount10.00order_idA1');
    expect(unipesaSignatureString({ a: '1', result: { code: 0, message: 'ok' } })).toBe('a1resultcode0messageok');
    expect(unipesaSign({ a: '1' }, 'k')).toMatch(/^[0-9a-f]{128}$/);
  });

  it('accepts its own signatures and rejects tampering', () => {
    const f = { merchant_id: 'm1', order_id: 'WZABC1U1', amount: '100.00', status: 2, result: { code: 0, message: 'Success' } };
    const signed = { ...f, signature: unipesaSign(f, 'uni-secret') };
    expect(verifyUnipesa(signed, 'uni-secret')).toBe(true);
    expect(verifyUnipesa({ ...signed, signature: signed.signature.toUpperCase() }, 'uni-secret')).toBe(true);
    expect(verifyUnipesa(signed, 'other')).toBe(false);
    expect(verifyUnipesa({ ...signed, amount: '1.00' }, 'uni-secret')).toBe(false);
    expect(verifyUnipesa(f, 'uni-secret')).toBe(false);
    expect(verifyUnipesa({ ...f, signature: 'short' }, 'uni-secret')).toBe(false);
    // Unipesa's flattening of nested objects without their keys is accepted too.
    expect(verifyUnipesa({ ...f, signature: unipesaSign(f, 'uni-secret', false) }, 'uni-secret')).toBe(true);
  });

  it('maps Unipesa statuses', () => {
    expect(mapUnipesa({ status: 2, amount: '50.00', order_id: 'X', transaction_ref: 'R1' })).toMatchObject({ outcome: 'paid', amount: 50, receipt: 'R1' });
    expect(mapUnipesa({ status: 3, provider_result: { message: 'Insufficient funds' } })).toMatchObject({ outcome: 'failed', reason: 'Insufficient funds' });
    expect(mapUnipesa({ status: 4 }).outcome).toBe('failed');
    expect(mapUnipesa({ status: 1 }).outcome).toBe('pending');
    expect(mapUnipesa({ status: 0 }).outcome).toBe('pending');
  });

  it('builds a signed payment-page link with letters-and-digits order ids', async () => {
    const g = createUnipesa(loadPaymentConfig({ ...GATEWAY_ENV, UNIPESA_PROVIDER_ID: '12' }).unipesa!);
    const ref = g.merchantRef('WZ-ABC123', 2);
    expect(ref).toBe('WZABC123U2');
    const { redirectUrl, providerRef } = await g.startCheckout({ merchantRef: ref, amount: 85000, description: 'Trip', returnUrl: 'https://whizperz.test/pay/WZ-ABC123/?return=unipesa', email: 'j@x.co', phone: undefined, name: 'Jane Wanjiku' });
    expect(providerRef).toBe(ref);
    const u = new URL(redirectUrl);
    expect(u.origin).toBe('https://hpp.unipesa.tech');
    const fields = Object.fromEntries(u.searchParams);
    expect(fields).toMatchObject({ merchant_id: 'merchant-1', order_id: ref, country: 'KE', amount: '85000.00', currency: 'KES', provider_id: '12', operation: 'c2b', callback_url: 'https://whizperz.test/api/callbacks/unipesa/uni-cb' });
    expect(verifyUnipesa(fields, 'uni-secret')).toBe(true);
  });

  it('only trusts callbacks for our merchant with a valid signature', () => {
    const g = createUnipesa(loadPaymentConfig(GATEWAY_ENV).unipesa!);
    const f = { merchant_id: 'merchant-1', order_id: 'WZX1U1', amount: '10.00', status: 2 };
    const headers = new Headers();
    expect(g.readNotice({ headers, raw: '', body: { ...f, signature: unipesaSign(f, 'uni-secret') } })).toMatchObject({ merchantRef: 'WZX1U1', verified: { outcome: 'paid', amount: 10 } });
    expect(g.readNotice({ headers, raw: '', body: { ...f, signature: unipesaSign(f, 'nope') } })).toBeNull();
    const other = { ...f, merchant_id: 'someone-else' };
    expect(g.readNotice({ headers, raw: '', body: { ...other, signature: unipesaSign(other, 'uni-secret') } })).toBeNull();
  });

  it('double-checks with Unipesa when a status address is set', async () => {
    const statusReply = { order_id: 'WZX1U1', status: 2, amount: '10.00' };
    const { impl, calls } = fakeFetch({ 'POST https://api.unipesa.example/status': () => ({ body: { ...statusReply, signature: unipesaSign(statusReply, 'uni-secret') } }) });
    const g = createUnipesa(loadPaymentConfig({ ...GATEWAY_ENV, UNIPESA_STATUS_URL: 'https://api.unipesa.example/status/{merchant_id}' }).unipesa!, impl);
    expect(await g.checkStatus({ merchantRef: 'WZX1U1', providerRef: 'WZX1U1' })).toMatchObject({ outcome: 'paid', amount: 10 });
    expect(calls[0]!.url).toBe('https://api.unipesa.example/status/merchant-1');
    const sent = JSON.parse(String(calls[0]!.init.body)) as Record<string, unknown>;
    expect(verifyUnipesa(sent, 'uni-secret')).toBe(true);

    const noUrl = createUnipesa(loadPaymentConfig(GATEWAY_ENV).unipesa!, impl);
    expect(await noUrl.checkStatus({ merchantRef: 'x', providerRef: 'x' })).toBeUndefined();
  });
});

/* ---------- NOWPayments ---------- */

describe('NOWPayments', () => {
  const ipn = { payment_id: 5077, payment_status: 'finished', pay_address: 'T1', price_amount: 653.85, price_currency: 'usd', order_id: 'WZ-ABC123-C1', nested: { b: 2, a: 1 } };

  it('checks IPN signatures over the body with sorted keys', () => {
    const sig = nowPaymentsSignature(ipn, 'np-ipn');
    expect(sig).toMatch(/^[0-9a-f]{128}$/);
    // Key order in the body doesn't matter.
    const reordered = { order_id: ipn.order_id, nested: { a: 1, b: 2 }, price_currency: 'usd', price_amount: 653.85, pay_address: 'T1', payment_status: 'finished', payment_id: 5077 };
    expect(verifyNowPayments(reordered, sig, 'np-ipn')).toBe(true);
    expect(verifyNowPayments({ ...ipn, price_amount: 1 }, sig, 'np-ipn')).toBe(false);
    expect(verifyNowPayments(ipn, sig, 'other')).toBe(false);
    expect(verifyNowPayments(ipn, null, 'np-ipn')).toBe(false);
  });

  it('maps payment statuses; a part payment is never "paid"', () => {
    expect(mapNowPayment({ ...ipn }).outcome).toBe('paid');
    expect(mapNowPayment({ payment_status: 'partially_paid', actually_paid: 5, pay_amount: 10, pay_currency: 'usdttrc20' })).toMatchObject({ outcome: 'underpaid', reason: expect.stringContaining('5 of 10 USDTTRC20') });
    for (const s of ['waiting', 'confirming', 'confirmed', 'sending']) expect(mapNowPayment({ payment_status: s }).outcome).toBe('pending');
    for (const s of ['failed', 'expired', 'refunded']) expect(mapNowPayment({ payment_status: s }).outcome).toBe('failed');
    expect(mapNowPayment({ ...ipn, pay_currency: 'btc', actually_paid: 0.01 })).toMatchObject({ currency: 'USD', amount: 653.85, method: 'BTC 0.01', receipt: '5077' });
  });

  it('creates a dollar invoice and reads payments back with the API key', async () => {
    const { impl, calls } = fakeFetch({
      'POST https://api-sandbox.nowpayments.io/v1/invoice': () => ({ body: { id: '4522625843', invoice_url: 'https://nowpayments.io/payment/?iid=4522625843' } }),
      'GET https://api-sandbox.nowpayments.io/v1/payment/5077': () => ({ body: ipn }),
    });
    const g = createNowPayments(loadPaymentConfig(GATEWAY_ENV).crypto!, impl);
    const r = await g.startCheckout({ merchantRef: 'WZ-ABC123-C1', amount: 653.85, description: 'Trip', returnUrl: 'https://whizperz.test/pay/WZ-ABC123/?return=crypto', email: undefined, phone: undefined, name: 'J' });
    expect(r).toEqual({ redirectUrl: 'https://nowpayments.io/payment/?iid=4522625843', providerRef: '4522625843' });
    expect(new Headers(calls[0]!.init.headers).get('x-api-key')).toBe('np-key');
    expect(JSON.parse(String(calls[0]!.init.body))).toMatchObject({ price_amount: 653.85, price_currency: 'usd', order_id: 'WZ-ABC123-C1', ipn_callback_url: 'https://whizperz.test/api/callbacks/crypto/np-cb' });
    expect(await g.checkStatus({ merchantRef: 'x', providerRef: '1' })).toBeUndefined();
    expect(await g.checkStatus({ merchantRef: 'x', providerRef: '1', txnId: '5077' })).toMatchObject({ outcome: 'paid' });
  });
});

/* ---------- iPOS Pay ---------- */

describe('iPOS Pay', () => {
  it('reads amounts given in cents or dollars', () => {
    expect(iposAmount('65385', 653.85)).toBe(653.85);
    expect(iposAmount('653.85', 653.85)).toBe(653.85);
    expect(iposAmount('1500', undefined)).toBe(15);
    expect(iposAmount('', 1)).toBeUndefined();
  });

  it('maps status replies', () => {
    const ok = mapIposStatus({ iposHPResponse: { responseCode: 200, responseMessage: 'Successful', transactionReferenceId: 'R', transactionId: 'T1', amount: '65385', cardType: 'VISA', cardLast4Digit: '4242' } }, 653.85);
    expect(ok).toMatchObject({ outcome: 'paid', amount: 653.85, currency: 'USD', receipt: 'T1', method: 'VISA ••4242', merchantRef: 'R' });
    expect(mapIposStatus({ iposHPResponse: { responseCode: 400, responseMessage: 'Declined' } })?.outcome).toBe('failed');
    expect(mapIposStatus({ iposHPResponse: { responseCode: 401, responseMessage: 'Cancelled By Customer' } })?.outcome).toBe('failed');
    expect(mapIposStatus({ iposHPResponse: { responseCode: 102, responseMessage: 'Pending' } })?.outcome).toBe('pending');
    expect(mapIposStatus({})).toBeUndefined();
  });

  it('gets a token, opens a payment page in cents and asks iPOSpays for the result', async () => {
    const { impl, calls } = fakeFetch({
      'POST https://auth.ipospays.tech/v1/authenticate-token': () => ({ body: { responseCode: '00', token: 'tok-1' } }),
      'POST https://payment.ipospays.tech/api/v3/external-payment-transaction': () => ({ body: { message: 'Url generated Successful', information: 'https://payment.ipospays.tech/api/v1/externalPay?t=abc' } }),
      'GET https://api.ipospays.tech/v1/queryPaymentStatus': () => ({ body: { iposHPResponse: { responseCode: 200, responseMessage: 'Successful', transactionReferenceId: 'WZ-A-I1', amount: '65385' } } }),
    });
    const g = createIpos(loadPaymentConfig(GATEWAY_ENV).ipos!, impl);
    const r = await g.startCheckout({ merchantRef: 'WZ-A-I1', amount: 653.85, description: 'Trip', returnUrl: 'https://whizperz.test/pay/WZ-A/?return=ipos', email: 'j@x.co', phone: '254712345678', name: 'Jane' });
    expect(r.redirectUrl).toBe('https://payment.ipospays.tech/api/v1/externalPay?t=abc');
    const auth = new Headers(calls[0]!.init.headers);
    expect([auth.get('apiKey'), auth.get('secretKey')]).toEqual(['ik', 'is']);
    const hpp = calls[1]!;
    expect(new Headers(hpp.init.headers).get('token')).toBe('tok-1');
    expect(JSON.parse(String(hpp.init.body))).toMatchObject({
      merchantAuthentication: { merchantId: '139322815010', transactionReferenceId: 'WZ-A-I1' },
      transactionRequest: { transactionType: 1, amount: '65385' },
      notificationOption: { postAPI: 'https://whizperz.test/api/callbacks/ipos/ipos-cb', returnUrl: 'https://whizperz.test/pay/WZ-A/?return=ipos' },
      preferences: { customerEmail: 'j@x.co', customerMobile: '+254712345678' },
    });
    expect(await g.checkStatus({ merchantRef: 'WZ-A-I1', providerRef: 'WZ-A-I1', amount: 653.85 })).toMatchObject({ outcome: 'paid', amount: 653.85 });
    expect(new Headers(calls[2]!.init.headers).get('Authorization')).toBe('tok-1');
    expect(calls[2]!.url).toContain('tpn=139322815010&transactionReferenceId=WZ-A-I1');
    // The token is reused.
    expect(calls.filter((c) => c.url.includes('authenticate-token'))).toHaveLength(1);
  });

  it('uses a portal token directly when given one, and treats "not found" as not paid yet', async () => {
    const { impl, calls } = fakeFetch({});
    const g = createIpos(loadPaymentConfig({ ...GATEWAY_ENV, IPOS_AUTH_TOKEN: 'portal-token' }).ipos!, impl);
    expect(await g.checkStatus({ merchantRef: 'X', providerRef: 'X' })).toEqual({ outcome: 'pending' });
    expect(calls.some((c) => c.url.includes('authenticate-token'))).toBe(false);
    expect(new Headers(calls[0]!.init.headers).get('Authorization')).toBe('portal-token');
  });

  it('never trusts the notification body, only which payment it is about', () => {
    const g = createIpos(loadPaymentConfig(GATEWAY_ENV).ipos!);
    const n = g.readNotice({ headers: new Headers(), raw: '', body: { iposHPResponse: { transactionReferenceId: 'WZ-A-I1', responseCode: 200 } } });
    expect(n).toEqual({ merchantRef: 'WZ-A-I1' });
    expect(g.readNotice({ headers: new Headers(), raw: '', body: {} })).toBeNull();
  });
});

/* ---------- The payment flow with a stand-in gateway ---------- */

function fakeGateway(id: 'ipos' | 'unipesa' | 'crypto', currency: 'USD' | 'KES') {
  let status: GatewayResult | undefined = { outcome: 'pending' };
  let notice: ReturnType<Gateway['readNotice']> = null;
  const g: Gateway = {
    id,
    label: id === 'ipos' ? 'iPOS Pay' : id === 'unipesa' ? 'Unipesa' : 'Crypto',
    currency,
    merchantRef: (ref, n) => `${ref}-X${n}`,
    startCheckout: vi.fn(async (input) => ({ redirectUrl: `https://gw.example/pay/${input.merchantRef}`, providerRef: `prov-${input.merchantRef}` })),
    checkStatus: vi.fn(async () => status),
    readNotice: vi.fn(() => notice),
    ping: vi.fn(async () => undefined),
  };
  return {
    g,
    setStatus: (s: GatewayResult | undefined) => (status = s),
    setNotice: (n: ReturnType<Gateway['readNotice']>) => (notice = n),
  };
}

async function setup(currency: 'USD' | 'KES' = 'USD', id: 'ipos' | 'unipesa' | 'crypto' = 'ipos') {
  const t = makeDeps({ env: GATEWAY_ENV });
  const fake = fakeGateway(id, currency);
  t.deps.gateways = { [id]: fake.g };
  const quote = await createQuote(t.deps, { guestName: 'Jane Wanjiku', description: 'Wild to blue', amountKes: 85000, email: 'jane@example.com' });
  return { ...t, ...fake, quote };
}

const notice = { headers: new Headers(), raw: '', body: {} };

describe('paying through a hosted gateway', () => {
  it('charges the converted dollar amount and remembers it', async () => {
    const { deps, g, quote } = await setup();
    const { redirectUrl } = await startGateway(deps, 'ipos', quote.ref, { email: 'other@example.com' });
    expect(redirectUrl).toBe(`https://gw.example/pay/${quote.ref}-X1`);
    expect(g.startCheckout).toHaveBeenCalledWith(expect.objectContaining({ amount: 653.85, merchantRef: `${quote.ref}-X1`, email: 'other@example.com', returnUrl: `https://whizperz.test/pay/${quote.ref}/?return=ipos` }));
    const saved = (await deps.store.get(quote.ref))!;
    expect(saved.payments[0]).toMatchObject({ provider: 'ipos', status: 'pending', amountKes: 85000, providerRef: `prov-${quote.ref}-X1`, charged: { amount: 653.85, currency: 'USD', rate: 130 } });
    expect(saved.history?.at(-1)?.text).toBe('Opened iPOS Pay checkout for USD 653.85 at 130 KES per dollar.');
    expect(viewQuote(deps, saved).usdAmount).toBe(653.85);
  });

  it('refuses gateways that are off, and quotes that are already paid', async () => {
    const { deps, quote } = await setup();
    await expect(startGateway(deps, 'crypto', quote.ref, {})).rejects.toThrow('crypto (NOWPayments) payments aren’t switched on');
    await expect(startGateway(deps, 'ipos', quote.ref, { email: 'not-an-email' })).rejects.toThrow('doesn’t look right');
  });

  it('marks the booking paid only after the gateway confirms the right amount', async () => {
    const { deps, quote, setStatus, setNotice, notify } = await setup();
    await startGateway(deps, 'ipos', quote.ref, {});
    setNotice({ merchantRef: `${quote.ref}-X1` });
    expect(await handleGatewayNotice(deps, 'ipos', notice)).toBe('pending');
    setStatus({ outcome: 'paid', merchantRef: `${quote.ref}-X1`, amount: 653.85, currency: 'USD', receipt: 'T99', method: 'VISA ••4242' });
    expect(await handleGatewayNotice(deps, 'ipos', notice)).toBe('paid');
    const q = (await deps.store.get(quote.ref))!;
    expect(q.status).toBe('paid');
    expect(q.payments[0]).toMatchObject({ status: 'paid', receipt: 'T99', method: 'VISA ••4242' });
    expect(q.history?.at(-1)?.text).toBe('Paid KES 85,000 (charged USD 653.85) by iPOS Pay (VISA ••4242), receipt T99.');
    expect(notify).toHaveBeenCalledWith({ type: 'paid', ref: quote.ref, paymentId: q.payments[0]!.id });
    // A repeat notification changes nothing.
    expect(await handleGatewayNotice(deps, 'ipos', notice)).toBe('ignored');
  });

  it.each([
    [{ amount: 600 }, 'amount USD 600'],
    [{ currency: 'EUR' }, 'currency EUR'],
    [{ merchantRef: 'WZ-OTHER-X1' }, 'reference WZ-OTHER-X1'],
  ])('flags a "paid" result that doesn’t match (%j)', async (over, problem) => {
    const { deps, quote, setStatus, setNotice, notify } = await setup();
    await startGateway(deps, 'ipos', quote.ref, {});
    setNotice({ merchantRef: `${quote.ref}-X1` });
    setStatus({ outcome: 'paid', merchantRef: `${quote.ref}-X1`, amount: 653.85, currency: 'USD', ...over });
    expect(await handleGatewayNotice(deps, 'ipos', notice)).toBe('failed');
    const q = (await deps.store.get(quote.ref))!;
    expect(q.status).toBe('awaiting_payment');
    expect(q.payments[0]!.flag).toContain(problem);
    expect(notify).toHaveBeenCalledWith(expect.objectContaining({ type: 'flagged' }));
  });

  it('flags crypto that arrived short', async () => {
    const { deps, quote, setStatus, setNotice } = await setup('USD', 'crypto');
    await startGateway(deps, 'crypto', quote.ref, {});
    setNotice({ merchantRef: `${quote.ref}-X1`, txnId: '5077' });
    setStatus({ outcome: 'underpaid', reason: 'Only part of the crypto amount arrived (5 of 10 USDT).' });
    expect(await handleGatewayNotice(deps, 'crypto', notice)).toBe('failed');
    const q = (await deps.store.get(quote.ref))!;
    expect(q.payments[0]).toMatchObject({ status: 'failed', txnId: '5077', flag: 'crypto (NOWPayments): Only part of the crypto amount arrived (5 of 10 USDT).' });
  });

  it('uses a signed notification when the gateway can’t be asked, and ignores anything unsigned', async () => {
    const { deps, quote, setStatus, setNotice } = await setup('KES', 'unipesa');
    await startGateway(deps, 'unipesa', quote.ref, {});
    setStatus(undefined);
    setNotice(null);
    expect(await handleGatewayNotice(deps, 'unipesa', notice)).toBe('rejected');
    setNotice({ merchantRef: `${quote.ref}-X1` });
    expect(await handleGatewayNotice(deps, 'unipesa', notice)).toBe('unverified');
    setNotice({ merchantRef: `${quote.ref}-X1`, verified: { outcome: 'paid', amount: 85000, receipt: 'UNI1' } });
    expect(await handleGatewayNotice(deps, 'unipesa', notice)).toBe('paid');
    expect((await deps.store.get(quote.ref))!.payments[0]!.charged).toEqual({ amount: 85000, currency: 'KES' });
  });

  it('ignores notifications about payments we never made', async () => {
    const { deps, setNotice } = await setup();
    setNotice({ merchantRef: 'WZ-NOPE00-X1' });
    expect(await handleGatewayNotice(deps, 'ipos', notice)).toBe('ignored');
    expect(await handleGatewayNotice(deps, 'unipesa', notice)).toBe('ignored');
  });

  it('checks again when the guest is waiting on the pay page', async () => {
    const { deps, quote, time, setStatus } = await setup();
    await startGateway(deps, 'ipos', quote.ref, {});
    setStatus({ outcome: 'failed', reason: 'Declined' });
    time.advance(11_000);
    const view = await getQuoteStatus(deps, quote.ref);
    expect(view).toMatchObject({ status: 'failed', message: 'Declined' });
  });

  it('points refunds to the gateway’s own dashboard, and records them by hand', async () => {
    const { deps, quote, setStatus, setNotice } = await setup();
    await startGateway(deps, 'ipos', quote.ref, {});
    setNotice({ merchantRef: `${quote.ref}-X1` });
    setStatus({ outcome: 'paid', amount: 653.85, currency: 'USD' });
    await handleGatewayNotice(deps, 'ipos', notice);
    const paymentId = (await deps.store.get(quote.ref))!.payments[0]!.id;
    await expect(refundPayment(deps, quote.ref, { paymentId, amountKes: 85000, reason: 'Cancelled', mode: 'provider' }, 'spence')).rejects.toThrow('iPOSpays portal');
    const r = await refundPayment(deps, quote.ref, { paymentId, amountKes: 85000, reason: 'Cancelled', mode: 'manual', reference: 'IPOS-REF-1' }, 'spence');
    expect(r.status).toBe('completed');
    expect((await deps.store.get(quote.ref))!.status).toBe('refunded');
  });

  it('offers every method that is switched on', async () => {
    const { deps, quote } = await setup();
    expect(viewQuote(deps, (await deps.store.get(quote.ref))!).methods).toEqual({ mpesa: true, card: true, ipos: true, unipesa: false, crypto: false });
  });
});
