/**
 * Registers this site's IPN URL with Pesapal and prints the ipn_id to put in PESAPAL_IPN_ID.
 * Run once per environment (sandbox and production), after SITE_URL points at a public https address.
 *
 *   npm run pesapal:register-ipn
 */
import { loadPaymentConfig } from '../src/lib/payments/config';
import { createPesapal } from '../src/lib/payments/pesapal';

const config = loadPaymentConfig(process.env);
if (!config.pesapal) {
  console.error(config.warnings.find((w) => w.startsWith('Pesapal')) ?? 'Pesapal is not configured.');
  process.exit(1);
}
if (!config.siteUrl.startsWith('https://')) {
  console.warn(`Warning: SITE_URL is ${config.siteUrl}. Pesapal can only reach a public https address.`);
}
const res = await createPesapal(config.pesapal).registerIpn(config.pesapal.ipnUrl);
console.log(`Registered ${res.url}`);
console.log(`Add this to .env:\nPESAPAL_IPN_ID=${res.ipn_id}`);
