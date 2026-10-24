// @ts-check
import { defineConfig } from 'astro/config';
import node from '@astrojs/node';

export default defineConfig({
  // Change to the real domain before launch (used for canonical URLs).
  site: 'https://whizperz.co.ke',
  trailingSlash: 'ignore',
  // Pages are still built as static HTML. Only the payment API and pay links run on the server.
  adapter: node({ mode: 'standalone' }),
  // The admin area does its own same-origin check (src/middleware.ts), which also works behind a proxy.
  security: { checkOrigin: false },
});
