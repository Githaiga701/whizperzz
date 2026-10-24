import { defineConfig, devices } from '@playwright/test';
import { rmSync } from 'node:fs';
import { E2E_ADMIN_TOKEN, E2E_IPOS, E2E_NOWPAYMENTS, E2E_UNIPESA, E2E_USD_RATE, MOCK_PORT, MOCK_SMTP_PORT, SITE_PORT } from './tests/e2e/env';

/**
 * Browser tests run against the real built server (npm run build first; npm run test:e2e does both)
 * with fake M-Pesa and Pesapal servers, so payments can be tested end to end safely.
 */
const site = `http://127.0.0.1:${SITE_PORT}`;
const mock = `http://127.0.0.1:${MOCK_PORT}`;
// Kept outside test-results/, which Playwright manages and clears itself.
const dataDir = '.e2e-data';

// Start every run with no saved data. Playwright loads this file again inside each test worker,
// so only the main process may clear it (otherwise a new worker would wipe the running server's files).
if (process.env['TEST_WORKER_INDEX'] === undefined) rmSync(dataDir, { recursive: true, force: true });

const siteEnv = {
  HOST: '127.0.0.1',
  PORT: String(SITE_PORT),
  PAYMENTS_MODE: 'sandbox',
  SITE_URL: site,
  DATA_DIR: dataDir,
  ADMIN_TOKEN: E2E_ADMIN_TOKEN,
  // All test traffic comes from one address, so allow more requests per minute.
  RATE_LIMIT_MULTIPLIER: '20',
  MPESA_CONSUMER_KEY: 'e2e-key',
  MPESA_CONSUMER_SECRET: 'e2e-secret',
  MPESA_SHORTCODE: '174379',
  MPESA_PASSKEY: 'e2e-passkey',
  MPESA_CALLBACK_SECRET: 'e2e-mpesa-cb',
  MPESA_BASE_URL: mock,
  PESAPAL_CONSUMER_KEY: 'e2e-pk',
  PESAPAL_CONSUMER_SECRET: 'e2e-ps',
  PESAPAL_CALLBACK_SECRET: 'e2e-pesapal-cb',
  PESAPAL_IPN_ID: 'e2e-ipn',
  PESAPAL_BASE_URL: `${mock}/pesapalv3`,
  USD_KES_RATE: String(E2E_USD_RATE),
  IPOS_TPN: E2E_IPOS.tpn,
  IPOS_API_KEY: E2E_IPOS.apiKey,
  IPOS_SECRET_KEY: E2E_IPOS.secretKey,
  IPOS_CALLBACK_SECRET: 'e2e-ipos-cb',
  IPOS_PAYMENT_URL: `${mock}/ipos/payment`,
  IPOS_API_URL: `${mock}/ipos/api`,
  IPOS_AUTH_URL: `${mock}/ipos/auth`,
  UNIPESA_MERCHANT_ID: E2E_UNIPESA.merchantId,
  UNIPESA_SECRET_KEY: E2E_UNIPESA.secretKey,
  UNIPESA_CALLBACK_SECRET: 'e2e-unipesa-cb',
  UNIPESA_HPP_URL: `${mock}/unipesa/hpp`,
  NOWPAYMENTS_API_KEY: E2E_NOWPAYMENTS.apiKey,
  NOWPAYMENTS_IPN_SECRET: E2E_NOWPAYMENTS.ipnSecret,
  NOWPAYMENTS_CALLBACK_SECRET: 'e2e-crypto-cb',
  NOWPAYMENTS_BASE_URL: `${mock}/nowpayments/v1`,
};

export default defineConfig({
  testDir: 'tests/e2e',
  fullyParallel: true,
  forbidOnly: Boolean(process.env['CI']),
  retries: process.env['CI'] ? 1 : 0,
  reporter: [['list'], ['html', { open: 'never' }]],
  timeout: 30_000,
  use: {
    baseURL: site,
    trace: 'retain-on-failure',
  },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'] } },
    // The admin tests change shared state (first-run setup, settings), so they run once, on desktop.
    { name: 'mobile', use: { ...devices['Pixel 7'] }, testIgnore: /admin\.spec\.ts/ },
  ],
  webServer: [
    {
      command: 'npx tsx tests/e2e/mock-providers.ts',
      url: `${mock}/health`,
      env: { MOCK_PORT: String(MOCK_PORT), MOCK_SMTP_PORT: String(MOCK_SMTP_PORT), MOCK_PESAPAL_IPN_URL: `${site}/api/callbacks/pesapal/e2e-pesapal-cb` },
      reuseExistingServer: false,
      stdout: 'pipe',
    },
    {
      command: 'node dist/server/entry.mjs',
      url: `${site}/api/health`,
      env: siteEnv,
      reuseExistingServer: false,
      stdout: 'pipe',
    },
  ],
});
