import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AdminError, UserStore, hashPassword, passwordVersion, validateUsername, verifyPassword } from '@/lib/admin/users';
import {
  clearLoginFailures,
  createSessionValue,
  loadSessionKey,
  loginLockedFor,
  readSessionValue,
  recordLoginFailure,
} from '@/lib/admin/session';
import { isLocalRequest, safeNext, sameOrigin } from '@/lib/admin/web';
import { SettingsStore, fieldSource, mergeEnv, settingsToEnv } from '@/lib/settings/store';
import { loadEmailConfig, loadPaymentConfig } from '@/lib/payments/config';

const dirs: string[] = [];
async function tempDir() {
  const d = await mkdtemp(join(tmpdir(), 'wz-admin-'));
  dirs.push(d);
  return d;
}
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

describe('passwords', () => {
  it('hashes with a fresh salt and verifies', () => {
    const a = hashPassword('correct horse');
    const b = hashPassword('correct horse');
    expect(a).not.toBe(b);
    expect(a.startsWith('scrypt$16384$8$1$')).toBe(true);
    expect(verifyPassword('correct horse', a)).toBe(true);
    expect(verifyPassword('correct hors', a)).toBe(false);
    expect(verifyPassword('x', 'not-a-hash')).toBe(false);
  });

  it.each(['ab', 'has space', 'UPPER!', 'x'.repeat(33)])('rejects username %j', (u) => {
    expect(() => validateUsername(u)).toThrow(AdminError);
  });
  it('lower-cases usernames', () => {
    expect(validateUsername('  Spence ')).toBe('spence');
  });
});

describe('UserStore', () => {
  it('creates, verifies, lists and saves users to disk', async () => {
    const dir = await tempDir();
    const users = new UserStore(dir);
    expect(users.hasUsers()).toBe(false);
    users.create('Spence', 'long-enough-1');
    expect(users.hasUsers()).toBe(true);
    expect(users.verify('spence', 'long-enough-1')?.username).toBe('spence');
    expect(users.verify('spence', 'wrong-password')).toBeUndefined();
    expect(users.verify('nobody', 'long-enough-1')).toBeUndefined();
    expect(new UserStore(dir).list().map((u) => u.username)).toEqual(['spence']);
    const raw = await readFile(join(dir, 'users.json'), 'utf8');
    expect(raw).not.toContain('long-enough-1');
  });

  it('refuses short passwords and duplicate names', async () => {
    const users = new UserStore(await tempDir());
    expect(() => users.create('spence', 'short')).toThrow(/10 characters/);
    users.create('spence', 'long-enough-1');
    expect(() => users.create('SPENCE', 'long-enough-2')).toThrow(/already a user/);
  });

  it('changes a password only with the current one, and that changes the session version', async () => {
    const users = new UserStore(await tempDir());
    const before = passwordVersion(users.create('spence', 'long-enough-1'));
    expect(() => users.changePassword('spence', 'wrong', 'new-password-1')).toThrow(/current password is wrong/);
    users.changePassword('spence', 'long-enough-1', 'new-password-1');
    expect(users.verify('spence', 'new-password-1')).toBeDefined();
    expect(passwordVersion(users.get('spence')!)).not.toBe(before);
  });

  it('never removes yourself or the last admin', async () => {
    const users = new UserStore(await tempDir());
    users.create('spence', 'long-enough-1');
    expect(() => users.remove('spence', 'spence')).toThrow(/yourself/);
    expect(() => users.remove('spence', 'mary')).toThrow(/at least one admin/);
    users.create('mary', 'long-enough-2');
    users.remove('mary', 'spence');
    expect(users.list()).toHaveLength(1);
  });

  it('resets a password without the old one (recovery)', async () => {
    const users = new UserStore(await tempDir());
    users.create('spence', 'long-enough-1');
    users.resetPassword('spence', 'brand-new-pass');
    expect(users.verify('spence', 'brand-new-pass')).toBeDefined();
    expect(() => users.resetPassword('ghost', 'brand-new-pass')).toThrow(/no user/);
  });
});

describe('sessions', () => {
  it('creates a key once and reuses it', async () => {
    const dir = await tempDir();
    const a = loadSessionKey(dir);
    expect(a).toHaveLength(32);
    expect(loadSessionKey(dir).equals(a)).toBe(true);
  });

  it('reads back a valid session and rejects edits, other keys and expiry', async () => {
    const key = loadSessionKey(await tempDir());
    const other = loadSessionKey(await tempDir());
    const v = createSessionValue(key, 'spence', 'pv1', 1_000);
    expect(readSessionValue(key, v, 2_000)).toMatchObject({ username: 'spence', passwordVersion: 'pv1' });
    expect(readSessionValue(other, v, 2_000)).toBeUndefined();
    const [u, pv, exp, mac] = v.split('.');
    expect(readSessionValue(key, [Buffer.from('mary').toString('base64url'), pv, exp, mac].join('.'), 2_000)).toBeUndefined();
    expect(readSessionValue(key, [u, pv, String(Number(exp) + 999999), mac].join('.'), 2_000)).toBeUndefined();
    expect(readSessionValue(key, v, 1_000 + 13 * 3600_000)).toBeUndefined();
    expect(readSessionValue(key, 'garbage', 2_000)).toBeUndefined();
    expect(readSessionValue(key, undefined)).toBeUndefined();
  });

  it('locks a login after five failures for fifteen minutes', () => {
    const k = `test-${Math.random()}`;
    for (let i = 0; i < 4; i++) recordLoginFailure(k, 0);
    expect(loginLockedFor(k, 0)).toBe(0);
    recordLoginFailure(k, 0);
    expect(loginLockedFor(k, 60_000)).toBe(14);
    expect(loginLockedFor(k, 16 * 60_000)).toBe(0);
    recordLoginFailure(k, 0);
    clearLoginFailures(k);
    expect(loginLockedFor(k, 0)).toBe(0);
  });
});

describe('request checks', () => {
  const req = (headers: Record<string, string>) => new Request('http://127.0.0.1:4321/admin/', { method: 'POST', headers });

  it('accepts forms from the same site, including behind a proxy', () => {
    expect(sameOrigin(req({ host: 'whizperz.co.ke', origin: 'https://whizperz.co.ke' }))).toBe(true);
    expect(sameOrigin(req({ host: 'localhost:4321', 'x-forwarded-host': 'whizperz.co.ke', origin: 'https://whizperz.co.ke' }))).toBe(true);
    expect(sameOrigin(req({ host: 'whizperz.co.ke', referer: 'https://whizperz.co.ke/admin/settings/' }))).toBe(true);
  });
  it('refuses forms from other sites or with no origin', () => {
    expect(sameOrigin(req({ host: 'whizperz.co.ke', origin: 'https://evil.example' }))).toBe(false);
    expect(sameOrigin(req({ host: 'whizperz.co.ke' }))).toBe(false);
    expect(sameOrigin(req({ host: 'whizperz.co.ke', origin: 'null' }))).toBe(false);
  });
  it('only treats direct local connections as local', () => {
    expect(isLocalRequest(req({}), '127.0.0.1')).toBe(true);
    expect(isLocalRequest(req({}), '::1')).toBe(true);
    expect(isLocalRequest(req({ 'x-forwarded-for': '41.90.1.1' }), '127.0.0.1')).toBe(false);
    expect(isLocalRequest(req({}), '41.90.1.1')).toBe(false);
  });
  it.each([
    ['/admin/quotes/WZ-ABCDEF/', '/admin/quotes/WZ-ABCDEF/'],
    ['/admin', '/admin'],
    ['https://evil.example', '/admin/'],
    ['//evil.example/admin', '/admin/'],
    ['/admin/../etc', '/admin/'],
    [null, '/admin/'],
  ])('safeNext(%j) → %s', (input, out) => {
    expect(safeNext(input)).toBe(out);
  });
});

describe('SettingsStore', () => {
  it('maps saved settings to environment names and wins over the environment', async () => {
    const s = new SettingsStore(await tempDir());
    s.saveGeneral({ siteUrl: 'https://whizperz.co.ke/', paymentsMode: 'production' });
    s.saveSection('mpesa', { consumerKey: 'ck', consumerSecret: 'cs', shortcode: '174379', passkey: 'pk', env: 'sandbox' }, {});
    const env = mergeEnv({ SITE_URL: 'http://old', MPESA_CONSUMER_KEY: 'from-env', PESAPAL_CONSUMER_KEY: 'pp' }, s.read());
    expect(env).toMatchObject({ SITE_URL: 'https://whizperz.co.ke', PAYMENTS_MODE: 'production', MPESA_CONSUMER_KEY: 'ck', MPESA_ENV: 'sandbox', PESAPAL_CONSUMER_KEY: 'pp' });
    expect(env['MPESA_CALLBACK_SECRET']).toMatch(/^[\w-]{20,}$/);
    const cfg = loadPaymentConfig(env);
    expect(cfg.mpesa?.baseUrl).toContain('sandbox');
    expect(cfg.siteUrl).toBe('https://whizperz.co.ke');
  });

  it('reloads saved settings after a restart', async () => {
    const dir = await tempDir();
    new SettingsStore(dir).saveSection('email', { host: 'smtp.x', pass: 'secret', from: 'a@b.co' });
    expect(new SettingsStore(dir).read().email).toMatchObject({ host: 'smtp.x', pass: 'secret', from: 'a@b.co' });
  });

  it('keeps saved secrets when the box is left blank, and clears normal fields', async () => {
    const s = new SettingsStore(await tempDir());
    s.saveSection('email', { host: 'smtp.x', pass: 'secret', from: 'a@b.co' });
    s.saveSection('email', { host: '', pass: '', from: 'c@d.co' });
    const e = s.read().email!;
    expect(e.pass).toBe('secret');
    expect(e.host).toBeUndefined();
    expect(e.from).toBe('c@d.co');
  });

  it('keeps the callback secret stable and uses the environment’s one if set', async () => {
    const s = new SettingsStore(await tempDir());
    s.saveSection('mpesa', { consumerKey: 'a' }, {});
    const first = s.read().mpesa!.callbackSecret;
    s.saveSection('mpesa', { consumerKey: 'b' }, {});
    expect(s.read().mpesa!.callbackSecret).toBe(first);
    const t = new SettingsStore(await tempDir());
    t.saveSection('pesapal', { consumerKey: 'a' }, { PESAPAL_CALLBACK_SECRET: 'from-host' });
    expect(t.read().pesapal!.callbackSecret).toBeUndefined();
  });

  it('forgets the Pesapal IPN when the account or environment changes', async () => {
    const s = new SettingsStore(await tempDir());
    s.saveSection('pesapal', { consumerKey: 'a', env: 'sandbox' }, {});
    s.setPesapalIpnId('ipn-1');
    s.saveSection('pesapal', { consumerKey: 'a', env: 'sandbox' }, {});
    expect(s.read().pesapal!.ipnId).toBe('ipn-1');
    s.saveSection('pesapal', { consumerKey: 'a', env: 'production' }, {});
    expect(s.read().pesapal!.ipnId).toBeUndefined();
  });

  it.each([
    ['email', { port: 'abc' }, /port/],
    ['email', { secure: 'maybe' }, /secure/],
    ['email', { notifyTo: 'not-an-email' }, /alerts address/],
    ['mpesa', { env: 'live!' }, /Environment/],
    ['mpesa', { shortcode: '12' }, /shortcode/],
  ] as const)('rejects bad %s values %j', async (section, input, msg) => {
    const s = new SettingsStore(await tempDir());
    expect(() => s.saveSection(section, input as Record<string, string>, {})).toThrow(msg);
  });

  it('rejects a site address that isn’t a web address', async () => {
    const s = new SettingsStore(await tempDir());
    expect(() => s.saveGeneral({ siteUrl: 'whizperz.co.ke' })).toThrow(/https/);
  });

  it('reports where each value comes from', async () => {
    const s = new SettingsStore(await tempDir());
    s.saveSection('email', { host: 'smtp.x' });
    const settings = s.read();
    expect(fieldSource(settings, {}, 'email', 'host')).toBe('settings');
    expect(fieldSource(settings, { SMTP_USER: 'u' }, 'email', 'user')).toBe('environment');
    expect(fieldSource(settings, {}, 'email', 'pass')).toBe('none');
  });

  it('writes nothing blank into the environment', () => {
    expect(settingsToEnv({ mpesa: { consumerKey: '  ' }, email: { host: 'h' } })).toEqual({ SMTP_HOST: 'h' });
  });
});

describe('loadEmailConfig', () => {
  it('is off without a host and from address', () => {
    expect(loadEmailConfig({ SMTP_HOST: 'h' })).toBeUndefined();
    expect(loadEmailConfig({ EMAIL_FROM: 'a@b.co' })).toBeUndefined();
  });
  it('defaults to port 587 with STARTTLS, and SSL on 465', () => {
    expect(loadEmailConfig({ SMTP_HOST: 'h', EMAIL_FROM: 'a@b.co' })).toMatchObject({ port: 587, secure: false });
    expect(loadEmailConfig({ SMTP_HOST: 'h', EMAIL_FROM: 'a@b.co', SMTP_PORT: '465' })).toMatchObject({ port: 465, secure: true });
    expect(loadEmailConfig({ SMTP_HOST: 'h', EMAIL_FROM: 'a@b.co', SMTP_SECURE: 'yes', NOTIFY_EMAIL: 't@b.co' })).toMatchObject({ secure: true, notifyTo: 't@b.co' });
  });
});
