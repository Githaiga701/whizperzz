import { test as base, expect, type Page } from '@playwright/test';

/**
 * Every test page:
 * - blocks outside services (photos, Google Translate) so tests are fast and don't depend on the internet,
 * - records JavaScript errors and console errors, and fails the test if any happened.
 */
export const test = base.extend<{ errors: string[] }>({
  errors: [
    async ({ page }, use) => {
      const errors: string[] = [];
      await page.route(/images\.unsplash\.com|translate\.google|translate-pa\.googleapis|gstatic\.com/, (route) =>
        route.request().resourceType() === 'image'
          ? route.fulfill({ status: 200, contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="4" height="3"/>' })
          : route.abort(),
      );
      // WhatsApp links open in a new tab. Answer them locally so we can read the message.
      await page.context().route(/wa\.me/, (route) => route.fulfill({ status: 200, contentType: 'text/html', body: '<title>wa</title>' }));
      page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
      page.on('console', (m) => {
        if (m.type() !== 'error') return;
        const text = m.text();
        // Blocked third-party requests and expected 4xx replies we deliberately trigger are not bugs.
        if (/ERR_FAILED|ERR_BLOCKED|net::|Failed to load resource/.test(text)) return;
        errors.push(`console: ${text}`);
      });
      await use(errors);
      expect(errors, 'JavaScript errors on the page').toEqual([]);
    },
    { auto: true },
  ],
});

export { expect };

export async function isMobile(page: Page): Promise<boolean> {
  return (page.viewportSize()?.width ?? 1200) < 700;
}
