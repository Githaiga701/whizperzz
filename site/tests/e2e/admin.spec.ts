import { test, expect, type BrowserContext, type Page, type APIRequestContext } from '@playwright/test';
import { MOCK_PORT, SITE_PORT } from './env';

/**
 * The admin screens, end to end: first-run setup, settings with test buttons, quotes, payments,
 * refunds (M-Pesa reversal, Pesapal, recorded by hand), emails, users and security.
 * Runs in order on one shared login, against the fake M-Pesa / Pesapal / mail servers.
 */
test.describe.configure({ mode: 'serial' });

const SITE = `http://127.0.0.1:${SITE_PORT}`;
const MOCK = `http://127.0.0.1:${MOCK_PORT}`;
let password = 'safari-sunrise-42';

let context: BrowserContext;
let page: Page;
let errors: string[] = [];

interface Mail {
  to: string;
  subject: string;
  text: string;
}

async function mails(request: APIRequestContext): Promise<Mail[]> {
  return (await request.get(`${MOCK}/mails`)).json();
}

async function expectMail(request: APIRequestContext, to: string, subject: string | RegExp, text?: string) {
  await expect
    .poll(
      async () =>
        (await mails(request)).some(
          (m) => m.to.includes(to) && (typeof subject === 'string' ? m.subject.includes(subject) : subject.test(m.subject)) && (!text || m.text.includes(text)),
        ),
      { timeout: 15_000, message: `email to ${to} about ${subject}` },
    )
    .toBe(true);
}

function flash(p: Page = page) {
  return p.locator('.flash');
}

async function newQuote(opts: { name: string; amount: string; email?: string; phone?: string; description: string; sendEmail?: boolean }): Promise<string> {
  await page.goto('/admin/quotes/new/');
  await page.getByLabel('Guest name').fill(opts.name);
  await page.getByLabel('Amount (KES)').fill(opts.amount);
  if (opts.email) await page.getByLabel('Guest email').fill(opts.email);
  if (opts.phone) await page.getByLabel('Guest phone').fill(opts.phone);
  await page.locator('input[name="description"]').fill(opts.description);
  const box = page.getByLabel('Email the pay link to the guest now');
  if (opts.sendEmail === false) await box.uncheck();
  await page.getByRole('button', { name: 'Create quote' }).click();
  await expect(page).toHaveURL(/\/admin\/quotes\/WZ-[A-Z0-9]{6}\/$/);
  return page.url().match(/WZ-[A-Z0-9]{6}/)![0];
}

test.beforeAll(async ({ browser }) => {
  context = await browser.newContext({ baseURL: SITE });
  // Pay pages open WhatsApp links in new tabs; answer them locally.
  await context.route(/wa\.me|images\.unsplash\.com|translate\.google/, (route) => route.fulfill({ status: 200, contentType: 'text/html', body: '' }));
  page = await context.newPage();
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('dialog', (d) => void d.accept());
});

test.afterEach(() => {
  expect(errors, 'JavaScript errors').toEqual([]);
  errors = [];
});

test.afterAll(async () => {
  await context.close();
});

test('the first visit goes to setup, and the public site stays open', async ({ request }) => {
  await page.goto('/admin/');
  await expect(page).toHaveURL(/\/admin\/setup\/$/);
  await expect(page.getByRole('heading', { name: 'Welcome' })).toBeVisible();
  expect((await request.get('/')).status()).toBe(200);
  // Nobody can reach admin data before setup.
  expect((await request.get('/api/admin/quotes')).status()).toBe(401);
});

test('create the first admin account', async () => {
  await page.getByLabel('Username').fill('Spence');
  await page.locator('input[name="password"]').fill(password);
  await page.locator('input[name="confirm"]').fill('something-else-1');
  await page.getByRole('button', { name: 'Create account' }).click();
  await expect(flash()).toHaveText('The two passwords don’t match.');

  await page.locator('input[name="password"]').fill(password);
  await page.locator('input[name="confirm"]').fill(password);
  await page.getByRole('button', { name: 'Create account' }).click();
  await expect(page).toHaveURL(/\/admin\/settings\/\?welcome=1/);
  await expect(page.getByText('You’re in. Three things to set up')).toBeVisible();
  await expect(page.locator('.admin-user')).toHaveText('spence');

  // Setup can't be used again to make a second "first" account.
  await page.goto('/admin/setup/');
  await expect(page).not.toHaveURL(/setup/);
});

test('settings: set up email and send a test', async ({ request }) => {
  await page.goto('/admin/settings/');
  const email = page.locator('#email');
  await email.getByLabel('Mail server (SMTP host)').fill('127.0.0.1');
  await email.getByLabel('Port', { exact: true }).fill('abc');
  await email.getByRole('button', { name: 'Save email' }).click();
  await expect(flash()).toContainText('The port is a number');

  await email.getByLabel('Mail server (SMTP host)').fill('127.0.0.1');
  await email.getByLabel('Port', { exact: true }).fill('4397');
  await email.getByLabel('Secure connection').selectOption('no');
  await email.getByLabel('Send from').fill('Whizperz Tours <bookings@whizperz.test>');
  await email.getByLabel('Send payment alerts to').fill('team@whizperz.test');
  await email.getByRole('button', { name: 'Save email' }).click();
  await expect(flash()).toContainText('Email settings saved');
  await expect(page.locator('.status-list')).toContainText('sending from Whizperz Tours');

  await page.locator('#email').getByLabel('Test email address').fill('spence@whizperz.test');
  await page.locator('#email').getByRole('button', { name: 'Send test email' }).click();
  await expect(flash()).toContainText('Test email sent to spence@whizperz.test');
  await expectMail(request, 'spence@whizperz.test', 'Whizperz test email');
});

test('settings: M-Pesa and Pesapal keys, test buttons and IPN', async () => {
  await page.goto('/admin/settings/');
  const mpesa = page.locator('#mpesa');
  await expect(mpesa).toContainText('from environment');
  // Secrets are never sent back to the browser.
  expect(await page.content()).not.toContain('e2e-secret');
  expect(await page.content()).not.toContain('e2e-passkey');

  await mpesa.getByLabel('Initiator name').fill('apiop');
  await mpesa.getByLabel('Security credential').fill('mock-security-credential');
  await mpesa.getByRole('button', { name: 'Save M-Pesa' }).click();
  await expect(flash()).toContainText('M-Pesa settings saved');
  await expect(page.locator('.status-list')).toContainText('refunds on');
  await expect(page.locator('#mpesa')).toContainText('· saved');

  await page.locator('#mpesa').getByRole('button', { name: 'Test connection' }).click();
  await expect(flash()).toContainText('M-Pesa connection works');

  await page.locator('#pesapal').getByRole('button', { name: 'Test connection' }).click();
  await expect(flash()).toContainText('Pesapal connection works');
  await page.locator('#pesapal').getByRole('button', { name: /Register IPN/ }).click();
  await expect(flash()).toContainText('Pesapal IPN registered');
  await expect(page.locator('#pesapal')).toContainText('mock-ipn-registered');

  // New keys clear the old IPN; the site finds or registers its result address again by itself.
  await page.locator('#pesapal').getByLabel('Consumer key').fill('e2e-pk-new');
  await page.locator('#pesapal').getByRole('button', { name: 'Save Pesapal' }).click();
  await expect(flash()).toContainText('Pesapal now sends payment results to this site');
  await expect(page.locator('.status-list li', { hasText: 'Card (Pesapal)' })).not.toContainText('Almost');
});

let mpesaRef = '';

test('settings: iPOS Pay, Unipesa and crypto are on, and their test buttons work', async () => {
  await page.goto('/admin/settings/');
  const status = page.locator('.status-list');
  await expect(status.locator('li', { hasText: 'iPOS Pay' })).toContainText('On');
  await expect(status.locator('li', { hasText: 'Unipesa' })).toContainText('On (KE)');
  await expect(status.locator('li', { hasText: 'Crypto' })).toContainText('On');
  // The rate comes from the host's environment here, so it shows as the placeholder.
  await expect(page.locator('#booking').getByLabel(/Exchange rate/)).toHaveAttribute('placeholder', '130');

  await page.locator('#ipos').getByRole('button', { name: 'Test connection' }).click();
  await expect(flash()).toContainText('iPOS Pay connection works');
  await page.locator('#crypto').getByRole('button', { name: 'Test connection' }).click();
  await expect(flash()).toContainText('Crypto connection works');
  await page.locator('#unipesa').getByRole('button', { name: 'Check settings' }).click();
  await expect(flash()).toContainText('Unipesa settings look right');
  // The notify addresses are shown with their secret hidden.
  await expect(page.locator('#crypto')).toContainText('/api/callbacks/crypto/••••');

  // A bad value is refused with a clear message.
  await page.locator('#unipesa summary', { hasText: 'More' }).click();
  await page.locator('#unipesa').getByLabel(/^Country/).fill('Kenya');
  await page.locator('#unipesa').getByRole('button', { name: 'Save Unipesa' }).click();
  await expect(flash()).toContainText('two-letter country code');
  // The Unipesa result address can be copied in full for Unipesa's onboarding form.
  await expect(page.locator('#unipesa-notify')).toHaveValue(/\/api\/callbacks\/unipesa\/e2e-unipesa-cb$/);
  await page.locator('#unipesa').getByLabel(/server IP addresses/).fill('not an ip');
  await page.locator('#unipesa').getByRole('button', { name: 'Save Unipesa' }).click();
  await expect(flash()).toContainText('List IP addresses');
});

test('settings: Paystack is on, its test button works, and its webhook address can be copied', async () => {
  await page.goto('/admin/settings/');
  await expect(page.locator('.status-list li', { hasText: 'Paystack' })).toContainText('On (test key)');
  const ps = page.locator('#paystack');
  await ps.getByRole('button', { name: 'Test connection' }).click();
  await expect(flash()).toContainText('Paystack connection works');
  await expect(page.locator('#paystack-notify')).toHaveValue(/\/api\/callbacks\/paystack\/e2e-paystack-cb$/);
  await expect(ps).toContainText('Test Webhook URL');

  // The public key is a common mix-up; it is refused with a clear message, and nothing changes.
  await ps.getByLabel(/^Secret key/).fill('pk_test_0123456789abcdef');
  await ps.getByRole('button', { name: 'Save Paystack' }).click();
  await expect(flash()).toContainText('isn’t a Paystack secret key');
  await ps.getByLabel(/^Payment options/).fill('card, ussd');
  await ps.getByRole('button', { name: 'Save Paystack' }).click();
  await expect(flash()).toContainText('card, mobile_money, bank_transfer and apple_pay');
  await expect(page.locator('.status-list li', { hasText: 'Paystack' })).toContainText('On (test key)');
});

test('social media links: faded logos until saved, then live in the footer and on Contact', async () => {
  const pub = await context.newPage();
  await pub.goto('/contact/');
  for (const [key, name] of [['instagram', 'Instagram'], ['tiktok', 'TikTok'], ['facebook', 'Facebook'], ['twitter', 'X']]) {
    const btn = pub.locator(`footer .social-btn[data-social="${key}"]`);
    await expect(btn).toHaveAttribute('aria-label', `${name}: coming soon`);
    await expect(btn.locator('svg path')).toHaveCount(1);
  }
  await expect(pub.locator('footer a.social-btn')).toHaveCount(0);
  await expect(pub.locator('footer .social-soon')).toBeVisible();

  await page.goto('/admin/settings/');
  const social = page.locator('#social');
  await social.getByLabel('Instagram').fill('https://evil.example/instagram');
  await social.getByRole('button', { name: 'Save social links' }).click();
  await expect(flash()).toContainText('doesn’t look like an Instagram link');
  await page.locator('#social').getByLabel('Instagram').fill('https://www.instagram.com/whizperztours');
  await page.locator('#social').getByRole('button', { name: 'Save social links' }).click();
  await expect(flash()).toContainText('Social links saved');

  await pub.reload();
  const ig = pub.locator('footer a.social-btn[data-social="instagram"]');
  await expect(ig).toHaveAttribute('href', 'https://www.instagram.com/whizperztours');
  await expect(ig).toHaveAttribute('target', '_blank');
  await expect(ig).toHaveAccessibleName('Whizperz on Instagram (opens in a new tab)');
  await expect(pub.locator('main a.social-btn[data-social="instagram"]')).toBeVisible();
  await expect(pub.locator('footer .social-btn[data-social="tiktok"]')).toHaveClass(/is-soon/);
  // With one network live, the "coming soon" line goes away; the faded logos still say so on their own.
  await expect(pub.locator('footer .social-soon')).toHaveCount(0);

  // Emptying the box puts it back to “soon”.
  await page.locator('#social').getByLabel('Instagram').fill('');
  await page.locator('#social').getByRole('button', { name: 'Save social links' }).click();
  await pub.reload();
  await expect(pub.locator('footer a.social-btn')).toHaveCount(0);
  await pub.close();
});

test('create a quote and email the pay link', async ({ request }) => {
  mpesaRef = await newQuote({ name: 'Amina Odhiambo', amount: '64,500', email: 'amina@example.com', phone: '0722 000 111', description: 'Into the open, 2 adults, March' });
  await expect(flash()).toContainText(`Quote ${mpesaRef} created. Pay link emailed to amina@example.com`);
  await expect(page.locator('#pay-link')).toHaveValue(`${SITE}/pay/${mpesaRef}/`);
  await expect(page.getByRole('link', { name: 'Send on WhatsApp' })).toHaveAttribute('href', /wa\.me\/254722000111\?text=/);
  await expectMail(request, 'amina@example.com', mpesaRef, `/pay/${mpesaRef}/`);
  await expect(page.locator('.timeline')).toContainText('Pay link emailed to amina@example.com');
});

test('guest pays with M-Pesa: admin sees it, guest gets a receipt, team gets an alert', async ({ request }) => {
  const guest = await context.newPage();
  await guest.goto(`/pay/${mpesaRef}/`);
  await expect(guest.locator('[data-amount]')).toHaveText('KES 64,500');
  await guest.getByLabel('Safaricom number').fill('0722000111');
  await guest.getByRole('button', { name: 'Send M-Pesa prompt' }).click();
  await expect(guest.locator('[data-pay-status]')).toContainText('Payment received', { timeout: 15_000 });
  await guest.close();

  await expectMail(request, 'amina@example.com', `Payment received: Whizperz booking ${mpesaRef}`, 'MOCK');
  await expectMail(request, 'team@whizperz.test', `Paid: KES 64,500 for ${mpesaRef}`);
  await page.goto(`/admin/quotes/${mpesaRef}/`);
  await expect(page.locator('[data-quote-status]')).toHaveText('Paid');
  await expect(page.locator('#pay-h ~ .table-wrap')).toContainText('MOCK');
  await expect(page.locator('.timeline')).toContainText('Receipt emailed to amina@example.com');

  await page.goto(`/admin/?q=${mpesaRef}`);
  await expect(page.locator('.admin-table tbody tr')).toHaveCount(1);
  await expect(page.locator('.admin-table tbody tr')).toContainText('Paid');
});

test('refund an M-Pesa payment (reversal)', async ({ request }) => {
  await page.goto(`/admin/quotes/${mpesaRef}/`);
  await page.locator('details.action > summary').filter({ hasText: /^Refund$/ }).click();
  const form = page.locator('[data-refund-form]');
  await expect(form.getByLabel('Amount to refund (KES)')).toHaveValue('64500');
  await expect(form).toContainText('M-Pesa reversals return the full');

  // Part refunds can't go through M-Pesa.
  await form.getByLabel('Amount to refund (KES)').fill('1000');
  await form.getByLabel('Reason').fill('Guest dropped one night');
  await form.getByRole('button', { name: 'Refund' }).click();
  await expect(flash()).toContainText('M-Pesa reversals return the whole payment');

  await page.locator('details.action > summary').filter({ hasText: /^Refund$/ }).click();
  await page.locator('[data-refund-form]').getByLabel('Reason').fill('Trip cancelled by guest');
  await page.locator('[data-refund-form]').getByRole('button', { name: 'Refund' }).click();
  await expect(flash()).toContainText('Reversal requested');

  await expect
    .poll(
      async () => {
        await page.reload();
        return page.locator('[data-quote-status]').textContent();
      },
      { timeout: 15_000 },
    )
    .toBe('Refunded');
  await expect(page.locator('#ref-h ~ .table-wrap')).toContainText('Done');
  await expect(page.locator('#ref-h ~ .table-wrap')).toContainText('REV');
  await expectMail(request, 'amina@example.com', `Refund for Whizperz booking ${mpesaRef}`);
  await expectMail(request, 'team@whizperz.test', `Refund completed: KES 64,500 for ${mpesaRef}`);

  // The guest's link now says it was refunded.
  const guest = await context.newPage();
  await guest.goto(`/pay/${mpesaRef}/`);
  await expect(guest.getByText('This booking was refunded.')).toBeVisible();
  await guest.close();
});

test('card payment, a part refund through Pesapal, then the rest recorded by hand', async ({ request }) => {
  const ref = await newQuote({ name: 'Kofi Mensah', amount: '120000', email: 'kofi@example.com', description: 'Wild to blue, family of 4' });
  const guest = await context.newPage();
  await guest.goto(`/pay/${ref}/`);
  await guest.getByLabel('Email for your receipt').fill('kofi@example.com');
  await guest.getByRole('button', { name: 'Continue to card payment' }).click();
  await guest.getByRole('button', { name: 'Pay now' }).click();
  await expect(guest.locator('h1')).toHaveText('All paid. Thank you!', { timeout: 15_000 });
  await guest.close();
  await expectMail(request, 'kofi@example.com', 'Payment received', 'Visa');

  await page.goto(`/admin/quotes/${ref}/`);
  await page.locator('details.action > summary').filter({ hasText: /^Refund$/ }).click();
  let form = page.locator('[data-refund-form]');
  await form.getByLabel('Amount to refund (KES)').fill('20,000');
  await form.getByLabel('Reason').fill('One guest cancelled');
  await form.getByRole('button', { name: 'Refund' }).click();
  await expect(flash()).toContainText('Refund sent to Pesapal');

  await page.getByRole('button', { name: 'Check refund status with Pesapal' }).click();
  await expect(flash()).toContainText('1 refund confirmed by Pesapal');
  await expect(page.locator('[data-quote-status]')).toHaveText('Paid');

  // Pesapal allows one refund per payment.
  await page.locator('details.action > summary').filter({ hasText: /^Refund$/ }).click();
  form = page.locator('[data-refund-form]');
  await expect(form.getByLabel('Amount to refund (KES)')).toHaveValue('100000');
  await form.getByLabel('Reason').fill('Rest of the trip cancelled');
  await form.getByRole('button', { name: 'Refund' }).click();
  await expect(flash()).toContainText('Pesapal allows one refund per payment');

  // So record the rest as paid back by bank transfer.
  await page.locator('details.action > summary').filter({ hasText: /^Refund$/ }).click();
  form = page.locator('[data-refund-form]');
  await form.getByLabel('Reason').fill('Rest of the trip cancelled');
  await form.getByLabel('I’ve already paid it back another way').check();
  await form.getByLabel('Refund reference').fill('BANK-778');
  await form.getByRole('button', { name: 'Refund' }).click();
  await expect(flash()).toContainText('Refund of KES 100,000 recorded');
  await expect(page.locator('[data-quote-status]')).toHaveText('Refunded');
  await expect(page.locator('#ref-h ~ .table-wrap')).toContainText('BANK-778');
});

test('record a cash payment, edit, cancel and reopen quotes', async ({ request }) => {
  const cashRef = await newQuote({ name: 'Wanjiru Kamau', amount: '18000', email: 'wanjiru@example.com', description: 'Rift and water, 3 days', sendEmail: false });
  await expect(flash()).toContainText('Copy the pay link below');
  await page.locator('summary', { hasText: 'Record a payment made another way' }).click();
  await page.getByLabel('How was it paid?').selectOption('Cash');
  await page.getByLabel('Reference').fill('CASH-12');
  await page.getByRole('button', { name: 'Record payment of KES 18,000' }).click();
  await expect(flash()).toContainText('Payment recorded');
  await expect(page.locator('[data-quote-status]')).toHaveText('Paid');
  await expectMail(request, 'wanjiru@example.com', `Payment received: Whizperz booking ${cashRef}`, 'CASH-12');

  const ref = await newQuote({ name: 'Otieno Family', amount: '50000', description: 'Saltwater days' });
  await page.locator('summary', { hasText: 'Edit details' }).click();
  await page.locator('details', { hasText: 'Edit details' }).getByLabel('Amount (KES)').fill('55000');
  await page.getByRole('button', { name: 'Save changes' }).click();
  await expect(flash()).toContainText('Quote updated');
  await expect(page.locator('.timeline')).toContainText('amount KES 50,000 → KES 55,000');

  const guest = await context.newPage();
  await guest.goto(`/pay/${ref}/`);
  await expect(guest.locator('[data-amount]')).toHaveText('KES 55,000');

  await page.locator('summary', { hasText: 'Cancel this quote' }).click();
  await page.getByLabel('Reason').fill('Guest chose another operator');
  await page.getByRole('button', { name: 'Cancel quote' }).click();
  await expect(flash()).toContainText('Quote cancelled');
  await guest.reload();
  await expect(guest.getByText('This quote has been cancelled')).toBeVisible();

  await page.getByRole('button', { name: 'Reopen quote' }).click();
  await expect(flash()).toContainText('Quote reopened');
  await guest.reload();
  await expect(guest.getByRole('button', { name: 'Send M-Pesa prompt' })).toBeVisible();
  await guest.close();

  await page.getByPlaceholder('Add a note').fill('Called them, paying next week');
  await page.getByRole('button', { name: 'Add note' }).click();
  await expect(page.locator('.timeline li').first()).toContainText('Note: Called them, paying next week');

  await page.goto('/admin/?status=cancelled');
  await expect(page.locator('main')).not.toContainText(ref);
  await page.goto('/admin/?q=otieno');
  await expect(page.locator('.admin-table tbody tr')).toHaveCount(1);
});

/** A real 1×1 PNG, for the photo upload. */
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

test('packages: add a journey with a photo and a price, edit, hide and delete it', async ({ request }) => {
  await page.goto('/admin/');
  await page.getByRole('navigation', { name: 'Admin' }).getByRole('link', { name: 'Packages' }).click();
  await expect(page.getByRole('heading', { name: 'Packages', level: 1 })).toBeVisible();
  // The starting journeys are listed, unpriced.
  await expect(page.locator('.pkg-table tbody tr').first()).toBeVisible();
  await expect(page.getByText(/have no price yet/)).toBeVisible();

  await page.getByRole('link', { name: 'New journey' }).click();
  await page.getByLabel('Journey name').fill('Admin Spec Escape');
  // The web address follows the name.
  await expect(page.locator('input[name="id"]')).toHaveValue('admin-spec-escape');
  await page.getByLabel(/^Summary/).fill('Two nights in the Mara, then the beach.');
  await page.getByLabel('Safari', { exact: true }).check();
  await page.getByLabel('Coast', { exact: true }).check();
  await page.locator('select[name="route"]').first().selectOption('maasai-mara');
  await page.getByRole('button', { name: 'Add another place' }).click();
  await page.locator('select[name="route"]').nth(1).selectOption('diani');
  await page.locator('input[name="dayTitle"]').first().fill('Into the Mara');
  await page.locator('input[name="daySpan"]').first().fill('2');
  await page.getByRole('button', { name: 'Add a day' }).click();
  await page.locator('input[name="dayTitle"]').nth(1).fill('Down to Diani');
  await page.locator('input[name="daySpan"]').nth(1).fill('3');
  await expect(page.locator('[data-day-total]')).toHaveText('5 days');
  await page.getByLabel(/^Price per adult/).fill('150,000');
  await expect(page.locator('[data-price-preview]')).toContainText('2 adults = KES 300,000, or a 30% deposit of KES 90,000 now');

  // Missing photo is caught and nothing typed is lost.
  await page.getByRole('button', { name: 'Create journey' }).click();
  await expect(flash()).toContainText('Add a photo');
  await expect(page.getByLabel('Journey name')).toHaveValue('Admin Spec Escape');
  await expect(page.locator('input[name="dayTitle"]').nth(1)).toHaveValue('Down to Diani');

  // A file that only pretends to be a photo is refused.
  await page.locator('input[name="photoFile"]').setInputFiles({ name: 'evil.png', mimeType: 'image/png', buffer: Buffer.from('<svg onload=alert(1)>') });
  await page.getByRole('button', { name: 'Create journey' }).click();
  await expect(flash()).toContainText('JPG, PNG or WebP');

  await page.locator('input[name="photoFile"]').setInputFiles({ name: 'beach.png', mimeType: 'image/png', buffer: PNG });
  await page.getByLabel('Describe the photo').fill('A white beach');
  await page.getByLabel(/Show on the website/).check();
  await page.getByRole('button', { name: 'Create journey' }).click();
  await expect(page).toHaveURL(/\/admin\/packages\/admin-spec-escape\/$/);
  await expect(flash()).toContainText('created and live on the website');

  // The uploaded photo is served from the site.
  const src = await page.locator('[data-photo-preview]').getAttribute('src');
  expect(src).toMatch(/^\/media\/admin-spec-escape-[0-9a-f]{8}\.png$/);
  const img = await request.get(src!);
  expect(img.headers()['content-type']).toBe('image/png');
  expect((await request.get('/media/..%2Fpackages.json')).status()).toBe(404);
  // Asked for a smaller size, it comes back as a WebP that can be cached for good.
  const small = await request.get(`${src}?w=480`);
  expect(small.headers()['content-type']).toBe('image/webp');
  expect(small.headers()['cache-control']).toContain('immutable');

  // It's on the public site with its price and route.
  const pub = await context.newPage();
  await pub.goto('/packages/');
  await expect(pub.locator('.journey-card', { hasText: 'Admin Spec Escape' })).toContainText('From KES 150,000 per person');
  await pub.goto('/packages/admin-spec-escape/');
  await expect(pub.locator('h1')).toHaveText('Admin Spec Escape');
  await expect(pub.locator('.itinerary li').nth(1)).toContainText('Days 3–5');
  await expect(pub.locator('[data-booking]')).toBeVisible();

  // Edit the price and a child price.
  await page.getByLabel(/^Price per adult/).fill('160000');
  await page.getByLabel(/^Price per child/).fill('90000');
  await page.getByRole('button', { name: 'Save changes' }).click();
  await expect(flash()).toContainText('Saved');
  await pub.reload();
  await expect(pub.locator('.price-line')).toContainText('KES 160,000 per person');
  await expect(pub.locator('.price-line')).toContainText('KES 90,000 per child');

  // Hide it: the page is gone from the site but kept in the admin.
  await page.getByRole('button', { name: 'Hide from site' }).click();
  await expect(flash()).toContainText('Hidden from the website');
  expect((await pub.goto('/packages/admin-spec-escape/'))?.status()).toBe(404);
  await page.getByRole('button', { name: 'Publish' }).click();
  await expect(flash()).toContainText('Now showing');
  expect((await pub.goto('/packages/admin-spec-escape/'))?.status()).toBe(200);

  // Can't create a second journey at the same address.
  await page.goto('/admin/packages/new/');
  await page.getByLabel('Journey name').fill('Admin Spec Escape');
  await page.getByLabel(/^Summary/).fill('Duplicate');
  await page.getByLabel('Safari', { exact: true }).check();
  await page.locator('select[name="route"]').first().selectOption('amboseli');
  await page.locator('input[name="dayTitle"]').first().fill('Day one');
  await page.getByLabel(/or paste an image address/).fill('https://images.unsplash.com/photo-x');
  await page.getByRole('button', { name: 'Create journey' }).click();
  await expect(flash()).toContainText('already a journey');

  // Delete it.
  await page.goto('/admin/packages/admin-spec-escape/');
  await page.getByRole('button', { name: 'Delete journey' }).click();
  await expect(page).toHaveURL(/\/admin\/packages\/$/);
  await expect(flash()).toContainText('deleted');
  expect((await pub.goto('/packages/admin-spec-escape/'))?.status()).toBe(404);
  await pub.close();
});

test('booking rules in settings', async () => {
  await page.goto('/admin/settings/');
  const box = page.locator('#booking');
  await expect(box.getByLabel(/Deposit/)).toHaveAttribute('placeholder', '30');
  await box.getByLabel(/Deposit/).fill('150');
  await box.getByRole('button', { name: 'Save booking rules' }).click();
  await expect(flash()).toContainText('percentage from 0 to 100');
  // Saving the defaults explicitly changes nothing for guests.
  await page.locator('#booking').getByLabel(/Deposit/).fill('30');
  await page.locator('#booking').getByLabel(/days ahead/).fill('3');
  await page.locator('#booking').getByRole('button', { name: 'Save booking rules' }).click();
  await expect(flash()).toContainText('Booking rules saved');
});

test('a guest books with a deposit; the admin sends the balance link; the guest pays the rest', async ({ request }) => {
  // Price a starting journey through the admin screen.
  await page.goto('/admin/packages/saltwater-days/');
  await page.getByLabel(/^Price per adult/).fill('80000');
  await page.getByRole('button', { name: 'Save changes' }).click();
  await expect(flash()).toContainText('Saved');

  const guest = await context.newPage();
  await guest.goto('/packages/saltwater-days/');
  const form = guest.locator('[data-booking]');
  await form.locator('input[name="travelDate"]').fill(new Date(Date.now() + 60 * 86_400_000).toISOString().slice(0, 10));
  await form.locator('input[name="name"]').fill('Amina Otieno');
  await form.locator('input[name="email"]').fill('amina@example.com');
  await form.locator('input[name="phone"]').fill('0722 111 222');
  await expect(form.locator('[data-pay-now]')).toHaveText('KES 48,000');
  await guest.getByRole('button', { name: 'Book and send M-Pesa prompt' }).click();
  await expect(guest.locator('h1')).toHaveText('All paid. Thank you!', { timeout: 15_000 });
  const ref = guest.url().match(/WZ-[A-Z0-9]{6}/)![0];
  await expectMail(request, 'amina@example.com', `Payment received: Whizperz booking ${ref}`, 'Balance to pay');

  // The admin sees the booking and creates the balance link.
  await page.goto(`/admin/quotes/${ref}/`);
  const panel = page.locator('[data-booking-panel]');
  await expect(panel).toContainText('Saltwater');
  await expect(panel).toContainText('2 adults');
  await expect(panel).toContainText('KES 160,000');
  await expect(panel).toContainText('Deposit (30%)');
  await panel.getByRole('button', { name: 'Create balance pay link (KES 112,000)' }).click();
  await expect(flash()).toContainText('Balance quote');
  await expect(flash()).toContainText('emailed to amina@example.com');
  const balanceRef = page.url().match(/WZ-[A-Z0-9]{6}/)![0];
  expect(balanceRef).not.toBe(ref);
  await expect(page.locator('[data-booking-panel]')).toContainText(ref);
  await expectMail(request, 'amina@example.com', balanceRef);

  // The deposit quote links to the balance and can't make a second one.
  await page.goto(`/admin/quotes/${ref}/`);
  await expect(page.locator('[data-booking-panel]')).toContainText(balanceRef);
  await expect(page.getByRole('button', { name: /Create balance pay link/ })).toHaveCount(0);

  // The guest pays the balance by card.
  await guest.goto(`/pay/${balanceRef}/`);
  await expect(guest.locator('[data-amount]')).toHaveText('KES 112,000');
  await expect(guest.locator('[data-plan]')).toContainText('Balance');
  await guest.getByLabel('Email for your receipt').fill('amina@example.com');
  await guest.getByRole('button', { name: 'Continue to card payment' }).click();
  await guest.getByRole('button', { name: 'Pay now' }).click();
  await expect(guest.locator('h1')).toHaveText('All paid. Thank you!', { timeout: 15_000 });
  await expectMail(request, 'amina@example.com', `Payment received: Whizperz booking ${balanceRef}`, 'Your trip is now paid in full');
  await guest.close();
});

test('users: add, log in as them, reset their password, remove them', async ({ browser }) => {
  await page.goto('/admin/users/');
  const add = page.locator('section', { hasText: 'Add a user' });
  await add.getByLabel('Username').fill('mary');
  await add.getByLabel('Password', { exact: true }).fill('mary-password-1');
  await add.getByLabel('Password again').fill('mary-password-1');
  await add.getByRole('button', { name: 'Add user' }).click();
  await expect(flash()).toContainText('mary can now log in');
  // You can't remove yourself.
  await expect(page.locator('tr', { hasText: 'That’s you' }).getByRole('button', { name: 'Remove' })).toHaveCount(0);

  const other = await browser.newContext({ baseURL: SITE });
  const mary = await other.newPage();
  await mary.goto('/admin/');
  await expect(mary).toHaveURL(/\/admin\/login\/\?next=/);
  await mary.getByLabel('Username').fill('mary');
  await mary.getByLabel('Password').fill('wrong-password-1');
  await mary.getByRole('button', { name: 'Log in' }).click();
  await expect(flash(mary)).toHaveText('Wrong username or password.');
  await mary.getByLabel('Password').fill('mary-password-1');
  await mary.getByRole('button', { name: 'Log in' }).click();
  await expect(mary.locator('.admin-user')).toHaveText('mary');

  // A new password logs her out everywhere.
  const row = page.locator('tr', { hasText: 'mary' });
  await row.locator('summary').click();
  await row.getByLabel('New password for mary').fill('mary-password-2');
  await row.getByRole('button', { name: 'Set' }).click();
  await expect(flash()).toContainText('New password set for mary');
  await mary.goto('/admin/');
  await expect(mary).toHaveURL(/\/admin\/login\//);

  await page.locator('tr', { hasText: 'mary' }).getByRole('button', { name: 'Remove' }).click();
  await expect(flash()).toContainText('mary has been removed');
  await mary.getByLabel('Username').fill('mary');
  await mary.getByLabel('Password').fill('mary-password-2');
  await mary.getByRole('button', { name: 'Log in' }).click();
  await expect(flash(mary)).toHaveText('Wrong username or password.');
  await other.close();
});

test('security: other websites, logged-out visitors, lockouts and headers', async ({ browser, request }) => {
  // A form posted from another website is refused.
  const forged = await page.request.post('/admin/settings/', { form: { action: 'save_general', siteUrl: 'https://evil.example' }, headers: { origin: 'https://evil.example' } });
  expect(forged.status()).toBe(403);

  // Logged in: the admin API works with the session; logged out, it doesn't.
  expect((await page.request.get('/api/admin/quotes')).status()).toBe(200);
  expect((await request.get('/api/admin/quotes')).status()).toBe(401);

  const res = await page.goto('/admin/');
  expect(res?.headers()['x-robots-tag']).toContain('noindex');
  expect(res?.headers()['cache-control']).toBe('no-store');
  expect(res?.headers()['x-frame-options']).toBe('DENY');

  // Five wrong passwords lock that login for a while.
  const other = await browser.newContext({ baseURL: SITE });
  const p = await other.newPage();
  await p.goto('/admin/login/');
  for (let i = 0; i < 5; i++) {
    await p.getByLabel('Username').fill('ghost');
    await p.getByLabel('Password').fill(`guess-${i}-xxxxxx`);
    await p.getByRole('button', { name: 'Log in' }).click();
  }
  await p.getByLabel('Username').fill('ghost');
  await p.getByLabel('Password').fill('another-guess');
  await p.getByRole('button', { name: 'Log in' }).click();
  await expect(flash(p)).toContainText('Too many wrong passwords');
  // A sneaky redirect after login is ignored.
  await p.goto('/admin/login/?next=https://evil.example');
  await expect(p.locator('form')).toBeVisible();
  await other.close();
});

test('on a phone the admin menu is one row, with the name and Log out beside the logo', async () => {
  const phone = await context.newPage();
  await phone.setViewportSize({ width: 375, height: 760 });
  await phone.goto('/admin/settings/');
  const nav = phone.getByRole('navigation', { name: 'Admin' });
  const links = nav.getByRole('link');
  // All tabs sit on the same line…
  const tops = await links.evaluateAll((els) => els.map((e) => Math.round(e.getBoundingClientRect().top)));
  expect(new Set(tops).size).toBe(1);
  // …and the row scrolls sideways, with the current page's tab brought into view.
  const current = nav.locator('[aria-current="page"]');
  await expect(current).toHaveText('Settings');
  await expect(current).toBeInViewport({ ratio: 1 });
  await expect(phone.locator('.admin-top .brand-name small')).toHaveText('Admin');
  await expect(phone.locator('.admin-top .brand-name small')).toBeVisible();
  const [brand, logout] = [await phone.locator('.admin-top .brand').boundingBox(), await phone.getByRole('button', { name: 'Log out' }).boundingBox()];
  expect(Math.abs(brand!.y + brand!.height / 2 - (logout!.y + logout!.height / 2))).toBeLessThan(12);
  // The header leaves most of the screen for the page.
  const header = await phone.locator('.admin-top').boundingBox();
  expect(header!.height).toBeLessThan(130);
  await phone.close();
});

test('every admin screen fits a phone without sideways scrolling', async () => {
  const phone = await context.newPage();
  await phone.setViewportSize({ width: 360, height: 740 });
  await phone.goto('/admin/packages/');
  const editHref = await phone.locator('a[href^="/admin/packages/"]:not([href$="/new/"])').filter({ hasNotText: 'packages' }).first().getAttribute('href');
  for (const path of ['/admin/', '/admin/settings/', '/admin/quotes/new/', '/admin/packages/', '/admin/packages/new/', editHref!, '/admin/users/']) {
    await phone.goto(path);
    const extra = await phone.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(extra, `${path} is wider than the phone`).toBeLessThanOrEqual(0);
  }
  await phone.close();
});

test('change your own password, log out and back in', async () => {
  await page.goto('/admin/users/');
  const form = page.locator('section', { hasText: 'Change your password' });
  await form.getByLabel('Current password').fill('not-my-password');
  await form.getByLabel('New password', { exact: true }).fill('new-safari-pass-7');
  await form.getByLabel('New password again').fill('new-safari-pass-7');
  await form.getByRole('button', { name: 'Change password' }).click();
  await expect(flash()).toContainText('Your current password is wrong');

  const f2 = page.locator('section', { hasText: 'Change your password' });
  await f2.getByLabel('Current password').fill(password);
  await f2.getByLabel('New password', { exact: true }).fill('new-safari-pass-7');
  await f2.getByLabel('New password again').fill('new-safari-pass-7');
  await f2.getByRole('button', { name: 'Change password' }).click();
  await expect(page).toHaveURL(/\/admin\/login\//);
  await expect(flash()).toContainText('Password changed');
  password = 'new-safari-pass-7';

  await page.getByLabel('Username').fill('spence');
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Log in' }).click();
  await expect(page.getByRole('heading', { name: 'Quotes' })).toBeVisible();

  await page.getByRole('button', { name: 'Log out' }).click();
  await expect(page).toHaveURL(/\/admin\/login\//);
  await expect(flash()).toHaveText('You’ve logged out.');
  await page.goto('/admin/settings/');
  await expect(page).toHaveURL(/\/admin\/login\/\?next=%2Fadmin%2Fsettings%2F/);
});
