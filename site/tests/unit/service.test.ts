import { describe, expect, it } from 'vitest';
import {
  MPESA_MAX_KES,
  PaymentError,
  createQuote,
  getQuoteStatus,
  handleMpesaCallback,
  handlePesapalIpn,
  isAdmin,
  startMpesa,
  startPesapal,
} from '@/lib/payments/service';
import { ProviderError } from '@/lib/payments/http';
import { FULL_ENV, makeDeps, pesapalStatus, processingError, stkCallback, stkPushOk, stkQueryResult } from '../helpers';

async function setup(opts: Parameters<typeof makeDeps>[0] = {}) {
  const t = makeDeps(opts);
  const quote = await createQuote(t.deps, { guestName: 'Jane Wanjiku', description: 'Wild to blue, 2 adults', amountKes: 85000, email: 'jane@example.com' });
  return { ...t, quote };
}

async function rejection(p: Promise<unknown>): Promise<PaymentError> {
  const err = await p.then(
    () => {
      throw new Error('expected a rejection');
    },
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(PaymentError);
  return err as PaymentError;
}

describe('createQuote', () => {
  it('stores a quote with a reference and normalised contact details', async () => {
    const { deps } = makeDeps();
    const q = await createQuote(deps, { guestName: '  Jane  ', description: 'Trip', amountKes: '1200', phone: '0712 345 678', email: 'j@x.co' });
    expect(q.ref).toMatch(/^WZ-/);
    expect(q).toMatchObject({ guestName: 'Jane', amountKes: 1200, phone: '254712345678', email: 'j@x.co', status: 'awaiting_payment' });
    expect(await deps.store.get(q.ref)).toEqual(q);
  });

  it.each([
    [{ description: 'x', amountKes: 1 }, /Guest name is required/],
    [{ guestName: 'J', amountKes: 1 }, /Description is required/],
    [{ guestName: 'J', description: 'x', amountKes: 0 }, /Amount/],
    [{ guestName: 'J', description: 'x', amountKes: 10.5 }, /Amount/],
    [{ guestName: 'J', description: 'x', amountKes: 'lots' }, /Amount/],
    [{ guestName: 'J'.repeat(81), description: 'x', amountKes: 1 }, /80 characters/],
    [{ guestName: 'J', description: 'x', amountKes: 1, email: 'nope' }, /Email/],
    [{ guestName: 'J', description: 'x', amountKes: 1, phone: '123' }, /Kenyan mobile/],
  ])('rejects bad input %j', async (input, message) => {
    const { deps } = makeDeps();
    const err = await rejection(createQuote(deps, input));
    expect(err.status).toBe(400);
    expect(err.message).toMatch(message);
  });
});

describe('M-Pesa flow', () => {
  it('sends a prompt for the stored amount, not anything from the browser', async () => {
    const { deps, daraja, quote } = await setup();
    const res = await startMpesa(deps, quote.ref, '0712345678');
    expect(res.message).toContain('0712 ••• 678');
    expect(daraja.stkPush).toHaveBeenCalledWith({ phone: '254712345678', amount: 85000, accountReference: quote.ref, description: 'Whizperz trip' });
    const saved = (await deps.store.get(quote.ref))!;
    expect(saved.payments).toHaveLength(1);
    expect(saved.payments[0]).toMatchObject({ provider: 'mpesa', status: 'pending', providerRef: 'ws_CO_001', amountKes: 85000, phone: '254712345678' });
    expect((await getQuoteStatus(deps, quote.ref, { refresh: false })).status).toBe('pending');
  });

  it('marks the quote paid after a successful callback that Safaricom confirms', async () => {
    const { deps, daraja, quote } = await setup();
    await startMpesa(deps, quote.ref, '0712345678');
    expect(await handleMpesaCallback(deps, stkCallback('ws_CO_001', { receipt: 'TJN5X1Y2Z3' }))).toBe('paid');
    expect(daraja.stkQuery).toHaveBeenCalledWith('ws_CO_001');
    const view = await getQuoteStatus(deps, quote.ref, { refresh: false });
    expect(view).toMatchObject({ status: 'paid', receipt: 'TJN5X1Y2Z3' });
    expect((await deps.store.get(quote.ref))!.paidAt).toBeDefined();
  });

  it('does not trust a callback that Safaricom’s own records contradict (forged callback)', async () => {
    const { deps, daraja, quote } = await setup();
    await startMpesa(deps, quote.ref, '0712345678');
    daraja.stkQuery.mockResolvedValueOnce(stkQueryResult('1032'));
    expect(await handleMpesaCallback(deps, stkCallback('ws_CO_001'))).toBe('failed');
    expect((await deps.store.get(quote.ref))!.status).toBe('awaiting_payment');
  });

  it('records a cancelled payment with a clear reason and allows a retry', async () => {
    const { deps, daraja, quote, time } = await setup();
    await startMpesa(deps, quote.ref, '0712345678');
    expect(await handleMpesaCallback(deps, stkCallback('ws_CO_001', { code: 1032 }))).toBe('failed');
    const view = await getQuoteStatus(deps, quote.ref, { refresh: false });
    expect(view).toMatchObject({ status: 'failed', message: 'The payment was cancelled on the phone.' });
    // A failed attempt doesn't block trying again straight away.
    daraja.stkPush.mockResolvedValueOnce(stkPushOk('ws_CO_002'));
    time.advance(5_000);
    await startMpesa(deps, quote.ref, '0712345678');
    expect((await deps.store.get(quote.ref))!.payments).toHaveLength(2);
  });

  it('flags a payment for the wrong amount instead of accepting it', async () => {
    const { deps, quote, logs } = await setup();
    await startMpesa(deps, quote.ref, '0712345678');
    expect(await handleMpesaCallback(deps, stkCallback('ws_CO_001', { amount: 1 }))).toBe('failed');
    const p = (await deps.store.get(quote.ref))!.payments[0]!;
    expect(p.status).toBe('failed');
    expect(p.flag).toMatch(/Amount mismatch: expected KES 85000, M-Pesa reported KES 1/);
    expect(p.receipt).toBe('TJN5X1Y2Z3');
    expect(logs.some((l) => l.level === 'warn' && l.message.includes('mismatch'))).toBe(true);
  });

  it('ignores repeated callbacks once a payment is settled', async () => {
    const { deps, daraja, quote } = await setup();
    await startMpesa(deps, quote.ref, '0712345678');
    await handleMpesaCallback(deps, stkCallback('ws_CO_001'));
    expect(await handleMpesaCallback(deps, stkCallback('ws_CO_001'))).toBe('ignored');
    expect(await handleMpesaCallback(deps, stkCallback('ws_CO_001', { code: 1032 }))).toBe('ignored');
    expect(daraja.stkQuery).toHaveBeenCalledTimes(1);
    expect((await deps.store.get(quote.ref))!.status).toBe('paid');
  });

  it('ignores callbacks for requests it never made, and junk bodies', async () => {
    const { deps } = await setup();
    expect(await handleMpesaCallback(deps, stkCallback('ws_CO_UNKNOWN'))).toBe('ignored');
    expect(await handleMpesaCallback(deps, { hello: 'world' })).toBe('ignored');
  });

  it('waits and retries when Safaricom can’t confirm yet, then settles on the next status check', async () => {
    const { deps, daraja, quote, time } = await setup();
    await startMpesa(deps, quote.ref, '0712345678');
    daraja.stkQuery.mockRejectedValueOnce(processingError());
    expect(await handleMpesaCallback(deps, stkCallback('ws_CO_001', { receipt: 'RCPT1' }))).toBe('awaiting_confirmation');
    expect((await getQuoteStatus(deps, quote.ref, { refresh: false })).status).toBe('pending');
    // Too soon to ask again: no extra query.
    await getQuoteStatus(deps, quote.ref);
    expect(daraja.stkQuery).toHaveBeenCalledTimes(1);
    time.advance(11_000);
    const view = await getQuoteStatus(deps, quote.ref);
    expect(view).toMatchObject({ status: 'paid', receipt: 'RCPT1' });
  });

  it('finds the result by asking Safaricom when the callback never arrives', async () => {
    const { deps, daraja, quote, time } = await setup();
    await startMpesa(deps, quote.ref, '0712345678');
    daraja.stkQuery.mockRejectedValueOnce(processingError());
    time.advance(11_000);
    expect((await getQuoteStatus(deps, quote.ref)).status).toBe('pending');
    time.advance(11_000);
    daraja.stkQuery.mockResolvedValueOnce(stkQueryResult('1037'));
    const view = await getQuoteStatus(deps, quote.ref);
    expect(view.status).toBe('failed');
    expect(view.message).toMatch(/could not be reached/);
  });

  it('gives up on a prompt nobody answered after five minutes', async () => {
    const { deps, daraja, quote, time } = await setup();
    await startMpesa(deps, quote.ref, '0712345678');
    daraja.stkQuery.mockRejectedValue(processingError());
    time.advance(6 * 60_000);
    const view = await getQuoteStatus(deps, quote.ref);
    expect(view).toMatchObject({ status: 'failed', message: expect.stringMatching(/didn’t get a response/) });
  });

  it('blocks a second prompt within a minute, then allows it', async () => {
    const { deps, daraja, quote, time } = await setup();
    await startMpesa(deps, quote.ref, '0712345678');
    const err = await rejection(startMpesa(deps, quote.ref, '0712345678'));
    expect(err.status).toBe(429);
    time.advance(61_000);
    daraja.stkPush.mockResolvedValueOnce(stkPushOk('ws_CO_002'));
    await startMpesa(deps, quote.ref, '0712345678');
    expect(daraja.stkPush).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['WZ-NOTREAL', '0712345678', 404],
    ['../etc/passwd', '0712345678', 404],
    [undefined, '0712345678', 404],
  ])('rejects unknown reference %j', async (ref, phone, status) => {
    const { deps } = await setup();
    expect((await rejection(startMpesa(deps, ref, phone))).status).toBe(status);
  });

  it('rejects a bad phone number before calling Safaricom', async () => {
    const { deps, daraja, quote } = await setup();
    const err = await rejection(startMpesa(deps, quote.ref, '12345'));
    expect(err).toMatchObject({ status: 400, code: 'invalid_phone' });
    expect(daraja.stkPush).not.toHaveBeenCalled();
  });

  it('refuses to charge a quote that is already paid or cancelled', async () => {
    const { deps, quote } = await setup();
    await deps.store.update(quote.ref, (q) => {
      q.status = 'paid';
    });
    expect((await rejection(startMpesa(deps, quote.ref, '0712345678'))).status).toBe(409);
    await deps.store.update(quote.ref, (q) => {
      q.status = 'cancelled';
    });
    expect((await rejection(startMpesa(deps, quote.ref, '0712345678'))).status).toBe(410);
  });

  it('explains the M-Pesa limit for big amounts', async () => {
    const { deps } = makeDeps();
    const q = await createQuote(deps, { guestName: 'Big Group', description: 'x', amountKes: MPESA_MAX_KES + 1 });
    const err = await rejection(startMpesa(deps, q.ref, '0712345678'));
    expect(err.code).toBe('over_limit');
    expect((await getQuoteStatus(deps, q.ref, { refresh: false })).methods.mpesa).toBe(false);
  });

  it('says so when M-Pesa is not switched on', async () => {
    const { deps, quote } = await setup({ mpesa: false });
    expect((await rejection(startMpesa(deps, quote.ref, '0712345678'))).status).toBe(503);
  });

  it('turns provider failures into a friendly 502 and records nothing', async () => {
    const { deps, daraja, quote } = await setup();
    daraja.stkPush.mockRejectedValueOnce(new ProviderError('mpesa', 'mpesa error: Invalid Access Token', 401));
    const err = await rejection(startMpesa(deps, quote.ref, '0712345678'));
    expect(err.status).toBe(502);
    expect(err.message).not.toMatch(/Access Token/);
    expect((await deps.store.get(quote.ref))!.payments).toHaveLength(0);
  });
});

describe('Pesapal flow', () => {
  it('creates an order for the stored amount and returns the checkout link', async () => {
    const { deps, pesapal, quote } = await setup();
    const { redirectUrl } = await startPesapal(deps, quote.ref, {});
    expect(redirectUrl).toContain(`track-${quote.ref}-1`);
    expect(pesapal.submitOrder).toHaveBeenCalledWith(
      expect.objectContaining({
        merchantReference: `${quote.ref}-1`,
        amount: 85000,
        email: 'jane@example.com',
        firstName: 'Jane',
        callbackUrl: `https://whizperz.test/pay/${quote.ref}/?return=card`,
      }),
    );
    const p = (await deps.store.get(quote.ref))!.payments[0]!;
    expect(p).toMatchObject({ provider: 'pesapal', status: 'pending', providerRef: `track-${quote.ref}-1`, merchantRef: `${quote.ref}-1` });
  });

  it('numbers each attempt so Pesapal never sees a reused reference', async () => {
    const { deps, pesapal, quote } = await setup();
    await startPesapal(deps, quote.ref, {});
    await startPesapal(deps, quote.ref, {});
    expect(pesapal.submitOrder.mock.calls.map((c) => c[0].merchantReference)).toEqual([`${quote.ref}-1`, `${quote.ref}-2`]);
  });

  it('needs an email or phone, and checks the email', async () => {
    const { deps } = makeDeps();
    const q = await createQuote(deps, { guestName: 'No Contact', description: 'x', amountKes: 100 });
    expect((await rejection(startPesapal(deps, q.ref, {}))).code).toBe('contact_required');
    expect((await rejection(startPesapal(deps, q.ref, { email: 'bad' }))).code).toBe('invalid_email');
    await expect(startPesapal(deps, q.ref, { email: 'ok@example.com' })).resolves.toHaveProperty('redirectUrl');
  });

  it('marks paid when the IPN arrives and Pesapal confirms the right amount', async () => {
    const { deps, pesapal, quote } = await setup();
    await startPesapal(deps, quote.ref, {});
    pesapal.transactionStatus.mockResolvedValueOnce(pesapalStatus({ merchant_reference: `${quote.ref}-1`, confirmation_code: 'CONF9' }));
    const res = await handlePesapalIpn(deps, { OrderTrackingId: `track-${quote.ref}-1`, OrderMerchantReference: `${quote.ref}-1`, OrderNotificationType: 'IPNCHANGE' });
    expect(res.outcome).toBe('paid');
    expect(res.body).toEqual({ orderNotificationType: 'IPNCHANGE', orderTrackingId: `track-${quote.ref}-1`, orderMerchantReference: `${quote.ref}-1`, status: 200 });
    expect(await getQuoteStatus(deps, quote.ref, { refresh: false })).toMatchObject({ status: 'paid', receipt: 'CONF9' });
  });

  it.each([
    ['amount', { amount: 1 }],
    ['currency', { currency: 'USD' }],
    ['merchant reference', { merchant_reference: 'SOMEONE-ELSE' }],
  ])('flags a completed payment with the wrong %s', async (_, over) => {
    const { deps, pesapal, quote } = await setup();
    await startPesapal(deps, quote.ref, {});
    pesapal.transactionStatus.mockResolvedValueOnce(pesapalStatus({ merchant_reference: `${quote.ref}-1`, ...over }));
    const res = await handlePesapalIpn(deps, { OrderTrackingId: `track-${quote.ref}-1`, OrderMerchantReference: `${quote.ref}-1`, OrderNotificationType: 'IPNCHANGE' });
    expect(res.outcome).toBe('failed');
    const saved = (await deps.store.get(quote.ref))!;
    expect(saved.status).toBe('awaiting_payment');
    expect(saved.payments[0]!.flag).toBeDefined();
  });

  it('records a failed card payment', async () => {
    const { deps, pesapal, quote } = await setup();
    await startPesapal(deps, quote.ref, {});
    pesapal.transactionStatus.mockResolvedValueOnce(pesapalStatus({ merchant_reference: `${quote.ref}-1`, status_code: 2, description: 'Card declined' }));
    await handlePesapalIpn(deps, { OrderTrackingId: `track-${quote.ref}-1`, OrderMerchantReference: `${quote.ref}-1`, OrderNotificationType: 'IPNCHANGE' });
    expect(await getQuoteStatus(deps, quote.ref, { refresh: false })).toMatchObject({ status: 'failed', message: 'Card declined' });
  });

  it('asks Pesapal to retry when it can’t check the status', async () => {
    const { deps, pesapal, quote } = await setup();
    await startPesapal(deps, quote.ref, {});
    pesapal.transactionStatus.mockRejectedValueOnce(new ProviderError('pesapal', 'down'));
    const res = await handlePesapalIpn(deps, { OrderTrackingId: `track-${quote.ref}-1`, OrderMerchantReference: `${quote.ref}-1`, OrderNotificationType: 'IPNCHANGE' });
    expect(res).toMatchObject({ outcome: 'error', body: { status: 500 } });
  });

  it('acknowledges but ignores IPNs for unknown or mismatched orders', async () => {
    const { deps, pesapal, quote } = await setup();
    await startPesapal(deps, quote.ref, {});
    expect((await handlePesapalIpn(deps, { OrderTrackingId: 'nope', OrderMerchantReference: 'x', OrderNotificationType: 'IPNCHANGE' })).outcome).toBe('ignored');
    expect((await handlePesapalIpn(deps, { OrderTrackingId: `track-${quote.ref}-1`, OrderMerchantReference: 'WRONG', OrderNotificationType: 'IPNCHANGE' })).outcome).toBe('ignored');
    expect(pesapal.transactionStatus).not.toHaveBeenCalled();
  });

  it('settles a card payment on the status check when the guest returns before the IPN', async () => {
    const { deps, pesapal, quote, time } = await setup();
    await startPesapal(deps, quote.ref, {});
    pesapal.transactionStatus.mockResolvedValue(pesapalStatus({ merchant_reference: `${quote.ref}-1` }));
    time.advance(11_000);
    expect((await getQuoteStatus(deps, quote.ref)).status).toBe('paid');
  });

  it('is off when the IPN id is missing', async () => {
    const { deps, quote } = await setup({ env: { ...FULL_ENV, PESAPAL_IPN_ID: '' } });
    expect((await rejection(startPesapal(deps, quote.ref, {}))).status).toBe(503);
    expect((await getQuoteStatus(deps, quote.ref, { refresh: false })).methods.card).toBe(false);
  });
});

describe('status view', () => {
  it('shows only what the guest needs', async () => {
    const { deps, quote } = await setup();
    const view = await getQuoteStatus(deps, quote.ref);
    expect(view).toEqual({
      ref: quote.ref,
      firstName: 'Jane',
      description: 'Wild to blue, 2 adults',
      amountKes: 85000,
      status: 'awaiting_payment',
      message: 'Ready to pay.',
      methods: { mpesa: true, card: true },
    });
    expect(JSON.stringify(view)).not.toContain('jane@example.com');
  });
});

describe('isAdmin', () => {
  const { deps } = makeDeps();
  it.each([
    ['Bearer admin-secret-token', true],
    ['Bearer admin-secret-tokem', false],
    ['Bearer admin', false],
    ['admin-secret-token', false],
    [null, false],
  ])('%j → %s', (header, expected) => {
    expect(isAdmin(deps.config, header)).toBe(expected);
  });
  it('is always false without a configured token', () => {
    const { deps: d } = makeDeps({ env: { ...FULL_ENV, ADMIN_TOKEN: '' } });
    expect(isAdmin(d.config, 'Bearer ')).toBe(false);
  });
});
