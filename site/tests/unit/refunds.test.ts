import { describe, expect, it, vi } from 'vitest';
import {
  PaymentError,
  addNote,
  cancelQuote,
  createQuote,
  editQuote,
  filterQuotes,
  getQuoteStatus,
  handleMpesaCallback,
  handleMpesaReversalResult,
  handlePesapalIpn,
  recordManualPayment,
  refundPayment,
  refundable,
  reopenQuote,
  resolveRefundManually,
  startMpesa,
  startPesapal,
  summarise,
  syncPesapalRefunds,
} from '@/lib/payments/service';
import { createDaraja, parseReversalResult } from '@/lib/payments/mpesa';
import { createPesapal } from '@/lib/payments/pesapal';
import { loadPaymentConfig } from '@/lib/payments/config';
import { ProviderError } from '@/lib/payments/http';
import { FULL_ENV, makeDeps, pesapalStatus, stkCallback } from '../helpers';

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

/** A quote paid by M-Pesa with receipt TJN5X1Y2Z3. */
async function paidByMpesa(opts: Parameters<typeof makeDeps>[0] = {}) {
  const t = makeDeps(opts);
  const q = await createQuote(t.deps, { guestName: 'Jane Wanjiku', description: 'Wild to blue', amountKes: 85000, email: 'jane@example.com' }, 'spence');
  await startMpesa(t.deps, q.ref, '0712345678');
  await handleMpesaCallback(t.deps, stkCallback('ws_CO_001'));
  const paid = (await t.deps.store.get(q.ref))!;
  return { ...t, ref: q.ref, payment: paid.payments[0]! };
}

async function paidByCard(method = 'Visa') {
  const t = makeDeps();
  const q = await createQuote(t.deps, { guestName: 'Kofi', description: 'Saltwater days', amountKes: 120000, email: 'k@example.com' });
  await startPesapal(t.deps, q.ref, {});
  t.pesapal.transactionStatus.mockResolvedValueOnce(pesapalStatus({ merchant_reference: `${q.ref}-1`, amount: 120000, payment_method: method, confirmation_code: 'CONF-1' }));
  await handlePesapalIpn(t.deps, { OrderTrackingId: `track-${q.ref}-1`, OrderMerchantReference: `${q.ref}-1`, OrderNotificationType: 'IPNCHANGE' });
  const paid = (await t.deps.store.get(q.ref))!;
  return { ...t, ref: q.ref, payment: paid.payments[0]! };
}

describe('history and notifications', () => {
  it('records who did what', async () => {
    const { deps, ref } = await paidByMpesa();
    const h = (await deps.store.get(ref))!.history!.map((x) => `${x.by}: ${x.text}`);
    expect(h[0]).toBe('spence: Quote created for KES 85,000.');
    expect(h[1]).toBe('guest: M-Pesa prompt sent to 0712 ••• 678.');
    expect(h[2]).toBe('system: Paid KES 85,000 by M-Pesa, receipt TJN5X1Y2Z3.');
  });

  it('notifies once when a payment is confirmed, and on flags', async () => {
    const { notify, deps, ref } = await paidByMpesa();
    expect(notify).toHaveBeenCalledWith({ type: 'paid', ref, paymentId: expect.stringMatching(/^pay_/) });
    await handleMpesaCallback(deps, stkCallback('ws_CO_001'));
    expect(notify).toHaveBeenCalledTimes(1);

    const t = makeDeps();
    const q = await createQuote(t.deps, { guestName: 'A', description: 'x', amountKes: 100 });
    await startMpesa(t.deps, q.ref, '0712345678');
    await handleMpesaCallback(t.deps, stkCallback('ws_CO_001', { amount: 1 }));
    expect(t.notify).toHaveBeenCalledWith(expect.objectContaining({ type: 'flagged', flag: expect.stringContaining('Amount mismatch') }));
  });

  it('never lets a failing email break a payment', async () => {
    const t = makeDeps();
    t.notify.mockRejectedValue(new Error('SMTP down'));
    const q = await createQuote(t.deps, { guestName: 'A', description: 'x', amountKes: 100 });
    await startMpesa(t.deps, q.ref, '0712345678');
    expect(await handleMpesaCallback(t.deps, stkCallback('ws_CO_001', { amount: 100 }))).toBe('paid');
    await new Promise((r) => setTimeout(r, 0));
    expect(t.logs.some((l) => l.message === 'Notification failed')).toBe(true);
  });

  it('adds notes', async () => {
    const { deps, ref } = await paidByMpesa();
    await addNote(deps, ref, '  Guest asked for a window seat ', 'mary');
    expect((await deps.store.get(ref))!.history!.at(-1)).toMatchObject({ by: 'mary', text: 'Note: Guest asked for a window seat' });
    expect((await rejection(addNote(deps, ref, '  ', 'mary'))).code).toBe('invalid_input');
  });
});

describe('M-Pesa refunds (reversal)', () => {
  it('requests a full reversal with the receipt, then completes on Safaricom’s result', async () => {
    const { deps, daraja, ref, payment, notify } = await paidByMpesa();
    const r = await refundPayment(deps, ref, { paymentId: payment.id, amountKes: '85,000', reason: 'Trip cancelled' }, 'spence');
    expect(daraja.reverse).toHaveBeenCalledWith({ transactionId: 'TJN5X1Y2Z3', amount: 85000, remarks: 'Trip cancelled' });
    expect(r).toMatchObject({ status: 'requested', via: 'mpesa', conversationId: 'AG_001', by: 'spence' });
    expect(refundable((await deps.store.get(ref))!, payment.id)).toBe(0);

    const outcome = await handleMpesaReversalResult(
      deps,
      { Result: { ResultType: 0, ResultCode: 0, ResultDesc: 'ok', OriginatorConversationID: 'orig-001', ConversationID: 'AG_001', TransactionID: 'REV123' } },
      'result',
    );
    expect(outcome).toBe('completed');
    const q = (await deps.store.get(ref))!;
    expect(q.status).toBe('refunded');
    expect(q.refunds![0]).toMatchObject({ status: 'completed', reference: 'REV123' });
    expect(notify).toHaveBeenLastCalledWith({ type: 'refund_completed', ref, refundId: r.id });
    expect((await getQuoteStatus(deps, ref, { refresh: false })).status).toBe('refunded');
    // Repeated results change nothing.
    expect(await handleMpesaReversalResult(deps, { Result: { ResultCode: 0, ResultDesc: 'ok', OriginatorConversationID: 'orig-001', ConversationID: 'AG_001' } }, 'result')).toBe('ignored');
  });

  it('marks the refund failed on an error result or timeout, so it can be tried again', async () => {
    const { deps, ref, payment } = await paidByMpesa();
    await refundPayment(deps, ref, { paymentId: payment.id, amountKes: 85000, reason: 'x' }, 'spence');
    expect(
      await handleMpesaReversalResult(deps, { Result: { ResultCode: 'R000002', ResultDesc: 'The OriginalTransactionID is invalid.', OriginatorConversationID: 'x', ConversationID: 'AG_001' } }, 'result'),
    ).toBe('failed');
    const q = (await deps.store.get(ref))!;
    expect(q.status).toBe('paid');
    expect(q.refunds![0]).toMatchObject({ status: 'failed', failureReason: 'The OriginalTransactionID is invalid.' });
    expect(refundable(q, payment.id)).toBe(85000);

    const t2 = await paidByMpesa();
    await refundPayment(t2.deps, t2.ref, { paymentId: t2.payment.id, amountKes: 85000, reason: 'x' }, 'spence');
    expect(await handleMpesaReversalResult(t2.deps, { Result: { ResultCode: 0, ResultDesc: 'ok', OriginatorConversationID: 'orig-001', ConversationID: 'AG_001' } }, 'timeout')).toBe(
      'failed',
    );
    expect((await t2.deps.store.get(t2.ref))!.refunds![0]!.failureReason).toMatch(/timed out/);
  });

  it('only does full reversals', async () => {
    const { deps, ref, payment, daraja } = await paidByMpesa();
    const err = await rejection(refundPayment(deps, ref, { paymentId: payment.id, amountKes: 1000, reason: 'x' }, 'spence'));
    expect(err.code).toBe('full_only');
    expect(daraja.reverse).not.toHaveBeenCalled();
  });

  it('explains when refund credentials are missing', async () => {
    const env = { ...FULL_ENV, MPESA_INITIATOR_NAME: '' };
    const { deps, ref, payment } = await paidByMpesa({ env });
    const err = await rejection(refundPayment(deps, ref, { paymentId: payment.id, amountKes: 85000, reason: 'x' }, 'spence'));
    expect(err).toMatchObject({ status: 503, message: expect.stringContaining('Settings → M-Pesa') });
  });

  it('shows Safaricom’s refusal and records nothing', async () => {
    const { deps, ref, payment, daraja } = await paidByMpesa();
    daraja.reverse.mockRejectedValueOnce(new ProviderError('mpesa', 'mpesa error: Bad Request - Invalid Initiator', 400));
    const err = await rejection(refundPayment(deps, ref, { paymentId: payment.id, amountKes: 85000, reason: 'x' }, 'spence'));
    expect(err.message).toContain('Invalid Initiator');
    expect((await deps.store.get(ref))!.refunds ?? []).toHaveLength(0);
  });

  it('can be settled by hand if Safaricom never answers', async () => {
    const { deps, ref, payment } = await paidByMpesa();
    const r = await refundPayment(deps, ref, { paymentId: payment.id, amountKes: 85000, reason: 'x' }, 'spence');
    await resolveRefundManually(deps, ref, r.id, true, 'mary');
    const q = (await deps.store.get(ref))!;
    expect(q.status).toBe('refunded');
    expect(q.history!.at(-1)!.by).toBe('mary');
    expect((await rejection(resolveRefundManually(deps, ref, r.id, false, 'mary'))).status).toBe(404);
  });

  it('ignores results for unknown reversals and junk', async () => {
    const { deps } = await paidByMpesa();
    expect(await handleMpesaReversalResult(deps, { Result: { ResultCode: 0, ResultDesc: 'ok', OriginatorConversationID: 'zz', ConversationID: 'nope' } }, 'result')).toBe('ignored');
    expect(await handleMpesaReversalResult(deps, { foo: 1 }, 'result')).toBe('ignored');
  });
});

describe('Pesapal refunds', () => {
  it('sends a part refund for a card payment, then completes when Pesapal shows it reversed', async () => {
    const { deps, pesapal, ref, payment } = await paidByCard('Visa');
    const r = await refundPayment(deps, ref, { paymentId: payment.id, amountKes: 20000, reason: 'One guest cancelled' }, 'spence');
    expect(pesapal.refund).toHaveBeenCalledWith({ confirmationCode: 'CONF-1', amount: 20000, username: 'spence', remarks: 'One guest cancelled' });
    expect(r.status).toBe('requested');

    pesapal.transactionStatus.mockResolvedValueOnce(pesapalStatus({ status_code: 0 }));
    expect(await syncPesapalRefunds(deps, ref)).toBe(0);
    pesapal.transactionStatus.mockResolvedValueOnce(pesapalStatus({ status_code: 3 }));
    expect(await syncPesapalRefunds(deps, ref)).toBe(1);
    const q = (await deps.store.get(ref))!;
    expect(q.refunds![0]!.status).toBe('completed');
    expect(q.status).toBe('paid');
    expect(refundable(q, payment.id)).toBe(100000);
  });

  it('allows only one Pesapal refund per payment', async () => {
    const { deps, ref, payment } = await paidByCard('Visa');
    await refundPayment(deps, ref, { paymentId: payment.id, amountKes: 20000, reason: 'x' }, 'spence');
    expect((await rejection(refundPayment(deps, ref, { paymentId: payment.id, amountKes: 1000, reason: 'x' }, 'spence'))).code).toBe('one_only');
  });

  it('refunds mobile money through Pesapal only in full', async () => {
    const { deps, ref, payment } = await paidByCard('MpesaKE');
    expect((await rejection(refundPayment(deps, ref, { paymentId: payment.id, amountKes: 1000, reason: 'x' }, 'spence'))).code).toBe('full_only');
    await expect(refundPayment(deps, ref, { paymentId: payment.id, amountKes: 120000, reason: 'x' }, 'spence')).resolves.toMatchObject({ via: 'pesapal' });
  });

  it('records the method from Pesapal on the payment', async () => {
    const { payment } = await paidByCard('Mastercard');
    expect(payment.method).toBe('Mastercard');
  });
});

describe('refunds recorded by hand', () => {
  it('records a refund made another way and finishes the booking when everything is back', async () => {
    const { deps, ref, payment, daraja, notify } = await paidByMpesa();
    await refundPayment(deps, ref, { paymentId: payment.id, amountKes: 5000, reason: 'Goodwill', mode: 'manual', reference: 'BANK-1' }, 'spence');
    let q = (await deps.store.get(ref))!;
    expect(q.status).toBe('paid');
    expect(refundable(q, payment.id)).toBe(80000);
    expect(daraja.reverse).not.toHaveBeenCalled();
    expect(notify).toHaveBeenLastCalledWith(expect.objectContaining({ type: 'refund_completed' }));
    await refundPayment(deps, ref, { paymentId: payment.id, amountKes: 80000, reason: 'Cancelled', mode: 'manual' }, 'spence');
    q = (await deps.store.get(ref))!;
    expect(q.status).toBe('refunded');
    expect((await rejection(refundPayment(deps, ref, { paymentId: payment.id, amountKes: 1, reason: 'x', mode: 'manual' }, 'spence'))).code).toBe('nothing_left');
  });

  it.each([
    [{ amountKes: 0, reason: 'x' }, 'invalid_input'],
    [{ amountKes: 90000, reason: 'x' }, 'too_much'],
    [{ amountKes: 100, reason: ' ' }, 'invalid_input'],
    [{ amountKes: 100, reason: 'x', paymentId: 'pay_nope' }, 'not_found'],
  ])('rejects %j', async (input, code) => {
    const { deps, ref, payment } = await paidByMpesa();
    expect((await rejection(refundPayment(deps, ref, { paymentId: payment.id, mode: 'manual', ...input }, 'spence'))).code).toBe(code);
  });
});

describe('manual payments, edits and cancelling', () => {
  it('records a cash payment, marks the quote paid and sends a receipt', async () => {
    const t = makeDeps();
    const q = await createQuote(t.deps, { guestName: 'W', description: 'x', amountKes: 18000, email: 'w@example.com' });
    expect((await rejection(recordManualPayment(t.deps, q.ref, { method: 'Gold bars' }, 'spence'))).code).toBe('invalid_input');
    const saved = await recordManualPayment(t.deps, q.ref, { method: 'Cash', reference: 'CASH-12', note: 'At the office' }, 'spence');
    expect(saved.status).toBe('paid');
    expect(saved.payments[0]).toMatchObject({ provider: 'manual', status: 'paid', method: 'Cash', receipt: 'CASH-12', note: 'At the office' });
    expect(saved.history!.at(-1)).toMatchObject({ by: 'spence', text: 'Paid KES 18,000 by Cash, receipt CASH-12.' });
    expect(t.notify).toHaveBeenCalledWith(expect.objectContaining({ type: 'paid' }));
    // Manual payments can only be refunded by hand.
    expect((await rejection(refundPayment(t.deps, q.ref, { paymentId: saved.payments[0]!.id, amountKes: 18000, reason: 'x' }, 'spence'))).code).toBe('manual_only');
  });

  it('edits an unpaid quote and records what changed', async () => {
    const t = makeDeps();
    const q = await createQuote(t.deps, { guestName: 'O', description: 'x', amountKes: 50000 });
    const e = await editQuote(t.deps, q.ref, { guestName: 'Otieno', description: 'x', amountKes: '55,000', email: 'o@example.com' }, 'spence');
    expect(e).toMatchObject({ guestName: 'Otieno', amountKes: 55000, email: 'o@example.com' });
    expect(e.history!.at(-1)!.text).toBe('Quote edited: amount KES 50,000 → KES 55,000, guest name, email.');
  });

  it('won’t edit while a payment is in progress, or once paid', async () => {
    const t = makeDeps();
    const q = await createQuote(t.deps, { guestName: 'O', description: 'x', amountKes: 500 });
    await startMpesa(t.deps, q.ref, '0712345678');
    expect((await rejection(editQuote(t.deps, q.ref, { guestName: 'O', description: 'x', amountKes: 1 }, 's'))).message).toMatch(/in progress/);
    await handleMpesaCallback(t.deps, stkCallback('ws_CO_001', { amount: 500 }));
    expect((await rejection(editQuote(t.deps, q.ref, { guestName: 'O', description: 'x', amountKes: 1 }, 's'))).message).toMatch(/unpaid/);
    expect((await rejection(cancelQuote(t.deps, q.ref, 's'))).status).toBe(409);
  });

  it('cancels and reopens', async () => {
    const t = makeDeps();
    const q = await createQuote(t.deps, { guestName: 'O', description: 'x', amountKes: 500 });
    await cancelQuote(t.deps, q.ref, 'spence', 'Changed plans');
    expect((await rejection(startMpesa(t.deps, q.ref, '0712345678'))).status).toBe(410);
    expect((await t.deps.store.get(q.ref))!.history!.at(-1)!.text).toBe('Quote cancelled: Changed plans');
    await reopenQuote(t.deps, q.ref, 'spence');
    await expect(startMpesa(t.deps, q.ref, '0712345678')).resolves.toBeDefined();
    expect((await rejection(reopenQuote(t.deps, q.ref, 'spence'))).status).toBe(409);
  });
});

describe('dashboard helpers', () => {
  it('summarises the month and finds quotes', async () => {
    const t = makeDeps();
    const a = await createQuote(t.deps, { guestName: 'Amina', description: 'Mara', amountKes: 1000, phone: '0722000111' });
    const b = await createQuote(t.deps, { guestName: 'Kofi', description: 'Coast', amountKes: 2000 });
    await recordManualPayment(t.deps, b.ref, { method: 'Cash', reference: 'CASH-9' }, 's');
    const all = await t.deps.store.list();
    expect(summarise(all, t.deps.now())).toMatchObject({ awaiting: 1, paidThisMonthKes: 2000, paidThisMonthCount: 1, needsAttention: 0, refundsPending: 0 });
    expect(filterQuotes(all, { q: 'amina' }).map((x) => x.ref)).toEqual([a.ref]);
    expect(filterQuotes(all, { q: '0722000111' }).map((x) => x.ref)).toEqual([a.ref]);
    expect(filterQuotes(all, { q: 'cash-9' }).map((x) => x.ref)).toEqual([b.ref]);
    expect(filterQuotes(all, { status: 'paid' }).map((x) => x.ref)).toEqual([b.ref]);
    expect(filterQuotes(all, { status: 'attention' })).toEqual([]);
  });
});

describe('provider clients: refunds', () => {
  const mpesa = loadPaymentConfig(FULL_ENV).mpesa!;
  const pesapalCfg = loadPaymentConfig(FULL_ENV).pesapal!;
  const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200, headers: { 'Content-Type': 'application/json' } });

  it('sends a Daraja reversal with the initiator and result URLs', async () => {
    const calls: { url: string; body: string }[] = [];
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, body: String(init?.body ?? '') });
      if (url.includes('oauth')) return json({ access_token: 't', expires_in: '3599' });
      return json({ OriginatorConversationID: 'o', ConversationID: 'c', ResponseCode: '0', ResponseDescription: 'ok' });
    });
    await createDaraja(mpesa, fetchImpl).reverse({ transactionId: 'TJN5X1Y2Z3', amount: 85000, remarks: 'x' });
    const body = JSON.parse(calls[1]!.body);
    expect(calls[1]!.url).toContain('/mpesa/reversal/v1/request');
    expect(body).toMatchObject({
      Initiator: 'apiop',
      SecurityCredential: 'encrypted-cred',
      CommandID: 'TransactionReversal',
      TransactionID: 'TJN5X1Y2Z3',
      Amount: 85000,
      ReceiverParty: '174379',
      RecieverIdentifierType: '11',
      ResultURL: 'https://whizperz.test/api/callbacks/mpesa-reversal/mpesa-cb-secret/result',
      QueueTimeOutURL: 'https://whizperz.test/api/callbacks/mpesa-reversal/mpesa-cb-secret/timeout',
    });
    expect(body.Remarks.length).toBeGreaterThanOrEqual(2);
  });

  it('refuses a reversal without initiator details', async () => {
    await expect(createDaraja({ ...mpesa, reversal: undefined }, vi.fn()).reverse({ transactionId: 'x', amount: 1, remarks: 'x' })).rejects.toThrow(/initiator/);
  });

  it('parses reversal results', () => {
    expect(parseReversalResult({ Result: { ResultCode: '0', ResultDesc: 'ok', OriginatorConversationID: 'o', ConversationID: 'c', TransactionID: 'T' } })).toEqual({
      ok: true,
      conversationId: 'c',
      originatorConversationId: 'o',
      transactionId: 'T',
    });
    expect(parseReversalResult({ Result: { ResultCode: 'R000001', ResultDesc: '', OriginatorConversationID: 'o', ConversationID: 'c' } })).toMatchObject({
      ok: false,
      reason: expect.stringContaining('R000001'),
    });
    expect(parseReversalResult({})).toBeNull();
  });

  it('sends a Pesapal refund request and reports a refusal', async () => {
    const bodies: string[] = [];
    let reply: unknown = { status: '200', message: 'Refund request successfully' };
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      bodies.push(String(init?.body ?? ''));
      if (url.includes('RequestToken')) return json({ token: 't', status: '200' });
      return json(reply);
    });
    const p = createPesapal(pesapalCfg, fetchImpl);
    await p.refund({ confirmationCode: 'C1', amount: 20000, username: 'spence', remarks: 'x' });
    expect(JSON.parse(bodies[1]!)).toEqual({ confirmation_code: 'C1', amount: '20000.00', username: 'spence', remarks: 'x' });
    reply = { status: '500', message: 'Refund rejected' };
    await expect(p.refund({ confirmationCode: 'C1', amount: 1, username: 's', remarks: 'x' })).rejects.toThrow(/Refund rejected/);
  });
});
