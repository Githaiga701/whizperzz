# Putting the site online on Namecheap (whizperzdawntours.com)

The site runs on Namecheap shared hosting (Stellar or higher) as a Node.js app, on the main domain **whizperzdawntours.com**. Everything is done in cPanel with clicks; no commands.

What you need: the Namecheap hosting plan with **whizperzdawntours.com** as its main domain, and the upload file **whizperz-cpanel.tar.gz** (made by **Make cPanel upload.bat**, see step 2).

In the steps below, `USERNAME` is your cPanel username. It's shown in cPanel's right-hand column (**General Information → Current User**) and in your hosting welcome email.

## 1. Domain and padlock (SSL)

1. If you bought the domain at Namecheap with the hosting, it already points to the hosting. If not: Namecheap → **Domain List** → **Manage** → **Nameservers** → **Namecheap Web Hosting DNS**. Allow up to a few hours for it to take effect.
2. cPanel → **SSL/TLS Status** → tick `whizperzdawntours.com` and `www.whizperzdawntours.com` → **Run AutoSSL**. Wait until both show a valid certificate. (Namecheap also offers its own PositiveSSL; either works.)

## 2. Make the upload file

On your PC, double-click **Make cPanel upload.bat** in the site folder. After about two minutes it opens the folder with **whizperz-cpanel.tar.gz** selected. (Your developer may send you this file instead.)

## 3. Upload it

1. cPanel → **File Manager**. Stay in your home folder (`/home/USERNAME`), **not** `public_html`.
2. **+ Folder** → `whizperz-app`. Make a second folder: `whizperz-data`. Bookings, payments, settings, users and uploaded photos are saved there.
3. Open `whizperz-app` → **Upload** → choose `whizperz-cpanel.tar.gz`. Wait for 100%.
4. Back in File Manager, right-click the file → **Extract** → `/home/USERNAME/whizperz-app`. Then delete the `.tar.gz`.

## 4. Create the Node.js app

cPanel → **Setup Node.js App** (under Software) → **Create Application**:

| Field | Value |
| --- | --- |
| Node.js version | **24.13** (not 22.22: the site needs 22.23 or newer) |
| Application mode | Production |
| Application root | `whizperz-app` |
| Application URL | `whizperzdawntours.com` (leave the path box empty) |
| Application startup file | `passenger.cjs` |

Under **Environment variables**, press **Add Variable** for each:

| Name | Value |
| --- | --- |
| `SITE_URL` | `https://whizperzdawntours.com` |
| `DATA_DIR` | `/home/USERNAME/whizperz-data` |
| `PAYMENTS_MODE` | `sandbox` (change to `production` when you go live) |
| `ADMIN_SETUP_KEY` | any long random phrase, only for creating the first admin account |
| `NODE_ENV` | `production` |

Press **Create**. Then press **Run NPM Install** and wait until it finishes (a few minutes), then **Restart**.

Don't add the `KV_REST_API_*` (Upstash) variables here: without them the site saves to `whizperz-data`, which is what you want on cPanel.

## 5. First visit

1. Open `https://whizperzdawntours.com` and check the home page loads.
2. Open `https://whizperzdawntours.com/admin/`. It asks for the setup key: type the `ADMIN_SETUP_KEY` value and create your account.
3. Back in **Setup Node.js App** → edit the app → delete the `ADMIN_SETUP_KEY` variable → **Save** → **Restart**.
4. Admin → **Settings → Site**: site address `https://whizperzdawntours.com`, payments mode **Sandbox** for now.
5. Admin → **Packages**: put a price on each journey (until then guests can only enquire).

## 6. Email for receipts and alerts

1. cPanel → **Email Accounts** → **Create**: `bookings@whizperzdawntours.com`.
2. Its **Connect Devices** page shows the outgoing server, usually `mail.whizperzdawntours.com`, port **465**, SSL.
3. Admin → **Settings → Email**: that server, port 465, secure **yes**, the full address as username, its password, Send from `Whizperz Tours <bookings@whizperzdawntours.com>`, and where your alerts should go. Press **Send test email**.

## 7. Payments

Fill in each provider in **Admin → Settings** and press its **Test connection**. Because the address is new:

- **M-Pesa** and **crypto (NOWPayments)**: nothing extra; the site sends its address with every payment.
- **Pesapal**: press **Register IPN** (needed whenever the site address changes).
- **Paystack**: in Paystack's dashboard → **Settings → API Keys & Webhooks**, set the webhook URL to the one shown under Paystack in the admin.
- Keep **Sandbox** until a real test payment of each kind has gone through. Then switch to live keys and set `PAYMENTS_MODE=production` in Setup Node.js App (and Restart).

## Updating the site later

1. Get a new **whizperz-cpanel.tar.gz** (Make cPanel upload.bat).
2. Upload it into `whizperz-app` and **Extract** it (overwrite all). Delete the `.tar.gz`.
3. **Setup Node.js App** → **Run NPM Install** → **Restart**.

Bookings, settings and photos in `whizperz-data` are never touched by an update.

## Backups

Once a month, and before every update: File Manager → right-click `whizperz-data` → **Compress** → Zip → download it. To restore, upload the zip into your home folder and **Extract** it over `whizperz-data`, then Restart the app.

## If something goes wrong

| You see | Try |
| --- | --- |
| A 503 page or "Incomplete response" | Setup Node.js App → **Restart**. Then open `whizperz-app/stderr.log` in File Manager and send it to your developer. |
| The Namecheap default page instead of the site | Check the app's Application URL is `whizperzdawntours.com` and that `public_html` has no `index.html` left over. |
| Run NPM Install fails or stops | Press it again (it resumes). If it keeps failing, ask Namecheap support to run `npm install --omit=dev` in `whizperz-app` for you. |
| The admin says the setup key is wrong | Re-check `ADMIN_SETUP_KEY` in the app settings, then **Restart** (changes apply only after a restart). |
| Payments never confirm | **Settings → Site** must be `https://whizperzdawntours.com` and SSL must be valid. The admin's quote page shows the reason for any failed M-Pesa prompt. |
