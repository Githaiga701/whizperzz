# Whizperz Tours & Safaris website

The public website plus a private **admin** for journeys, prices, bookings, payments (M-Pesa and card), refunds and emails. Everything day-to-day happens in the browser.

Guests can book a journey straight from its page: pick a date and how many people, choose a deposit or the full amount, and pay by M-Pesa or card.

## On your Windows computer

1. Double-click **Start Whizperz.bat**.
   - The first time, it installs what it needs (a few minutes). If Node.js is missing or too old, it opens the download page: install the **LTS** version and double-click again.
   - Your browser opens the admin at <http://localhost:4321/admin/>. The public site is at <http://localhost:4321>.
   - Keep the black window open while you use the site. Close it to stop.
2. The first time, the admin asks you to **create your account**.
3. Go to **Settings** and fill in the site address, M-Pesa, Pesapal and email. Each has a test button.
4. Go to **Packages** and put a price on each journey. Until a journey has a price, guests can only send an enquiry about it.

To check everything works, double-click **Run tests.bat**. It takes about 3 minutes and ends with "ALL TESTS PASSED" (or opens a report showing what failed).

## Using the admin

| To… | Go to |
| --- | --- |
| Add a journey, change its price, photo or days | **Packages** → **New journey**, or click a journey |
| Hide a journey without deleting it | Journey page → **Hide from site** |
| Change the deposit or how far ahead guests can book | **Settings** → **Online booking** |
| See online bookings | **Quotes** (online bookings show the journey, date and travellers) |
| Send the balance after a deposit | Quote page → **Create balance pay link** |
| Make a quote and get a pay link | **New quote** |
| Send the link | Quote page → **Send on WhatsApp**, **Email link** or **Copy link** |
| See who has paid | **Quotes** (search by name, reference, phone or receipt) |
| Record cash or bank payments | Quote page → **Record a payment made another way** |
| Refund | Quote page → **Refund** (M-Pesa reversal, Pesapal refund, or record one made another way) |
| Change an unpaid quote, cancel or reopen it | Quote page → **Edit details** / **Cancel this quote** |
| Add staff | **Users** |
| Payment and email accounts | **Settings** |

Guests get an emailed receipt when they pay and a note when they're refunded. You get an alert for every payment, and for anything that needs checking (for example, a payment for the wrong amount).

If everyone forgets their password, open `/admin/setup/?recover=1` on the server itself (or with the setup key, below).

## Putting it online

**On your cPanel hosting (tours.whizperzpizza.co.ke):** follow [DEPLOY_CPANEL.md](DEPLOY_CPANEL.md). Double-click **Make cPanel upload.bat** to build the file you upload.

**On Vercel (previews only):** the Vercel project's Root Directory must be `site`. The build picks the Vercel adapter by itself. Vercel can't keep files, so journeys, quotes, users and settings saved there are wiped every few minutes. Use it to show people the design, not to take real bookings or payments.

**On other hosts:**

The site needs a host that runs Node.js 22.23.4 or newer: a VPS, Railway, Render or Fly.io. The host runs `npm install`, `npm run build:site` and `npm start`.

1. Set these in the host's dashboard:
   - `ADMIN_SETUP_KEY`: any long secret. You type it once to create the first admin account online.
   - `DATA_DIR`: a folder on storage that survives redeploys. Journeys, uploaded photos, quotes, settings and users are saved there. **Back it up.**
2. Open `https://your-domain/admin/`, create your account, and fill in **Settings**, starting with the site address.
3. In Settings → Pesapal, press **Register IPN** again whenever the site address changes.

Anything in Settings can also come from environment variables (see `.env.example`), which suits hosts where you'd rather keep keys in their dashboard. Settings saved in the admin take priority.

## For developers

```bash
npm install
npm run dev          # http://localhost:4321 with live reload
npm run test:all     # type-check + unit/API tests (Vitest) + browser tests (Playwright)
```

- Destinations live in `src/content/` as Markdown. Journeys are edited in the admin and saved in `DATA_DIR/packages.json`; the first run copies the starting set from `src/content/packages/`.
- Booking and pricing logic is in `src/lib/packages/`. Prices are always recalculated on the server (`/api/book`).
- Landing-page motion is in `src/scripts/motion.ts` and the "Motion" section of `global.css`. It switches itself off for anyone whose device asks for reduced motion.
- Payment logic is in `src/lib/payments/` (no web code, fully unit-tested). Admin pages are in `src/pages/admin/`.
- Browser tests run the real built server against fake M-Pesa, Pesapal and mail servers (`tests/e2e/mock-providers.ts`).
- `npm run quote`, `/api/admin/quotes` and `/api/admin/packages` (with `ADMIN_TOKEN`) are there for scripts. The admin does the same in the browser.
