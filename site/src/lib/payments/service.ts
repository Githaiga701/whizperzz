import { timingSafeEqual } from 'node:crypto';
import { pesapalReady, type PaymentConfig } from './config';
import { ProviderError } from './http';
import { parseReversalResult, parseStkCallback, friendlyResult, type Daraja } from './mpesa';
import { mapPesapalStatus, type Pesapal, type PesapalIpn } from './pesapal';
import { kesToUsd, sameMoney, type GatewayNotice, type GatewayResult, type Gateways } from './gateways';
import type { GatewayId } from './store';
import { maskPhone, normalizeKenyanPhone } from './phone';
import { isQuoteRef, newId, newQuoteRef } from './reference';
import type { Payment, Quote, QuoteStore, Refund } from './store';

/** Safaricom's per-transaction limit for M-Pesa. */
export const MPESA_MAX_KES = 250_000;
/** Don't send a second phone prompt for the same quote within this window. */
export const MPESA_RESEND_MS = 60_000;
/** Ask the provider for an update at most this often when a guest is waiting. */
const RECHECK_MS = 10_000;
/** Give up on an M-Pesa prompt nobody answered after this long. */
const MPESA_GIVE_UP_MS = 5 * 60_000;

export type LogFn = (level: 'info' | 'warn' | 'error', message: string, data?: Record<string, unknown>) => void;

/** Things worth telling people about (by email). Sent after the change is saved. */
export type PaymentEvent =
  | { type: 'paid'; ref: string; paymentId: string }
  | { type: 'flagged'; ref: string; paymentId: string; flag: string }
  | { type: 'refund_completed'; ref: string; refundId: string }
  | { type: 'refund_failed'; ref: string; refundId: string };

export interface PaymentDeps {
  config: PaymentConfig;
  store: QuoteStore;
  daraja: Daraja | undefined;
  pesapal: Pesapal | undefined;
  /** iPOS Pay, Unipesa and crypto: whichever are set up. */
  gateways: Gateways;
  now: () => Date;
  log: LogFn;
  /** Sends emails for an event. Errors are logged, never shown to guests or providers. */
  notify: (event: PaymentEvent) => Promise<void>;
}

/** An error that is safe to show to the person who caused it. */
export class PaymentError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'PaymentError';
  }
}

/** Ways a guest can pay. "card" is Pesapal (cards, Airtel Money and more). */
export interface PayMethods {
  mpesa: boolean;
  card: boolean;
  ipos: boolean;
  unipesa: boolean;
  crypto: boolean;
}

export const METHOD_LABEL: Record<keyof PayMethods, string> = {
  mpesa: 'M-Pesa',
  card: 'Pesapal',
  ipos: 'iPOS Pay',
  unipesa: 'Unipesa',
  crypto: 'Crypto',
};

export const PROVIDER_NAME: Record<string, string> = {
  mpesa: 'M-Pesa',
  pesapal: 'Pesapal',
  ipos: 'iPOS Pay',
  unipesa: 'Unipesa',
  crypto: 'crypto (NOWPayments)',
  manual: 'manual',
};

export type PublicStatus = 'awaiting_payment' | 'pending' | 'paid' | 'failed' | 'cancelled' | 'refunded';

export interface QuoteView {
  ref: string;
  firstName: string;
  description: string;
  amountKes: number;
  status: PublicStatus;
  message: string;
  receipt?: string;
  methods: PayMethods;
  /** The dollar amount for iPOS Pay and crypto, when an exchange rate is set. */
  usdAmount?: number;
  /** Set when the guest booked a journey online (or this is the balance for one). */
  booking?: {
    packageName: string;
    travelDate: string;
    adults: number;
    children: number;
    totalKes: number;
    plan: 'deposit' | 'full' | 'balance';
    depositPercent: number;
    balanceKes: number;
  };
}

/* ---------- Helpers ---------- */

function addHistory(q: Quote, at: Date, by: string, text: string): void {
  (q.history ??= []).push({ at: at.toISOString(), by, text });
}

function fireNotify(deps: PaymentDeps, event: PaymentEvent): void {
  deps.notify(event).catch((err: unknown) => deps.log('error', 'Notification failed', { event: event.type, ref: event.ref, error: (err as Error).message }));
}

const kes = (n: number) => `KES ${n.toLocaleString('en-KE')}`;

/* ---------- Quotes ---------- */

export interface NewQuoteInput {
  guestName?: unknown;
  description?: unknown;
  amountKes?: unknown;
  email?: unknown;
  phone?: unknown;
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function text(value: unknown, field: string, max: number): string {
  if (typeof value !== 'string' || value.trim() === '') throw new PaymentError(400, 'invalid_input', `${field} is required.`);
  const v = value.trim();
  if (v.length > max) throw new PaymentError(400, 'invalid_input', `${field} must be ${max} characters or fewer.`);
  return v;
}

function amount(value: unknown, field = 'Amount'): number {
  const n = typeof value === 'string' ? Number(value.replace(/[,\s]/g, '')) : Number(value);
  if (!Number.isInteger(n) || n < 1 || n > 50_000_000) {
    throw new PaymentError(400, 'invalid_input', `${field} must be a whole number of shillings, at least 1.`);
  }
  return n;
}

function contact(input: { email?: unknown; phone?: unknown }): { email?: string; phone?: string } {
  const out: { email?: string; phone?: string } = {};
  if (input.email !== undefined && input.email !== '') {
    if (typeof input.email !== 'string' || !EMAIL.test(input.email.trim())) throw new PaymentError(400, 'invalid_input', 'Email address doesn’t look right.');
    out.email = input.email.trim();
  }
  if (input.phone !== undefined && input.phone !== '') {
    const phone = typeof input.phone === 'string' ? normalizeKenyanPhone(input.phone) : null;
    if (!phone) throw new PaymentError(400, 'invalid_input', 'Phone must be a Kenyan mobile number, like 0712 345 678.');
    out.phone = phone;
  }
  return out;
}

export async function createQuote(deps: PaymentDeps, input: NewQuoteInput, by = 'admin'): Promise<Quote> {
  const guestName = text(input.guestName, 'Guest name', 80);
  const description = text(input.description, 'Description', 200);
  const amountKes = amount(input.amountKes);
  const now = deps.now();
  const quote: Quote = {
    ref: '',
    guestName,
    description,
    amountKes,
    status: 'awaiting_payment',
    createdAt: now.toISOString(),
    payments: [],
    refunds: [],
    history: [],
    ...contact(input),
  };
  for (let attempt = 0; attempt < 5; attempt++) {
    const ref = newQuoteRef();
    if (await deps.store.get(ref)) continue;
    quote.ref = ref;
    addHistory(quote, now, by, `Quote created for ${kes(amountKes)}.`);
    const saved = await deps.store.create(quote);
    deps.log('info', 'Quote created', { ref, amountKes });
    return saved;
  }
  throw new Error('Could not generate a unique quote reference');
}

/** Changes a quote's details. Only allowed before anyone has started paying. */
export async function editQuote(deps: PaymentDeps, ref: unknown, input: NewQuoteInput, by: string): Promise<Quote> {
  const quote = await requireQuote(deps, ref);
  if (quote.status !== 'awaiting_payment') throw new PaymentError(409, 'locked', 'Only unpaid quotes can be changed.');
  if (quote.payments.some((p) => p.status === 'pending')) {
    throw new PaymentError(409, 'locked', 'A payment is in progress. Wait for it to finish before changing the quote.');
  }
  const guestName = text(input.guestName, 'Guest name', 80);
  const description = text(input.description, 'Description', 200);
  const amountKes = amount(input.amountKes);
  const c = contact(input);
  return deps.store.update(quote.ref, (q) => {
    const changes: string[] = [];
    if (q.amountKes !== amountKes) changes.push(`amount ${kes(q.amountKes)} → ${kes(amountKes)}`);
    if (q.guestName !== guestName) changes.push('guest name');
    if (q.description !== description) changes.push('description');
    if ((q.email ?? '') !== (c.email ?? '')) changes.push('email');
    if ((q.phone ?? '') !== (c.phone ?? '')) changes.push('phone');
    q.guestName = guestName;
    q.description = description;
    q.amountKes = amountKes;
    if (c.email) q.email = c.email;
    else delete q.email;
    if (c.phone) q.phone = c.phone;
    else delete q.phone;
    addHistory(q, deps.now(), by, changes.length ? `Quote edited: ${changes.join(', ')}.` : 'Quote saved with no changes.');
  });
}

export function payUrl(config: PaymentConfig, ref: string): string {
  return `${config.siteUrl}/pay/${ref}/`;
}

async function requireQuote(deps: PaymentDeps, ref: unknown): Promise<Quote> {
  if (!isQuoteRef(ref)) throw new PaymentError(404, 'not_found', 'We couldn’t find that booking reference.');
  const quote = await deps.store.get(ref);
  if (!quote) throw new PaymentError(404, 'not_found', 'We couldn’t find that booking reference.');
  return quote;
}

export async function getQuote(deps: PaymentDeps, ref: unknown): Promise<Quote> {
  return requireQuote(deps, ref);
}

function requirePayable(quote: Quote): void {
  if (quote.status === 'paid') throw new PaymentError(409, 'already_paid', 'This booking is already paid. Thank you!');
  if (quote.status === 'cancelled') throw new PaymentError(410, 'cancelled', 'This quote has been cancelled. Please contact us for a new one.');
  if (quote.status === 'refunded') throw new PaymentError(410, 'refunded', 'This booking was refunded. Please contact us if you’d like to rebook.');
}

function markPaid(q: Quote, paymentId: string, receipt: string | undefined, at: Date, extra: { method?: string | undefined } = {}): boolean {
  const p = q.payments.find((x) => x.id === paymentId);
  if (!p || p.status === 'paid') return false;
  p.status = 'paid';
  if (receipt) p.receipt = receipt;
  if (extra.method) p.method = extra.method;
  p.updatedAt = at.toISOString();
  delete p.failureReason;
  q.status = 'paid';
  q.paidAt = at.toISOString();
  const how =
    p.provider === 'mpesa'
      ? 'M-Pesa'
      : p.provider === 'pesapal'
        ? `card (${p.method ?? 'Pesapal'})`
        : p.provider === 'manual'
          ? (p.method ?? 'manual')
          : `${PROVIDER_NAME[p.provider]}${p.method ? ` (${p.method})` : ''}`;
  const charged = p.charged && p.charged.currency !== 'KES' ? ` (charged ${p.charged.currency} ${p.charged.amount.toFixed(2)})` : '';
  addHistory(q, at, p.provider === 'manual' ? 'admin' : 'system', `Paid ${kes(p.amountKes)}${charged} by ${how}${p.receipt ? `, receipt ${p.receipt}` : ''}.`);
  return true;
}

function markFailed(q: Quote, paymentId: string, reason: string, at: Date, flag?: string): void {
  const p = q.payments.find((x) => x.id === paymentId);
  if (!p || p.status !== 'pending') return;
  p.status = 'failed';
  p.failureReason = reason;
  if (flag) p.flag = flag;
  p.updatedAt = at.toISOString();
  addHistory(q, at, 'system', flag ? `Needs checking: ${flag}` : `${p.provider === 'mpesa' ? 'M-Pesa' : p.provider === 'pesapal' ? 'Card' : PROVIDER_NAME[p.provider]} payment failed: ${reason}`);
}

/* ---------- M-Pesa ---------- */

export async function startMpesa(deps: PaymentDeps, ref: unknown, phoneInput: unknown): Promise<{ message: string }> {
  const quote = await requireQuote(deps, ref);
  requirePayable(quote);
  if (!deps.daraja) throw new PaymentError(503, 'unavailable', 'M-Pesa payments aren’t switched on yet. Please pay by card or contact us.');
  const phone = typeof phoneInput === 'string' ? normalizeKenyanPhone(phoneInput) : null;
  if (!phone) throw new PaymentError(400, 'invalid_phone', 'Enter a Safaricom number, like 0712 345 678.');
  if (quote.amountKes > MPESA_MAX_KES) {
    throw new PaymentError(400, 'over_limit', `M-Pesa allows up to KES ${MPESA_MAX_KES.toLocaleString('en-KE')} per payment. Please pay by card, or ask us to split the payment.`);
  }
  const now = deps.now();
  const recent = quote.payments.find(
    (p) => p.provider === 'mpesa' && p.status === 'pending' && now.getTime() - Date.parse(p.createdAt) < MPESA_RESEND_MS,
  );
  if (recent) {
    throw new PaymentError(429, 'too_soon', 'We just sent a payment prompt. Check your phone, or wait a minute before trying again.');
  }

  let res;
  try {
    res = await deps.daraja.stkPush({ phone, amount: quote.amountKes, accountReference: quote.ref, description: 'Whizperz trip' });
  } catch (err) {
    deps.log('error', 'STK push failed', { ref: quote.ref, error: (err as Error).message });
    throw new PaymentError(502, 'provider_error', 'We couldn’t reach M-Pesa just now. Please try again in a minute.');
  }

  const at = now.toISOString();
  const payment: Payment = {
    id: newId('pay'),
    provider: 'mpesa',
    status: 'pending',
    amountKes: quote.amountKes,
    providerRef: res.CheckoutRequestID,
    phone,
    createdAt: at,
    updatedAt: at,
  };
  await deps.store.update(quote.ref, (q) => {
    q.payments.push(payment);
    addHistory(q, now, 'guest', `M-Pesa prompt sent to ${maskPhone(phone)}.`);
  });
  deps.log('info', 'STK push sent', { ref: quote.ref, checkoutRequestId: res.CheckoutRequestID });
  return { message: `Check your phone (${maskPhone(phone)}) and enter your M-Pesa PIN to pay.` };
}

/**
 * Handles Safaricom's callback. Always resolves (Safaricom only needs a 200);
 * the return value says what happened, for logs and tests.
 */
export async function handleMpesaCallback(deps: PaymentDeps, body: unknown): Promise<'paid' | 'failed' | 'ignored' | 'awaiting_confirmation'> {
  const result = parseStkCallback(body);
  if (!result) {
    deps.log('warn', 'M-Pesa callback was not an STK callback');
    return 'ignored';
  }
  const found = await deps.store.findPayment('mpesa', result.checkoutRequestId);
  if (!found) {
    deps.log('warn', 'M-Pesa callback for an unknown request', { checkoutRequestId: result.checkoutRequestId });
    return 'ignored';
  }
  const { quote, payment } = found;
  if (payment.status !== 'pending') return 'ignored';
  const now = deps.now();

  if (!result.ok) {
    await deps.store.update(quote.ref, (q) => markFailed(q, payment.id, result.reason, now));
    deps.log('info', 'M-Pesa payment failed', { ref: quote.ref, code: result.resultCode });
    return 'failed';
  }

  if (result.amount !== payment.amountKes) {
    const flag = `Amount mismatch: expected KES ${payment.amountKes}, M-Pesa reported KES ${result.amount} (receipt ${result.receipt}).`;
    await deps.store.update(quote.ref, (q) => {
      markFailed(q, payment.id, 'We received a payment we need to check by hand. We’ll be in touch shortly.', now, flag);
      const p = q.payments.find((x) => x.id === payment.id);
      if (p) p.receipt = result.receipt;
    });
    deps.log('warn', 'M-Pesa amount mismatch', { ref: quote.ref, expected: payment.amountKes, got: result.amount });
    fireNotify(deps, { type: 'flagged', ref: quote.ref, paymentId: payment.id, flag });
    return 'failed';
  }

  // Confirm with Safaricom directly, so a forged callback can't mark a booking paid.
  return confirmMpesa(deps, quote.ref, payment, result.receipt);
}

async function confirmMpesa(deps: PaymentDeps, ref: string, payment: Payment, receipt: string | undefined): Promise<'paid' | 'failed' | 'awaiting_confirmation'> {
  const now = deps.now();
  try {
    const q = await deps.daraja!.stkQuery(payment.providerRef);
    const code = Number(q.ResultCode);
    if (q.ResultCode !== undefined && code === 0) {
      let changed = false;
      await deps.store.update(ref, (qq) => {
        changed = markPaid(qq, payment.id, receipt ?? payment.receipt, now);
      });
      if (changed) {
        deps.log('info', 'M-Pesa payment confirmed', { ref });
        fireNotify(deps, { type: 'paid', ref, paymentId: payment.id });
      }
      return 'paid';
    }
    if (q.ResultCode !== undefined && Number.isFinite(code)) {
      await deps.store.update(ref, (qq) => markFailed(qq, payment.id, friendlyResult(code, q.ResultDesc), now));
      return 'failed';
    }
  } catch (err) {
    // "The transaction is being processed" comes back as an error. Try again on the next status check.
    deps.log('info', 'M-Pesa confirmation not available yet', { ref, error: (err as Error).message });
  }
  await deps.store.update(ref, (qq) => {
    const p = qq.payments.find((x) => x.id === payment.id);
    if (p) {
      if (receipt) p.receipt = receipt;
      p.updatedAt = now.toISOString();
    }
  });
  return 'awaiting_confirmation';
}

/* ---------- Pesapal ---------- */

export async function startPesapal(
  deps: PaymentDeps,
  ref: unknown,
  contactInput: { email?: unknown; phone?: unknown },
): Promise<{ redirectUrl: string }> {
  const quote = await requireQuote(deps, ref);
  requirePayable(quote);
  if (!deps.pesapal || !pesapalReady(deps.config)) {
    throw new PaymentError(503, 'unavailable', 'Card payments aren’t switched on yet. Please pay with M-Pesa or contact us.');
  }
  let email = quote.email;
  if (typeof contactInput.email === 'string' && contactInput.email.trim() !== '') {
    if (!EMAIL.test(contactInput.email.trim())) throw new PaymentError(400, 'invalid_email', 'That email address doesn’t look right.');
    email = contactInput.email.trim();
  }
  let phone = quote.phone;
  if (typeof contactInput.phone === 'string' && contactInput.phone.trim() !== '') {
    phone = normalizeKenyanPhone(contactInput.phone) ?? undefined;
  }
  if (!email && !phone) throw new PaymentError(400, 'contact_required', 'Add your email address so the card payment page can send your receipt.');

  const merchantRef = `${quote.ref}-${quote.payments.filter((p) => p.provider === 'pesapal').length + 1}`;
  let res;
  try {
    res = await deps.pesapal.submitOrder({
      merchantReference: merchantRef,
      amount: quote.amountKes,
      description: `${quote.description} (${quote.ref})`,
      callbackUrl: `${payUrl(deps.config, quote.ref)}?return=card`,
      email,
      phone,
      firstName: quote.guestName.split(/\s+/)[0] ?? quote.guestName,
    });
  } catch (err) {
    deps.log('error', 'Pesapal order failed', { ref: quote.ref, error: (err as Error).message });
    throw new PaymentError(502, 'provider_error', 'We couldn’t open the card payment page just now. Please try again in a minute.');
  }
  const now = deps.now();
  const at = now.toISOString();
  await deps.store.update(quote.ref, (q) => {
    q.payments.push({
      id: newId('pay'),
      provider: 'pesapal',
      status: 'pending',
      amountKes: quote.amountKes,
      providerRef: res.order_tracking_id,
      merchantRef,
      createdAt: at,
      updatedAt: at,
    });
    // Keep the email the guest typed, so their receipt can be sent there.
    if (email && !q.email) q.email = email;
    addHistory(q, now, 'guest', 'Opened card checkout (Pesapal).');
  });
  deps.log('info', 'Pesapal order created', { ref: quote.ref, merchantRef });
  return { redirectUrl: res.redirect_url };
}

async function checkPesapal(deps: PaymentDeps, ref: string, payment: Payment): Promise<'paid' | 'failed' | 'pending'> {
  const status = await deps.pesapal!.transactionStatus(payment.providerRef);
  const now = deps.now();
  const outcome = mapPesapalStatus(status.status_code);
  const matches =
    status.merchant_reference === payment.merchantRef && status.currency?.toUpperCase() === 'KES' && Number(status.amount) === payment.amountKes;

  if (outcome === 'paid' && !matches) {
    const flag = `Pesapal reported a completed payment that doesn’t match: ${status.merchant_reference}, ${status.currency} ${status.amount}.`;
    await deps.store.update(ref, (q) => markFailed(q, payment.id, 'We received a payment we need to check by hand. We’ll be in touch shortly.', now, flag));
    deps.log('warn', 'Pesapal mismatch', { ref });
    fireNotify(deps, { type: 'flagged', ref, paymentId: payment.id, flag });
    return 'failed';
  }
  if (outcome === 'paid') {
    let changed = false;
    await deps.store.update(ref, (q) => {
      changed = markPaid(q, payment.id, status.confirmation_code, now, { method: status.payment_method });
    });
    if (changed) {
      deps.log('info', 'Pesapal payment confirmed', { ref });
      fireNotify(deps, { type: 'paid', ref, paymentId: payment.id });
    }
  } else if (outcome === 'failed') {
    await deps.store.update(ref, (q) =>
      markFailed(q, payment.id, status.description || status.payment_status_description || 'The card payment did not go through.', now),
    );
  } else {
    await deps.store.update(ref, (q) => {
      const p = q.payments.find((x) => x.id === payment.id);
      if (p) p.updatedAt = now.toISOString();
    });
  }
  return outcome;
}

/** Handles Pesapal's IPN and returns the acknowledgement Pesapal expects. */
export async function handlePesapalIpn(deps: PaymentDeps, ipn: PesapalIpn): Promise<{ body: Record<string, unknown>; outcome: string }> {
  const ack = (status: number) => ({
    orderNotificationType: ipn.OrderNotificationType,
    orderTrackingId: ipn.OrderTrackingId,
    orderMerchantReference: ipn.OrderMerchantReference,
    status,
  });
  if (!deps.pesapal) return { body: ack(500), outcome: 'unavailable' };
  const found = await deps.store.findPayment('pesapal', ipn.OrderTrackingId);
  if (!found || found.payment.merchantRef !== ipn.OrderMerchantReference) {
    deps.log('warn', 'Pesapal IPN for an unknown order', { trackingId: ipn.OrderTrackingId });
    return { body: ack(200), outcome: 'ignored' };
  }
  if (found.payment.status !== 'pending') {
    // A later IPN can tell us a refund went through.
    if (found.payment.status === 'paid') await syncPesapalRefunds(deps, found.quote.ref).catch(() => undefined);
    return { body: ack(200), outcome: 'ignored' };
  }
  try {
    const outcome = await checkPesapal(deps, found.quote.ref, found.payment);
    return { body: ack(200), outcome };
  } catch (err) {
    deps.log('error', 'Pesapal status check failed', { ref: found.quote.ref, error: (err as Error).message });
    // 500 tells Pesapal to send the notification again later.
    return { body: ack(500), outcome: 'error' };
  }
}

/* ---------- iPOS Pay, Unipesa and crypto (hosted checkout pages) ---------- */

/** Which ways to pay are switched on, for a given amount. */
export function payMethods(deps: PaymentDeps, amountKes: number): PayMethods {
  return {
    mpesa: Boolean(deps.daraja) && amountKes <= MPESA_MAX_KES,
    card: Boolean(deps.pesapal) && pesapalReady(deps.config),
    ipos: Boolean(deps.gateways.ipos),
    unipesa: Boolean(deps.gateways.unipesa),
    crypto: Boolean(deps.gateways.crypto),
  };
}

/** Sends the guest to iPOS Pay, Unipesa or NOWPayments. The amount always comes from the quote. */
export async function startGateway(
  deps: PaymentDeps,
  id: GatewayId,
  ref: unknown,
  contactInput: { email?: unknown; phone?: unknown },
): Promise<{ redirectUrl: string }> {
  const quote = await requireQuote(deps, ref);
  requirePayable(quote);
  const gateway = deps.gateways[id];
  if (!gateway) throw new PaymentError(503, 'unavailable', `${PROVIDER_NAME[id]} payments aren’t switched on yet. Please choose another way to pay.`);
  let email = quote.email;
  if (typeof contactInput.email === 'string' && contactInput.email.trim() !== '') {
    if (!EMAIL.test(contactInput.email.trim())) throw new PaymentError(400, 'invalid_email', 'That email address doesn’t look right.');
    email = contactInput.email.trim();
  }
  let phone = quote.phone;
  if (typeof contactInput.phone === 'string' && contactInput.phone.trim() !== '') phone = normalizeKenyanPhone(contactInput.phone) ?? phone;

  let charged: { amount: number; currency: string; rate?: number };
  if (gateway.currency === 'USD') {
    const rate = deps.config.usdRate;
    if (!rate) throw new PaymentError(503, 'unavailable', 'Dollar payments need an exchange rate. Please choose another way to pay.');
    charged = { amount: kesToUsd(quote.amountKes, rate), currency: 'USD', rate };
  } else {
    charged = { amount: quote.amountKes, currency: 'KES' };
  }
  const merchantRef = gateway.merchantRef(quote.ref, quote.payments.filter((p) => p.provider === id).length + 1);
  let res;
  try {
    res = await gateway.startCheckout({
      merchantRef,
      amount: charged.amount,
      description: `${quote.description} (${quote.ref})`,
      returnUrl: `${payUrl(deps.config, quote.ref)}?return=${id}`,
      email,
      phone,
      name: quote.guestName,
    });
  } catch (err) {
    deps.log('error', `${gateway.label} checkout failed`, { ref: quote.ref, error: (err as Error).message });
    throw new PaymentError(502, 'provider_error', `We couldn’t open the ${gateway.label} payment page just now. Please try again in a minute, or choose another way to pay.`);
  }
  const now = deps.now();
  const at = now.toISOString();
  await deps.store.update(quote.ref, (q) => {
    q.payments.push({ id: newId('pay'), provider: id, status: 'pending', amountKes: quote.amountKes, providerRef: res.providerRef, merchantRef, charged, createdAt: at, updatedAt: at });
    if (email && !q.email) q.email = email;
    const money = charged.currency === 'KES' ? '' : ` for ${charged.currency} ${charged.amount.toFixed(2)} at ${charged.rate} KES per dollar`;
    addHistory(q, now, 'guest', `Opened ${gateway.label} checkout${money}.`);
  });
  deps.log('info', `${gateway.label} checkout opened`, { ref: quote.ref, merchantRef, charged });
  return { redirectUrl: res.redirectUrl };
}

/** Applies what a gateway told us, after checking it's about this payment and the right amount. */
async function applyGatewayResult(deps: PaymentDeps, ref: string, payment: Payment, r: GatewayResult): Promise<'paid' | 'failed' | 'pending'> {
  const now = deps.now();
  const label = PROVIDER_NAME[payment.provider];
  const expected = payment.charged ?? { amount: payment.amountKes, currency: 'KES' };
  const problems: string[] = [];
  if (r.merchantRef && r.merchantRef !== payment.merchantRef) problems.push(`reference ${r.merchantRef}`);
  if (r.currency && r.currency.toUpperCase() !== expected.currency) problems.push(`currency ${r.currency}`);
  if (r.amount !== undefined && !sameMoney(r.amount, expected.amount)) problems.push(`amount ${r.currency ?? expected.currency} ${r.amount}`);

  if ((r.outcome === 'paid' && problems.length) || r.outcome === 'underpaid') {
    const flag =
      r.outcome === 'underpaid'
        ? `${label}: ${r.reason ?? 'the guest paid less than the amount due.'}`
        : `${label} reported a completed payment that doesn’t match (${problems.join(', ')}; expected ${expected.currency} ${expected.amount}).`;
    await deps.store.update(ref, (q) => markFailed(q, payment.id, 'We received a payment we need to check by hand. We’ll be in touch shortly.', now, flag));
    deps.log('warn', `${label} mismatch`, { ref, problems });
    fireNotify(deps, { type: 'flagged', ref, paymentId: payment.id, flag });
    return 'failed';
  }
  if (r.outcome === 'paid') {
    let changed = false;
    await deps.store.update(ref, (q) => {
      changed = markPaid(q, payment.id, r.receipt, now, { method: r.method });
    });
    if (changed) {
      deps.log('info', `${label} payment confirmed`, { ref });
      fireNotify(deps, { type: 'paid', ref, paymentId: payment.id });
    }
    return 'paid';
  }
  if (r.outcome === 'failed') {
    await deps.store.update(ref, (q) => markFailed(q, payment.id, r.reason ?? 'The payment did not go through.', now));
    return 'failed';
  }
  await deps.store.update(ref, (q) => {
    const p = q.payments.find((x) => x.id === payment.id);
    if (p) p.updatedAt = now.toISOString();
  });
  return 'pending';
}

async function checkGateway(deps: PaymentDeps, ref: string, payment: Payment): Promise<'paid' | 'failed' | 'pending' | 'unknown'> {
  const gateway = deps.gateways[payment.provider as GatewayId];
  if (!gateway) return 'unknown';
  const r = await gateway.checkStatus({ merchantRef: payment.merchantRef ?? '', providerRef: payment.providerRef, txnId: payment.txnId, amount: payment.charged?.amount });
  if (!r) return 'unknown';
  return applyGatewayResult(deps, ref, payment, r);
}

/**
 * A gateway's notification. We only believe a status that came straight from the gateway's API,
 * or a notification carrying a valid signature made with our secret key.
 */
export async function handleGatewayNotice(deps: PaymentDeps, id: GatewayId, notice: GatewayNotice): Promise<'paid' | 'failed' | 'pending' | 'ignored' | 'rejected' | 'unverified'> {
  const gateway = deps.gateways[id];
  if (!gateway) return 'ignored';
  const read = gateway.readNotice(notice);
  if (!read) {
    deps.log('warn', `${gateway.label} notification rejected (bad signature or not ours)`);
    return 'rejected';
  }
  const found = read.merchantRef ? await deps.store.findByMerchantRef(id, read.merchantRef) : undefined;
  if (!found) {
    deps.log('warn', `${gateway.label} notification for an unknown payment`, { merchantRef: read.merchantRef });
    return 'ignored';
  }
  let payment = found.payment;
  if (read.txnId && payment.txnId !== read.txnId) {
    await deps.store.update(found.quote.ref, (q) => {
      const p = q.payments.find((x) => x.id === payment.id);
      if (p) p.txnId = read.txnId!;
    });
    payment = { ...payment, txnId: read.txnId };
  }
  if (payment.status !== 'pending') return 'ignored';
  const asked = await gateway.checkStatus({ merchantRef: payment.merchantRef ?? '', providerRef: payment.providerRef, txnId: payment.txnId, amount: payment.charged?.amount });
  const result = asked ?? read.verified;
  if (!result) {
    deps.log('warn', `${gateway.label} notification could not be confirmed`, { ref: found.quote.ref });
    return 'unverified';
  }
  return applyGatewayResult(deps, found.quote.ref, payment, result);
}

/* ---------- Status ---------- */

/** Asks the providers about any payment still waiting, so the page updates even if a callback was missed. */
async function reconcile(deps: PaymentDeps, quote: Quote): Promise<void> {
  if (quote.status !== 'awaiting_payment') return;
  const now = deps.now().getTime();
  for (const p of quote.payments) {
    if (p.status !== 'pending' || now - Date.parse(p.updatedAt) < RECHECK_MS) continue;
    try {
      if (p.provider === 'mpesa' && deps.daraja) {
        const r = await confirmMpesa(deps, quote.ref, p, p.receipt);
        if (r === 'awaiting_confirmation' && now - Date.parse(p.createdAt) > MPESA_GIVE_UP_MS) {
          await deps.store.update(quote.ref, (q) => markFailed(q, p.id, 'We didn’t get a response from M-Pesa. Please try again.', deps.now()));
        }
      } else if (p.provider === 'pesapal' && deps.pesapal) {
        await checkPesapal(deps, quote.ref, p);
      } else if (p.provider === 'ipos' || p.provider === 'unipesa' || p.provider === 'crypto') {
        await checkGateway(deps, quote.ref, p);
      }
    } catch (err) {
      if (!(err instanceof ProviderError)) throw err;
      deps.log('warn', 'Status check failed', { ref: quote.ref, provider: p.provider, error: err.message });
    }
  }
}

export function viewQuote(deps: PaymentDeps, quote: Quote): QuoteView {
  const methods = payMethods(deps, quote.amountKes);
  const base = {
    ref: quote.ref,
    firstName: quote.guestName.split(/\s+/)[0] ?? quote.guestName,
    description: quote.description,
    amountKes: quote.amountKes,
    methods,
    ...(deps.config.usdRate ? { usdAmount: kesToUsd(quote.amountKes, deps.config.usdRate) } : {}),
    ...(quote.booking
      ? {
          booking: {
            packageName: quote.booking.packageName,
            travelDate: quote.booking.travelDate,
            adults: quote.booking.adults,
            children: quote.booking.children,
            totalKes: quote.booking.totalKes,
            plan: quote.booking.plan,
            depositPercent: quote.booking.depositPercent,
            balanceKes: quote.booking.balanceKes,
          },
        }
      : {}),
  };
  if (quote.status === 'paid') {
    const paid = quote.payments.find((p) => p.status === 'paid');
    const view: QuoteView = { ...base, status: 'paid', message: 'Payment received. Thank you! We’ll send your confirmation shortly.' };
    if (paid?.receipt) view.receipt = paid.receipt;
    return view;
  }
  if (quote.status === 'refunded') return { ...base, status: 'refunded', message: 'This booking was refunded. Please contact us if you have any questions.' };
  if (quote.status === 'cancelled') return { ...base, status: 'cancelled', message: 'This quote has been cancelled. Please contact us for a new one.' };
  const last = quote.payments.at(-1);
  if (last?.status === 'pending') {
    return {
      ...base,
      status: 'pending',
      message:
        last.provider === 'mpesa'
          ? 'Waiting for you to enter your M-Pesa PIN…'
          : last.provider === 'pesapal'
            ? 'Waiting for the card payment to be confirmed…'
            : last.provider === 'crypto'
              ? 'Waiting for the crypto payment to be confirmed on the blockchain. This can take a few minutes…'
              : `Waiting for ${PROVIDER_NAME[last.provider]} to confirm the payment…`,
    };
  }
  if (last?.status === 'failed') return { ...base, status: 'failed', message: last.failureReason ?? 'The payment did not go through. Please try again.' };
  return { ...base, status: 'awaiting_payment', message: 'Ready to pay.' };
}

export async function getQuoteStatus(deps: PaymentDeps, ref: unknown, opts: { refresh: boolean } = { refresh: true }): Promise<QuoteView> {
  let quote = await requireQuote(deps, ref);
  if (opts.refresh) {
    await reconcile(deps, quote);
    quote = (await deps.store.get(quote.ref))!;
  }
  return viewQuote(deps, quote);
}

/* ---------- Admin actions ---------- */

export async function cancelQuote(deps: PaymentDeps, ref: unknown, by: string, reason = ''): Promise<Quote> {
  const quote = await requireQuote(deps, ref);
  if (quote.status !== 'awaiting_payment') throw new PaymentError(409, 'locked', 'Only unpaid quotes can be cancelled. Use a refund for paid bookings.');
  return deps.store.update(quote.ref, (q) => {
    q.status = 'cancelled';
    q.cancelledAt = deps.now().toISOString();
    addHistory(q, deps.now(), by, `Quote cancelled${reason.trim() ? `: ${reason.trim()}` : '.'}`);
  });
}

export async function reopenQuote(deps: PaymentDeps, ref: unknown, by: string): Promise<Quote> {
  const quote = await requireQuote(deps, ref);
  if (quote.status !== 'cancelled') throw new PaymentError(409, 'locked', 'Only cancelled quotes can be reopened.');
  return deps.store.update(quote.ref, (q) => {
    q.status = 'awaiting_payment';
    delete q.cancelledAt;
    addHistory(q, deps.now(), by, 'Quote reopened.');
  });
}

export const MANUAL_METHODS = ['Cash', 'Bank transfer', 'M-Pesa (paid directly)', 'Card (in person)', 'Other'] as const;

/** Records a payment received outside the site, e.g. cash at the office or a bank transfer. */
export async function recordManualPayment(
  deps: PaymentDeps,
  ref: unknown,
  input: { method?: unknown; reference?: unknown; note?: unknown },
  by: string,
): Promise<Quote> {
  const quote = await requireQuote(deps, ref);
  requirePayable(quote);
  const method = typeof input.method === 'string' && (MANUAL_METHODS as readonly string[]).includes(input.method) ? input.method : undefined;
  if (!method) throw new PaymentError(400, 'invalid_input', 'Choose how it was paid.');
  const reference = typeof input.reference === 'string' ? input.reference.trim().slice(0, 80) : '';
  const note = typeof input.note === 'string' ? input.note.trim().slice(0, 300) : '';
  const now = deps.now();
  const payment: Payment = {
    id: newId('pay'),
    provider: 'manual',
    status: 'pending',
    amountKes: quote.amountKes,
    providerRef: newId('manual'),
    method,
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
  };
  if (reference) payment.receipt = reference;
  if (note) payment.note = note;
  const saved = await deps.store.update(quote.ref, (q) => {
    q.payments.push(payment);
    markPaid(q, payment.id, payment.receipt, now);
    const last = q.history?.at(-1);
    if (last) last.by = by;
  });
  fireNotify(deps, { type: 'paid', ref: quote.ref, paymentId: payment.id });
  return saved;
}

/** Money still refundable on a payment (paid amount minus refunds that are done or in progress). */
export function refundable(q: Quote, paymentId: string): number {
  const p = q.payments.find((x) => x.id === paymentId);
  if (!p || p.status !== 'paid') return 0;
  const used = (q.refunds ?? []).filter((r) => r.paymentId === paymentId && r.status !== 'failed').reduce((s, r) => s + r.amountKes, 0);
  return Math.max(0, p.amountKes - used);
}

const CARD_METHODS = /visa|master|amex|american express|card|union/i;

export interface RefundInput {
  paymentId?: unknown;
  amountKes?: unknown;
  reason?: unknown;
  /** "provider" sends it through M-Pesa/Pesapal. "manual" records a refund already made another way. */
  mode?: unknown;
  reference?: unknown;
}

export async function refundPayment(deps: PaymentDeps, ref: unknown, input: RefundInput, by: string): Promise<Refund> {
  const quote = await requireQuote(deps, ref);
  const payment = quote.payments.find((p) => p.id === input.paymentId);
  if (!payment || payment.status !== 'paid') throw new PaymentError(404, 'not_found', 'Choose a paid payment to refund.');
  const left = refundable(quote, payment.id);
  if (left <= 0) throw new PaymentError(409, 'nothing_left', 'This payment has already been fully refunded (or a refund is in progress).');
  const amountKes = amount(input.amountKes, 'Refund amount');
  if (amountKes > left) throw new PaymentError(400, 'too_much', `You can refund at most ${kes(left)} on this payment.`);
  const reason = typeof input.reason === 'string' && input.reason.trim() ? input.reason.trim().slice(0, 200) : '';
  if (!reason) throw new PaymentError(400, 'invalid_input', 'Add a short reason for the refund.');
  const mode = input.mode === 'manual' ? 'manual' : 'provider';
  const now = deps.now();
  const refund: Refund = {
    id: newId('ref'),
    paymentId: payment.id,
    via: mode === 'manual' ? 'manual' : payment.provider,
    status: 'requested',
    amountKes,
    reason,
    by,
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
  };

  if (mode === 'manual') {
    refund.status = 'completed';
    const reference = typeof input.reference === 'string' ? input.reference.trim().slice(0, 80) : '';
    if (reference) refund.reference = reference;
  } else if (payment.provider === 'mpesa') {
    if (!deps.daraja || !deps.config.mpesa?.reversal) {
      throw new PaymentError(503, 'unavailable', 'M-Pesa refunds need the initiator name and security credential. Add them in Settings → M-Pesa, or record a refund you made another way.');
    }
    if (amountKes !== payment.amountKes || (quote.refunds ?? []).some((r) => r.paymentId === payment.id && r.status !== 'failed')) {
      throw new PaymentError(400, 'full_only', `M-Pesa reversals return the whole payment (${kes(payment.amountKes)}). For part refunds, send the money another way and record it here.`);
    }
    if (!payment.receipt) throw new PaymentError(409, 'no_receipt', 'This payment has no M-Pesa receipt number, so it can’t be reversed automatically.');
    try {
      const res = await deps.daraja.reverse({ transactionId: payment.receipt, amount: amountKes, remarks: reason });
      refund.conversationId = res.ConversationID;
      refund.originatorConversationId = res.OriginatorConversationID;
    } catch (err) {
      deps.log('error', 'M-Pesa reversal request failed', { ref: quote.ref, error: (err as Error).message });
      throw new PaymentError(502, 'provider_error', `M-Pesa didn’t accept the refund: ${(err as Error).message.replace(/^mpesa error: /, '')}`);
    }
  } else if (payment.provider === 'pesapal') {
    if (!deps.pesapal) throw new PaymentError(503, 'unavailable', 'Pesapal isn’t set up. Add it in Settings → Pesapal, or record a refund you made another way.');
    if ((quote.refunds ?? []).some((r) => r.paymentId === payment.id && r.via === 'pesapal' && r.status !== 'failed')) {
      throw new PaymentError(409, 'one_only', 'Pesapal allows one refund per payment, and this one already has a refund.');
    }
    if (amountKes !== payment.amountKes && !CARD_METHODS.test(payment.method ?? '')) {
      throw new PaymentError(400, 'full_only', 'Pesapal can only refund mobile money payments in full.');
    }
    if (!payment.receipt) throw new PaymentError(409, 'no_receipt', 'This payment has no Pesapal confirmation code, so it can’t be refunded automatically.');
    try {
      await deps.pesapal.refund({ confirmationCode: payment.receipt, amount: amountKes, username: by, remarks: reason });
    } catch (err) {
      deps.log('error', 'Pesapal refund request failed', { ref: quote.ref, error: (err as Error).message });
      throw new PaymentError(502, 'provider_error', `Pesapal didn’t accept the refund: ${(err as Error).message.replace(/^Pesapal refund failed: /, '')}`);
    }
  } else if (payment.provider === 'manual') {
    throw new PaymentError(400, 'manual_only', 'This payment was recorded by hand, so record the refund by hand too.');
  } else {
    const where = payment.provider === 'ipos' ? 'your iPOSpays portal' : payment.provider === 'unipesa' ? 'your Unipesa merchant dashboard' : 'your NOWPayments dashboard';
    throw new PaymentError(
      400,
      'manual_only',
      `${PROVIDER_NAME[payment.provider]} refunds are made in ${where}. Do it there, then choose “I’ve already paid it back another way” to record it here.`,
    );
  }

  await deps.store.update(quote.ref, (q) => {
    (q.refunds ??= []).push(refund);
    if (refund.status === 'completed') {
      addHistory(q, now, by, `Refund of ${kes(amountKes)} recorded (paid back outside the site${refund.reference ? `, ref ${refund.reference}` : ''}). Reason: ${reason}`);
      settleRefundStatus(q);
    } else {
      addHistory(
        q,
        now,
        by,
        refund.via === 'pesapal'
          ? `Refund of ${kes(amountKes)} sent to Pesapal. Approve it in your Pesapal dashboard. Reason: ${reason}`
          : `M-Pesa reversal of ${kes(amountKes)} requested. Waiting for Safaricom. Reason: ${reason}`,
      );
    }
  });
  if (refund.status === 'completed') fireNotify(deps, { type: 'refund_completed', ref: quote.ref, refundId: refund.id });
  deps.log('info', 'Refund started', { ref: quote.ref, via: refund.via, amountKes });
  return refund;
}

/** When everything paid has been refunded, the booking counts as refunded. */
function settleRefundStatus(q: Quote): void {
  const paid = q.payments.filter((p) => p.status === 'paid').reduce((s, p) => s + p.amountKes, 0);
  const back = (q.refunds ?? []).filter((r) => r.status === 'completed').reduce((s, r) => s + r.amountKes, 0);
  if (paid > 0 && back >= paid) q.status = 'refunded';
}

function finishRefund(q: Quote, refundId: string, ok: boolean, at: Date, detail: { reference?: string | undefined; reason?: string | undefined }): boolean {
  const r = q.refunds?.find((x) => x.id === refundId);
  if (!r || r.status !== 'requested') return false;
  r.status = ok ? 'completed' : 'failed';
  r.updatedAt = at.toISOString();
  if (detail.reference) r.reference = detail.reference;
  if (!ok) r.failureReason = detail.reason ?? 'The refund did not go through.';
  addHistory(
    q,
    at,
    'system',
    ok ? `Refund of ${kes(r.amountKes)} completed${detail.reference ? ` (${detail.reference})` : ''}.` : `Refund of ${kes(r.amountKes)} failed: ${r.failureReason}`,
  );
  if (ok) settleRefundStatus(q);
  return true;
}

/** Handles Safaricom's reversal result (or timeout). */
export async function handleMpesaReversalResult(deps: PaymentDeps, body: unknown, kind: 'result' | 'timeout'): Promise<'completed' | 'failed' | 'ignored'> {
  const parsed = parseReversalResult(body);
  if (!parsed) return 'ignored';
  const matches = (r: Refund) =>
    r.via === 'mpesa' && (r.conversationId === parsed.conversationId || (!!parsed.originatorConversationId && r.originatorConversationId === parsed.originatorConversationId));
  const quote = await deps.store.find((q) => (q.refunds ?? []).some(matches));
  if (!quote) {
    deps.log('warn', 'Reversal result for an unknown refund', { conversationId: parsed.conversationId });
    return 'ignored';
  }
  const refund = quote.refunds!.find(matches)!;
  const ok = kind === 'result' && parsed.ok;
  const reason =
    kind === 'timeout' ? 'Safaricom timed out. Check the M-Pesa org portal before trying again.' : parsed.ok ? undefined : parsed.reason;
  let changed = false;
  await deps.store.update(quote.ref, (q) => {
    changed = finishRefund(q, refund.id, ok, deps.now(), { reference: parsed.ok ? parsed.transactionId : undefined, reason });
  });
  if (!changed) return 'ignored';
  fireNotify(deps, { type: ok ? 'refund_completed' : 'refund_failed', ref: quote.ref, refundId: refund.id });
  return ok ? 'completed' : 'failed';
}

/** Pesapal marks a refunded payment as "reversed" (status 3). Check any refunds still waiting. */
export async function syncPesapalRefunds(deps: PaymentDeps, ref: unknown): Promise<number> {
  const quote = await requireQuote(deps, ref);
  if (!deps.pesapal) return 0;
  let done = 0;
  for (const r of (quote.refunds ?? []).filter((x) => x.via === 'pesapal' && x.status === 'requested')) {
    const p = quote.payments.find((x) => x.id === r.paymentId);
    if (!p) continue;
    const status = await deps.pesapal.transactionStatus(p.providerRef);
    if (status.status_code === 3) {
      let changed = false;
      await deps.store.update(quote.ref, (q) => {
        changed = finishRefund(q, r.id, true, deps.now(), {});
      });
      if (changed) {
        done++;
        fireNotify(deps, { type: 'refund_completed', ref: quote.ref, refundId: r.id });
      }
    }
  }
  return done;
}

/** Marks a provider refund as done or failed by hand, e.g. after checking the provider’s dashboard. */
export async function resolveRefundManually(deps: PaymentDeps, ref: unknown, refundId: unknown, ok: boolean, by: string, note = ''): Promise<Quote> {
  const quote = await requireQuote(deps, ref);
  const refund = quote.refunds?.find((r) => r.id === refundId);
  if (!refund || refund.status !== 'requested') throw new PaymentError(404, 'not_found', 'That refund isn’t waiting for a result.');
  let changed = false;
  const saved = await deps.store.update(quote.ref, (q) => {
    changed = finishRefund(q, refund.id, ok, deps.now(), { reason: note || 'Marked as failed by an admin.' });
    const last = q.history?.at(-1);
    if (last) last.by = by;
  });
  if (changed) fireNotify(deps, { type: ok ? 'refund_completed' : 'refund_failed', ref: quote.ref, refundId: refund.id });
  return saved;
}

export async function addNote(deps: PaymentDeps, ref: unknown, note: unknown, by: string): Promise<Quote> {
  const quote = await requireQuote(deps, ref);
  const n = typeof note === 'string' ? note.trim().slice(0, 500) : '';
  if (!n) throw new PaymentError(400, 'invalid_input', 'Write a note first.');
  return deps.store.update(quote.ref, (q) => addHistory(q, deps.now(), by, `Note: ${n}`));
}

export async function logHistory(deps: Pick<PaymentDeps, 'store' | 'now'>, ref: string, by: string, line: string): Promise<void> {
  await deps.store.update(ref, (q) => addHistory(q, deps.now(), by, line));
}

/* ---------- Dashboard ---------- */

export interface QuoteSummary {
  awaiting: number;
  paidThisMonthKes: number;
  paidThisMonthCount: number;
  needsAttention: number;
  refundsPending: number;
}

/** Quotes with a flagged payment or a refund that failed: someone should look at them. */
export function needsAttention(q: Quote): boolean {
  return q.payments.some((p) => p.flag) || (q.refunds ?? []).some((r) => r.status === 'failed');
}

export function summarise(quotes: Quote[], now: Date): QuoteSummary {
  const monthKey = now.toISOString().slice(0, 7);
  const paid = quotes.filter((q) => (q.status === 'paid' || q.status === 'refunded') && q.paidAt?.slice(0, 7) === monthKey);
  return {
    awaiting: quotes.filter((q) => q.status === 'awaiting_payment').length,
    paidThisMonthKes: paid.reduce((s, q) => s + q.amountKes, 0),
    paidThisMonthCount: paid.length,
    needsAttention: quotes.filter(needsAttention).length,
    refundsPending: quotes.reduce((s, q) => s + (q.refunds ?? []).filter((r) => r.status === 'requested').length, 0),
  };
}

export function filterQuotes(quotes: Quote[], opts: { q?: string | null | undefined; status?: string | null | undefined }): Quote[] {
  const term = (opts.q ?? '').trim().toLowerCase();
  // Phone numbers are saved as 2547…; let people search the way they'd type them (0712 345 678, +254…).
  const phoneTerm = normalizeKenyanPhone(term);
  return quotes.filter((q) => {
    if (opts.status === 'attention' ? !needsAttention(q) : opts.status && opts.status !== 'all' && q.status !== opts.status) return false;
    if (!term) return true;
    if (phoneTerm && (q.phone === phoneTerm || q.payments.some((p) => p.phone === phoneTerm))) return true;
    const hay = [q.ref, q.guestName, q.description, q.email ?? '', q.phone ?? '', ...q.payments.map((p) => p.receipt ?? '')].join(' ').toLowerCase();
    return hay.includes(term);
  });
}

/* ---------- Admin API token ---------- */

export function isAdmin(config: PaymentConfig, authorization: string | null): boolean {
  if (!config.adminToken || !authorization?.startsWith('Bearer ')) return false;
  const given = Buffer.from(authorization.slice(7));
  const expected = Buffer.from(config.adminToken);
  return given.length === expected.length && timingSafeEqual(given, expected);
}
