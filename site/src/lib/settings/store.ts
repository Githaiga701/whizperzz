import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { readJsonSync, writeJsonSync } from '@/lib/files';

/**
 * Settings entered in the admin screen. Saved in DATA_DIR/settings.json.
 * Anything set here takes priority over the same setting in .env or the host's environment variables.
 */
export interface Settings {
  siteUrl?: string;
  paymentsMode?: 'sandbox' | 'production';
  mpesa?: {
    env?: 'sandbox' | 'production';
    consumerKey?: string;
    consumerSecret?: string;
    shortcode?: string;
    passkey?: string;
    tillNumber?: string;
    initiatorName?: string;
    securityCredential?: string;
    callbackSecret?: string;
  };
  pesapal?: {
    env?: 'sandbox' | 'production';
    consumerKey?: string;
    consumerSecret?: string;
    ipnId?: string;
    /** The address ipnId was registered for. */
    ipnUrl?: string;
    callbackIps?: string;
    callbackSecret?: string;
  };
  booking?: {
    depositPercent?: string;
    leadDays?: string;
    usdRate?: string;
  };
  ipos?: {
    env?: 'sandbox' | 'production';
    tpn?: string;
    authToken?: string;
    apiKey?: string;
    secretKey?: string;
    paymentUrl?: string;
    apiUrl?: string;
    authUrl?: string;
    callbackSecret?: string;
  };
  unipesa?: {
    merchantId?: string;
    publicId?: string;
    payType?: string;
    currency?: string;
    callbackIps?: string;
    secretKey?: string;
    providerId?: string;
    country?: string;
    hppUrl?: string;
    statusUrl?: string;
    callbackSecret?: string;
  };
  crypto?: {
    env?: 'sandbox' | 'production';
    apiKey?: string;
    ipnSecret?: string;
    callbackSecret?: string;
  };
  email?: {
    host?: string;
    port?: string;
    secure?: 'yes' | 'no';
    user?: string;
    pass?: string;
    from?: string;
    notifyTo?: string;
  };
}

export type Section = 'mpesa' | 'pesapal' | 'email' | 'booking' | 'ipos' | 'unipesa' | 'crypto';

/** Sections whose notify address contains a secret we create. */
const CALLBACK_SECTIONS: readonly Section[] = ['mpesa', 'pesapal', 'ipos', 'unipesa', 'crypto'];

/** Fields that are never shown back in the browser. Leaving them blank on save keeps the saved value. */
export const SECRET_FIELDS: Record<Section, readonly string[]> = {
  mpesa: ['consumerSecret', 'passkey', 'securityCredential', 'callbackSecret'],
  pesapal: ['consumerSecret', 'callbackSecret'],
  email: ['pass'],
  booking: [],
  ipos: ['authToken', 'secretKey', 'callbackSecret'],
  unipesa: ['secretKey', 'callbackSecret'],
  crypto: ['apiKey', 'ipnSecret', 'callbackSecret'],
};

/** How each setting maps to an environment variable. */
export const ENV_MAP = {
  siteUrl: 'SITE_URL',
  paymentsMode: 'PAYMENTS_MODE',
  mpesa: {
    env: 'MPESA_ENV',
    consumerKey: 'MPESA_CONSUMER_KEY',
    consumerSecret: 'MPESA_CONSUMER_SECRET',
    shortcode: 'MPESA_SHORTCODE',
    passkey: 'MPESA_PASSKEY',
    tillNumber: 'MPESA_TILL_NUMBER',
    initiatorName: 'MPESA_INITIATOR_NAME',
    securityCredential: 'MPESA_SECURITY_CREDENTIAL',
    callbackSecret: 'MPESA_CALLBACK_SECRET',
  },
  pesapal: {
    env: 'PESAPAL_ENV',
    consumerKey: 'PESAPAL_CONSUMER_KEY',
    consumerSecret: 'PESAPAL_CONSUMER_SECRET',
    ipnId: 'PESAPAL_IPN_ID',
    ipnUrl: 'PESAPAL_IPN_URL',
    callbackIps: 'PESAPAL_CALLBACK_IPS',
    callbackSecret: 'PESAPAL_CALLBACK_SECRET',
  },
  booking: {
    depositPercent: 'DEPOSIT_PERCENT',
    leadDays: 'BOOKING_LEAD_DAYS',
    usdRate: 'USD_KES_RATE',
  },
  ipos: {
    env: 'IPOS_ENV',
    tpn: 'IPOS_TPN',
    authToken: 'IPOS_AUTH_TOKEN',
    apiKey: 'IPOS_API_KEY',
    secretKey: 'IPOS_SECRET_KEY',
    paymentUrl: 'IPOS_PAYMENT_URL',
    apiUrl: 'IPOS_API_URL',
    authUrl: 'IPOS_AUTH_URL',
    callbackSecret: 'IPOS_CALLBACK_SECRET',
  },
  unipesa: {
    merchantId: 'UNIPESA_MERCHANT_ID',
    publicId: 'UNIPESA_PUBLIC_ID',
    payType: 'UNIPESA_PAY_TYPE',
    currency: 'UNIPESA_CURRENCY',
    callbackIps: 'UNIPESA_CALLBACK_IPS',
    secretKey: 'UNIPESA_SECRET_KEY',
    providerId: 'UNIPESA_PROVIDER_ID',
    country: 'UNIPESA_COUNTRY',
    hppUrl: 'UNIPESA_HPP_URL',
    statusUrl: 'UNIPESA_STATUS_URL',
    callbackSecret: 'UNIPESA_CALLBACK_SECRET',
  },
  crypto: {
    env: 'NOWPAYMENTS_ENV',
    apiKey: 'NOWPAYMENTS_API_KEY',
    ipnSecret: 'NOWPAYMENTS_IPN_SECRET',
    callbackSecret: 'NOWPAYMENTS_CALLBACK_SECRET',
  },
  email: {
    host: 'SMTP_HOST',
    port: 'SMTP_PORT',
    secure: 'SMTP_SECURE',
    user: 'SMTP_USER',
    pass: 'SMTP_PASS',
    from: 'EMAIL_FROM',
    notifyTo: 'NOTIFY_EMAIL',
  },
} as const;

export function settingsToEnv(s: Settings): Record<string, string> {
  const out: Record<string, string> = {};
  const put = (key: string, v: unknown) => {
    if (typeof v === 'string' && v.trim() !== '') out[key] = v.trim();
  };
  put(ENV_MAP.siteUrl, s.siteUrl);
  put(ENV_MAP.paymentsMode, s.paymentsMode);
  for (const section of ['mpesa', 'pesapal', 'email', 'booking', 'ipos', 'unipesa', 'crypto'] as const) {
    const values = (s[section] ?? {}) as Record<string, unknown>;
    for (const [field, key] of Object.entries(ENV_MAP[section])) put(key, values[field]);
  }
  return out;
}

/** Settings from the admin screen win; the environment fills any gaps. */
export function mergeEnv(env: Record<string, string | undefined>, s: Settings): Record<string, string | undefined> {
  const merged: Record<string, string | undefined> = { ...env, ...settingsToEnv(s) };
  // Pesapal keys saved here belong with an IPN registered here; never pair them with one from the environment.
  if (s.pesapal?.consumerKey && !s.pesapal.ipnId) {
    delete merged['PESAPAL_IPN_ID'];
    delete merged['PESAPAL_IPN_URL'];
  }
  return merged;
}

export function newSecret(): string {
  return randomBytes(24).toString('base64url');
}

function validateField(field: string, v: string): void {
  if (field === 'env' && v !== 'sandbox' && v !== 'production') throw new Error('Environment must be sandbox or live.');
  if (field === 'port' && !/^\d{1,5}$/.test(v)) throw new Error('The port is a number, usually 587 or 465.');
  if (field === 'secure' && v !== 'yes' && v !== 'no') throw new Error('Choose a secure connection option.');
  if ((field === 'shortcode' || field === 'tillNumber') && !/^\d{5,7}$/.test(v)) throw new Error(`The ${field === 'shortcode' ? 'shortcode' : 'till number'} should be 5 to 7 digits.`);
  if (field === 'notifyTo' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) throw new Error('The alerts address doesn’t look like an email address.');
  if (field === 'depositPercent' && !(/^\d{1,3}$/.test(v) && Number(v) <= 100)) throw new Error('The deposit is a percentage from 0 to 100.');
  if (field === 'leadDays' && !(/^\d{1,3}$/.test(v) && Number(v) <= 365)) throw new Error('Days ahead must be a number from 0 to 365.');
  if (field === 'usdRate' && !(/^\d{1,4}(\.\d{1,4})?$/.test(v) && Number(v) >= 1)) throw new Error('The exchange rate is shillings per US dollar, like 129.50.');
  if (field === 'tpn' && !/^[A-Za-z0-9]{6,20}$/.test(v)) throw new Error('The TPN is the 10 to 12 digit terminal number from iPOSpays.');
  if (field === 'providerId' && !/^\d{1,6}$/.test(v)) throw new Error('The Unipesa provider ID is a number, like 12.');
  if (field === 'country' && !/^[A-Za-z]{2}$/.test(v)) throw new Error('Use the two-letter country code, like KE.');
  if (field === 'merchantId' && !/^[\w-]{4,64}$/.test(v)) throw new Error('The merchant ID can only contain letters, numbers, dashes and underscores.');
  if (field === 'publicId' && !/^[\w-]{4,64}$/.test(v)) throw new Error('The public ID can only contain letters, numbers, dashes and underscores.');
  if (field === 'payType' && !/^[a-z_]{2,20}$/i.test(v)) throw new Error('The payment type is a single word, like card.');
  if (field === 'currency' && !/^[A-Za-z]{3}$/.test(v)) throw new Error('Use the three-letter currency code, like KES.');
  if (field === 'callbackIps' && !v.split(/[\s,]+/).filter(Boolean).every((ip) => /^(\d{1,3}(\.\d{1,3}){3}(\/\d{1,2})?|[0-9a-f:]+)$/i.test(ip))) {
    throw new Error('List IP addresses separated by commas, like 41.90.1.10, 41.90.2.0/24.');
  }
  if (['paymentUrl', 'apiUrl', 'authUrl', 'hppUrl', 'statusUrl'].includes(field) && !/^https:\/\/[^\s]+$/.test(v)) throw new Error('Addresses must start with https://.');
  if (v.length > 4000) throw new Error('That value is too long.');
}

export class SettingsStore {
  private cache: Settings | undefined;
  readonly file: string;

  constructor(dataDir: string) {
    this.file = join(dataDir, 'settings.json');
  }

  read(): Settings {
    if (!this.cache) this.cache = readJsonSync<Settings>(this.file) ?? {};
    return structuredClone(this.cache);
  }

  private write(next: Settings): Settings {
    writeJsonSync(this.file, next, { private: true });
    this.cache = next;
    return structuredClone(next);
  }

  saveGeneral(input: { siteUrl?: string | undefined; paymentsMode?: string | undefined }): Settings {
    const s = this.read();
    const url = (input.siteUrl ?? '').trim().replace(/\/+$/, '');
    if (url && !/^https?:\/\/[^\s/]+/.test(url)) throw new Error('Site address must start with https:// (or http:// for testing on your computer).');
    if (url) s.siteUrl = url;
    else delete s.siteUrl;
    if (input.paymentsMode === 'sandbox' || input.paymentsMode === 'production') s.paymentsMode = input.paymentsMode;
    return this.write(s);
  }

  /**
   * Saves one section. Secret fields left blank keep their saved value;
   * other fields left blank are cleared. Callback secrets are created automatically.
   */
  saveSection(section: Section, input: Record<string, string | undefined>, env: Record<string, string | undefined> = process.env): Settings {
    const s = this.read();
    const current = { ...((s[section] ?? {}) as Record<string, string | undefined>) };
    const secrets = SECRET_FIELDS[section];
    const allowed = Object.keys(ENV_MAP[section]);
    const before = JSON.stringify(current);

    for (const field of allowed) {
      if (field === 'callbackSecret' || field === 'ipnId' || field === 'ipnUrl') continue;
      if (!(field in input)) continue;
      const v = (input[field] ?? '').trim();
      if (v !== '') validateField(field, v);
      if (secrets.includes(field)) {
        if (v !== '') current[field] = v;
      } else if (v === '') {
        delete current[field];
      } else {
        current[field] = v;
      }
    }

    // Create a callback secret if there isn't one, unless the host's environment already provides it.
    if (CALLBACK_SECTIONS.includes(section) && !current['callbackSecret']) {
      const envKey = (ENV_MAP[section] as Record<string, string>)['callbackSecret']!;
      if (!env[envKey]?.trim()) current['callbackSecret'] = newSecret();
    }
    // A new Pesapal account or environment needs its IPN registered again.
    if (section === 'pesapal') {
      const old = JSON.parse(before) as Record<string, string | undefined>;
      if (old['consumerKey'] !== current['consumerKey'] || (old['env'] ?? '') !== (current['env'] ?? '')) {
        delete current['ipnId'];
        delete current['ipnUrl'];
      }
    }
    (s as Record<string, unknown>)[section] = current;
    return this.write(s);
  }

  setPesapalIpnId(ipnId: string, ipnUrl?: string): Settings {
    const s = this.read();
    s.pesapal = { ...(s.pesapal ?? {}), ipnId, ...(ipnUrl ? { ipnUrl } : {}) };
    return this.write(s);
  }

  /** Clears one saved secret, e.g. to fall back to the environment variable. */
  clearField(section: Section, field: string): Settings {
    const s = this.read();
    const values = { ...((s[section] ?? {}) as Record<string, string>) };
    delete values[field];
    (s as Record<string, unknown>)[section] = values;
    return this.write(s);
  }
}

export type FieldSource = 'settings' | 'environment' | 'none';

/** Where a setting's value currently comes from, for the admin screen. Never includes secret values. */
export function fieldSource(s: Settings, env: Record<string, string | undefined>, section: Section, field: string): FieldSource {
  const v = ((s[section] ?? {}) as Record<string, string | undefined>)[field];
  if (v && v.trim() !== '') return 'settings';
  const key = (ENV_MAP[section] as Record<string, string>)[field];
  if (key && env[key] && env[key]!.trim() !== '') return 'environment';
  return 'none';
}
