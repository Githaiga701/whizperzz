import AxeBuilder from '@axe-core/playwright';
import { test, expect, isMobile } from './fixtures';
import { fieldNotes } from '../../src/data/notes';

const destinations = ['maasai-mara', 'amboseli', 'tsavo', 'diani', 'laikipia', 'naivasha-nakuru', 'samburu', 'lamu'];
const journeys = ['into-the-open', 'under-a-big-sky', 'saltwater-days', 'wild-to-blue', 'rift-and-water', 'laikipia-slow-days', 'north-country'];

const pages = [
  '/',
  '/destinations/',
  ...destinations.map((d) => `/destinations/${d}/`),
  '/packages/',
  ...journeys.map((j) => `/packages/${j}/`),
  '/plan/',
  '/gallery/',
  '/about/',
  '/faq/',
  '/how-to-book/',
  '/contact/',
  '/privacy/',
];

test.describe('every page', () => {
  for (const path of pages) {
    test(`${path} loads cleanly`, async ({ page }) => {
      const res = await page.goto(path);
      expect(res?.status()).toBe(200);
      await expect(page.locator('h1')).toHaveCount(1);
      await expect(page).toHaveTitle(/Whizperz/);
      await expect(page.locator('header .brand')).toBeVisible();
      await expect(page.locator('footer')).toContainText('Whizperz Tours & Safaris');
      // Every image says what it shows (or is marked decorative with alt="").
      const missingAlt = await page.locator('img:not([alt])').count();
      expect(missingAlt).toBe(0);
    });
  }

  test('unknown pages return a friendly 404', async ({ page }) => {
    const res = await page.goto('/no-such-page/');
    expect(res?.status()).toBe(404);
    await expect(page.locator('h1')).toHaveText('Wrong turn.');
  });
});

test('every internal link on the site works', async ({ page, request }) => {
  test.skip(await isMobile(page), 'Links are the same on mobile');
  const seen = new Set<string>();
  for (const path of ['/', '/destinations/', '/packages/', '/faq/', '/contact/', '/payments/']) {
    await page.goto(path);
    const hrefs = await page.locator('a[href^="/"]').evaluateAll((as) => as.map((a) => (a as HTMLAnchorElement).getAttribute('href')!));
    hrefs.forEach((h) => seen.add(h.split('#')[0]!));
  }
  expect(seen.size).toBeGreaterThan(20);
  for (const href of seen) {
    const res = await request.get(href);
    expect(res.status(), href).toBeLessThan(400);
  }
});

test.describe('accessibility (axe)', () => {
  for (const path of ['/', '/destinations/maasai-mara/', '/packages/wild-to-blue/', '/plan/', '/contact/', '/faq/', '/how-to-book/']) {
    test(`${path} has no serious accessibility problems`, async ({ page }) => {
      await page.goto(path);
      // Scroll everything into view and let the reveal animations finish, so colours are checked as people see them.
      await page.evaluate(async () => {
        for (let y = 0; y < document.documentElement.scrollHeight; y += 400) {
          window.scrollTo({ top: y, behavior: 'instant' });
          await new Promise((r) => setTimeout(r, 30));
        }
        await new Promise((r) => setTimeout(r, 150));
        await Promise.all(document.getAnimations().filter((a) => a.effect?.getTiming().iterations !== Infinity).map((a) => a.finished.catch(() => undefined)));
      });
      const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze();
      const serious = results.violations
        .filter((v) => v.impact === 'serious' || v.impact === 'critical')
        .map((v) => `${v.id}: ${v.help} → ${v.nodes.map((n) => n.target.join(' ')).slice(0, 3).join(' | ')}`);
      expect(serious).toEqual([]);
    });
  }
});

test('mobile menu opens and closes', async ({ page }) => {
  test.skip(!(await isMobile(page)), 'Mobile only');
  await page.goto('/');
  const toggle = page.locator('.menu-toggle');
  const menu = page.locator('#main-nav');
  await expect(menu).toBeHidden();
  await toggle.click();
  await expect(menu).toBeVisible();
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  await page.keyboard.press('Escape');
  await expect(menu).toBeHidden();
  await toggle.click();
  await menu.getByRole('link', { name: 'Journeys' }).click();
  await expect(page).toHaveURL(/\/packages\/$/);
});

test('the current page is marked in the navigation', async ({ page }) => {
  test.skip(await isMobile(page), 'Desktop nav');
  await page.goto('/destinations/amboseli/');
  await expect(page.locator('#main-nav a[aria-current="page"]')).toHaveText('Destinations');
});

test('FAQs open and close', async ({ page }) => {
  await page.goto('/faq/');
  const first = page.locator('.faq-list details').first();
  await expect(first.locator('p')).toBeHidden();
  await first.locator('summary').click();
  await expect(first.locator('p')).toBeVisible();
});

test('the hero notes write themselves in, one after another, readable to screen readers', async ({ page }) => {
  await page.clock.install();
  await page.goto('/');
  const note = page.locator('.hero-whisper');
  const first = (await note.locator('[data-note-sr]').textContent())!;
  expect(fieldNotes.map((n) => n.text)).toContain(first);
  // It writes itself in…
  await page.clock.runFor(10_000);
  await expect(note.locator('.ch.on').last()).toHaveText('.');
  await expect(note.locator('figcaption')).toHaveText(fieldNotes.find((n) => n.text === first)!.from);
  // …then gives way to a different note.
  await page.clock.runFor(15_000);
  await expect(note.locator('[data-note-sr]')).not.toHaveText(first);
  expect(fieldNotes.map((n) => n.text)).toContain(await note.locator('[data-note-sr]').textContent());
});

test('with reduced motion the note still writes itself (it only fades letters in, nothing moves)', async ({ browser }) => {
  const context = await browser.newContext({ reducedMotion: 'reduce' });
  const page = await context.newPage();
  await page.clock.install();
  await page.route(/images\.unsplash\.com|translate\.google/, (r) => r.abort());
  await page.goto('/');
  const note = page.locator('.hero-whisper');
  await page.clock.runFor(10_000);
  await expect(note.locator('.ch.on').first()).toBeVisible();
  // The card itself never moves: no nudge animation when it turns.
  await expect(note).toHaveCSS('animation-name', /soft-in|none/);
  await context.close();
});

test('public pages are cached at the edge; admin pages never are', async ({ request }) => {
  const home = await request.get('/');
  expect(home.headers()['cache-control']).toBe('public, max-age=0, s-maxage=60, stale-while-revalidate=86400');
  const admin = await request.get('/admin/login/');
  expect(admin.headers()['cache-control']).toBe('no-store');
});

test('journey pages number multi-day entries correctly', async ({ page }) => {
  await page.goto('/packages/wild-to-blue/');
  await expect(page.locator('.day-label')).toHaveText(['Day 1', 'Day 2', 'Day 3', 'Days 4–6', 'Day 7']);
});

test('pay pages and API responses are kept out of search engines and caches', async ({ page, request }) => {
  await page.goto('/pay/WZ-AAAAAA/');
  await expect(page.locator('meta[name="robots"]')).toHaveAttribute('content', /noindex/);
  const res = await request.get('/api/health');
  expect(res.headers()['cache-control']).toBe('no-store');
});

test.describe('landing page motion', () => {
  test('things move in as you scroll', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('html')).toHaveClass(/\bmotion\b/);
    // The headline is still one readable heading.
    await expect(page.getByRole('heading', { level: 1, name: 'Find your way into the wild.' })).toBeVisible();
    await expect(page.locator('.marquee li').first()).toHaveText('Maasai Mara');

    const card = page.locator('.journey-grid > .journey-card').first();
    await expect(card).not.toHaveClass(/is-in/);
    await card.scrollIntoViewIfNeeded();
    await expect(card).toHaveClass(/is-in/);
    await expect(card).toHaveCSS('opacity', '1', { timeout: 3000 });

    // The map's pins drop in once it's on screen.
    const map = page.locator('[data-map="home"]');
    await map.scrollIntoViewIfNeeded();
    await expect(map).toHaveClass(/is-in/);
  });

  test('with less motion asked for, things only fade in: nothing slides, zooms or drifts', async ({ browser }) => {
    const context = await browser.newContext({ reducedMotion: 'reduce' });
    const page = await context.newPage();
    await page.route(/images\.unsplash\.com|translate\.google/, (r) => r.abort());
    await page.goto('/');
    const html = page.locator('html');
    await expect(html).toHaveClass(/\bmotion-soft\b/);
    await expect(html).not.toHaveClass(/(^|\s)motion(\s|$)/);
    // No moving parts: the marquee, photo zoom and birds stay still, and the hero doesn't parallax.
    await expect(page.locator('.marquee-track')).toHaveCSS('animation-name', 'none');
    // The photo fades in once but never zooms.
    await expect(page.locator('.hero-photo img')).toHaveCSS('animation-name', 'soft-in');
    await expect(page.locator('.flock')).toHaveCSS('animation-name', 'none');
    // A card fades in when it reaches the screen, without moving.
    const card = page.locator('.journey-grid > .journey-card').first();
    await expect(card).toHaveCSS('opacity', '0');
    await card.scrollIntoViewIfNeeded();
    await expect(card).toHaveClass(/is-in/);
    await expect(card).toHaveCSS('opacity', '1', { timeout: 3000 });
    await expect(card).toHaveCSS('transform', 'none');
    await page.evaluate(() => window.scrollTo(0, 400));
    await expect(page.locator('.hero-photo')).toHaveCSS('transform', 'none');
    await context.close();
  });

  test('on a touch screen, cards lean as they scroll past and taps get a response', async ({ browser }) => {
    const context = await browser.newContext({ hasTouch: true, isMobile: true, viewport: { width: 390, height: 844 } });
    const page = await context.newPage();
    await page.route(/images\.unsplash\.com|translate\.google/, (r) => r.abort());
    await page.goto('/');
    expect(await page.evaluate(() => matchMedia('(hover: hover) and (pointer: fine)').matches)).toBe(false);
    const card = page.locator('.journey-grid > .journey-card').first();
    await card.scrollIntoViewIfNeeded();
    await expect(card).toHaveClass(/is-in/);
    await expect(card).toHaveClass(/is-leaning/, { timeout: 4000 });
    // Low on the screen it leans back; scrolled up past the middle it leans the other way.
    const lean = () => card.evaluate((el) => parseFloat(getComputedStyle(el).getPropertyValue('--rx')));
    await card.evaluate((el) => window.scrollTo(0, el.getBoundingClientRect().top + window.scrollY - window.innerHeight * 0.75));
    await expect.poll(lean).toBeGreaterThan(0.5);
    await card.evaluate((el) => window.scrollTo(0, el.getBoundingClientRect().top + window.scrollY - window.innerHeight * 0.05));
    await expect.poll(lean).toBeLessThan(-0.5);
    // Hover-only effects stay off, so nothing is left stuck after a tap.
    await expect(card).not.toHaveClass(/is-tilting/);
    await context.close();
  });

  test('the name under the logo reads "Tours & Safaris" on phones too', async ({ browser }) => {
    for (const width of [320, 390]) {
      const context = await browser.newContext({ viewport: { width, height: 760 } });
      const page = await context.newPage();
      await page.route(/images\.unsplash\.com|translate\.google/, (r) => r.abort());
      await page.goto('/');
      const sub = page.locator('.site-header .brand-name small');
      await expect(sub).toBeVisible();
      await expect(sub).toHaveText('Tours & Safaris');
      // It fits beside the menu button.
      const [subBox, menuBox] = [await sub.boundingBox(), await page.locator('.menu-toggle').boundingBox()];
      expect(subBox!.x + subBox!.width).toBeLessThan(menuBox!.x);
      await context.close();
    }
  });
});
