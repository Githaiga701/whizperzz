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
  PESAPAL_BASE_URL: blank,
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
}

export interface PaymentConfig {
  mode: 'sandbox' | 'production';
  siteUrl: string;
  dataDir: string;
  adminToken: string | undefined;
  mpesa: MpesaConfig | undefined;
  pesapal: PesapalConfig | undefined;
  /** Human-readable reasons a provider is switched off. Logged once at start-up. */
  warnings: string[];
}

export const MPESA_URLS = {
  sandbox: 'https://sandbox.safaricom.co.ke',
  production: 'https://api.safaricom.co.ke',
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
  const siteUrl = (env.SITE_URL ?? 'http://localhost:4321').replace(/\/+$/, '');
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
    pesapal = {
      baseUrl: env.PESAPAL_BASE_URL ?? PESAPAL_URLS[env.PESAPAL_ENV ?? mode],
      consumerKey: env.PESAPAL_CONSUMER_KEY!,
      consumerSecret: env.PESAPAL_CONSUMER_SECRET!,
      ipnId: env.PESAPAL_IPN_ID,
      callbackSecret: secret,
      ipnUrl: `${siteUrl}/api/callbacks/pesapal/${encodeURIComponent(secret)}`,
    };
    if (!env.PESAPAL_IPN_ID) {
      warnings.push('Pesapal checkout is off until PESAPAL_IPN_ID is set. Run: npm run pesapal:register-ipn');
    }
  } else {
    warnings.push(`Pesapal is off. Missing: ${pesapalMissing.join(', ')}.`);
  }


  return {
    mode,
    siteUrl,
    dataDir: env.DATA_DIR ?? './data',
    adminToken: env.ADMIN_TOKEN,
    mpesa,
    pesapal,
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
