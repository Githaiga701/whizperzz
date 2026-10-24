import { payLinkEmail, receiptEmail } from '@/lib/email/templates';
import { logHistory, payUrl, PaymentError } from '@/lib/payments/service';
import type { Quote } from '@/lib/payments/store';
import { getRuntime, log } from './payments';

/** Emails the guest their pay link and notes it in the quote's history. */
export async function emailPayLink(quote: Quote, by: string): Promise<void> {
  const rt = getRuntime();
  if (!rt.mailer) throw new PaymentError(503, 'no_email', 'Email isn’t set up yet. Add your mail server in Settings → Email, or share the link on WhatsApp.');
  if (!quote.email) throw new PaymentError(400, 'no_address', 'This quote has no guest email. Edit the quote to add one.');
  try {
    await rt.mailer.send(payLinkEmail(quote, payUrl(rt.deps.config, quote.ref)));
  } catch (err) {
    log('error', 'Pay link email failed', { ref: quote.ref, error: (err as Error).message });
    throw new PaymentError(502, 'email_failed', `The email didn’t send: ${(err as Error).message}`);
  }
  await logHistory(rt.deps, quote.ref, by, `Pay link emailed to ${quote.email}.`);
}

/** Sends the receipt again, e.g. when the guest can't find it. */
export async function resendReceipt(quote: Quote, by: string): Promise<void> {
  const rt = getRuntime();
  if (!rt.mailer) throw new PaymentError(503, 'no_email', 'Email isn’t set up yet. Add your mail server in Settings → Email.');
  if (!quote.email) throw new PaymentError(400, 'no_address', 'This quote has no guest email.');
  const paid = quote.payments.find((p) => p.status === 'paid');
  if (!paid) throw new PaymentError(409, 'not_paid', 'There’s no payment to send a receipt for yet.');
  try {
    await rt.mailer.send(receiptEmail(quote, paid));
  } catch (err) {
    throw new PaymentError(502, 'email_failed', `The email didn’t send: ${(err as Error).message}`);
  }
  await logHistory(rt.deps, quote.ref, by, `Receipt emailed again to ${quote.email}.`);
}

/** The WhatsApp message an admin sends a guest with their link. */
export function whatsappShareUrl(quote: Quote, url: string): string {
  const first = quote.guestName.split(/\s+/)[0] ?? quote.guestName;
  const text = `Hello ${first}, here is the payment link for your Whizperz trip (${quote.description}, KES ${quote.amountKes.toLocaleString('en-KE')}): ${url}\nYou can pay with M-Pesa or card. Reference ${quote.ref}.`;
  const to = quote.phone ?? '';
  return `https://wa.me/${to}?text=${encodeURIComponent(text)}`;
}
