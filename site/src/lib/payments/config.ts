import { z } from 'astro/zod';

/**
 * Server-only payment configuration, read from environment variables.
 * A provider is switched on only when all of its credentials are present,
 * so the site runs fine (with payments hidden) before any accounts exist.
 */

const blank = z
  .string()
  .optional()
  .transform((v) => (v && v.trim() !== '' ? v.trim() : undefined));

const envSchema = z.object({
  PAYMENTS_MODE: z.enum(['sandbox', 'production']).default('sandbox'),
  SITE_URL: blank,
  DATA_DIR: blank,
  ADMIN_TOKEN: blank,

  MPESA_ENV: z.enum(['sandbox', 'production']).optional(),
  MPESA_CONSUMER_KEY: blank,
  MPESA_CONSUMER_SECRET: blank,
  MPESA_SHORTCODE: blank,
  MPESA_PASSKEY: blank,
  /** Set for a Till (Buy Goods). Leave empty for a Paybill. */
  MPESA_TILL_NUMBER: blank,
  /** Random string that forms part of the callback URL, so strangers can't guess it. */
  MPESA_CALLBACK_SECRET: blank,
  /** For refunds (reversals): the API user created on the M-Pesa org portal, and its encrypted password. */
  MPESA_INITIATOR_NAME: blank,
  MPESA_SECURITY_CREDENTIAL: blank,
  /** Override for tests only. */
  MPESA_BASE_URL: blank,

  PESAPAL_ENV: z.enum(['sandbox', 'production']).optional(),
  PESAPAL_CONSUMER_KEY: blank,
  PESAPAL_CONSUMER_SECRET: blank,
  /** The ipn_id returned when the IPN URL was registered (npm run pesapal:register-ipn). */
  PESAPAL_IPN_ID: blank,
  PESAPAL_CALLBACK_SECRET: blank,
  /** The address the saved PESAPAL_IPN_ID was registered for. If the site address changes, the IPN is registered again. */
  PESAPAL_IPN_URL: blank,
  /** Optional allow-list of the IP addresses Pesapal sends notifications from. */
  PESAPAL_CALLBACK_IPS: blank,
  PESAPAL_BASE_URL: blank,

  /** Shillings per US dollar. iPOS Pay and crypto charge in dollars, converted at this rate. */
  USD_KES_RATE: blank,

  IPOS_ENV: z.enum(['sandbox', 'production']).optional(),
  /** The Terminal (TPN) number of the iPOSpays e-commerce terminal. */
  IPOS_TPN: blank,
  /** Either the auth token made in the iPOSpays portal (Settings → Merchant Keys / Ecom token)… */
  IPOS_AUTH_TOKEN: blank,
  /** …or the API key and secret key, which the site swaps for a token itself. */
  IPOS_API_KEY: blank,
  IPOS_SECRET_KEY: blank,
  IPOS_CALLBACK_SECRET: blank,
  /** Overrides, e.g. if Dejavoo gives different live addresses. */
  IPOS_PAYMENT_URL: blank,
  IPOS_API_URL: blank,
  IPOS_AUTH_URL: blank,

  UNIPESA_MERCHANT_ID: blank,
  /** The "merchant public ID" some Unipesa addresses contain. Defaults to the merchant ID. */
  UNIPESA_PUBLIC_ID: blank,
  /** Optional: the "type" Unipesa's payment page should open with (e.g. card). */
  UNIPESA_PAY_TYPE: blank,
  UNIPESA_CURRENCY: blank,
  /** Optional allow-list of the IP addresses Unipesa sends results from (comma separated; IPv4 ranges like 41.1.2.0/24 allowed). */
  UNIPESA_CALLBACK_IPS: blank,
  UNIPESA_SECRET_KEY: blank,
  UNIPESA_CALLBACK_SECRET: blank,
  /** Which payment option Unipesa's page opens with (their provider id). Empty lets Unipesa decide. */
  UNIPESA_PROVIDER_ID: blank,
  UNIPESA_COUNTRY: blank,
  UNIPESA_HPP_URL: blank,
  /** Unipesa's transaction status address, if they give you one. Used to double-check payments. */
  UNIPESA_STATUS_URL: blank,

  /** Paystack secret key: sk_test_… while testing, sk_live_… when live. */
  PAYSTACK_SECRET_KEY: blank,
  PAYSTACK_CALLBACK_SECRET: blank,
  /** Optional: which payment options Paystack's page shows, e.g. "card,mobile_money". Empty shows all you've switched on. */
  PAYSTACK_CHANNELS: blank,
  /** Optional allow-list of the IP addresses Paystack sends webhooks from. */
  PAYSTACK_CALLBACK_IPS: blank,
  PAYSTACK_BASE_URL: blank,

  NOWPAYMENTS_ENV: z.enum(['sandbox', 'production']).optional(),
  NOWPAYMENTS_API_KEY: blank,
  NOWPAYMENTS_IPN_SECRET: blank,
  NOWPAYMENTS_CALLBACK_SECRET: blank,
  NOWPAYMENTS_BASE_URL: blank,
});

export type PaymentEnv = z.input<typeof envSchema>;

export interface MpesaConfig {
  baseUrl: string;
  consumerKey: string;
  consumerSecret: string;
  shortcode: string;
  passkey: string;
  tillNumber: string | undefined;
  callbackUrl: string;
  callbackSecret: string;
  /** Present only when refunds (reversals) are set up. */
  reversal: { initiatorName: string; securityCredential: string; resultUrl: string; timeoutUrl: string } | undefined;
}

export interface PesapalConfig {
  baseUrl: string;
  consumerKey: string;
  consumerSecret: string;
  ipnId: string | undefined;
  ipnUrl: string;
  callbackSecret: string;
  callbackIps: string[];
}

export interface IposConfig {
  paymentUrl: string;
  apiUrl: string;
  authUrl: string;
  tpn: string;
  authToken: string | undefined;
  apiKey: string | undefined;
  secretKey: string | undefined;
  callbackSecret: string;
  notifyUrl: string;
}

export interface UnipesaConfig {
  hppUrl: string;
  merchantId: string;
  publicId: string | undefined;
  secretKey: string;
  providerId: string | undefined;
  payType: string | undefined;
  country: string;
  currency: string;
  /** Status address; may contain {merchant_id} and {public_id}. */
  statusUrl: string | undefined;
  callbackIps: string[];
  callbackSecret: string;
  notifyUrl: string;
}

export interface PaystackConfig {
  baseUrl: string;
  secretKey: string;
  /** True for an sk_test_ key: no real money moves. */
  testKey: boolean;
  channels: string[];
  callbackIps: string[];
  callbackSecret: string;
  notifyUrl: string;
}

export interface NowPaymentsConfig {
  baseUrl: string;
  apiKey: string;
  ipnSecret: string;
  callbackSecret: string;
  notifyUrl: string;
}

export interface PaymentConfig {
  mode: 'sandbox' | 'production';
  siteUrl: string;
  dataDir: string;
  adminToken: string | undefined;
  mpesa: MpesaConfig | undefined;
  pesapal: PesapalConfig | undefined;
  /** Shillings per US dollar, for methods that charge in dollars. */
  usdRate: number | undefined;
  ipos: IposConfig | undefined;
  unipesa: UnipesaConfig | undefined;
  crypto: NowPaymentsConfig | undefined;
  paystack: PaystackConfig | undefined;
  /** Human-readable reasons a provider is switched off. Logged once at start-up. */
  warnings: string[];
}

export const MPESA_URLS = {
  sandbox: 'https://sandbox.safaricom.co.ke',
  production: 'https://api.safaricom.co.ke',
} as const;

export const IPOS_URLS = {
  sandbox: { payment: 'https://payment.ipospays.tech', api: 'https://api.ipospays.tech', auth: 'https://auth.ipospays.tech' },
  // From iPOSpays' published docs (HPP, queryPaymentStatus and token API). Can be overridden in Settings.
  production: { payment: 'https://payment.ipospays.com', api: 'https://api.ipospays.com', auth: 'https://auth.ipospays.com' },
} as const;

export const UNIPESA_HPP_URL = 'https://hpp.unipesa.tech';

export const PAYSTACK_API_URL = 'https://api.paystack.co';

/** Payment options Paystack's page can show for Kenyan businesses. */
export const PAYSTACK_CHANNELS = ['card', 'mobile_money', 'bank_transfer', 'apple_pay'] as const;

export const NOWPAYMENTS_URLS = {
  sandbox: 'https://api-sandbox.nowpayments.io/v1',
  production: 'https://api.nowpayments.io/v1',
} as const;

export const PESAPAL_URLS = {
  sandbox: 'https://cybqa.pesapal.com/pesapalv3',
  production: 'https://pay.pesapal.com/v3',
} as const;

function missing(names: [string, string | undefined][]): string[] {
  return names.filter(([, v]) => !v).map(([n]) => n);
}

export function loadPaymentConfig(raw: Record<string, string | undefined>): PaymentConfig {
  const env = envSchema.parse(raw);
  const warnings: string[] = [];
  // Without SITE_URL, use the address Vercel gives the site (previews), and only then this computer.
  const vercelHost = raw['VERCEL_PROJECT_PRODUCTION_URL']?.trim() || raw['VERCEL_URL']?.trim();
  const siteUrl = (env.SITE_URL ?? (vercelHost ? `https://${vercelHost}` : 'http://localhost:4321')).replace(/\/+$/, '');
  const mode = env.PAYMENTS_MODE;

  if (mode === 'production' && !siteUrl.startsWith('https://')) {
    warnings.push('SITE_URL must be https in production. Payment providers will not call back to http.');
  }

  let mpesa: MpesaConfig | undefined;
  const mpesaMissing = missing([
    ['MPESA_CONSUMER_KEY', env.MPESA_CONSUMER_KEY],
    ['MPESA_CONSUMER_SECRET', env.MPESA_CONSUMER_SECRET],
    ['MPESA_SHORTCODE', env.MPESA_SHORTCODE],
    ['MPESA_PASSKEY', env.MPESA_PASSKEY],
    ['MPESA_CALLBACK_SECRET', env.MPESA_CALLBACK_SECRET],
  ]);
  if (mpesaMissing.length === 0) {
    const secret = env.MPESA_CALLBACK_SECRET!;
    mpesa = {
      baseUrl: env.MPESA_BASE_URL ?? MPESA_URLS[env.MPESA_ENV ?? mode],
      consumerKey: env.MPESA_CONSUMER_KEY!,
      consumerSecret: env.MPESA_CONSUMER_SECRET!,
      shortcode: env.MPESA_SHORTCODE!,
      passkey: env.MPESA_PASSKEY!,
      tillNumber: env.MPESA_TILL_NUMBER,
      callbackSecret: secret,
      callbackUrl: `${siteUrl}/api/callbacks/mpesa/${encodeURIComponent(secret)}`,
      reversal:
        env.MPESA_INITIATOR_NAME && env.MPESA_SECURITY_CREDENTIAL
          ? {
              initiatorName: env.MPESA_INITIATOR_NAME,
              securityCredential: env.MPESA_SECURITY_CREDENTIAL,
              resultUrl: `${siteUrl}/api/callbacks/mpesa-reversal/${encodeURIComponent(secret)}/result`,
              timeoutUrl: `${siteUrl}/api/callbacks/mpesa-reversal/${encodeURIComponent(secret)}/timeout`,
            }
          : undefined,
    };
  } else {
    warnings.push(`M-Pesa is off. Missing: ${mpesaMissing.join(', ')}.`);
  }

  let pesapal: PesapalConfig | undefined;
  const pesapalMissing = missing([
    ['PESAPAL_CONSUMER_KEY', env.PESAPAL_CONSUMER_KEY],
    ['PESAPAL_CONSUMER_SECRET', env.PESAPAL_CONSUMER_SECRET],
    ['PESAPAL_CALLBACK_SECRET', env.PESAPAL_CALLBACK_SECRET],
  ]);
  if (pesapalMissing.length === 0) {
    const secret = env.PESAPAL_CALLBACK_SECRET!;
    const ipnUrl = `${siteUrl}/api/callbacks/pesapal/${encodeURIComponent(secret)}`;
    // An IPN id registered for an older site address would send results to the wrong place.
    const stale = Boolean(env.PESAPAL_IPN_URL && env.PESAPAL_IPN_URL !== ipnUrl);
    pesapal = {
      baseUrl: env.PESAPAL_BASE_URL ?? PESAPAL_URLS[env.PESAPAL_ENV ?? mode],
      consumerKey: env.PESAPAL_CONSUMER_KEY!,
      consumerSecret: env.PESAPAL_CONSUMER_SECRET!,
      ipnId: stale ? undefined : env.PESAPAL_IPN_ID,
      callbackSecret: secret,
      ipnUrl,
      callbackIps: (env.PESAPAL_CALLBACK_IPS ?? '').split(/[\s,]+/).filter(Boolean),
    };
    if (!pesapal.ipnId) {
      warnings.push(stale ? 'Pesapal: the site address changed, so the IPN will be registered again.' : 'Pesapal checkout is off until the IPN is registered (Settings → Pesapal does this automatically).');
    }
  } else {
    warnings.push(`Pesapal is off. Missing: ${pesapalMissing.join(', ')}.`);
  }

  const rate = env.USD_KES_RATE ? Number(env.USD_KES_RATE) : undefined;
  const usdRate = rate && Number.isFinite(rate) && rate > 0 ? rate : undefined;
  const callback = (name: string, secret: string) => `${siteUrl}/api/callbacks/${name}/${encodeURIComponent(secret)}`;

  let ipos: IposConfig | undefined;
  const iposMissing = missing([
    ['IPOS_TPN', env.IPOS_TPN],
    ['IPOS_AUTH_TOKEN or IPOS_API_KEY + IPOS_SECRET_KEY', env.IPOS_AUTH_TOKEN ?? (env.IPOS_API_KEY && env.IPOS_SECRET_KEY ? 'ok' : undefined)],
    ['IPOS_CALLBACK_SECRET', env.IPOS_CALLBACK_SECRET],
    ['USD_KES_RATE', usdRate ? 'ok' : undefined],
  ]);
  if (iposMissing.length === 0) {
    const urls = IPOS_URLS[env.IPOS_ENV ?? mode];
    ipos = {
      paymentUrl: (env.IPOS_PAYMENT_URL ?? urls.payment).replace(/\/+$/, ''),
      apiUrl: (env.IPOS_API_URL ?? urls.api).replace(/\/+$/, ''),
      authUrl: (env.IPOS_AUTH_URL ?? urls.auth).replace(/\/+$/, ''),
      tpn: env.IPOS_TPN!,
      authToken: env.IPOS_AUTH_TOKEN,
      apiKey: env.IPOS_API_KEY,
      secretKey: env.IPOS_SECRET_KEY,
      callbackSecret: env.IPOS_CALLBACK_SECRET!,
      notifyUrl: callback('ipos', env.IPOS_CALLBACK_SECRET!),
    };
  } else if (env.IPOS_TPN || env.IPOS_API_KEY || env.IPOS_AUTH_TOKEN) {
    warnings.push(`iPOS Pay is off. Missing: ${iposMissing.join(', ')}.`);
  }

  let unipesa: UnipesaConfig | undefined;
  const unipesaMissing = missing([
    ['UNIPESA_MERCHANT_ID', env.UNIPESA_MERCHANT_ID],
    ['UNIPESA_SECRET_KEY', env.UNIPESA_SECRET_KEY],
    ['UNIPESA_CALLBACK_SECRET', env.UNIPESA_CALLBACK_SECRET],
  ]);
  if (unipesaMissing.length === 0) {
    unipesa = {
      hppUrl: (env.UNIPESA_HPP_URL ?? UNIPESA_HPP_URL).replace(/\/+$/, ''),
      merchantId: env.UNIPESA_MERCHANT_ID!,
      publicId: env.UNIPESA_PUBLIC_ID,
      secretKey: env.UNIPESA_SECRET_KEY!,
      providerId: env.UNIPESA_PROVIDER_ID,
      payType: env.UNIPESA_PAY_TYPE,
      country: (env.UNIPESA_COUNTRY ?? 'KE').toUpperCase(),
      currency: (env.UNIPESA_CURRENCY ?? 'KES').toUpperCase(),
      statusUrl: env.UNIPESA_STATUS_URL,
      callbackIps: (env.UNIPESA_CALLBACK_IPS ?? '').split(/[\s,]+/).filter(Boolean),
      callbackSecret: env.UNIPESA_CALLBACK_SECRET!,
      notifyUrl: callback('unipesa', env.UNIPESA_CALLBACK_SECRET!),
    };
  } else if (env.UNIPESA_MERCHANT_ID || env.UNIPESA_SECRET_KEY) {
    warnings.push(`Unipesa is off. Missing: ${unipesaMissing.join(', ')}.`);
  }

  let crypto: NowPaymentsConfig | undefined;
  const cryptoMissing = missing([
    ['NOWPAYMENTS_API_KEY', env.NOWPAYMENTS_API_KEY],
    ['NOWPAYMENTS_IPN_SECRET', env.NOWPAYMENTS_IPN_SECRET],
    ['NOWPAYMENTS_CALLBACK_SECRET', env.NOWPAYMENTS_CALLBACK_SECRET],
    ['USD_KES_RATE', usdRate ? 'ok' : undefined],
  ]);
  if (cryptoMissing.length === 0) {
    crypto = {
      baseUrl: (env.NOWPAYMENTS_BASE_URL ?? NOWPAYMENTS_URLS[env.NOWPAYMENTS_ENV ?? mode]).replace(/\/+$/, ''),
      apiKey: env.NOWPAYMENTS_API_KEY!,
      ipnSecret: env.NOWPAYMENTS_IPN_SECRET!,
      callbackSecret: env.NOWPAYMENTS_CALLBACK_SECRET!,
      notifyUrl: callback('crypto', env.NOWPAYMENTS_CALLBACK_SECRET!),
    };
  } else if (env.NOWPAYMENTS_API_KEY || env.NOWPAYMENTS_IPN_SECRET) {
    warnings.push(`Crypto (NOWPayments) is off. Missing: ${cryptoMissing.join(', ')}.`);
  }

  let paystack: PaystackConfig | undefined;
  const paystackMissing = missing([
    ['PAYSTACK_SECRET_KEY', env.PAYSTACK_SECRET_KEY],
    ['PAYSTACK_CALLBACK_SECRET', env.PAYSTACK_CALLBACK_SECRET],
  ]);
  if (paystackMissing.length === 0) {
    const testKey = env.PAYSTACK_SECRET_KEY!.startsWith('sk_test_');
    if (mode === 'production' && testKey) warnings.push('Paystack has a test key (sk_test_…) while payments are live. Guests can’t really pay with it.');
    if (mode === 'sandbox' && env.PAYSTACK_SECRET_KEY!.startsWith('sk_live_')) warnings.push('Paystack has a live key (sk_live_…) while payments are in sandbox mode. Real money will move.');
    paystack = {
      baseUrl: (env.PAYSTACK_BASE_URL ?? PAYSTACK_API_URL).replace(/\/+$/, ''),
      secretKey: env.PAYSTACK_SECRET_KEY!,
      testKey,
      channels: (env.PAYSTACK_CHANNELS ?? '')
        .split(/[\s,]+/)
        .map((c) => c.toLowerCase())
        .filter((c): c is string => (PAYSTACK_CHANNELS as readonly string[]).includes(c)),
      callbackIps: (env.PAYSTACK_CALLBACK_IPS ?? '').split(/[\s,]+/).filter(Boolean),
      callbackSecret: env.PAYSTACK_CALLBACK_SECRET!,
      notifyUrl: callback('paystack', env.PAYSTACK_CALLBACK_SECRET!),
    };
  } else if (env.PAYSTACK_SECRET_KEY) {
    warnings.push(`Paystack is off. Missing: ${paystackMissing.join(', ')}.`);
  }

  return {
    mode,
    siteUrl,
    dataDir: env.DATA_DIR ?? './data',
    adminToken: env.ADMIN_TOKEN,
    mpesa,
    pesapal,
    usdRate,
    ipos,
    unipesa,
    crypto,
    paystack,
    warnings,
  };
}

/** True when Pesapal can actually take payments (credentials and IPN id). */
export function pesapalReady(config: PaymentConfig): boolean {
  return Boolean(config.pesapal?.ipnId);
}

/* ---------- Email ---------- */

export interface EmailConfig {
  host: string;
  port: number;
  secure: boolean;
  user: string | undefined;
  pass: string | undefined;
  from: string;
  /** Where payment alerts go. */
  notifyTo: string | undefined;
}

const emailSchema = z.object({
  SMTP_HOST: blank,
  SMTP_PORT: blank,
  SMTP_SECURE: blank,
  SMTP_USER: blank,
  SMTP_PASS: blank,
  EMAIL_FROM: blank,
  NOTIFY_EMAIL: blank,
});

/** Email is on when there is a mail server and a "from" address. */
export function loadEmailConfig(raw: Record<string, string | undefined>): EmailConfig | undefined {
  const env = emailSchema.parse(raw);
  if (!env.SMTP_HOST || !env.EMAIL_FROM) return undefined;
  const port = Number(env.SMTP_PORT ?? 587);
  const secure = env.SMTP_SECURE ? ['yes', 'true', '1'].includes(env.SMTP_SECURE.toLowerCase()) : port === 465;
  return {
    host: env.SMTP_HOST,
    port: Number.isInteger(port) && port > 0 ? port : 587,
    secure,
    user: env.SMTP_USER,
    pass: env.SMTP_PASS,
    from: env.EMAIL_FROM,
    notifyTo: env.NOTIFY_EMAIL,
  };
}

/* ---------- Booking ---------- */

export interface BookingConfig {
  /** Share of the total paid as a deposit (0 = no deposits, guests always pay in full). */
  depositPercent: number;
  /** How many days ahead the earliest travel date must be. */
  leadDays: number;
}

export function loadBookingConfig(raw: Record<string, string | undefined>): BookingConfig {
  const pct = Number(raw['DEPOSIT_PERCENT'] ?? 30);
  const lead = Number(raw['BOOKING_LEAD_DAYS'] ?? 3);
  return {
    depositPercent: Number.isInteger(pct) && pct >= 0 && pct <= 100 ? pct : 30,
    leadDays: Number.isInteger(lead) && lead >= 0 && lead <= 365 ? lead : 3,
  };
}
