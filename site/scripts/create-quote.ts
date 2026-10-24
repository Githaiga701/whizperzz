/**
 * Creates a quote and prints the pay link to send the guest.
 *
 *   npm run quote -- --name "Jane Wanjiku" --amount 85000 --desc "Wild to blue, 2 adults, 12-18 Jan" [--email jane@example.com] [--phone 0712345678]
 *
 * Talks to the running site through the admin API, so it works against your laptop or the live server.
 * Uses SITE_URL and ADMIN_TOKEN from .env (or pass --url).
 */
import { parseArgs } from 'node:util';

const { values } = parseArgs({
  options: {
    name: { type: 'string' },
    amount: { type: 'string' },
    desc: { type: 'string' },
    email: { type: 'string' },
    phone: { type: 'string' },
    url: { type: 'string' },
  },
});

const site = (values.url ?? process.env['SITE_URL'] ?? 'http://localhost:4321').replace(/\/+$/, '');
const token = process.env['ADMIN_TOKEN'];

if (!values.name || !values.amount || !values.desc) {
  console.error('Usage: npm run quote -- --name "Guest name" --amount 85000 --desc "Trip description" [--email ...] [--phone ...]');
  process.exit(1);
}
if (!token) {
  console.error('ADMIN_TOKEN is not set. Add it to .env first.');
  process.exit(1);
}

const res = await fetch(`${site}/api/admin/quotes`, {
  method: 'POST',
  headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({ guestName: values.name, amountKes: Number(values.amount), description: values.desc, email: values.email, phone: values.phone }),
});
const data = (await res.json()) as { message?: string; quote?: { ref: string; amountKes: number }; payUrl?: string };
if (!res.ok) {
  console.error(`Failed (${res.status}): ${data.message ?? 'unknown error'}`);
  process.exit(1);
}
console.log(`Quote ${data.quote!.ref} for KES ${data.quote!.amountKes.toLocaleString('en-KE')}`);
console.log(`Send this link to the guest: ${data.payUrl}`);
