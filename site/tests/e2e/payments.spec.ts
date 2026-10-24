import type { APIRequestContext } from '@playwright/test';
import { test, expect } from './fixtures';
import { E2E_ADMIN_TOKEN } from './env';

const admin = { Authorization: `Bearer ${E2E_ADMIN_TOKEN}` };

async function newQuote(request: APIRequestContext, over: Record<string, unknown> = {}) {
  const res = await request.post('/api/admin/quotes', {
    headers: admin,
    data: { guestName: 'Jane Wanjiku', description: 'Wild to blue, 2 adults, 12 to 18 January', amountKes: 85000, ...over },
  });
  expect(res.status()).toBe(201);
  return (await res.json()) as { quote: { ref: string }; payUrl: string };
}

test.describe('admin API', () => {
  test('refuses requests without the admin token', async ({ request }) => {
    expect((await request.get('/api/admin/quotes')).status()).toBe(401);
    expect((await request.post('/api/admin/quotes', { data: { guestName: 'x', description: 'x', amountKes: 1 } })).status()).toBe(401);
  });

  test('creates a quote with a pay link', async ({ request }) => {
    const { quote, payUrl } = await newQuote(request);
    expect(quote.ref).toMatch(/^WZ-[A-Z0-9]{6}$/);
    expect(payUrl).toBe(`http://127.0.0.1:4399/pay/${quote.ref}/`);
  });
});

test.describe('paying with M-Pesa', () => {
  test('guest pays and the page confirms it', async ({ page, request }) => {
    const { quote } = await newQuote(request);
    await page.goto(`/pay/${quote.ref}/`);
    await expect(page.locator('h1')).toHaveText('Pay for your trip');
    await expect(page.locator('[data-amount]')).toHaveText('KES 85,000');
    await expect(page.getByText('For Jane')).toBeVisible();
    // Nothing floats over the payment form.
    await expect(page.locator('.contact-dock')).toHaveCount(0);

    await page.getByLabel('Safaricom number').fill('0712 345 678');
    await page.getByRole('button', { name: 'Send M-Pesa prompt' }).click();
    const status = page.locator('[data-pay-status]');
    await expect(status).toContainText('Check your phone (0712 ••• 678)');
    // The mock "guest" approves the prompt; Safaricom calls back; the page polls and updates.
    await expect(status).toContainText('Payment received', { timeout: 15_000 });
    await expect(status).toContainText(/Receipt: MOCK/);
    await expect(page.locator('h1')).toHaveText('All paid. Thank you!');

    // Reloading shows the paid state with no payment buttons.
    await page.reload();
    await expect(page.locator('h1')).toHaveText('All paid. Thank you!');
    await expect(page.getByRole('button', { name: 'Send M-Pesa prompt' })).toHaveCount(0);

    // And paying again is refused.
    const again = await request.post('/api/pay/mpesa', { data: { ref: quote.ref, phone: '0712345678' } });
    expect(again.status()).toBe(409);
  });

  test('a cancelled prompt shows why and lets the guest try again', async ({ page, request }) => {
    const { quote } = await newQuote(request);
    await page.goto(`/pay/${quote.ref}/`);
    await page.getByLabel('Safaricom number').fill('0712 345 000');
    await page.getByRole('button', { name: 'Send M-Pesa prompt' }).click();
    const status = page.locator('[data-pay-status]');
    await expect(status).toContainText('The payment was cancelled on the phone.', { timeout: 15_000 });
    await expect(page.locator('[data-pay-mpesa]')).toHaveAttribute('aria-busy', 'false');
    await expect(page.getByRole('button', { name: 'Send M-Pesa prompt' })).toBeEnabled();
  });

  test('a wrong number is caught before anything is sent', async ({ page, request }) => {
    const { quote } = await newQuote(request);
    await page.goto(`/pay/${quote.ref}/`);
    await page.getByLabel('Safaricom number').fill('12345');
    await page.getByRole('button', { name: 'Send M-Pesa prompt' }).click();
    await expect(page.locator('[data-pay-status]')).toHaveText('Enter a Safaricom number, like 0712 345 678.');
  });

  test('amounts over the M-Pesa limit only offer card', async ({ page, request }) => {
    const { quote } = await newQuote(request, { amountKes: 400000 });
    await page.goto(`/pay/${quote.ref}/`);
    await expect(page.locator('[data-amount]')).toHaveText('KES 400,000');
    await expect(page.getByRole('button', { name: 'Send M-Pesa prompt' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Continue to card payment' })).toBeVisible();
  });

  test('the browser cannot change the amount', async ({ request }) => {
    const { quote } = await newQuote(request, { amountKes: 5000 });
    const res = await request.post('/api/pay/mpesa', { data: { ref: quote.ref, phone: '0712345678', amount: 1, amountKes: 1 } });
    expect(res.status()).toBe(202);
    await expect
      .poll(async () => (await (await request.get(`/api/pay/status?ref=${quote.ref}`)).json()).status, { timeout: 15_000, intervals: [1000] })
      .toBe('paid');
    const list = (await (await request.get('/api/admin/quotes', { headers: admin })).json()) as { quotes: { ref: string; payments: { amountKes: number }[] }[] };
    expect(list.quotes.find((q) => q.ref === quote.ref)!.payments[0]!.amountKes).toBe(5000);
  });
});

test.describe('paying by card (Pesapal)', () => {
  test('guest is sent to checkout and comes back to a confirmed booking', async ({ page, request }) => {
    const { quote } = await newQuote(request, { amountKes: 120000 });
    await page.goto(`/pay/${quote.ref}/`);
    await page.getByLabel('Email for your receipt').fill('jane@example.com');
    await page.getByRole('button', { name: 'Continue to card payment' }).click();
    await expect(page.locator('h1')).toHaveText('Mock Pesapal checkout');
    await expect(page.getByText('KES 120000')).toBeVisible();
    await page.getByRole('button', { name: 'Pay now' }).click();

    await expect(page).toHaveURL(new RegExp(`/pay/${quote.ref}/\\?return=card`));
    await expect(page.locator('h1')).toHaveText('All paid. Thank you!', { timeout: 15_000 });
    await expect(page.locator('[data-pay-status]')).toContainText('Receipt: PSP');
  });

  test('asks for an email before opening checkout', async ({ page, request }) => {
    const { quote } = await newQuote(request);
    await page.goto(`/pay/${quote.ref}/`);
    await page.getByRole('button', { name: 'Continue to card payment' }).click();
    expect(await page.getByLabel('Email for your receipt').evaluate((el: HTMLInputElement) => el.validity.valueMissing)).toBe(true);
  });
});

test.describe('callbacks', () => {
  test('reject callers who don’t know the secret', async ({ request }) => {
    expect((await request.post('/api/callbacks/mpesa/wrong', { data: {} })).status()).toBe(404);
    expect((await request.post('/api/callbacks/pesapal/wrong', { data: {} })).status()).toBe(404);
  });

  test('a forged M-Pesa callback cannot mark a booking paid', async ({ request }) => {
    const { quote } = await newQuote(request);
    // Even with the right secret, a callback for a request we never made is ignored.
    const res = await request.post('/api/callbacks/mpesa/e2e-mpesa-cb', {
      data: {
        Body: {
          stkCallback: {
            MerchantRequestID: 'x',
            CheckoutRequestID: 'ws_CO_FORGED',
            ResultCode: 0,
            ResultDesc: 'ok',
            CallbackMetadata: { Item: [{ Name: 'Amount', Value: 85000 }, { Name: 'MpesaReceiptNumber', Value: 'FAKE' }] },
          },
        },
      },
    });
    expect(res.status()).toBe(200);
    const status = await (await request.get(`/api/pay/status?ref=${quote.ref}`)).json();
    expect(status.status).toBe('awaiting_payment');
  });
});

test('an unknown pay link shows a helpful message', async ({ page }) => {
  const res = await page.goto('/pay/WZ-AAAAAA/');
  expect(res?.status()).toBe(404);
  await expect(page.getByText('We couldn’t find that payment link.')).toBeVisible();
});
