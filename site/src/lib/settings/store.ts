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
    callbackSecret?: string;
  };
  booking?: {
    depositPercent?: string;
    leadDays?: string;
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

export type Section = 'mpesa' | 'pesapal' | 'email' | 'booking';

/** Fields that are never shown back in the browser. Leaving them blank on save keeps the saved value. */
export const SECRET_FIELDS: Record<Section, readonly string[]> = {
  mpesa: ['consumerSecret', 'passkey', 'securityCredential', 'callbackSecret'],
  pesapal: ['consumerSecret', 'callbackSecret'],
  email: ['pass'],
  booking: [],
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
    callbackSecret: 'PESAPAL_CALLBACK_SECRET',
  },
  booking: {
    depositPercent: 'DEPOSIT_PERCENT',
    leadDays: 'BOOKING_LEAD_DAYS',
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
  for (const section of ['mpesa', 'pesapal', 'email', 'booking'] as const) {
    const values = (s[section] ?? {}) as Record<string, unknown>;
    for (const [field, key] of Object.entries(ENV_MAP[section])) put(key, values[field]);
  }
  return out;
}

/** Settings from the admin screen win; the environment fills any gaps. */
export function mergeEnv(env: Record<string, string | undefined>, s: Settings): Record<string, string | undefined> {
  return { ...env, ...settingsToEnv(s) };
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
      if (field === 'callbackSecret' || field === 'ipnId') continue;
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
    if ((section === 'mpesa' || section === 'pesapal') && !current['callbackSecret']) {
      const envKey = (ENV_MAP[section] as Record<string, string>)['callbackSecret']!;
      if (!env[envKey]?.trim()) current['callbackSecret'] = newSecret();
    }
    // A new Pesapal account or environment needs its IPN registered again.
    if (section === 'pesapal') {
      const old = JSON.parse(before) as Record<string, string | undefined>;
      if (old['consumerKey'] !== current['consumerKey'] || (old['env'] ?? '') !== (current['env'] ?? '')) delete current['ipnId'];
    }
    (s as Record<string, unknown>)[section] = current;
    return this.write(s);
  }

  setPesapalIpnId(ipnId: string): Settings {
    const s = this.read();
    s.pesapal = { ...(s.pesapal ?? {}), ipnId };
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
