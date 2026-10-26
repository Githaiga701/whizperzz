/**
 * Start-up file for cPanel's "Setup Node.js App" (Phusion Passenger).
 * Passenger runs this file; it loads the built site, and Passenger hands it the web requests.
 * Set DATA_DIR, SITE_URL and BEHIND_PROXY=1 in the app's environment variables (see DEPLOY_CPANEL.md).
 */
process.env.BEHIND_PROXY ??= '1';
process.env.HOST ??= '127.0.0.1';
import('./dist/server/entry.mjs').catch((err) => {
  console.error('The Whizperz site could not start:', err);
  process.exit(1);
});
