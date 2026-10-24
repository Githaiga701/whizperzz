/**
 * Booking prices. Used on the package page (live total as the guest chooses) and on the server
 * (which always recalculates, so the browser can never set its own price). No server-only imports here.
 */

export interface PricingRules {
  adultKes: number | null;
  childKes: number | null;
  minGuests: number;
  maxGuests: number;
}

export type PayPlan = 'deposit' | 'full';

export interface PriceBreakdown {
  adults: number;
  children: number;
  adultKes: number;
  childKes: number;
  totalKes: number;
  /** What the guest pays now. */
  payNowKes: number;
  /** What's left to pay later (0 when paying in full). */
  balanceKes: number;
  plan: PayPlan;
  depositPercent: number;
}

export class PriceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PriceError';
  }
}

export function calculatePrice(rules: PricingRules, input: { adults: number; children: number; plan: PayPlan }, depositPercent: number): PriceBreakdown {
  if (rules.adultKes === null) throw new PriceError('This journey isn’t priced yet. Send us an enquiry and we’ll quote it for you.');
  const adults = Number(input.adults);
  const children = Number(input.children);
  if (!Number.isInteger(adults) || adults < 1) throw new PriceError('At least one adult needs to travel.');
  if (!Number.isInteger(children) || children < 0) throw new PriceError('Choose how many children are travelling.');
  const guests = adults + children;
  if (guests < rules.minGuests) throw new PriceError(`This journey needs at least ${rules.minGuests} travellers.`);
  if (guests > rules.maxGuests) throw new PriceError(`This journey takes up to ${rules.maxGuests} travellers. For bigger groups, send us an enquiry.`);

  const childKes = rules.childKes ?? rules.adultKes;
  const totalKes = adults * rules.adultKes + children * childKes;
  const pct = Math.min(100, Math.max(0, Math.round(depositPercent)));
  const plan: PayPlan = input.plan === 'deposit' && pct > 0 && pct < 100 ? 'deposit' : 'full';
  const payNowKes = plan === 'deposit' ? Math.ceil((totalKes * pct) / 100) : totalKes;
  return { adults, children, adultKes: rules.adultKes, childKes, totalKes, payNowKes, balanceKes: totalKes - payNowKes, plan, depositPercent: pct };
}

export function travellersLabel(adults: number, children: number): string {
  const a = `${adults} adult${adults === 1 ? '' : 's'}`;
  return children > 0 ? `${a}, ${children} child${children === 1 ? '' : 'ren'}` : a;
}

export const kes = (n: number) => `KES ${n.toLocaleString('en-KE')}`;
