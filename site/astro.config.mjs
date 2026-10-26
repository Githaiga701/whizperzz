// @ts-check
import { defineConfig } from 'astro/config';
import node from '@astrojs/node';
import vercel from '@astrojs/vercel';

// Vercel sets VERCEL=1 during its builds. Everywhere else (cPanel, your computer) the site is a Node.js server.
const onVercel = Boolean(process.env.VERCEL);

export default defineConfig({
  // The public address, used for canonical links. Set SITE_URL when building for another address.
  site: process.env.SITE_URL || (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : 'https://tours.whizperzpizza.co.ke'),
  trailingSlash: 'ignore',
  // Pages are still built as static HTML. Only the payment API, admin and pay links run on the server.
  adapter: onVercel ? vercel() : node({ mode: 'standalone' }),
  // The admin area does its own same-origin check (src/middleware.ts), which also works behind a proxy.
  security: { checkOrigin: false },
});
