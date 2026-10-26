import { test, expect } from './fixtures';

/**
 * Layout checks across screen sizes, from a small phone to a wide desktop, including a phone held sideways.
 * Runs once (desktop project) and sets its own screen sizes.
 */

const SIZES = [
  { name: 'small phone', width: 320, height: 568 },
  { name: 'phone', width: 390, height: 844 },
  { name: 'phone sideways', width: 844, height: 390 },
  { name: 'tablet', width: 768, height: 1024 },
  { name: 'small laptop', width: 1024, height: 640 },
  { name: 'desktop', width: 1440, height: 900 },
];

const PAGES = ['/', '/destinations/', '/destinations/amboseli/', '/packages/', '/packages/wild-to-blue/', '/plan/', '/gallery/', '/about/', '/contact/', '/faq/', '/how-to-book/', '/privacy/'];

test.beforeEach(({}, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop', 'Sets its own screen sizes');
});

for (const size of SIZES) {
  test(`no sideways scrolling on a ${size.name} (${size.width}×${size.height})`, async ({ page }) => {
    await page.setViewportSize(size);
    for (const path of PAGES) {
      await page.goto(path);
      const extra = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      expect(extra, `${path} is wider than the screen`).toBeLessThanOrEqual(0);
    }
  });
}

test('the guide’s note never covers the headline, at any screen size', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  for (const width of [320, 390, 600, 800, 1024, 1180, 1440, 1920]) {
    for (const height of [400, 640, 800, 1000]) {
      await page.setViewportSize({ width, height });
      await page.goto('/');
      const hit = await page.evaluate(() => {
        const note = document.querySelector('.hero-whisper');
        if (!note || getComputedStyle(note).display === 'none') return '';
        const a = note.getBoundingClientRect();
        return [...document.querySelectorAll('.hero h1 .word, .hero-copy, .hero-actions .button')]
          .filter((el) => {
            const b = el.getBoundingClientRect();
            return a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
          })
          .map((el) => el.textContent?.trim())
          .join(', ');
      });
      expect(hit, `note overlaps the hero at ${width}×${height}`).toBe('');
    }
  }
});

test('on a phone, the floating contact buttons step aside while typing', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/contact/');
  const dock = page.locator('.contact-dock');
  await expect(dock).toBeVisible();
  await page.locator('input[name="name"]').focus();
  await expect(dock).toHaveClass(/is-tucked/);
  await page.locator('h1').click();
  await expect(dock).not.toHaveClass(/is-tucked/);
});

test('on a touch screen, map pins and footer links are big enough to tap', async ({ browser }) => {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  const page = await ctx.newPage();
  await page.route(/images\.unsplash\.com/, (r) => r.abort());
  await page.goto('/plan/');
  for (const box of await page.locator('.kenya-map [data-pin]').evaluateAll((els) => els.map((e) => e.getBoundingClientRect().toJSON() as DOMRect))) {
    expect(box.height).toBeGreaterThanOrEqual(18);
    expect(box.width).toBeGreaterThanOrEqual(40);
  }
  for (const h of await page.locator('.site-footer .footer-top ul:not(.social) a').evaluateAll((els) => els.map((e) => e.getBoundingClientRect().height))) {
    expect(h).toBeGreaterThanOrEqual(40);
  }
  await ctx.close();
});
