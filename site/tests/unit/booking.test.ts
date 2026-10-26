import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { calculatePrice, PriceError, travellersLabel, type PricingRules } from '@/lib/packages/pricing';
import { availableMethods, bookPackage, createBalanceQuote, dateWindow, prettyDate, type BookInput } from '@/lib/packages/booking';
import { PackageStore, validatePackage, type TripPackage } from '@/lib/packages/store';
import { loadBookingConfig } from '@/lib/payments/config';
import { handleMpesaCallback, recordManualPayment } from '@/lib/payments/service';
import { FULL_ENV, makeDeps, stkCallback } from '../helpers';
import { sampleInput } from '../package-helpers';

const rules = (over: Partial<PricingRules> = {}): PricingRules => ({ adultKes: 100_000, childKes: 60_000, minGuests: 1, maxGuests: 6, ...over });

describe('calculatePrice', () => {
  it('adds up adults and children', () => {
    expect(calculatePrice(rules(), { adults: 2, children: 1, plan: 'full' }, 30)).toEqual({
      adults: 2,
      children: 1,
      adultKes: 100_000,
      childKes: 60_000,
      totalKes: 260_000,
      payNowKes: 260_000,
      balanceKes: 0,
      plan: 'full',
      depositPercent: 30,
    });
  });

  it('charges children the adult price when no child price is set', () => {
    expect(calculatePrice(rules({ childKes: null }), { adults: 1, children: 2, plan: 'full' }, 30).totalKes).toBe(300_000);
  });

  it('works out a deposit, rounding up to the shilling', () => {
    const p = calculatePrice(rules({ adultKes: 33_333 }), { adults: 1, children: 0, plan: 'deposit' }, 30);
    expect(p.payNowKes).toBe(10_000); // 9,999.9 → 10,000
    expect(p.balanceKes).toBe(23_333);
    expect(p.payNowKes + p.balanceKes).toBe(p.totalKes);
  });

  it('switches to paying in full when deposits are turned off', () => {
    expect(calculatePrice(rules(), { adults: 1, children: 0, plan: 'deposit' }, 0).plan).toBe('full');
    expect(calculatePrice(rules(), { adults: 1, children: 0, plan: 'deposit' }, 100).plan).toBe('full');
  });

  it.each([
    [rules({ adultKes: null }), { adults: 2, children: 0 }, 'isn’t priced yet'],
    [rules(), { adults: 0, children: 2 }, 'At least one adult'],
    [rules(), { adults: 1.5, children: 0 }, 'At least one adult'],
    [rules(), { adults: 1, children: -1 }, 'how many children'],
    [rules({ minGuests: 4 }), { adults: 2, children: 1 }, 'at least 4'],
    [rules({ maxGuests: 3 }), { adults: 2, children: 2 }, 'up to 3'],
  ] as const)('refuses impossible groups (%#)', (r, group, message) => {
    expect(() => calculatePrice(r, { ...group, plan: 'full' }, 30)).toThrow(PriceError);
    expect(() => calculatePrice(r, { ...group, plan: 'full' }, 30)).toThrow(message);
  });

  it('describes the group in words', () => {
    expect(travellersLabel(1, 0)).toBe('1 adult');
    expect(travellersLabel(2, 1)).toBe('2 adults, 1 child');
    expect(travellersLabel(2, 3)).toBe('2 adults, 3 children');
  });
});

describe('booking rules from settings', () => {
  it('defaults to a 30% deposit and 3 days’ notice', () => {
    expect(loadBookingConfig({})).toEqual({ depositPercent: 30, leadDays: 3 });
    expect(loadBookingConfig({ DEPOSIT_PERCENT: '50', BOOKING_LEAD_DAYS: '0' })).toEqual({ depositPercent: 50, leadDays: 0 });
  });

  it('lets guests pick dates from the notice period up to two years ahead, in Nairobi time', () => {
    // 22:30 UTC is already the next day in Nairobi.
    expect(dateWindow(new Date('2026-10-23T22:30:00Z'), 3)).toEqual({ min: '2026-10-27', max: '2028-10-24' });
    expect(prettyDate('2027-01-12')).toBe('12 January 2027');
  });
});

/* ---------- Booking from a journey page ---------- */

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

async function setup(opts: { pricing?: Partial<TripPackage['pricing']>; published?: boolean; mpesa?: boolean; pesapal?: boolean } = {}) {
  const t = makeDeps({ ...(opts.mpesa === false ? { mpesa: false } : {}), ...(opts.pesapal === false ? { pesapal: false } : {}) });
  const dir = mkdtempSync(join(tmpdir(), 'wz-book-'));
  dirs.push(dir);
  const base = validatePackage(sampleInput({ published: opts.published === false ? '' : 'on' }), ['maasai-mara', 'diani']);
  const pkg: TripPackage = { ...base, pricing: { adultKes: 100_000, childKes: 50_000, minGuests: 1, maxGuests: 6, ...opts.pricing } };
  const packages = new PackageStore(dir, async () => [pkg]);
  const cfg = { depositPercent: 30, leadDays: 3 };
  return { ...t, packages, cfg, pkg };
}

const booking = (over: Partial<BookInput> = {}): BookInput => ({
  packageId: 'wild-to-blue',
  travelDate: '2027-01-12',
  adults: 2,
  children: 1,
  plan: 'deposit',
  method: 'mpesa',
  name: 'Jane Wanjiku',
  email: 'jane@example.com',
  phone: '0712 345 678',
  ...over,
});

describe('bookPackage', () => {
  it('saves the booking at the server’s price and sends the M-Pesa prompt for the deposit', async () => {
    const { deps, packages, cfg, daraja } = await setup();
    const res = await bookPackage(deps, packages, cfg, booking());
    expect(res.next).toBe(`/pay/${res.ref}/`);
    expect(res.warning).toBeUndefined();

    const q = (await deps.store.get(res.ref))!;
    expect(q.amountKes).toBe(75_000); // 30% of 250,000
    expect(q.description).toBe('Wild to Blue · 2 adults, 1 child · 12 January 2027 · 30% deposit');
    expect(q.history?.[0]?.by).toBe('guest');
    expect(q.booking).toEqual({
      packageId: 'wild-to-blue',
      packageName: 'Wild to Blue',
      travelDate: '2027-01-12',
      adults: 2,
      children: 1,
      totalKes: 250_000,
      plan: 'deposit',
      depositPercent: 30,
      balanceKes: 175_000,
    });
    expect(q.history?.[0]?.text).toMatch(/^Booked online: Wild to Blue.*Total KES 250,000; paying a 30% deposit of KES 75,000/);
    expect(daraja.stkPush).toHaveBeenCalledWith(expect.objectContaining({ amount: 75_000, phone: '254712345678' }));
  });

  it('ignores any amount the browser sends', async () => {
    const { deps, packages, cfg } = await setup();
    const res = await bookPackage(deps, packages, cfg, { ...booking({ plan: 'full' }), amountKes: 1, totalKes: 1, price: 1 } as BookInput);
    expect((await deps.store.get(res.ref))!.amountKes).toBe(250_000);
  });

  it('sends card payers to Pesapal checkout for the full amount', async () => {
    const { deps, packages, cfg, pesapal } = await setup();
    const res = await bookPackage(deps, packages, cfg, booking({ method: 'card', plan: 'full', phone: '' }));
    expect(res.next).toMatch(/^https:\/\/cybqa\.pesapal\.com\/iframe/);
    expect(pesapal.submitOrder).toHaveBeenCalledWith(expect.objectContaining({ amount: 250_000, email: 'jane@example.com' }));
    expect((await deps.store.get(res.ref))!.booking?.plan).toBe('full');
  });

  it('keeps the booking and returns to the pay page when the payment can’t start', async () => {
    const { deps, packages, cfg, daraja } = await setup();
    daraja.stkPush.mockRejectedValueOnce(new Error('Safaricom is down'));
    const res = await bookPackage(deps, packages, cfg, booking());
    expect(res.next).toBe(`/pay/${res.ref}/`);
    expect(res.warning).toBe('We couldn’t reach M-Pesa just now. Please try again in a minute.');
    expect((await deps.store.get(res.ref))!.status).toBe('awaiting_payment');
  });

  it.each([
    [{ packageId: 'nope' }, 'isn’t available'],
    [{ travelDate: '' }, 'Choose your travel date'],
    [{ travelDate: '12/01/2027' }, 'Choose your travel date'],
    [{ travelDate: '2026-10-24' }, 'earliest date'],
    [{ travelDate: '2029-01-01' }, 'next two years'],
    [{ method: 'bitcoin' }, 'how you’d like to pay'],
    [{ adults: 0 }, 'At least one adult'],
    [{ adults: 5, children: 2 }, 'up to 6'],
    [{ email: '' }, 'email address'],
    [{ phone: '' }, 'Safaricom number'],
    [{ phone: '0201 234 567' }, 'Safaricom number'],
  ] as [Partial<BookInput>, string][])('refuses %j', async (over, message) => {
    const { deps, packages, cfg, daraja } = await setup();
    await expect(bookPackage(deps, packages, cfg, booking(over))).rejects.toThrow(message);
    expect(await deps.store.list()).toEqual([]);
    expect(daraja.stkPush).not.toHaveBeenCalled();
  });

  it('won’t book drafts or unpriced journeys', async () => {
    const draft = await setup({ published: false });
    await expect(bookPackage(draft.deps, draft.packages, draft.cfg, booking())).rejects.toThrow('isn’t available');
    const unpriced = await setup({ pricing: { adultKes: null, childKes: null } });
    await expect(bookPackage(unpriced.deps, unpriced.packages, unpriced.cfg, booking())).rejects.toThrow('isn’t priced yet');
  });

  it('only offers payment methods that are switched on', async () => {
    const { deps, packages, cfg } = await setup({ mpesa: false });
    expect(availableMethods(deps)).toEqual({ mpesa: false, card: true, ipos: false, unipesa: false, crypto: false });
    await expect(bookPackage(deps, packages, cfg, booking())).rejects.toThrow('M-Pesa payments aren’t available');
    const noIpn = makeDeps({ env: { ...FULL_ENV, PESAPAL_IPN_ID: undefined } });
    expect(availableMethods(noIpn.deps).card).toBe(false);
  });

  it('steers big M-Pesa payments to card or a deposit', async () => {
    const { deps, packages, cfg } = await setup({ pricing: { adultKes: 200_000, childKes: null } });
    await expect(bookPackage(deps, packages, cfg, booking({ plan: 'full', adults: 2, children: 0 }))).rejects.toThrow(/up to KES 250,000.*or pay a deposit/);
    // The deposit (30% of 400,000) fits.
    const ok = await bookPackage(deps, packages, cfg, booking({ plan: 'deposit', adults: 2, children: 0 }));
    expect((await deps.store.get(ok.ref))!.amountKes).toBe(120_000);
  });
});

describe('paying the balance', () => {
  async function paidDeposit() {
    const t = await setup();
    const res = await bookPackage(t.deps, t.packages, t.cfg, booking());
    const q = (await t.deps.store.get(res.ref))!;
    const checkout = q.payments[0]!.providerRef!;
    await handleMpesaCallback(t.deps, stkCallback(checkout, { amount: 75_000 }));
    expect((await t.deps.store.get(res.ref))!.status).toBe('paid');
    return { ...t, ref: res.ref };
  }

  it('creates a pay link for the rest once the deposit is paid', async () => {
    const { deps, ref } = await paidDeposit();
    const child = await createBalanceQuote(deps, ref, 'spence');
    expect(child.amountKes).toBe(175_000);
    expect(child.description).toBe('Balance: Wild to Blue · 2 adults, 1 child · 12 January 2027');
    expect(child.email).toBe('jane@example.com');
    expect(child.booking).toMatchObject({ plan: 'balance', parentRef: ref, totalKes: 250_000 });
    expect(child.booking?.balanceRef).toBeUndefined();

    const parent = (await deps.store.get(ref))!;
    expect(parent.booking?.balanceRef).toBe(child.ref);
    expect(parent.history?.at(-1)?.text).toContain(`Balance pay link created: ${child.ref}`);

    await expect(createBalanceQuote(deps, ref, 'spence')).rejects.toThrow('already a balance quote');
    await expect(createBalanceQuote(deps, child.ref, 'spence')).rejects.toThrow('isn’t a deposit booking');
  });

  it('waits for the deposit to be paid', async () => {
    const { deps, packages, cfg } = await setup();
    const res = await bookPackage(deps, packages, cfg, booking());
    await expect(createBalanceQuote(deps, res.ref, 'spence')).rejects.toThrow('hasn’t been paid yet');
  });

  it('isn’t offered for full payments or hand-made quotes', async () => {
    const { deps, packages, cfg } = await setup();
    const full = await bookPackage(deps, packages, cfg, booking({ plan: 'full', method: 'card' }));
    await recordManualPayment(deps, full.ref, { method: 'Cash', reference: 'R1', note: '' }, 'spence');
    await expect(createBalanceQuote(deps, full.ref, 'spence')).rejects.toThrow('isn’t a deposit booking');
  });
});
