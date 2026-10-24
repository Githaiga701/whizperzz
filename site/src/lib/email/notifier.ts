import type { EmailConfig, PaymentConfig } from '@/lib/payments/config';
import { logHistory, type LogFn, type PaymentEvent } from '@/lib/payments/service';
import type { QuoteStore } from '@/lib/payments/store';
import type { Mailer } from './mailer';
import { adminAttentionEmail, adminPaidEmail, adminRefundEmail, receiptEmail, refundEmail } from './templates';

interface NotifierDeps {
  store: QuoteStore;
  config: PaymentConfig;
  email: EmailConfig | undefined;
  mailer: Mailer | undefined;
  log: LogFn;
  now?: () => Date;
}

/**
 * Turns payment events into emails: a receipt or refund note for the guest (when we have their email)
 * and an alert for the Whizperz team (when an alert address is set). Each email sent is noted in the quote's history.
 */
export function createNotifier(d: NotifierDeps) {
  return async function notify(event: PaymentEvent): Promise<void> {
    if (!d.mailer || !d.email) return;
    const quote = await d.store.get(event.ref);
    if (!quote) return;
    const adminUrl = `${d.config.siteUrl}/admin/quotes/${quote.ref}/`;
    const notifyTo = d.email.notifyTo;

    const history = { store: d.store, now: d.now ?? (() => new Date()) };
    const send = async (msg: Parameters<Mailer['send']>[0], who: 'guest' | 'team', note: string) => {
      try {
        await d.mailer!.send(msg);
        if (who === 'guest') await logHistory(history, quote.ref, 'system', note);
      } catch (err) {
        d.log('error', 'Email failed', { ref: quote.ref, to: who, error: (err as Error).message });
        await logHistory(history, quote.ref, 'system', `Email to ${who === 'guest' ? quote.email : 'the team'} failed: ${(err as Error).message}`);
      }
    };

    if (event.type === 'paid') {
      const p = quote.payments.find((x) => x.id === event.paymentId);
      if (!p) return;
      if (quote.email) await send(receiptEmail(quote, p), 'guest', `Receipt emailed to ${quote.email}.`);
      if (notifyTo) await send(adminPaidEmail(notifyTo, quote, p, adminUrl), 'team', '');
    } else if (event.type === 'flagged') {
      if (notifyTo) await send(adminAttentionEmail(notifyTo, quote, event.flag, adminUrl), 'team', '');
    } else {
      const r = quote.refunds?.find((x) => x.id === event.refundId);
      if (!r) return;
      if (event.type === 'refund_completed' && quote.email) await send(refundEmail(quote, r), 'guest', `Refund confirmation emailed to ${quote.email}.`);
      if (notifyTo) await send(adminRefundEmail(notifyTo, quote, r, adminUrl), 'team', '');
    }
  };
}
