import { describe, expect, it, vi } from 'vitest';
import { loadPaymentConfig } from '@/lib/payments/config';
import { createPaystack, mapPaystack, paystackReference, paystackSignature, verifyPaystack } from '@/lib/payments/gateways/paystack';
import { createQuote, handleGatewayNotice, startGateway } from '@/lib/payments/service';
import { FULL_ENV, makeDeps } from '../helpers';

const KEY = 'sk_test_unitpaystackkey0001';
const ENV = { ...FULL_ENV, PAYSTACK_SECRET_KEY: KEY, PAYSTACK_CALLBACK_SECRET: 'ps-cb' };

function fakeFetch(handler: (url: URL, init: RequestInit) => { status?: number; body: unknown }) {
  const calls: { url: string; init: RequestInit }[] = [];
  const impl = vi.fn(async (input: string, init: RequestInit = {}) => {
    calls.push({ url: input, init });
    const r = handler(new URL(input), init);
    return new Response(JSON.stringify(r.body), { status: r.status ?? 200 });
  });
  return { impl, calls };
}

describe('Paystack settings', () => {
  it('is off until the secret key and callback secret are there', () => {
    expect(loadPaymentConfig(FULL_ENV).paystack).toBeUndefined();
    const c = loadPaymentConfig(ENV).paystack!;
    expect(c.baseUrl).toBe('https://api.paystack.co');
    expect(c.testKey).toBe(true);
    expect(c.notifyUrl).toMatch(/\/api\/callbacks\/paystack\/ps-cb$/);
  });

  it('warns when a test key is used for live payments, or a live key in sandbox', () => {
    expect(loadPaymentConfig({ ...ENV, PAYMENTS_MODE: 'production', SITE_URL: 'https://x.example' }).warnings.join(' ')).toMatch(/test key/);
    expect(loadPaymentConfig({ ...ENV, PAYSTACK_SECRET_KEY: 'sk_live_abc1234567890' }).warnings.join(' ')).toMatch(/Real money/);
  });

  it('keeps only payment options Paystack knows', () => {
    expect(loadPaymentConfig({ ...ENV, PAYSTACK_CHANNELS: 'card, Mobile_Money, ussd' }).paystack!.channels).toEqual(['card', 'mobile_money']);
  });
});

describe('Paystack references and signatures', () => {
  it('makes references Paystack accepts, unique per attempt', () => {
    const a = paystackReference('WZ-ABC123', 1);
    expect(a).toMatch(/^WZ-ABC123-PS1-[0-9a-f]{6}$/);
    expect(paystackReference('WZ-ABC123', 1)).not.toBe(a);
    expect(paystackReference('WZ/ÄB C', 2, 'x')).toBe('WZBC-PS2-x');
  });

  it('accepts only the HMAC-SHA512 of the exact body, made with our secret key', () => {
    const raw = '{"event":"charge.success","data":{"reference":"R1","amount":100}}';
    const sig = paystackSignature(raw, KEY);
    expect(verifyPaystack(raw, sig, KEY)).toBe(true);
    expect(verifyPaystack(raw, sig.toUpperCase(), KEY)).toBe(true);
    expect(verifyPaystack(raw.replace('100', '1'), sig, KEY)).toBe(false);
    expect(verifyPaystack(raw, paystackSignature(raw, 'sk_test_other'), KEY)).toBe(false);
    expect(verifyPaystack(raw, null, KEY)).toBe(false);
    expect(verifyPaystack(raw, 'abc', KEY)).toBe(false);
  });
});

describe('Paystack results', () => {
  it('reads amounts in cents and names the card', () => {
    expect(mapPaystack({ id: 99, status: 'success', reference: 'R', amount: 8_500_050, currency: 'kes', authorization: { brand: 'visa ', last4: '4081', channel: 'card' } })).toEqual({
      outcome: 'paid',
      merchantRef: 'R',
      amount: 85000.5,
      currency: 'KES',
      receipt: 'PSK-99',
      method: 'VISA ••4081',
    });
    expect(mapPaystack({ status: 'success', channel: 'mobile_money', authorization: { channel: 'mobile_money' } }).method).toBe('M-Pesa');
  });

  it('treats failed and reversed as not paid, and everything unfinished as pending', () => {
    expect(mapPaystack({ status: 'failed', gateway_response: 'Declined' })).toMatchObject({ outcome: 'failed', reason: 'Paystack: Declined' });
    expect(mapPaystack({ status: 'reversed' }).outcome).toBe('failed');
    for (const status of ['abandoned', 'ongoing', 'pending', 'processing', 'queued', 'weird']) expect(mapPaystack({ status }).outcome).toBe('pending');
  });
});

describe('Paystack checkout', () => {
  it('sends the amount in cents, KES, our reference, and both return addresses', async () => {
    const { impl, calls } = fakeFetch(() => ({ body: { status: true, data: { authorization_url: 'https://checkout.paystack.com/abc', access_code: 'abc', reference: 'R' } } }));
    const g = createPaystack(loadPaymentConfig({ ...ENV, PAYSTACK_CHANNELS: 'card,mobile_money' }).paystack!, impl);
    const out = await g.startCheckout({ merchantRef: 'WZ-1-PS1-aaaaaa', amount: 85000.5, description: 'Trip', returnUrl: 'https://site/pay/WZ-1/?return=paystack', email: 'a@b.co', phone: undefined, name: 'A' });
    expect(out).toEqual({ redirectUrl: 'https://checkout.paystack.com/abc', providerRef: 'abc' });
    expect(calls[0]!.url).toBe('https://api.paystack.co/transaction/initialize');
    expect((calls[0]!.init.headers as Record<string, string>)['Authorization']).toBe(`Bearer ${KEY}`);
    const body = JSON.parse(String(calls[0]!.init.body)) as Record<string, unknown>;
    expect(body).toMatchObject({ email: 'a@b.co', amount: 8_500_050, currency: 'KES', reference: 'WZ-1-PS1-aaaaaa', callback_url: 'https://site/pay/WZ-1/?return=paystack', channels: ['card', 'mobile_money'] });
    expect((body['metadata'] as Record<string, unknown>)['cancel_action']).toBe('https://site/pay/WZ-1/?return=paystack&cancelled=1');
  });

  it('never sends guests to a non-https page, and needs an email', async () => {
    const { impl } = fakeFetch(() => ({ body: { status: true, data: { authorization_url: 'http://evil.example/' } } }));
    const g = createPaystack(loadPaymentConfig(ENV).paystack!, impl);
    const input = { merchantRef: 'R', amount: 1, description: '', returnUrl: 'https://s/', email: 'a@b.co', phone: undefined, name: '' };
    await expect(g.startCheckout(input)).rejects.toThrow(/checkout link/);
    await expect(g.startCheckout({ ...input, email: undefined })).rejects.toThrow(/email/);
  });

  it('reports Paystack’s own error message', async () => {
    const { impl } = fakeFetch(() => ({ status: 401, body: { status: false, message: 'Invalid key' } }));
    const g = createPaystack(loadPaymentConfig(ENV).paystack!, impl);
    await expect(g.ping()).rejects.toThrow(/Invalid key/);
  });
});

describe('Paystack webhooks', () => {
  const raw = (reference: string, amount = 8_500_000) => JSON.stringify({ event: 'charge.success', data: { id: 5, status: 'success', reference, amount, currency: 'KES' } });

  async function setup(verifyStatus: string, verifyAmount = 8_500_000) {
    const { impl } = fakeFetch((url) => {
      if (url.pathname === '/transaction/initialize') return { body: { status: true, data: { authorization_url: 'https://checkout.paystack.com/x', access_code: 'x' } } };
      const reference = decodeURIComponent(url.pathname.split('/').pop()!);
      return { body: { status: true, data: { id: 5, status: verifyStatus, reference, amount: verifyAmount, currency: 'KES' } } };
    });
    const { deps } = makeDeps({ env: ENV });
    deps.gateways.paystack = createPaystack(deps.config.paystack!, impl);
    const q = await createQuote(deps, { guestName: 'Jane', description: 'Trip', amountKes: 85000 });
    await startGateway(deps, 'paystack', q.ref, { email: 'jane@example.com' });
    const ref = (await deps.store.get(q.ref))!.payments[0]!.merchantRef!;
    return { deps, quoteRef: q.ref, ref };
  }
  const notice = (body: string, sig: string | undefined, ip?: string) => ({
    headers: new Headers(sig ? { 'x-paystack-signature': sig } : {}),
    body: JSON.parse(body) as Record<string, unknown>,
    raw: body,
    ip,
  });

  it('marks the booking paid only after Paystack confirms it', async () => {
    const { deps, quoteRef, ref } = await setup('success');
    const body = raw(ref);
    expect(await handleGatewayNotice(deps, 'paystack', notice(body, undefined))).toBe('rejected');
    expect(await handleGatewayNotice(deps, 'paystack', notice(body, paystackSignature(body, 'sk_test_wrong')))).toBe('rejected');
    expect(await handleGatewayNotice(deps, 'paystack', notice(body, paystackSignature(body, KEY)))).toBe('paid');
    expect((await deps.store.get(quoteRef))!.status).toBe('paid');
  });

  it('does not believe a signed webhook when Paystack’s API disagrees', async () => {
    const { deps, quoteRef, ref } = await setup('abandoned');
    const body = raw(ref);
    expect(await handleGatewayNotice(deps, 'paystack', notice(body, paystackSignature(body, KEY)))).toBe('pending');
    expect((await deps.store.get(quoteRef))!.status).toBe('awaiting_payment');
  });

  it('flags a payment for the wrong amount instead of accepting it', async () => {
    const { deps, quoteRef, ref } = await setup('success', 100);
    const body = raw(ref, 100);
    expect(await handleGatewayNotice(deps, 'paystack', notice(body, paystackSignature(body, KEY)))).toBe('failed');
    const q = (await deps.store.get(quoteRef))!;
    expect(q.status).toBe('awaiting_payment');
    expect(q.payments[0]!.flag).toMatch(/doesn’t match/);
  });

  it('ignores webhooks from other IP addresses when an allow-list is set', async () => {
    const g = createPaystack(loadPaymentConfig({ ...ENV, PAYSTACK_CALLBACK_IPS: '52.31.139.75, 52.49.173.169, 52.214.14.220' }).paystack!);
    const body = raw('R');
    const sig = paystackSignature(body, KEY);
    expect(g.readNotice(notice(body, sig, '41.1.1.1'))).toBeNull();
    expect(g.readNotice(notice(body, sig, '52.31.139.75'))?.merchantRef).toBe('R');
  });
});
