import type { BookingConfig } from '@/lib/payments/config';
import { normalizeKenyanPhone } from '@/lib/payments/phone';
import {
  METHOD_LABEL,
  MPESA_MAX_KES,
  PaymentError,
  payMethods,
  startGateway,
  type PayMethods,
  createQuote,
  getQuote,
  payUrl,
  startMpesa,
  startPesapal,
  type PaymentDeps,
} from '@/lib/payments/service';
import type { Quote } from '@/lib/payments/store';
import { calculatePrice, kes, PriceError, travellersLabel, type PayPlan } from './pricing';
import type { PackageStore, TripPackage } from './store';

export interface BookInput {
  packageId?: unknown;
  travelDate?: unknown;
  adults?: unknown;
  children?: unknown;
  plan?: unknown;
  method?: unknown;
  name?: unknown;
  email?: unknown;
  phone?: unknown;
}

export interface BookResult {
  ref: string;
  /** Where to send the guest next: the pay page (M-Pesa, it polls for the result) or Pesapal’s checkout. */
  next: string;
  /** Set when the booking was saved but the payment couldn't start; the pay page lets them try again. */
  warning?: string;
}

/** Which ways to pay are switched on right now (before we know the amount, so M-Pesa's limit isn't applied). */
export function availableMethods(deps: PaymentDeps): PayMethods {
  return { ...payMethods(deps, 0), mpesa: Boolean(deps.daraja) };
}

const METHODS = ['mpesa', 'card', 'ipos', 'unipesa', 'crypto'] as const;

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** Earliest and latest dates a guest can pick, as YYYY-MM-DD (Nairobi time). */
export function dateWindow(now: Date, leadDays: number): { min: string; max: string } {
  const nairobi = new Date(now.getTime() + 3 * 3600_000);
  const min = new Date(nairobi);
  min.setUTCDate(min.getUTCDate() + leadDays);
  const max = new Date(nairobi);
  max.setUTCFullYear(max.getUTCFullYear() + 2);
  return { min: isoDate(min), max: isoDate(max) };
}

export function prettyDate(iso: string): string {
  return new Date(`${iso}T12:00:00Z`).toLocaleDateString('en-KE', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
}

/**
 * A guest books a journey from its page: we price it on the server, save it as a quote,
 * and start the payment they chose. The amount never comes from the browser.
 */
export async function bookPackage(deps: PaymentDeps, packages: PackageStore, cfg: BookingConfig, input: BookInput): Promise<BookResult> {
  const pkg = typeof input.packageId === 'string' ? await packages.get(input.packageId) : undefined;
  if (!pkg || !pkg.published) throw new PaymentError(404, 'not_found', 'That journey isn’t available to book.');

  const { min, max } = dateWindow(deps.now(), cfg.leadDays);
  const travelDate = typeof input.travelDate === 'string' ? input.travelDate : '';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(travelDate) || Number.isNaN(Date.parse(travelDate))) throw new PaymentError(400, 'invalid_date', 'Choose your travel date.');
  if (travelDate < min) throw new PaymentError(400, 'invalid_date', `The earliest date you can book online is ${prettyDate(min)}. For sooner trips, message us.`);
  if (travelDate > max) throw new PaymentError(400, 'invalid_date', 'Please choose a date within the next two years.');

  const method = METHODS.find((m) => m === input.method);
  const methods = availableMethods(deps);
  if (!method) throw new PaymentError(400, 'invalid_method', 'Choose how you’d like to pay.');
  if (!methods[method]) {
    throw new PaymentError(503, 'unavailable', `${method === 'card' ? 'Card' : METHOD_LABEL[method]} payments aren’t available right now. Please choose another way to pay.`);
  }

  let price;
  try {
    price = calculatePrice(pkg.pricing, { adults: Number(input.adults), children: Number(input.children ?? 0), plan: input.plan === 'deposit' ? 'deposit' : 'full' }, cfg.depositPercent);
  } catch (err) {
    if (err instanceof PriceError) throw new PaymentError(400, 'invalid_price', err.message);
    throw err;
  }
  if (method === 'mpesa' && price.payNowKes > MPESA_MAX_KES) {
    throw new PaymentError(400, 'over_limit', `M-Pesa allows up to ${kes(MPESA_MAX_KES)} per payment. Choose card${price.plan === 'full' && cfg.depositPercent > 0 ? ', or pay a deposit' : ''}.`);
  }

  const name = typeof input.name === 'string' ? input.name.trim() : '';
  const email = typeof input.email === 'string' ? input.email.trim() : '';
  const phoneRaw = typeof input.phone === 'string' ? input.phone.trim() : '';
  if (!email) throw new PaymentError(400, 'invalid_input', 'Add your email address for your receipt.');
  if (method === 'mpesa' && !normalizeKenyanPhone(phoneRaw)) throw new PaymentError(400, 'invalid_phone', 'Enter the Safaricom number to pay from, like 0712 345 678.');
  // For card payments a foreign number is fine; only Kenyan mobiles are saved on the quote.

  const plan: PayPlan = price.plan;
  const description = `${pkg.name} · ${travellersLabel(price.adults, price.children)} · ${prettyDate(travelDate)}${plan === 'deposit' ? ` · ${price.depositPercent}% deposit` : ''}`.slice(0, 200);

  const quote = await createQuote(
    deps,
    {
      guestName: name,
      description,
      amountKes: price.payNowKes,
      email,
      ...(normalizeKenyanPhone(phoneRaw) ? { phone: phoneRaw } : {}),
    },
    'guest',
  );
  await deps.store.update(quote.ref, (q) => {
    q.booking = {
      packageId: pkg.id,
      packageName: pkg.name,
      travelDate,
      adults: price.adults,
      children: price.children,
      totalKes: price.totalKes,
      plan,
      depositPercent: price.depositPercent,
      balanceKes: price.balanceKes,
    };
    const first = q.history?.[0];
    if (first) first.text = `Booked online: ${pkg.name}, ${travellersLabel(price.adults, price.children)}, ${prettyDate(travelDate)}. Total ${kes(price.totalKes)}; paying ${plan === 'deposit' ? `a ${price.depositPercent}% deposit of ${kes(price.payNowKes)}` : `in full (${kes(price.payNowKes)})`}.`;
  });
  deps.log('info', 'Package booked', { ref: quote.ref, packageId: pkg.id, totalKes: price.totalKes, plan, method });

  const pay = payUrl(deps.config, quote.ref);
  try {
    if (method === 'mpesa') {
      await startMpesa(deps, quote.ref, phoneRaw);
      return { ref: quote.ref, next: pay };
    }
    if (method === 'card') {
      const { redirectUrl } = await startPesapal(deps, quote.ref, { email });
      return { ref: quote.ref, next: redirectUrl };
    }
    const { redirectUrl } = await startGateway(deps, method, quote.ref, { email, phone: phoneRaw });
    return { ref: quote.ref, next: redirectUrl };
  } catch (err) {
    if (!(err instanceof PaymentError)) throw err;
    return { ref: quote.ref, next: pay, warning: err.message };
  }
}

/** After a deposit is paid: a new quote (and pay link) for the balance. */
export async function createBalanceQuote(deps: PaymentDeps, ref: unknown, by: string): Promise<Quote> {
  const parent = await getQuote(deps, ref);
  const b = parent.booking;
  if (!b || b.plan !== 'deposit') throw new PaymentError(400, 'not_deposit', 'This isn’t a deposit booking.');
  if (parent.status !== 'paid') throw new PaymentError(409, 'not_paid', 'The deposit hasn’t been paid yet.');
  if (b.balanceRef) throw new PaymentError(409, 'exists', `There’s already a balance quote: ${b.balanceRef}.`);
  if (b.balanceKes <= 0) throw new PaymentError(409, 'nothing_due', 'Nothing is left to pay.');

  const child = await createQuote(
    deps,
    {
      guestName: parent.guestName,
      description: `Balance: ${b.packageName} · ${travellersLabel(b.adults, b.children)} · ${prettyDate(b.travelDate)}`.slice(0, 200),
      amountKes: b.balanceKes,
      ...(parent.email ? { email: parent.email } : {}),
      ...(parent.phone ? { phone: parent.phone } : {}),
    },
    by,
  );
  await deps.store.update(child.ref, (q) => {
    q.booking = { ...b, plan: 'balance', parentRef: parent.ref };
    delete q.booking.balanceRef;
    const first = q.history?.[0];
    if (first) first.text = `Balance quote for booking ${parent.ref}: ${kes(b.balanceKes)}.`;
  });
  await deps.store.update(parent.ref, (q) => {
    if (q.booking) q.booking.balanceRef = child.ref;
    (q.history ??= []).push({ at: deps.now().toISOString(), by, text: `Balance pay link created: ${child.ref} for ${kes(b.balanceKes)}.` });
  });
  return (await deps.store.get(child.ref))!;
}

export type { TripPackage };
