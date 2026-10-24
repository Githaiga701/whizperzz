import { loadBookingConfig, loadEmailConfig, loadPaymentConfig, type BookingConfig, type EmailConfig } from '@/lib/payments/config';
import { createDaraja } from '@/lib/payments/mpesa';
import { createPesapal } from '@/lib/payments/pesapal';
import { PaymentError, isAdmin, type LogFn, type PaymentDeps } from '@/lib/payments/service';
import { QuoteStore, filePersistence } from '@/lib/payments/store';
import { SettingsStore, mergeEnv } from '@/lib/settings/store';
import { UserStore } from '@/lib/admin/users';
import { loadSessionKey } from '@/lib/admin/session';
import { createMailer, type Mailer } from '@/lib/email/mailer';
import { createNotifier } from '@/lib/email/notifier';

/** One JSON line per event, without secrets. Most hosts collect stdout as logs. */
export const log: LogFn = (level, message, data) => {
  const line = JSON.stringify({ time: new Date().toISOString(), level, message, ...data });
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);
};

export interface Runtime {
  dataDir: string;
  /** Environment after applying settings saved in the admin screen. */
  env: Record<string, string | undefined>;
  deps: PaymentDeps;
  email: EmailConfig | undefined;
  mailer: Mailer | undefined;
  booking: BookingConfig;
  settings: SettingsStore;
  users: UserStore;
  sessionKey: Buffer;
}

// These live for the whole process: they hold files and queues that must not be duplicated.
let base: { dataDir: string; store: QuoteStore; settings: SettingsStore; users: UserStore; sessionKey: Buffer } | undefined;
let runtime: Runtime | undefined;
let override: PaymentDeps | undefined;

function getBase() {
  if (!base) {
    const dataDir = process.env['DATA_DIR']?.trim() || './data';
    base = {
      dataDir,
      store: new QuoteStore(filePersistence(dataDir)),
      settings: new SettingsStore(dataDir),
      users: new UserStore(dataDir),
      sessionKey: loadSessionKey(dataDir),
    };
  }
  return base;
}

export function getRuntime(): Runtime {
  if (runtime) return runtime;
  const b = getBase();
  const env = { ...mergeEnv(process.env, b.settings.read()), DATA_DIR: b.dataDir };
  const config = loadPaymentConfig(env);
  config.warnings.forEach((w) => log('warn', w));
  const email = loadEmailConfig(env);
  const mailer = email ? createMailer(email) : undefined;
  const deps: PaymentDeps = {
    config,
    store: b.store,
    daraja: config.mpesa ? createDaraja(config.mpesa) : undefined,
    pesapal: config.pesapal ? createPesapal(config.pesapal) : undefined,
    now: () => new Date(),
    log,
    notify: async () => undefined,
  };
  deps.notify = createNotifier({ store: b.store, config, email, mailer, log });
  runtime = { dataDir: b.dataDir, env, deps, email, mailer, booking: loadBookingConfig(env), settings: b.settings, users: b.users, sessionKey: b.sessionKey };
  return runtime;
}

/** The data folder, for other server modules (packages, uploads). */
export function dataDir(): string {
  return getBase().dataDir;
}

export function getPaymentDeps(): PaymentDeps {
  return override ?? getRuntime().deps;
}

/** Call after saving settings so the next request uses the new keys. */
export function reloadRuntime(): void {
  runtime = undefined;
}

/** Lets tests swap in fake providers and an in-memory store. */
export function setPaymentDeps(next: PaymentDeps | undefined): void {
  override = next;
}

/* ---------- Small HTTP helpers for the API routes ---------- */

export function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers },
  });
}

const MAX_BODY = 32 * 1024;

export async function readJson(request: Request): Promise<Record<string, unknown>> {
  const raw = await request.text();
  if (raw.length > MAX_BODY) throw new PaymentError(413, 'too_large', 'Request is too large.');
  if (raw.trim() === '') return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
  } catch {
    /* fall through */
  }
  throw new PaymentError(400, 'invalid_json', 'Request body must be a JSON object.');
}

/** Turns known errors into friendly JSON and hides everything else behind a generic 500. */
export async function handle(fn: () => Promise<Response>): Promise<Response> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof PaymentError) return json(err.status, { error: err.code, message: err.message });
    log('error', 'Unhandled API error', { error: (err as Error).message, stack: (err as Error).stack });
    return json(500, { error: 'server_error', message: 'Something went wrong on our side. Please try again, or contact us.' });
  }
}

/* ---------- A simple per-IP rate limit for public endpoints ---------- */

const hits = new Map<string, { count: number; resetAt: number }>();
/** Raise every limit at once, e.g. for automated tests that all come from one address. */
const multiplier = Math.max(1, Number(process.env['RATE_LIMIT_MULTIPLIER'] ?? 1) || 1);

export function rateLimit(key: string, baseLimit: number, windowMs: number, now = Date.now()): void {
  const limit = baseLimit * multiplier;
  const entry = hits.get(key);
  if (!entry || entry.resetAt <= now) {
    hits.set(key, { count: 1, resetAt: now + windowMs });
    if (hits.size > 10_000) {
      for (const [k, v] of hits) if (v.resetAt <= now) hits.delete(k);
    }
    return;
  }
  entry.count++;
  if (entry.count > limit) throw new PaymentError(429, 'rate_limited', 'Too many requests. Please wait a minute and try again.');
}

export function resetRateLimits(): void {
  hits.clear();
}

/** Logged in to the admin screen, or using the ADMIN_TOKEN (for scripts). Returns who it is. */
export function requireAdmin(request: Request, locals: App.Locals): string {
  if (locals.admin) return locals.admin;
  if (isAdmin(getPaymentDeps().config, request.headers.get('authorization'))) return 'api';
  throw new PaymentError(401, 'unauthorized', 'Log in to the admin, or send the admin token.');
}
