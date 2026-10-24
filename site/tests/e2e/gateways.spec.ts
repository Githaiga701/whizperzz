import type { APIRequestContext, Page } from '@playwright/test';
import { test, expect } from './fixtures';
import { E2E_ADMIN_TOKEN, E2E_NOWPAYMENTS, E2E_UNIPESA } from './env';
import { unipesaSign } from '../../src/lib/payments/gateways/unipesa';
import { nowPaymentsSignature } from '../../src/lib/payments/gateways/nowpayments';

/**
 * iPOS Pay, Unipesa and crypto (NOWPayments), end to end against fake versions of each service.
 * The site charges KES 85,000 = USD 653.85 at the test rate of 130 shillings per dollar.
 */

const admin = { Authorization: `Bearer ${E2E_ADMIN_TOKEN}` };

async function newQuote(request: APIRequestContext, amountKes = 85000): Promise<string> {
  const res = await request.post('/api/admin/quotes', {
    headers: admin,
    data: { guestName: 'Jane Wanjiku', description: 'Wild to blue, 2 adults', amountKes },
  });
  expect(res.status()).toBe(201);
  return ((await res.json()) as { quote: { ref: string } }).quote.ref;
}

async function quoteJson(request: APIRequestContext, ref: string) {
  const all = (await (await request.get('/api/admin/quotes', { headers: admin })).json()) as {
    quotes: { ref: string; status: string; payments: { provider: string; status: string; merchantRef?: string; flag?: string; receipt?: string; charged?: { amount: number; currency: string } }[] }[];
  };
  return all.quotes.find((q) => q.ref === ref)!;
}

async function openGateway(page: Page, ref: string, form: string, button: string, email = 'jane@example.com') {
  await page.goto(`/pay/${ref}/`);
  const f = page.locator(`[data-pay-gateway="${form}"]`);
  await f.locator('input[name="email"]').fill(email);
  await f.getByRole('button', { name: button }).click();
}

test.describe('iPOS Pay', () => {
  test('guest pays in dollars and comes back to a confirmed booking', async ({ page, request }) => {
    const ref = await newQuote(request);
    await page.goto(`/pay/${ref}/`);
    await expect(page.locator('[data-pay-gateway="ipos"]')).toContainText('USD 653.85');
    await openGateway(page, ref, 'ipos', 'Continue to iPOS Pay');
    await expect(page.locator('h1')).toHaveText('Mock iPOSpays checkout');
    await expect(page.getByText('USD 653.85')).toBeVisible();
    await page.getByRole('button', { name: 'Pay now' }).click();

    await expect(page).toHaveURL(new RegExp(`/pay/${ref}/\\?return=ipos`));
    await expect(page.locator('h1')).toHaveText('All paid. Thank you!', { timeout: 15_000 });
    await expect(page.locator('[data-pay-status]')).toContainText('Receipt: IPOS');
    const q = await quoteJson(request, ref);
    expect(q.payments[0]).toMatchObject({ provider: 'ipos', status: 'paid', charged: { amount: 653.85, currency: 'USD' } });
  });

  test('a declined card shows why and lets the guest try again', async ({ page, request }) => {
    const ref = await newQuote(request);
    await openGateway(page, ref, 'ipos', 'Continue to iPOS Pay');
    await page.getByRole('button', { name: 'Decline' }).click();
    await expect(page.locator('[data-pay-status]')).toContainText('Declined', { timeout: 15_000 });
    await expect(page.locator('[data-pay-gateway="ipos"]')).toBeVisible();
  });
});

test.describe('Unipesa', () => {
  test('guest pays and the signed result confirms the booking', async ({ page, request }) => {
    const ref = await newQuote(request);
    await openGateway(page, ref, 'unipesa', 'Continue to Unipesa', '');
    await expect(page.locator('h1')).toHaveText('Mock Unipesa checkout');
    await expect(page.getByText('KES 85000.00')).toBeVisible();
    await page.getByRole('button', { name: 'Pay now' }).click();
    await expect(page).toHaveURL(new RegExp(`/pay/${ref}/\\?return=unipesa`));
    await expect(page.locator('h1')).toHaveText('All paid. Thank you!', { timeout: 15_000 });
    await expect(page.locator('[data-pay-status]')).toContainText('Receipt: UNI');
  });

  test('forged or unsigned results are ignored', async ({ request }) => {
    const ref = await newQuote(request);
    // Open checkout so there is a payment to target.
    const open = await request.post('/api/pay/gateway', { data: { ref, method: 'unipesa' } });
    expect(open.status()).toBe(200);
    const orderId = new URL(((await open.json()) as { redirectUrl: string }).redirectUrl).searchParams.get('order_id')!;
    const fields: Record<string, unknown> = { merchant_id: E2E_UNIPESA.merchantId, amount: '85000.00', order_id: orderId, transaction_id: 'T1', status: 2 };

    expect((await request.post('/api/callbacks/unipesa/wrong-secret', { data: fields })).status()).toBe(404);
    // Signed with the wrong key.
    await request.post('/api/callbacks/unipesa/e2e-unipesa-cb', { data: { ...fields, signature: unipesaSign(fields, 'not-the-key') } });
    // Correct key but the amount was changed after signing.
    const signed = { ...fields, signature: unipesaSign(fields, E2E_UNIPESA.secretKey) };
    await request.post('/api/callbacks/unipesa/e2e-unipesa-cb', { data: { ...signed, amount: '1.00' } });
    expect((await quoteJson(request, ref)).status).toBe('awaiting_payment');

    // A genuine result for a smaller amount is flagged, not accepted.
    const cheap = { ...fields, amount: '100.00' };
    await request.post('/api/callbacks/unipesa/e2e-unipesa-cb', { data: { ...cheap, signature: unipesaSign(cheap, E2E_UNIPESA.secretKey) } });
    const q = await quoteJson(request, ref);
    expect(q.status).toBe('awaiting_payment');
    expect(q.payments[0]!.flag).toContain('doesn’t match');
  });
});

test.describe('crypto (NOWPayments)', () => {
  test('guest pays in USDT; the page waits for the blockchain, then confirms', async ({ page, request }) => {
    const ref = await newQuote(request);
    await page.goto(`/pay/${ref}/`);
    await expect(page.locator('[data-pay-gateway="crypto"]')).toContainText('USD 653.85');
    await openGateway(page, ref, 'crypto', 'Continue to crypto payment');
    await expect(page.locator('h1')).toHaveText('Mock NOWPayments invoice');
    await page.getByRole('button', { name: 'Send USDT' }).click();
    await expect(page).toHaveURL(new RegExp(`/pay/${ref}/\\?return=crypto`));
    await expect(page.locator('h1')).toHaveText('All paid. Thank you!', { timeout: 20_000 });
    const q = await quoteJson(request, ref);
    expect(q.payments[0]).toMatchObject({ provider: 'crypto', status: 'paid', charged: { amount: 653.85, currency: 'USD' } });
  });

  test('a part payment is flagged for the team instead of accepted', async ({ page, request }) => {
    const ref = await newQuote(request);
    await openGateway(page, ref, 'crypto', 'Continue to crypto payment');
    await page.getByRole('button', { name: 'Send half' }).click();
    await expect(page.locator('[data-pay-status]')).toContainText('check by hand', { timeout: 20_000 });
    const q = await quoteJson(request, ref);
    expect(q.status).toBe('awaiting_payment');
    expect(q.payments[0]!.flag).toContain('Only part of the crypto amount arrived');
  });

  test('notifications without a valid signature are ignored', async ({ request }) => {
    const ref = await newQuote(request);
    const open = await request.post('/api/pay/gateway', { data: { ref, method: 'crypto', email: 'jane@example.com' } });
    expect(open.status()).toBe(200);
    const q = await quoteJson(request, ref);
    const body = { payment_id: 999999, payment_status: 'finished', order_id: q.payments[0]!.merchantRef, price_amount: 653.85, price_currency: 'usd' };
    await request.post('/api/callbacks/crypto/e2e-crypto-cb', { data: body, headers: { 'x-nowpayments-sig': nowPaymentsSignature(body, 'wrong-secret') } });
    await request.post('/api/callbacks/crypto/e2e-crypto-cb', { data: body });
    // Correctly signed, but NOWPayments itself has never heard of this payment, so it can't be confirmed.
    await request.post('/api/callbacks/crypto/e2e-crypto-cb', { data: body, headers: { 'x-nowpayments-sig': nowPaymentsSignature(body, E2E_NOWPAYMENTS.ipnSecret) } });
    expect((await quoteJson(request, ref)).status).toBe('awaiting_payment');
  });
});

test('online bookings can be paid with any method', async ({ request }) => {
  const id = `e2e-gw-${Math.random().toString(36).slice(2, 7)}`;
  const made = await request.post('/api/admin/packages', {
    headers: admin,
    data: {
      id,
      name: `Gateway trip ${id}`,
      route: ['diani'],
      styles: ['coast'],
      photoSrc: 'https://images.unsplash.com/photo-test',
      summary: 'Test.',
      itinerary: [{ title: 'Beach', note: '', span: 3 }],
      published: true,
      adultKes: 65000,
    },
  });
  expect(made.status()).toBe(201);
  const travelDate = new Date(Date.now() + 40 * 86_400_000).toISOString().slice(0, 10);
  for (const [method, host] of [
    ['ipos', '/ipos/pay'],
    ['unipesa', '/unipesa/hpp'],
    ['crypto', '/nowpayments/pay'],
  ] as const) {
    const res = await request.post('/api/book', {
      data: { packageId: id, travelDate, adults: 2, children: 0, plan: 'full', method, name: 'Jane', email: 'jane@example.com', phone: '' },
    });
    expect(res.status(), await res.text()).toBe(201);
    expect(((await res.json()) as { next: string }).next).toContain(host);
  }
  await request.delete(`/api/admin/packages/${id}`, { headers: admin });
});
