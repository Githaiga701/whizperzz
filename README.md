# Whizperz Tours & Safaris

The whole website is in the **site** folder. Open `site/README.md` to run it, use the admin, or put it online.

```
site/
  src/
    pages/        every page and API address (pages/api = payments, callbacks, admin API)
    components/   reusable page parts (components/admin = admin-only parts)
    layouts/      page frames: Base (public site) and Admin
    lib/          the site's logic
      payments/   M-Pesa, Pesapal, iPOS, Unipesa, crypto; quotes and refunds
      packages/   journeys: saving, pricing, booking, photo uploads
      admin/      logins, sessions, users
      email/      receipts and alerts
      settings/   everything saved from the admin Settings screen
      server/     connects the above to the web server
    content/      starting destinations and journeys (Markdown)
    data/         FAQ text
    config/       business name and contact details
    styles/       site and admin CSS
  public/         files served as-is (favicon)
  scripts/        cPanel packaging, Pesapal IPN registration, quote tool
  tests/          unit, API and browser tests
  data/           saved journeys, quotes, users (not in Git; back it up)
```
