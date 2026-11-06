import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { APIContext } from 'astro';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { loadBookingConfig, type OpenPayConfig } from '@/lib/payments/config';
import { createOpenPayment, openPayAmountKes } from '@/lib/payments/open-pay';
import { PaymentError, startGateway } from '@/lib/payments/service';
import { createNowPayments } from '@/lib/payments/gateways/nowpayments';
import { SettingsStore } from '@/lib/settings/store';
import { reloadRuntime, resetRateLimits, setPaymentDeps } from '@/lib/server/payments';
import * as openRoute from '@/pages/api/pay/open';
import { FULL_ENV, makeDeps } from '../helpers';

const LIMITS: OpenPayConfig = { minKes: 500, maxKes: 2_000_000 };
const RATE_ENV = { ...FULL_ENV, USD_KES_RATE: '129.5' };
const guest = { name: 'Jane Wanjiku', email: 'jane@example.com' };

async function rejects(p: Promise<unknown>, code: string) {
  await expect(p).rejects.toBeInstanceOf(PaymentError);
  await expect(p).rejects.toMatchObject({ code });
}

describe('loadBookingConfig: Make a payment page', () => {
  it('is off unless switched on', () => {
    expect(loadBookingConfig({}).openPay).toBeUndefined();
    expect(loadBookingConfig({ OPEN_PAY: 'off' }).openPay).toBeUndefined();
    expect(loadBookingConfig({ OPEN_PAY: 'yes' }).openPay).toBeUndefined();
  });

  it('uses the default limits when none are set', () => {
    expect(loadBookingConfig({ OPEN_PAY: 'on' }).openPay).toEqual({ minKes: 500, maxKes: 2_000_000 });
    expect(loadBookingConfig({ OPEN_PAY: ' ON ' }).openPay).toEqual({ minKes: 500, maxKes: 2_000_000 });
  });

  it('reads the limits, ignoring nonsense', () => {
    expect(loadBookingConfig({ OPEN_PAY: 'on', OPEN_PAY_MIN_KES: '1000', OPEN_PAY_MAX_KES: '300000' }).openPay).toEqual({ minKes: 1000, maxKes: 300_000 });
    expect(loadBookingConfig({ OPEN_PAY: 'on', OPEN_PAY_MIN_KES: 'abc', OPEN_PAY_MAX_KES: '-5' }).openPay).toEqual({ minKes: 500, maxKes: 2_000_000 });
  });

  it('falls back to the defaults when the lowest amount is above the highest', () => {
    expect(loadBookingConfig({ OPEN_PAY: 'on', OPEN_PAY_MIN_KES: '9000', OPEN_PAY_MAX_KES: '100' }).openPay).toEqual({ minKes: 500, maxKes: 2_000_000 });
  });
});

describe('openPayAmountKes', () => {
  it('takes whole shillings as they are', () => {
    expect(openPayAmountKes(15000, 'KES', undefined)).toBe(15000);
    expect(() => openPayAmountKes(150.5, 'KES', 129.5)).toThrow(/whole number/);
  });

  it('converts dollars at the rate, rounded up to the shilling', () => {
    expect(openPayAmountKes(100, 'USD', 129.5)).toBe(12950);
    expect(openPayAmountKes(10.01, 'USD', 129.5)).toBe(1297); // 1296.295 → 1297
    expect(openPayAmountKes(0.1 + 0.2, 'USD', 100)).toBe(30); // floating-point noise doesn't add a shilling
  });

  it('refuses dollars without a rate, and fractions of a cent', () => {
    expect(() => openPayAmountKes(100, 'USD', undefined)).toThrow(/isn’t available/);
    expect(() => openPayAmountKes(10.005, 'USD', 129.5)).toThrow(/two decimals/);
  });
});

describe('createOpenPayment', () => {
  it('creates a quote for the amount the guest chose and points at its pay page', async () => {
    const t = makeDeps({ env: RATE_ENV });
    const res = await createOpenPayment(t.deps, LIMITS, { ...guest, amount: '15,000', currency: 'KES', note: '  Balance for   WZ-ABC123 ' });
    expect(res.amountKes).toBe(15000);
    expect(res.next).toBe(`${t.deps.config.siteUrl}/pay/${res.ref}/`);
    const q = await t.deps.store.get(res.ref);
    expect(q).toMatchObject({ amountKes: 15000, guestName: 'Jane Wanjiku', email: 'jane@example.com', description: 'Balance for WZ-ABC123', status: 'awaiting_payment' });
    expect(q!.history![0]!.by).toBe('guest (Make a payment page)');
  });

  it('defaults to shillings and a plain description', async () => {
    const t = makeDeps({ env: RATE_ENV });
    const res = await createOpenPayment(t.deps, LIMITS, { ...guest, amount: 2500 });
    expect((await t.deps.store.get(res.ref))!.description).toBe('Payment to Whizperz Tours');
  });

  it('converts a dollar amount to the quote’s shillings', async () => {
    const t = makeDeps({ env: RATE_ENV });
    const res = await createOpenPayment(t.deps, LIMITS, { ...guest, amount: '250', currency: 'USD' });
    expect(res.amountKes).toBe(32375);
  });

  it('charges crypto in dollars for what the guest chose', async () => {
    const t = makeDeps({ env: RATE_ENV });
    const bodies: Record<string, unknown>[] = [];
    t.deps.gateways = {
      crypto: createNowPayments({ apiKey: 'k', ipnSecret: 's', baseUrl: 'https://api.nowpayments.io/v1', notifyUrl: 'https://example.com/n' } as never, async (_url, init) => {
        bodies.push(JSON.parse(String(init?.body)));
        return new Response(JSON.stringify({ id: 99, invoice_url: 'https://nowpayments.io/payment/?iid=99' }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }),
    };
    const res = await createOpenPayment(t.deps, LIMITS, { ...guest, amount: '250', currency: 'USD' });
    const out = await startGateway(t.deps, 'crypto', res.ref, { email: guest.email });
    expect(out).toMatchObject({ redirectUrl: 'https://nowpayments.io/payment/?iid=99' });
    expect(bodies[0]).toMatchObject({ price_amount: 250, price_currency: 'usd' });
  });

  it('stays within the limits set in the admin', async () => {
    const t = makeDeps({ env: RATE_ENV });
    await rejects(createOpenPayment(t.deps, LIMITS, { ...guest, amount: 499 }), 'out_of_range');
    await rejects(createOpenPayment(t.deps, LIMITS, { ...guest, amount: 2_000_001 }), 'out_of_range');
    await rejects(createOpenPayment(t.deps, LIMITS, { ...guest, amount: 3, currency: 'USD' }), 'out_of_range'); // ≈ KES 389
    await expect(createOpenPayment(t.deps, LIMITS, { ...guest, amount: 500 })).resolves.toMatchObject({ amountKes: 500 });
  });

  it('is unavailable when switched off', async () => {
    await rejects(createOpenPayment(makeDeps().deps, undefined, { ...guest, amount: 5000 }), 'not_found');
  });

  it.each([
    [{ ...guest, amount: '' }, 'invalid_amount'],
    [{ ...guest, amount: 'lots' }, 'invalid_amount'],
    [{ ...guest, amount: -100 }, 'invalid_amount'],
    [{ ...guest, amount: 5000, currency: 'EUR' }, 'invalid_currency'],
    [{ name: 'Jane', amount: 5000 }, 'invalid_input'],
    [{ email: 'jane@example.com', amount: 5000 }, 'invalid_input'],
    [{ ...guest, email: 'not-an-email', amount: 5000 }, 'invalid_input'],
    [{ ...guest, phone: '12', amount: 5000 }, 'invalid_input'],
    [{ ...guest, amount: 5000, note: 'x'.repeat(121) }, 'invalid_input'],
  ])('rejects %j', async (input, code) => {
    await rejects(createOpenPayment(makeDeps({ env: RATE_ENV }).deps, LIMITS, input), code);
  });

  it('is unavailable when no way to pay is switched on, and creates nothing', async () => {
    const t = makeDeps({ env: RATE_ENV, mpesa: false, pesapal: false });
    t.deps.config = { ...t.deps.config, pesapal: undefined } as typeof t.deps.config;
    await rejects(createOpenPayment(t.deps, LIMITS, { ...guest, amount: 5000 }), 'not_found');
    expect(await t.deps.store.list()).toHaveLength(0);
  });

  it('refuses dollars when no exchange rate is set', async () => {
    await rejects(createOpenPayment(makeDeps().deps, LIMITS, { ...guest, amount: 100, currency: 'USD' }), 'no_usd');
  });
});

describe('Settings: Make a payment page fields', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'wz-settings-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('saves on/off and limits, and rejects bad values', () => {
    const store = new SettingsStore(dir);
    store.saveSection('booking', { openPay: 'on', openMinKes: '1000', openMaxKes: '500000' }, {});
    expect(store.read().booking).toMatchObject({ openPay: 'on', openMinKes: '1000', openMaxKes: '500000' });
    expect(() => store.saveSection('booking', { openPay: 'maybe' }, {})).toThrow(/On or Off/);
    expect(() => store.saveSection('booking', { openMaxKes: '12.5' }, {})).toThrow(/whole shillings/);
  });
});

describe('POST /api/pay/open', () => {
  let dir: string;
  const saved = { DATA_DIR: process.env['DATA_DIR'], OPEN_PAY: process.env['OPEN_PAY'] };

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'wz-open-'));
    process.env['DATA_DIR'] = dir;
  });
  afterAll(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    reloadRuntime();
    rmSync(dir, { recursive: true, force: true });
  });
  beforeEach(() => resetRateLimits());
  afterEach(() => setPaymentDeps(undefined));

  function post(body: unknown, ip = '10.0.0.9') {
    const url = new URL('http://localhost/api/pay/open');
    const request = new Request(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    return openRoute.POST({ request, url, params: {}, locals: { ip } } as unknown as APIContext);
  }

  it('runs on the server', () => {
    expect(openRoute.prerender).toBe(false);
  });

  it('answers 404 while the page is off', async () => {
    delete process.env['OPEN_PAY'];
    reloadRuntime();
    setPaymentDeps(makeDeps({ env: RATE_ENV }).deps);
    const res = await post({ ...guest, amount: 5000 });
    expect(res.status).toBe(404);
  });

  it('creates the quote when on, and limits how often one address can', async () => {
    process.env['OPEN_PAY'] = 'on';
    reloadRuntime();
    const t = makeDeps({ env: RATE_ENV });
    setPaymentDeps(t.deps);
    const res = await post({ ...guest, amount: 5000, currency: 'KES' });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.next).toMatch(/\/pay\/WZ-[A-Z0-9]+\/$/);
    expect((await t.deps.store.get(body.ref))!.amountKes).toBe(5000);

    for (let i = 0; i < 4; i++) await post({ ...guest, amount: 5000 });
    const limited = await post({ ...guest, amount: 5000 });
    expect(limited.status).toBe(429);
    expect((await post({ ...guest, amount: 5000 }, '10.0.0.10')).status).toBe(201);
  });

  it('explains what’s wrong in plain words', async () => {
    process.env['OPEN_PAY'] = 'on';
    reloadRuntime();
    setPaymentDeps(makeDeps({ env: RATE_ENV }).deps);
    const res = await post({ ...guest, amount: 10 });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: 'out_of_range', message: expect.stringMatching(/KES 500 to KES 2,000,000/) });
  });
});
