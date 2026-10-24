/** Shared between the Playwright config and the tests. Keep this file free of side effects. */
export const SITE_PORT = 4399;
export const MOCK_PORT = 4398;
export const E2E_ADMIN_TOKEN = 'e2e-admin-token';
export const MOCK_SMTP_PORT = 4397;

/** Test keys shared by the site and the fake gateways, so signatures match. */
export const E2E_UNIPESA = { merchantId: 'e2e-merchant', secretKey: 'e2e-unipesa-secret' };
export const E2E_NOWPAYMENTS = { apiKey: 'e2e-np-key', ipnSecret: 'e2e-np-ipn-secret' };
export const E2E_IPOS = { tpn: '139322815010', apiKey: 'e2e-ipos-key', secretKey: 'e2e-ipos-secret' };
export const E2E_USD_RATE = 130;
