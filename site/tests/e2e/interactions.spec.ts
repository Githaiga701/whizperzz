import { test, expect } from './fixtures';

test.describe('route sketcher', () => {
  test('builds a route from the map and the list, and sends it on WhatsApp', async ({ page, context }) => {
    await page.goto('/plan/');
    const sketch = page.locator('[data-sketcher]');
    await expect(sketch.locator('[data-empty]')).toBeVisible();

    await sketch.locator('[data-map="sketch"] [data-pin="maasai-mara"]').click();
    await sketch.getByRole('button', { name: 'Diani Coast', exact: true }).click();
    await expect(sketch.locator('[data-total]')).toHaveText('7 nights, 2 places');
    await expect(sketch.locator('[data-map="sketch"] [data-pin="maasai-mara"]')).toHaveAttribute('aria-pressed', 'true');
    await expect(sketch.locator('[data-route]')).toHaveAttribute('d', /^M.+Q/);

    await sketch.getByRole('button', { name: 'More nights in Maasai Mara' }).click();
    await sketch.getByRole('button', { name: 'Move Diani Coast earlier' }).click();
    await expect(sketch.locator('.route-list .stop-name')).toHaveText([/Nairobi/, /Diani Coast/, /Maasai Mara/, /Nairobi/]);
    await expect(sketch.locator('[data-total]')).toHaveText('8 nights, 2 places');

    await sketch.locator('select[name="month"]').selectOption('August');
    await sketch.locator('input[name="travellers"]').fill('4');
    const [popup] = await Promise.all([context.waitForEvent('page'), sketch.getByRole('button', { name: 'Send route on WhatsApp' }).click()]);
    const text = new URL(popup.url()).searchParams.get('text')!;
    expect(popup.url()).toContain('wa.me/254795144687');
    expect(text).toContain('My route (8 nights): Nairobi → Diani Coast (4) → Maasai Mara (4) → Nairobi');
    expect(text).toContain('When: August');
    expect(text).toContain('Travellers: 4');
  });

  test('works from the keyboard', async ({ page }) => {
    await page.goto('/plan/');
    const pin = page.locator('[data-map="sketch"] [data-pin="lamu"]');
    await pin.focus();
    await page.keyboard.press('Enter');
    await expect(pin).toHaveAttribute('aria-pressed', 'true');
    await page.keyboard.press(' ');
    await expect(pin).toHaveAttribute('aria-pressed', 'false');
  });

  test('remembers the route after a reload and can remove stops', async ({ page }) => {
    await page.goto('/plan/');
    await page.getByRole('button', { name: 'Samburu', exact: true }).click();
    await page.reload();
    await expect(page.locator('[data-total]')).toHaveText('3 nights, 1 place');
    await page.getByRole('button', { name: 'Remove Samburu', exact: true }).click();
    await expect(page.locator('[data-empty]')).toBeVisible();
    await expect(page.locator('[data-route]')).toHaveAttribute('d', '');
  });

  test('a destination’s “Add to my route” button starts a route with it', async ({ page }) => {
    await page.goto('/destinations/tsavo/');
    await page.getByRole('link', { name: 'Add Tsavo to my route' }).click();
    await expect(page).toHaveURL(/\/plan\/\?add=tsavo/);
    await expect(page.locator('.route-list')).toContainText('Tsavo');
  });

  test('asks for a place before sending an empty route', async ({ page }) => {
    await page.goto('/plan/');
    await page.getByRole('button', { name: 'Send route on WhatsApp' }).click();
    await expect(page.locator('[data-sketcher] [data-status]')).toHaveText('Add at least one place to your route first.');
  });
});

test.describe('enquiry forms', () => {
  test('contact form needs a name and message, then opens WhatsApp with them', async ({ page, context }) => {
    await page.goto('/contact/');
    const form = page.locator('[data-enquiry]');
    await form.getByRole('button', { name: 'Send on WhatsApp' }).click();
    // The browser's own validation stops an empty form.
    expect(await form.locator('input[name="name"]').evaluate((el: HTMLInputElement) => el.validity.valueMissing)).toBe(true);

    await form.locator('input[name="name"]').fill('Jane Wanjiku');
    await form.locator('textarea[name="message"]').fill('Mara in August for two');
    await form.locator('select[name="month"]').selectOption('August');
    const [popup] = await Promise.all([context.waitForEvent('page'), form.getByRole('button', { name: 'Send on WhatsApp' }).click()]);
    const text = new URL(popup.url()).searchParams.get('text')!;
    expect(text).toContain('Mara in August for two');
    expect(text).toContain('Jane Wanjiku');
    await expect(form.locator('[data-status]')).toContainText('WhatsApp should open');
  });

  test('journey enquiry includes the journey name', async ({ page, context }) => {
    await page.goto('/packages/saltwater-days/');
    const form = page.locator('[data-enquiry]');
    await form.locator('input[name="name"]').fill('Ali');
    await form.locator('textarea[name="message"]').fill('Can we add Lamu?');
    const [popup] = await Promise.all([context.waitForEvent('page'), form.getByRole('button', { name: 'Send on WhatsApp' }).click()]);
    expect(new URL(popup.url()).searchParams.get('text')).toContain('Journey: Saltwater days');
  });
});

test.describe('filters', () => {
  test('destinations filter by type and search', async ({ page }) => {
    await page.goto('/destinations/');
    const rows = page.locator('#place-rows [data-filter-item]:visible');
    await expect(rows).toHaveCount(8);
    await page.getByRole('button', { name: 'Coast', exact: true }).click();
    await expect(rows).toHaveCount(2);
    await expect(page.locator('[data-filter-count]')).toHaveText('Showing 2 places');
    await page.getByRole('button', { name: 'All places' }).click();
    await page.getByPlaceholder('Search places').fill('elephant');
    await expect(rows.first()).toBeVisible();
    await page.getByPlaceholder('Search places').fill('penguins');
    await expect(rows).toHaveCount(0);
    await expect(page.locator('[data-no-results]')).toBeVisible();
    await expect(page.locator('[data-no-results] h2')).toHaveText('No places match “penguins”');
  });

  test('journeys filter by length', async ({ page }) => {
    await page.goto('/packages/');
    // Other tests add their own journeys while this runs; count only the starting ones.
    const cards = page.locator('#journey-list [data-filter-item]:visible').filter({ hasNotText: /Test trip|Admin Spec/ });
    await expect(cards).toHaveCount(7);
    await page.locator('[data-filter-days]').selectOption('long');
    await expect(cards).toHaveCount(1);
    await expect(cards.first()).toContainText('Wild to blue');
    await page.locator('[data-filter-days]').selectOption('short');
    await expect(cards).toHaveCount(1);
    await expect(cards.first()).toContainText('Rift and water');
  });
});
