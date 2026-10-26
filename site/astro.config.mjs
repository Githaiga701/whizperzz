// @ts-check
import { defineConfig } from 'astro/config';
import node from '@astrojs/node';

export default defineConfig({
  // The public address, used for canonical links. Set SITE_URL when building for another address.
  site: process.env.SITE_URL || 'https://tours.whizperzpizza.co.ke',
  trailingSlash: 'ignore',
  // Pages are still built as static HTML. Only the payment API and pay links run on the server.
  adapter: node({ mode: 'standalone' }),
  // The admin area does its own same-origin check (src/middleware.ts), which also works behind a proxy.
  security: { checkOrigin: false },
});
