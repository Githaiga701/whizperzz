import AxeBuilder from '@axe-core/playwright';
import type { APIRequestContext, Page } from '@playwright/test';
import { test, expect } from './fixtures';
import { E2E_ADMIN_TOKEN } from './env';

/**
 * The unhappy paths: inline validation, offline and slow connections, no search results, and success only after
 * confirmation. See UI_STATES.md for the full map.
 */

const auth = { Authorization: `Bearer ${E2E_ADMIN_TOKEN}` };
const made: string[] = [];

test.afterEach(async ({ request }) => {
  for (const id of made.splice(0)) await request.delete(`/api/admin/packages/${id}`, { headers: auth });
});

async function makeTrip(request: APIRequestContext): Promise<string> {
  const id = `e2e-st-${Math.random().toString(36).slice(2, 8)}`;
  const res = await request.post('/api/admin/packages', {
    headers: auth,
    data: {
      id,
      name: `State trip ${id}`,
      route: ['maasai-mara'],
      styles: ['safari'],
      photoSrc: 'https://images.unsplash.com/photo-test',
      photoAlt: 'A test photo',
      summary: 'A journey made by the state tests.',
      itinerary: [{ title: 'Into the Mara', note: 'Game drives.', span: 3 }],
      order: 950,
      published: true,
      adultKes: 100000,
      childKes: 60000,
      maxGuests: 6,
    },
  });
  expect(res.status(), await res.text()).toBe(201);
  made.push(id);
  return id;
}

const tripDate = (daysAhead = 40) => new Date(Date.now() + daysAhead * 86_400_000).toISOString().slice(0, 10);

async function fillGuest(page: Page) {
  const form = page.locator('[data-booking]');
  await form.locator('input[name="travelDate"]').fill(tripDate());
  await form.locator('input[name="name"]').fill('Jane Wanjiku');
  await form.locator('input[name="email"]').fill('jane@example.com');
  await form.locator('input[name="phone"]').fill('0712 345 678');
}

async function quotesFor(request: APIRequestContext, id: string) {
  const all = (await (await request.get('/api/admin/quotes', { headers: auth })).json()) as { quotes: { ref: string; description: string }[] };
  return all.quotes.filter((q) => q.description.includes(id));
}

test.describe('booking form validation', () => {
  test('an empty form shows each problem beside its field, with a summary', async ({ page, request }) => {
    const id = await makeTrip(request);
    await page.goto(`/packages/${id}/`);
    const form = page.locator('[data-booking]');
    await form.locator('[data-submit]').click();

    const summary = form.locator('[data-error-summary]');
    await expect(summary).toBeVisible();
    await expect(summary).toContainText('Please fix 4 things');
    await expect(summary).toBeFocused();
    await expect(summary.getByRole('link')).toHaveText([
      'Choose the date you’d like to start.',
      'Enter your full name.',
      'Enter your email address so we can send your receipt.',
      'Enter the Safaricom number to pay from.',
    ]);

    // Each field says what's wrong, and assistive tech hears it as the field's description.
    const name = form.locator('input[name="name"]');
    await expect(name).toHaveAttribute('aria-invalid', 'true');
    await expect(name).toHaveAccessibleDescription('Enter your full name.');
    await expect(name).toHaveAccessibleName('Full name');

    // The summary links jump to the field.
    await summary.getByRole('link', { name: 'Enter your full name.' }).click();
    await expect(name).toBeFocused();

    // Fixing a field clears its error straight away; nothing was sent.
    await name.fill('Jane Wanjiku');
    await expect(name).not.toHaveAttribute('aria-invalid', 'true');
    expect(await quotesFor(request, id)).toHaveLength(0);
  });

  test('formats are checked precisely: date window, email, M-Pesa number', async ({ page, request }) => {
    const id = await makeTrip(request);
    await page.goto(`/packages/${id}/`);
    const form = page.locator('[data-booking]');
    await fillGuest(page);
    const min = await form.locator('input[name="travelDate"]').getAttribute('min');
    await form.locator('input[name="travelDate"]').fill('2020-01-01');
    await form.locator('input[name="email"]').fill('jane@');
    await form.locator('input[name="phone"]').fill('12345');
    await form.locator('[data-submit]').click();

    const pretty = new Date(`${min}T12:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
    await expect(form.locator('input[name="travelDate"]')).toHaveAccessibleDescription(`Choose ${pretty} or later.`);
    await expect(form.locator('input[name="email"]')).toHaveAccessibleDescription('Enter an email address like name@example.com.');
    await expect(form.locator('input[name="phone"]')).toHaveAccessibleDescription('Enter a Safaricom number like 0712 345 678.');

    // No serious accessibility problems with the errors showing.
    const results = await new AxeBuilder({ page }).include('[data-booking]').withTags(['wcag2a', 'wcag2aa']).analyze();
    expect(results.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical').map((v) => v.id)).toEqual([]);
  });
});

test.describe('booking on a bad connection', () => {
  test('lost reply: the guest is told, keeps their details, and pressing again doesn’t book twice', async ({ page, request }) => {
    const id = await makeTrip(request);
    await page.goto(`/packages/${id}/`);
    await fillGuest(page);

    // The booking reaches the server, but the reply is lost on the way back.
    let calls = 0;
    await page.route('**/api/book', async (route) => {
      calls++;
      if (calls === 1) {
        await route.fetch();
        return route.abort('internetdisconnected');
      }
      return route.continue();
    });
    const form = page.locator('[data-booking]');
    await form.locator('[data-submit]').click();
    await expect(form.locator('[data-status]')).toContainText('couldn’t send your booking');
    await expect(form.locator('[data-status]')).toContainText('You won’t be booked twice');
    await expect(page.locator('[data-net-banner]')).toBeVisible();
    await expect(page.locator('[data-net-banner]')).toContainText('You’re offline');
    await expect(form.locator('input[name="name"]')).toHaveValue('Jane Wanjiku');

    // The banner checks the connection itself and says when it's back.
    await expect(page.locator('[data-net-banner]')).toContainText('Back online', { timeout: 10_000 });

    await form.locator('[data-submit]').click();
    await expect(page).toHaveURL(/\/pay\/WZ-[A-Z0-9]{6}\/$/);
    const quotes = await quotesFor(request, id);
    expect(quotes).toHaveLength(1);
    expect(page.url()).toContain(quotes[0]!.ref);
  });

  test('a slow reply says so instead of looking frozen, and the button can’t be pressed twice', async ({ page, request }) => {
    test.setTimeout(45_000);
    const id = await makeTrip(request);
    await page.goto(`/packages/${id}/`);
    await fillGuest(page);
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    await page.route('**/api/book', async (route) => {
      await held;
      await route.continue();
    });
    const form = page.locator('[data-booking]');
    const submit = form.locator('[data-submit]');
    await submit.click();
    await expect(submit).toBeDisabled();
    await expect(form).toHaveAttribute('aria-busy', 'true');
    await expect(form.locator('[data-status]')).toHaveText('Saving your booking and sending the M-Pesa prompt…');
    await expect(form.locator('[data-status]')).toContainText('Your connection seems slow', { timeout: 12_000 });
    release();
    await expect(page).toHaveURL(/\/pay\/WZ-[A-Z0-9]{6}\/$/);
    expect(await quotesFor(request, id)).toHaveLength(1);
  });
});

test('pay page: a lost status check while waiting for the PIN says so, then confirms once the payment is seen', async ({ page, request }) => {
  const id = await makeTrip(request);
  await page.goto(`/packages/${id}/`);
  await fillGuest(page);
  let checks = 0;
  await page.route(/\/api\/pay\/status/, (route) => (++checks === 1 ? route.abort('internetdisconnected') : route.continue()));
  await page.locator('[data-booking] [data-submit]').click();
  await expect(page).toHaveURL(/\/pay\//);
  const status = page.locator('[data-pay-status]');
  await expect(status).toContainText('You’re offline. If you’ve entered your PIN, the payment still goes through.');
  await expect(status).toHaveAttribute('data-state', 'offline');
  // Success only once the server has it, with next steps and focus on the news.
  await expect(page.locator('h1')).toHaveText('All paid. Thank you!', { timeout: 15_000 });
  await expect(page.locator('h1')).toBeFocused();
  await expect(page.locator('[data-paid-next]')).toBeVisible();
  await expect(page.locator('[data-paid-next]')).toContainText('See more journeys');
});

test.describe('no search results', () => {
  test('shows the search, suggests a spelling, offers other filters and a way out', async ({ page }) => {
    await page.goto('/destinations/');
    const rows = page.locator('#place-rows [data-filter-item]:visible');
    const search = page.getByPlaceholder('Search places');
    const none = page.locator('[data-no-results]');

    await search.fill('elephnat');
    await expect(rows).toHaveCount(0);
    await expect(none.getByRole('heading')).toHaveText('No places match “elephnat”');
    await none.getByRole('button', { name: 'elephant' }).click();
    await expect(search).toHaveValue('elephant');
    await expect(rows.first()).toBeVisible();
    await expect(none).toBeHidden();

    // A search that works, with a filter that rules everything out: offer the filters that would show something.
    await page.getByRole('button', { name: 'Coast', exact: true }).click();
    if ((await rows.count()) === 0) {
      await expect(none.getByRole('heading')).toHaveText('No places match “elephant”');
      await expect(none.getByRole('button', { name: /^All places \(\d+\)$/ })).toBeVisible();
    }

    await search.fill('zzzz');
    await none.getByRole('button', { name: 'Clear search and filters' }).click();
    await expect(search).toHaveValue('');
    await expect(rows).toHaveCount(8);
    await expect(page.getByRole('button', { name: 'All places' })).toHaveAttribute('aria-pressed', 'true');
  });
});

test('the offline bar appears when the device goes offline and clears when it’s back', async ({ page, context }) => {
  await page.goto('/contact/');
  const bar = page.locator('[data-net-banner]');
  await expect(bar).toBeHidden();
  await context.setOffline(true);
  await expect(bar).toBeVisible();
  await expect(bar).toContainText('You’re offline.');
  await expect(bar.getByRole('button', { name: 'Try now' })).toBeVisible();
  // The page itself is still there to read.
  await expect(page.locator('[data-enquiry]')).toBeVisible();
  await context.setOffline(false);
  await expect(bar).toContainText('Back online', { timeout: 10_000 });
  await expect(bar).toBeHidden({ timeout: 6_000 });
});

test('enquiry form shows inline errors and keeps what was typed', async ({ page }) => {
  await page.goto('/contact/');
  const form = page.locator('[data-enquiry]');
  await form.locator('input[name="name"]').fill('Jane');
  await form.getByRole('button', { name: 'Send by email' }).click();
  const message = form.locator('textarea[name="message"]');
  await expect(message).toBeFocused();
  await expect(message).toHaveAccessibleDescription('Tell us a little about the trip you have in mind.');
  await expect(form.locator('input[name="name"]')).toHaveValue('Jane');
});
