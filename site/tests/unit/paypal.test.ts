import { describe, expect, it, vi } from 'vitest';
import { loadPaymentConfig } from '@/lib/payments/config';
import { createPayPal, mapPayPalOrder, paypalEmailLink, paypalReference, type PayPalOrder } from '@/lib/payments/gateways/paypal';
import { confirmPaymentByHand, createQuote, getQuoteStatus, handleGatewayNotice, markPaymentNotReceived, startGateway } from '@/lib/payments/service';
import { FULL_ENV, makeDeps } from '../helpers';

const ID = 'AXunitPayPalClientId000000000001';
const SECRET = 'EKunitPayPalSecret000000000000001';
const API_ENV = { ...FULL_ENV, USD_KES_RATE: '130', PAYPAL_CLIENT_ID: ID, PAYPAL_CLIENT_SECRET: SECRET, PAYPAL_CALLBACK_SECRET: 'pp-cb' };
const EMAIL_ENV = { ...FULL_ENV, USD_KES_RATE: '130', PAYPAL_EMAIL: 'pay@whizperz.test', PAYPAL_CALLBACK_SECRET: 'pp-cb' };

function fakeFetch(handler: (url: URL, init: RequestInit) => { status?: number; body: unknown }) {
  const calls: { url: string; init: RequestInit }[] = [];
  const impl = vi.fn(async (input: string, init: RequestInit = {}) => {
    calls.push({ url: input, init });
    const r = handler(new URL(input), init);
    return new Response(JSON.stringify(r.body), { status: r.status ?? 200 });
  });
  return { impl, calls };
}

describe('PayPal settings', () => {
  it('is off until it has an email or API keys, an exchange rate and a callback secret', () => {
    expect(loadPaymentConfig(FULL_ENV).paypal).toBeUndefined();
    const noRate = loadPaymentConfig({ ...API_ENV, USD_KES_RATE: '' });
    expect(noRate.paypal).toBeUndefined();
    expect(noRate.warnings.join(' ')).toMatch(/PayPal is off.*USD_KES_RATE/);
  });

  it('uses the API when both keys are set, otherwise the email-only way', () => {
    const api = loadPaymentConfig(API_ENV).paypal!;
    expect(api).toMatchObject({ mode: 'api', sandbox: true, apiUrl: 'https://api-m.sandbox.paypal.com' });
    expect(api.notifyUrl).toBe('https://whizperz.test/api/callbacks/paypal/pp-cb');
    expect(loadPaymentConfig(EMAIL_ENV).paypal).toMatchObject({ mode: 'email', email: 'pay@whizperz.test', checkoutUrl: 'https://www.sandbox.paypal.com/cgi-bin/webscr' });
    const live = loadPaymentConfig({ ...EMAIL_ENV, PAYPAL_ENV: 'production' }).paypal!;
    expect(live.checkoutUrl).toBe('https://www.paypal.com/cgi-bin/webscr');
    // A client ID without its secret falls back to email, and says so.
    const half = loadPaymentConfig({ ...EMAIL_ENV, PAYPAL_CLIENT_ID: ID });
    expect(half.paypal?.mode).toBe('email');
    expect(half.warnings.join(' ')).toMatch(/client ID but no secret/);
  });
});

describe('PayPal references and results', () => {
  it('makes a unique invoice id per attempt', () => {
    const a = paypalReference('WZ-ABC123', 1);
    expect(a).toMatch(/^WZ-ABC123-PP1-[0-9a-f]{6}$/);
    expect(paypalReference('WZ-ABC123', 1)).not.toBe(a);
  });

  it('is paid only when the capture COMPLETED', () => {
    const order = (capture: string | undefined, status = 'COMPLETED'): PayPalOrder => ({
      id: 'O1',
      status,
      payment_source: { paypal: { email_address: 'g@x.co' } },
      purchase_units: [
        { invoice_id: 'R', amount: { currency_code: 'USD', value: '653.85' }, ...(capture ? { payments: { captures: [{ id: 'CAP1', status: capture, invoice_id: 'R', amount: { currency_code: 'USD', value: '653.85' } }] } } : {}) },
      ],
    });
    expect(mapPayPalOrder(order('COMPLETED'))).toMatchObject({ outcome: 'paid', merchantRef: 'R', amount: 653.85, currency: 'USD', receipt: 'CAP1', method: 'PayPal' });
    expect(mapPayPalOrder(order('PENDING')).outcome).toBe('pending');
    expect(mapPayPalOrder(order('DECLINED')).outcome).toBe('failed');
    expect(mapPayPalOrder(order(undefined, 'APPROVED'))).toMatchObject({ outcome: 'pending', approved: true });
    expect(mapPayPalOrder(order(undefined, 'PAYER_ACTION_REQUIRED')).outcome).toBe('pending');
    expect(mapPayPalOrder(order(undefined, 'VOIDED')).outcome).toBe('failed');
    expect(mapPayPalOrder({ ...order('COMPLETED'), payment_source: { card: { brand: 'VISA', last_digits: '4242' } } }).method).toBe('VISA ••4242 (PayPal)');
  });
});

describe('PayPal by API', () => {
  /** A fake PayPal that remembers one order. */
  function fakePayPal(opts: { captureStatus?: string; amount?: string; captureError?: string } = {}) {
    const order = { id: 'ORDER-1', status: 'PAYER_ACTION_REQUIRED', invoice: '', amount: '' };
    const { impl, calls } = fakeFetch((url, init) => {
      if (url.pathname === '/v1/oauth2/token') {
        const ok = (init.headers as Record<string, string>)['Authorization'] === `Basic ${Buffer.from(`${ID}:${SECRET}`).toString('base64')}`;
        return ok ? { body: { access_token: 'tok', expires_in: 32000 } } : { status: 401, body: { error: 'invalid_client', error_description: 'Client Authentication failed' } };
      }
      if (url.pathname === '/v2/checkout/orders' && init.method === 'POST') {
        const b = JSON.parse(String(init.body)) as { purchase_units: { invoice_id: string; amount: { value: string } }[] };
        order.invoice = b.purchase_units[0]!.invoice_id;
        order.amount = opts.amount ?? b.purchase_units[0]!.amount.value;
        return { status: 201, body: { id: order.id, status: order.status, links: [{ rel: 'self', href: 'x' }, { rel: 'payer-action', href: `https://www.sandbox.paypal.com/checkoutnow?token=${order.id}` }] } };
      }
      const unit = () => ({ invoice_id: order.invoice, amount: { currency_code: 'USD', value: order.amount } });
      if (url.pathname.endsWith('/capture')) {
        if (opts.captureError) return { status: 422, body: { name: 'UNPROCESSABLE_ENTITY', message: 'nope', details: [{ issue: opts.captureError }] } };
        order.status = 'COMPLETED';
        return { status: 201, body: { id: order.id, status: 'COMPLETED', purchase_units: [{ ...unit(), payments: { captures: [{ id: 'CAP-9', status: opts.captureStatus ?? 'COMPLETED', invoice_id: order.invoice, amount: { currency_code: 'USD', value: order.amount } }] } }] } };
      }
      if (url.pathname === `/v2/checkout/orders/${order.id}`) return { body: { id: order.id, status: order.status, purchase_units: [unit()] } };
      return { status: 404, body: { message: 'not found' } };
    });
    return { impl, calls, order };
  }

  async function setup(opts: Parameters<typeof fakePayPal>[0] = {}) {
    const fake = fakePayPal(opts);
    const { deps, time } = makeDeps({ env: API_ENV });
    deps.gateways.paypal = createPayPal(deps.config.paypal!, fake.impl);
    const q = await createQuote(deps, { guestName: 'Jane Wanjiku', description: 'Mara', amountKes: 85000 });
    const { redirectUrl } = await startGateway(deps, 'paypal', q.ref, { email: 'jane@example.com' });
    // The site re-checks a waiting payment at most every 10 seconds.
    const later = () => time.advance(11_000);
    return { deps, ref: q.ref, redirectUrl, later, ...fake };
  }

  it('creates a dollar order for the quote amount and sends the guest to PayPal', async () => {
    const { redirectUrl, calls, deps, ref } = await setup();
    expect(redirectUrl).toBe('https://www.sandbox.paypal.com/checkoutnow?token=ORDER-1');
    const create = calls.find((c) => c.url.endsWith('/v2/checkout/orders'))!;
    const body = JSON.parse(String(create.init.body)) as Record<string, any>;
    expect(body['intent']).toBe('CAPTURE');
    // 85,000 / 130 = 653.846… rounded up to the cent.
    expect(body['purchase_units'][0].amount).toEqual({ currency_code: 'USD', value: '653.85' });
    expect(body['payment_source'].paypal.experience_context).toMatchObject({ shipping_preference: 'NO_SHIPPING', user_action: 'PAY_NOW', return_url: `https://whizperz.test/pay/${ref}/?return=paypal` });
    expect((create.init.headers as Record<string, string>)['PayPal-Request-Id']).toBe(body['purchase_units'][0].invoice_id);
    const p = (await deps.store.get(ref))!.payments[0]!;
    expect(p).toMatchObject({ provider: 'paypal', status: 'pending', providerRef: 'ORDER-1', charged: { amount: 653.85, currency: 'USD', rate: 130 } });
  });

  it('stays pending until the guest approves, then captures and marks it paid', async () => {
    const { deps, ref, order, calls, later } = await setup();
    later();
    expect((await getQuoteStatus(deps, ref)).status).toBe('pending');
    expect(calls.some((c) => c.url.endsWith('/capture'))).toBe(false);
    order.status = 'APPROVED';
    later();
    const v = await getQuoteStatus(deps, ref);
    expect(v.status).toBe('paid');
    const p = (await deps.store.get(ref))!.payments[0]!;
    expect(p).toMatchObject({ status: 'paid', receipt: 'CAP-9' });
    expect((calls.find((c) => c.url.endsWith('/capture'))!.init.headers as Record<string, string>)['PayPal-Request-Id']).toBe('ORDER-1-capture');
  });

  it('a webhook only makes us ask PayPal: a fake "completed" event alone changes nothing', async () => {
    const { deps, ref } = await setup();
    const invoice = (await deps.store.get(ref))!.payments[0]!.merchantRef!;
    const raw = JSON.stringify({ event_type: 'PAYMENT.CAPTURE.COMPLETED', resource: { id: 'FAKE', status: 'COMPLETED', invoice_id: invoice, amount: { currency_code: 'USD', value: '653.85' }, supplementary_data: { related_ids: { order_id: 'ORDER-1' } } } });
    const out = await handleGatewayNotice(deps, 'paypal', { headers: new Headers(), body: JSON.parse(raw), raw });
    // PayPal itself still says the guest hasn't approved, so it isn't believed.
    expect(out).toBe('pending');
    expect((await deps.store.get(ref))!.status).toBe('awaiting_payment');
  });

  it('a webhook after the guest approved captures the payment even if they closed the tab', async () => {
    const { deps, ref, order } = await setup();
    order.status = 'APPROVED';
    const invoice = (await deps.store.get(ref))!.payments[0]!.merchantRef!;
    const raw = JSON.stringify({ event_type: 'CHECKOUT.ORDER.APPROVED', resource: { id: 'ORDER-1', status: 'APPROVED', purchase_units: [{ invoice_id: invoice }] } });
    expect(await handleGatewayNotice(deps, 'paypal', { headers: new Headers(), body: JSON.parse(raw), raw })).toBe('paid');
  });

  it('flags a payment for the wrong amount instead of marking it paid', async () => {
    const { deps, ref, order, later } = await setup({ amount: '1.00' });
    order.status = 'APPROVED';
    later();
    await getQuoteStatus(deps, ref);
    const q = (await deps.store.get(ref))!;
    expect(q.status).toBe('awaiting_payment');
    expect(q.payments[0]!.flag).toBeTruthy();
  });

  it('a declined card ends the attempt so the guest can try again', async () => {
    const { deps, ref, order, later } = await setup({ captureError: 'INSTRUMENT_DECLINED' });
    order.status = 'APPROVED';
    later();
    const v = await getQuoteStatus(deps, ref);
    expect(v.status).toBe('failed');
    expect(v.message).toMatch(/couldn’t take the payment/);
  });

  it('tests the keys by asking for an access token', async () => {
    const good = fakePayPal();
    await expect(createPayPal(loadPaymentConfig(API_ENV).paypal!, good.impl).ping()).resolves.toBeUndefined();
    const bad = fakePayPal();
    const wrong = loadPaymentConfig({ ...API_ENV, PAYPAL_CLIENT_SECRET: 'EKwrongPayPalSecret0000000000000' }).paypal!;
    await expect(createPayPal(wrong, bad.impl).ping()).rejects.toThrow(/invalid_client/);
  });
});

describe('PayPal by email only', () => {
  async function setup() {
    const { deps, notify } = makeDeps({ env: EMAIL_ENV });
    deps.gateways.paypal = createPayPal(deps.config.paypal!);
    const q = await createQuote(deps, { guestName: 'Jane Wanjiku', description: 'Mara', amountKes: 85000, email: 'jane@example.com' });
    const { redirectUrl } = await startGateway(deps, 'paypal', q.ref, {});
    return { deps, notify, ref: q.ref, redirectUrl };
  }

  it('sends the guest to PayPal with your email and the exact dollar amount', async () => {
    const { redirectUrl, ref, deps } = await setup();
    const url = new URL(redirectUrl);
    expect(url.origin + url.pathname).toBe('https://www.sandbox.paypal.com/cgi-bin/webscr');
    const p = (await deps.store.get(ref))!.payments[0]!;
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      cmd: '_xclick',
      business: 'pay@whizperz.test',
      amount: '653.85',
      currency_code: 'USD',
      invoice: p.merchantRef,
      return: `https://whizperz.test/pay/${ref}/?return=paypal`,
      cancel_return: `https://whizperz.test/pay/${ref}/?return=paypal&cancelled=1`,
    });
    expect(paypalEmailLink('https://x/y', 'a@b.co', { merchantRef: 'R', amount: 5, description: 'T', returnUrl: 'https://s/p/', email: undefined, phone: undefined, name: 'n' })).toContain('cancel_return=https%3A%2F%2Fs%2Fp%2F%3Fcancelled%3D1');
  });

  it('tells the team to look for it, and tells the guest it will be confirmed by hand', async () => {
    const { deps, notify, ref } = await setup();
    expect(notify).toHaveBeenCalledWith(expect.objectContaining({ type: 'flagged', ref, flag: expect.stringMatching(/Jane Wanjiku is paying USD 653\.85 by PayPal/) }));
    const v = await getQuoteStatus(deps, ref);
    expect(v).toMatchObject({ status: 'pending', confirmedByHand: true });
    expect(v.message).toMatch(/we’ll confirm it here and email your receipt/);
  });

  it('the team confirms it with the PayPal transaction id', async () => {
    const { deps, notify, ref } = await setup();
    const id = (await deps.store.get(ref))!.payments[0]!.id;
    await expect(confirmPaymentByHand(deps, ref, id, { reference: ' ' }, 'admin')).rejects.toThrow(/transaction ID/);
    const q = await confirmPaymentByHand(deps, ref, id, { reference: '8AB12345CD678901E' }, 'spence');
    expect(q.status).toBe('paid');
    expect(q.payments[0]).toMatchObject({ status: 'paid', receipt: '8AB12345CD678901E' });
    expect(q.history!.at(-1)).toMatchObject({ by: 'spence' });
    expect(notify).toHaveBeenCalledWith({ type: 'paid', ref, paymentId: id });
    await expect(confirmPaymentByHand(deps, ref, id, { reference: 'X' }, 'admin')).rejects.toThrow(/isn’t waiting/);
  });

  it('or marks it not received, and the guest can pay again', async () => {
    const { deps, ref } = await setup();
    const id = (await deps.store.get(ref))!.payments[0]!.id;
    await markPaymentNotReceived(deps, ref, id, 'admin');
    const v = await getQuoteStatus(deps, ref);
    expect(v.status).toBe('failed');
    expect(v.methods.paypal).toBe(true);
  });
});
