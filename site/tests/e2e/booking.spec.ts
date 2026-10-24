import type { APIRequestContext, Page } from '@playwright/test';
import { test, expect } from './fixtures';
import { E2E_ADMIN_TOKEN } from './env';

/**
 * Guests booking and paying straight from a journey page, against the fake M-Pesa and Pesapal servers.
 * Each test makes its own journey through the admin API, so tests don't share prices.
 */

const auth = { Authorization: `Bearer ${E2E_ADMIN_TOKEN}` };
const made: string[] = [];

test.afterEach(async ({ request }) => {
  for (const id of made.splice(0)) await request.delete(`/api/admin/packages/${id}`, { headers: auth });
});

async function makeTrip(request: APIRequestContext, over: Record<string, unknown> = {}): Promise<string> {
  const id = `e2e-${Math.random().toString(36).slice(2, 8)}`;
  const res = await request.post('/api/admin/packages', {
    headers: auth,
    data: {
      id,
      name: `Test trip ${id}`,
      route: ['maasai-mara', 'diani'],
      styles: ['safari'],
      photoSrc: 'https://images.unsplash.com/photo-test',
      photoAlt: 'A test photo',
      summary: 'A journey made by the tests.',
      itinerary: [
        { title: 'Into the Mara', note: 'Game drives.', span: 3 },
        { title: 'To the coast', note: 'Beach days.', span: 2 },
      ],
      order: 900,
      published: true,
      adultKes: 100000,
      childKes: 60000,
      maxGuests: 6,
      ...over,
    },
  });
  expect(res.status(), await res.text()).toBe(201);
  made.push(id);
  return id;
}

/** A date comfortably inside the booking window. */
function tripDate(daysAhead = 40): string {
  return new Date(Date.now() + daysAhead * 86_400_000).toISOString().slice(0, 10);
}

async function fillGuest(page: Page, opts: { phone?: string } = {}) {
  const form = page.locator('[data-booking]');
  await form.locator('input[name="travelDate"]').fill(tripDate());
  await form.locator('input[name="name"]').fill('Jane Wanjiku');
  await form.locator('input[name="email"]').fill('jane@example.com');
  if (opts.phone) await form.locator('input[name="phone"]').fill(opts.phone);
}

test('journey cards and pages show the price per person', async ({ page, request }) => {
  const id = await makeTrip(request);
  await page.goto('/packages/');
  const card = page.locator('.journey-card', { hasText: `Test trip ${id}` });
  await expect(card).toContainText('From KES 100,000 per person');
  await card.getByRole('link').click();
  await expect(page).toHaveURL(new RegExp(`/packages/${id}/$`));
  await expect(page.locator('.price-line')).toContainText('KES 100,000 per person');
  await expect(page.locator('.price-line')).toContainText('KES 60,000 per child');
  await expect(page.getByRole('heading', { name: 'Book this journey' })).toBeVisible();
});

test('the total updates as the guest chooses', async ({ page, request }) => {
  const id = await makeTrip(request);
  await page.goto(`/packages/${id}/`);
  const form = page.locator('[data-booking]');
  const payNow = form.locator('[data-pay-now]');

  // Starts at 2 adults with a 30% deposit.
  await expect(form.locator('input[name="adults"]')).toHaveValue('2');
  await expect(payNow).toHaveText('KES 60,000');
  await expect(form.locator('[data-total-note]')).toHaveText('Then KES 140,000 before you travel.');

  await form.getByRole('button', { name: 'More children' }).click();
  await expect(form.locator('[data-lines]')).toContainText('1 × KES 60,000 (children)');
  await expect(form.locator('[data-lines]')).toContainText('Total for 2 adults, 1 child');
  await expect(payNow).toHaveText('KES 78,000');

  await form.getByText('Pay in full').click();
  await expect(payNow).toHaveText('KES 260,000');
  await expect(form.locator('[data-total-note]')).toHaveText('Paid in full. Nothing more to pay.');

  // Can't go below one adult or over the group limit.
  await form.getByRole('button', { name: 'Fewer adults' }).click();
  await form.getByRole('button', { name: 'Fewer adults' }).click();
  await expect(form.locator('input[name="adults"]')).toHaveValue('1');
  for (let i = 0; i < 6; i++) await form.getByRole('button', { name: 'More adults' }).click();
  await expect(form.locator('input[name="adults"]')).toHaveValue('6');
  await expect(form.locator('[data-status]')).toContainText('up to 6 travellers');
  await expect(form.locator('[data-submit]')).toBeDisabled();
});

test('book with an M-Pesa deposit and get confirmed', async ({ page, request }) => {
  const id = await makeTrip(request);
  await page.goto(`/packages/${id}/`);
  await fillGuest(page, { phone: '0712 345 678' });
  const submit = page.getByRole('button', { name: 'Book and send M-Pesa prompt' });
  await submit.click();

  await expect(page).toHaveURL(/\/pay\/WZ-[A-Z0-9]{6}\/$/);
  await expect(page.locator('[data-amount]')).toHaveText('KES 60,000');
  const summary = page.locator('.pay-summary');
  await expect(summary).toContainText(`Test trip ${id}`);
  await expect(summary).toContainText('2 adults');
  await expect(summary).toContainText('KES 200,000');
  await expect(summary.locator('[data-plan]')).toContainText('30% deposit');
  await expect(summary.locator('[data-plan]')).toContainText('balance of KES 140,000');
  // The fake guest approves the prompt; the page polls and updates.
  await expect(page.locator('h1')).toHaveText('All paid. Thank you!', { timeout: 15_000 });
  await expect(page.locator('[data-pay-status]')).toContainText(/Receipt: MOCK/);

  // The admin sees it as a paid deposit booking.
  const ref = page.url().match(/WZ-[A-Z0-9]{6}/)![0];
  const quotes = (await (await request.get('/api/admin/quotes', { headers: auth })).json()) as { quotes: { ref: string; status: string; amountKes: number; booking?: { plan: string; balanceKes: number } }[] };
  const q = quotes.quotes.find((x) => x.ref === ref)!;
  expect(q).toMatchObject({ status: 'paid', amountKes: 60000, booking: { plan: 'deposit', balanceKes: 140000 } });
});

test('book and pay in full by card', async ({ page, request }) => {
  const id = await makeTrip(request);
  await page.goto(`/packages/${id}/`);
  await fillGuest(page);
  const form = page.locator('[data-booking]');
  await form.getByText('Pay in full').click();
  await form.getByText('Visa, Mastercard via Pesapal').click();
  // A phone number is optional for card payments.
  await expect(form.locator('input[name="phone"]')).not.toHaveAttribute('required', '');
  await page.getByRole('button', { name: 'Book and continue to card payment' }).click();

  await expect(page.locator('h1')).toHaveText('Mock Pesapal checkout');
  await expect(page.getByText('KES 200000')).toBeVisible();
  await page.getByRole('button', { name: 'Pay now' }).click();
  await expect(page).toHaveURL(/\/pay\/WZ-[A-Z0-9]{6}\/\?return=card/);
  await expect(page.locator('h1')).toHaveText('All paid. Thank you!', { timeout: 15_000 });
  await expect(page.locator('[data-plan]')).toContainText('Paid in full');
});

test('big M-Pesa payments are steered to card or a deposit', async ({ page, request }) => {
  const id = await makeTrip(request, { adultKes: 200000, childKes: null });
  await page.goto(`/packages/${id}/`);
  const form = page.locator('[data-booking]');
  await form.getByText('Pay in full').click();
  await expect(form.locator('[data-status]')).toContainText('M-Pesa allows up to KES 250,000 per payment. Choose card or pay a deposit.');
  await expect(form.locator('[data-submit]')).toBeDisabled();
  await form.getByText(/% deposit/).click();
  await expect(form.locator('[data-submit]')).toBeEnabled();
  // Without a child price, the counter just says travellers.
  await expect(form.getByRole('button', { name: 'More children' })).toHaveCount(0);
  await expect(form.getByText('Travellers', { exact: true })).toBeVisible();
});

test('the server checks everything again', async ({ request }) => {
  const id = await makeTrip(request);
  const base = { packageId: id, travelDate: tripDate(), adults: 2, children: 0, plan: 'full', method: 'mpesa', name: 'Jane', email: 'jane@example.com', phone: '0712345678' };

  const tooSoon = await request.post('/api/book', { data: { ...base, travelDate: new Date().toISOString().slice(0, 10) } });
  expect(tooSoon.status()).toBe(400);
  expect((await tooSoon.json()).message).toMatch(/earliest date/);

  const cheap = await request.post('/api/book', { data: { ...base, amountKes: 1, totalKes: 1 } });
  expect(cheap.status()).toBe(201);
  const { ref } = (await cheap.json()) as { ref: string };
  const status = await (await request.get(`/api/pay/status?ref=${ref}`)).json();
  expect(status).toBeTruthy();
  const page = await request.get(`/pay/${ref}/`);
  expect(await page.text()).toContain('KES 200,000');

  const missing = await request.post('/api/book', { data: { ...base, packageId: 'no-such-trip' } });
  expect(missing.status()).toBe(404);
});

test('drafts and unpriced journeys can’t be booked', async ({ page, request }) => {
  const draft = await makeTrip(request, { published: false });
  expect((await page.goto(`/packages/${draft}/`))?.status()).toBe(404);

  const unpriced = await makeTrip(request, { adultKes: null, childKes: null });
  await page.goto(`/packages/${unpriced}/`);
  await expect(page.locator('[data-booking]')).toHaveCount(0);
  await expect(page.locator('.price-line')).toContainText('Priced to your dates');
  await expect(page.locator('#enquire')).toBeVisible();
  const res = await request.post('/api/book', {
    data: { packageId: unpriced, travelDate: tripDate(), adults: 2, children: 0, plan: 'full', method: 'card', name: 'J', email: 'j@x.co' },
  });
  expect(res.status()).toBe(400);
});

test('the old Payments page now explains how to book', async ({ page }) => {
  await page.goto('/payments/');
  await expect(page).toHaveURL(/\/how-to-book\/$/);
  await expect(page.locator('h1')).toHaveText('Book in a few minutes.');
  await expect(page.locator('.steps')).toContainText('30% deposit');
  await expect(page.locator('footer').getByRole('link', { name: 'How to book' })).toBeVisible();
});
