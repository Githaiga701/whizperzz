# Payments: setting up and going live

Everything below is done in the admin, under **Settings**. You don't need to edit any files.

Guests can pay by **M-Pesa**, **Pesapal** (cards, Airtel Money and more), **iPOS Pay** (cards in US dollars), **Unipesa** (mobile money and cards in the region) and **crypto** (NOWPayments). Each method appears on the site once its keys are saved. The full account-opening guide for every provider is the "Whizperz payment setup guide" document.

## How a payment works

**Booked online.** On a journey's page the guest picks a date, the number of adults and children, a deposit or the full amount, and M-Pesa or card. The site works out the price from the journey's prices in **Packages**, saves the booking as a quote and starts the payment. After a deposit is paid, open the quote and press **Create balance pay link**; the guest gets a link for the rest.

The deposit share (30% to start with) and how many days ahead guests must book (3) are in **Settings → Online booking**. M-Pesa takes at most KES 250,000 per payment, so bigger amounts are steered to card or a deposit.

**Quoted by you.**

1. **New quote**: enter the guest, trip and agreed amount. The site gives you a private pay link.
2. Send it with **Send on WhatsApp** or **Email link**.
3. The guest pays with **M-Pesa** (a prompt on their phone) or **card** (Pesapal's secure page).
4. Safaricom or Pesapal tells the site. The site **double-checks with them directly** and checks the amount, then marks the quote **Paid**, emails the guest a receipt and emails you an alert.

The browser never decides the amount. It only sends the booking reference.

## Test with the sandboxes first

Payment providers send results to your site, so it must be online at a public **https** address. On your own computer, payments still work, but you'll press **Check with the provider now** on the quote page to see the result.

1. **Settings → Site**: your public address, and *Sandbox* mode.
2. **Settings → M-Pesa**: from developer.safaricom.co.ke → My Apps (enable M-Pesa Express). The sandbox shortcode is `174379`. The passkey is on the M-Pesa Express simulator page. Press **Test connection**.
3. **Settings → Pesapal**: the demo keys from developer.pesapal.com. Press **Test connection**, then **Register IPN**.
4. **Settings → Email**: your mail server. Press **Send test email**.
5. Make a quote for KES 1 to yourself and pay it.

### Refunds
- **M-Pesa** refunds are *reversals*: the whole payment goes back to the payer's phone. You need an API user with the Reversal role on the M-Pesa org portal, and its security credential from the Daraja portal. Fill both in under Settings → M-Pesa → *For refunds*. For a part refund, send the money another way and choose **I've already paid it back another way**.
- **Pesapal** allows one refund per payment (cards can be partial, mobile money only in full). You approve it in your Pesapal dashboard, then press **Check refund status with Pesapal**.
- Cash, bank and other refunds: choose **I've already paid it back another way** and add the reference.
- If a refund is stuck, open **Refund stuck? Update it by hand** on the quote page after checking the provider's dashboard.

## Going live checklist

- [ ] Whizperz's own Daraja app approved for production ("Go Live"), with the real shortcode/till and passkey.
- [ ] Pesapal merchant account verified, with live keys.
- [ ] Site online at its real https address. **Settings → Site** shows it, mode *Live*.
- [ ] M-Pesa and Pesapal switched to *Live* (or left on "Same as payments mode"), live keys saved, both **Test connection** buttons green.
- [ ] **Register IPN** pressed again on the live site.
- [ ] Email set up, test email received, alerts address filled in.
- [ ] One real KES 10 payment each way, then refunded from the admin.
- [ ] `DATA_DIR` on storage that survives redeploys, and backed up.
- [ ] Privacy page reviewed against the Kenya Data Protection Act.

## Built-in safety
- Callback addresses contain a random secret, and every result is confirmed with the provider before a booking is marked paid.
- Wrong amounts, currencies or references are **flagged, not accepted**. Flagged quotes show under **Need checking** and you get an email.
- Secret keys are saved on the server only and never shown again in the browser.
- Admin logins are rate-limited (5 wrong passwords locks that login for 15 minutes). Sessions end after 12 hours or when the password changes. Forms from other websites are refused.

## Not built yet
- Automatic refunds for iPOS Pay, Unipesa and crypto (refund in their dashboards, then record it on the quote).
- Automatic reminders for unpaid balances (create the balance link from the quote page).
- Automatic retries of failed refunds (retry from the quote page).
