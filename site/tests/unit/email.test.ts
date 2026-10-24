import { describe, expect, it, vi } from 'vitest';
import { adminPaidEmail, esc, payLinkEmail, receiptEmail, refundEmail } from '@/lib/email/templates';
import { createNotifier } from '@/lib/email/notifier';
import type { Mailer } from '@/lib/email/mailer';
import type { Quote } from '@/lib/payments/store';
import { createQuote, recordManualPayment } from '@/lib/payments/service';
import { loadEmailConfig } from '@/lib/payments/config';
import { makeDeps } from '../helpers';

const quote: Quote = {
  ref: 'WZ-ABCDEF',
  guestName: 'Jane <b>Wanjiku</b>',
  description: 'Wild to blue & more',
  amountKes: 85000,
  email: 'jane@example.com',
  status: 'paid',
  createdAt: '2026-10-23T09:00:00Z',
  payments: [
    { id: 'pay_1', provider: 'mpesa', status: 'paid', amountKes: 85000, providerRef: 'ws', receipt: 'TJN5X1Y2Z3', createdAt: '2026-10-23T09:00:00Z', updatedAt: '2026-10-23T09:01:00Z' },
  ],
};

describe('email templates', () => {
  it('escapes HTML', () => {
    expect(esc(`<a href="x">'&'</a>`)).toBe('&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;');
  });

  it('pay link email has the link, amount and reference, in text and HTML', () => {
    const m = payLinkEmail(quote, 'https://whizperz.co.ke/pay/WZ-ABCDEF/');
    expect(m.to).toBe('jane@example.com');
    expect(m.subject).toContain('WZ-ABCDEF');
    expect(m.text).toContain('https://whizperz.co.ke/pay/WZ-ABCDEF/');
    expect(m.text).toContain('KES 85,000');
    expect(m.html).toContain('href="https://whizperz.co.ke/pay/WZ-ABCDEF/"');
    // Guest-entered text can't inject HTML.
    expect(m.html).not.toContain('<b>Wanjiku</b>');
    expect(m.html).toContain('Wild to blue &amp; more');
  });

  it('receipt shows the receipt number and method', () => {
    const m = receiptEmail(quote, quote.payments[0]!);
    expect(m.subject).toBe('Payment received: Whizperz booking WZ-ABCDEF');
    expect(m.text).toMatch(/Receipt: TJN5X1Y2Z3/);
    expect(m.text).toMatch(/Paid with: M-Pesa/);
    expect(m.text).toMatch(/23 October 2026/);
  });

  it('refund email explains where the money goes', () => {
    const m = refundEmail(quote, { id: 'r', paymentId: 'pay_1', via: 'mpesa', status: 'completed', amountKes: 85000, reason: 'x', by: 's', createdAt: '', updatedAt: '' });
    expect(m.text).toContain('M-Pesa number you paid from');
  });

  it('team alert links to the admin', () => {
    const m = adminPaidEmail('team@x.co', quote, quote.payments[0]!, 'https://x/admin/quotes/WZ-ABCDEF/');
    expect(m.to).toBe('team@x.co');
    expect(m.subject).toBe('Paid: KES 85,000 for WZ-ABCDEF (Jane <b>Wanjiku</b>)');
    expect(m.text).toContain('https://x/admin/quotes/WZ-ABCDEF/');
  });
});

describe('notifier', () => {
  function setup(opts: { notifyTo?: string; fail?: boolean } = {}) {
    const t = makeDeps();
    const sent: Parameters<Mailer['send']>[0][] = [];
    const mailer: Mailer = {
      send: vi.fn(async (m) => {
        if (opts.fail) throw new Error('Connection refused');
        sent.push(m);
      }),
      verify: vi.fn(async () => undefined),
    };
    const email = loadEmailConfig({ SMTP_HOST: 'h', EMAIL_FROM: 'b@whizperz.test', ...(opts.notifyTo ? { NOTIFY_EMAIL: opts.notifyTo } : {}) })!;
    const notify = createNotifier({ store: t.deps.store, config: t.deps.config, email, mailer, log: t.deps.log, now: t.deps.now });
    return { ...t, sent, notify };
  }

  it('emails the guest a receipt and the team an alert, and notes it', async () => {
    const t = setup({ notifyTo: 'team@whizperz.test' });
    const q = await createQuote(t.deps, { guestName: 'Jane', description: 'x', amountKes: 500, email: 'jane@example.com' });
    const paid = await recordManualPayment(t.deps, q.ref, { method: 'Cash' }, 's');
    await t.notify({ type: 'paid', ref: q.ref, paymentId: paid.payments[0]!.id });
    expect(t.sent.map((m) => m.to)).toEqual(['jane@example.com', 'team@whizperz.test']);
    expect((await t.deps.store.get(q.ref))!.history!.at(-1)!.text).toBe('Receipt emailed to jane@example.com.');
  });

  it('skips the guest without an email, and the team without an alert address', async () => {
    const t = setup();
    const q = await createQuote(t.deps, { guestName: 'Jane', description: 'x', amountKes: 500 });
    const paid = await recordManualPayment(t.deps, q.ref, { method: 'Cash' }, 's');
    await t.notify({ type: 'paid', ref: q.ref, paymentId: paid.payments[0]!.id });
    expect(t.sent).toEqual([]);
  });

  it('records a failed email in the history instead of throwing', async () => {
    const t = setup({ fail: true });
    const q = await createQuote(t.deps, { guestName: 'Jane', description: 'x', amountKes: 500, email: 'jane@example.com' });
    const paid = await recordManualPayment(t.deps, q.ref, { method: 'Cash' }, 's');
    await expect(t.notify({ type: 'paid', ref: q.ref, paymentId: paid.payments[0]!.id })).resolves.toBeUndefined();
    expect((await t.deps.store.get(q.ref))!.history!.at(-1)!.text).toMatch(/Email to jane@example.com failed: Connection refused/);
  });

  it('alerts the team about flagged payments', async () => {
    const t = setup({ notifyTo: 'team@whizperz.test' });
    const q = await createQuote(t.deps, { guestName: 'Jane', description: 'x', amountKes: 500 });
    await t.notify({ type: 'flagged', ref: q.ref, paymentId: 'p', flag: 'Amount mismatch' });
    expect(t.sent[0]).toMatchObject({ to: 'team@whizperz.test', subject: expect.stringContaining('Needs checking') });
  });
});
