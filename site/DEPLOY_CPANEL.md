# Putting the site online on cPanel (tours.whizperzpizza.co.ke)

The tours site runs on its own subdomain, beside the restaurant's WordPress site, on the same cPanel account. Nothing on whizperzpizza.co.ke changes.

**Before you start:** your host must enable **Setup Node.js App** with **Node.js 22.23 or newer** (or 24). It appears in cPanel under **Software**.

## 1. Create the subdomain

1. cPanel → **Domains** → **Create A New Domain**.
2. Domain: `tours.whizperzpizza.co.ke`. Untick **Share document root**. Keep the suggested folder (`tours.whizperzpizza.co.ke`). Submit.
3. cPanel → **SSL/TLS Status** → tick the new subdomain → **Run AutoSSL**. Wait until it shows a valid certificate (a few minutes).

## 2. Make the upload file (on your PC)

Double-click **Make cPanel upload.bat** in the site folder. After about two minutes it opens the folder with **whizperz-cpanel.tar.gz** selected.

## 3. Upload it

1. cPanel → **File Manager**. Stay in your home folder (`/home/diamondrestauran`), not `public_html`.
2. **+ Folder** → name it `whizperz-app`. Make a second folder named `whizperz-data` (bookings, settings and uploaded photos are saved here).
3. Open `whizperz-app` → **Upload** → choose `whizperz-cpanel.tar.gz`.
4. Back in File Manager, right-click the file → **Extract** → into `/home/diamondrestauran/whizperz-app`. Then delete the `.tar.gz`.

## 4. Create the Node.js app

cPanel → **Setup Node.js App** → **Create Application**:

| Field | Value |
| --- | --- |
| Node.js version | 22.23 or newer (or 24) |
| Application mode | Production |
| Application root | `whizperz-app` |
| Application URL | `tours.whizperzpizza.co.ke` |
| Application startup file | `passenger.cjs` |

Add these **environment variables**:

| Name | Value |
| --- | --- |
| `SITE_URL` | `https://tours.whizperzpizza.co.ke` |
| `DATA_DIR` | `/home/diamondrestauran/whizperz-data` |
| `BEHIND_PROXY` | `1` |
| `NODE_ENV` | `production` |
| `ADMIN_SETUP_KEY` | any long random phrase (only for creating the first admin account) |

Press **Create**, then **Run NPM Install** (a few minutes), then **Restart**.

## 5. First visit

1. Open `https://tours.whizperzpizza.co.ke/admin/`. It asks for the setup key: type the `ADMIN_SETUP_KEY` value and create your account.
2. Back in **Setup Node.js App**, delete the `ADMIN_SETUP_KEY` variable and press **Restart**.
3. In the admin: **Settings → Site** = `https://tours.whizperzpizza.co.ke`, payments mode Sandbox for now.

## 6. Email for receipts and alerts

1. cPanel → **Email Accounts** → **Create**: `bookings@whizperzpizza.co.ke`.
2. Its **Connect Devices** page shows the mail server: usually `mail.whizperzpizza.co.ke`, port **465**, SSL.
3. Admin → **Settings → Email**: that server, port 465, the full address as username, its password, Send from `Whizperz Tours <bookings@whizperzpizza.co.ke>`. Send a test.

## Updating the site later

1. Double-click **Make cPanel upload.bat**.
2. Upload the new `whizperz-cpanel.tar.gz` into `whizperz-app` and **Extract** it (overwrite). Delete the `.tar.gz`.
3. **Setup Node.js App** → **Restart**. Press **Run NPM Install** first only if you were told the packages changed.

Bookings, settings and photos in `whizperz-data` are never touched by an update.

## Backups

Once a month (and before updates), File Manager → right-click `whizperz-data` → **Compress** → download the archive. cPanel → **Backup** also includes it in a full home-folder backup.

## If something goes wrong

| You see | Try |
| --- | --- |
| "Incomplete response" or a 503 page | Setup Node.js App → **Restart**. Then open `whizperz-app/stderr.log` in File Manager (if your host keeps one) and send it to your developer. |
| "Node.js version is too old" in the log | Pick 22.23+ or 24 in the app settings, or ask the host to add it. |
| Run NPM Install fails | Ask the host to raise the account's memory limit for the install, or to run `npm install` in `whizperz-app` for you. |
| The site works but payments never confirm | Check **Settings → Site** is the https address and AutoSSL is valid. |

## Linking from the restaurant site

In WordPress → **Appearance → Menus**, add a **Custom Link** to `https://tours.whizperzpizza.co.ke` named **Tours & Safaris**.
