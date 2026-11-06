import type { OpenPayConfig } from './config';
import { PaymentError, createQuote, payMethods, payUrl, type PaymentDeps } from './service';

/**
 * The public "Make a payment" page: the guest types how much to pay (a deposit, a balance, a custom quote, a tip)
 * instead of opening a link the team sent. We turn that into an ordinary quote, so it is paid, checked, confirmed
 * and refunded exactly like any other booking, and every way to pay (M-Pesa, cards, PayPal, crypto…) works for it.
 *
 * The amount the guest typed is only ever used here, checked against the limits set in the admin. After this, the
 * amount comes from the saved quote like everywhere else, never from the browser.
 */

export interface OpenPayInput {
  name?: unknown;
  email?: unknown;
  phone?: unknown;
  amount?: unknown;
  currency?: unknown;
  /** What it's for, in the guest's words (optional). */
  note?: unknown;
}

export interface OpenPayResult {
  ref: string;
  /** The pay page for the new quote. */
  next: string;
  amountKes: number;
}

const kes = (n: number) => `KES ${n.toLocaleString('en-KE')}`;

function parseAmount(value: unknown): number {
  const n = typeof value === 'string' ? Number(value.replace(/[,\s]/g, '')) : Number(value);
  if (!Number.isFinite(n) || n <= 0) throw new PaymentError(400, 'invalid_amount', 'Enter how much you’d like to pay.');
  return n;
}

/** Shillings for what the guest typed. Dollars are converted at the admin's rate, rounded up to the shilling. */
export function openPayAmountKes(amount: number, currency: 'KES' | 'USD', usdRate: number | undefined): number {
  if (currency === 'KES') {
    if (!Number.isInteger(amount)) throw new PaymentError(400, 'invalid_amount', 'Enter a whole number of shillings, like 15000.');
    return amount;
  }
  if (Math.abs(amount * 100 - Math.round(amount * 100)) > 1e-6) {
    throw new PaymentError(400, 'invalid_amount', 'Dollar amounts can have at most two decimals, like 150.50.');
  }
  if (!usdRate) throw new PaymentError(400, 'no_usd', 'Paying in US dollars isn’t available right now. Please enter the amount in Kenyan shillings.');
  return Math.ceil(amount * usdRate - 1e-9);
}

export async function createOpenPayment(deps: PaymentDeps, open: OpenPayConfig | undefined, input: OpenPayInput): Promise<OpenPayResult> {
  // Off in the admin, or no way to pay is set up: don't leave a quote nobody can pay.
  const anyMethod = Object.values({ ...payMethods(deps, 0), mpesa: Boolean(deps.daraja) }).some(Boolean);
  if (!open || !anyMethod) throw new PaymentError(404, 'not_found', 'This page isn’t available. Message us and we’ll send you a payment link.');

  const currency = input.currency === undefined || input.currency === '' ? 'KES' : input.currency;
  if (currency !== 'KES' && currency !== 'USD') throw new PaymentError(400, 'invalid_currency', 'Choose Kenyan shillings or US dollars.');

  const amountKes = openPayAmountKes(parseAmount(input.amount), currency, deps.config.usdRate);
  if (amountKes < open.minKes || amountKes > open.maxKes) {
    throw new PaymentError(400, 'out_of_range', `Online payments here are from ${kes(open.minKes)} to ${kes(open.maxKes)}. For other amounts, message us.`);
  }

  // An email is how the guest gets their receipt, and several gateways (crypto, Paystack) need one.
  if (typeof input.email !== 'string' || input.email.trim() === '') throw new PaymentError(400, 'invalid_input', 'Email address is required for your receipt.');

  const note = typeof input.note === 'string' ? input.note.trim().replace(/\s+/g, ' ') : '';
  if (note.length > 120) throw new PaymentError(400, 'invalid_input', 'What it’s for must be 120 characters or fewer.');

  const quote = await createQuote(
    deps,
    {
      guestName: input.name,
      email: input.email,
      phone: input.phone,
      amountKes,
      description: note || 'Payment to Whizperz Tours',
    },
    'guest (Make a payment page)',
  );
  deps.log('info', 'Open payment started', { ref: quote.ref, amountKes, currency });
  return { ref: quote.ref, next: payUrl(deps.config, quote.ref), amountKes };
}
