import { describe, expect, it } from 'vitest';
import { loadPaymentConfig, MPESA_URLS, PESAPAL_URLS, pesapalReady } from '@/lib/payments/config';
import { FULL_ENV } from '../helpers';

describe('loadPaymentConfig', () => {
  it('turns both providers on when every credential is present', () => {
    const c = loadPaymentConfig(FULL_ENV);
    expect(c.mpesa?.baseUrl).toBe(MPESA_URLS.sandbox);
    expect(c.pesapal?.baseUrl).toBe(PESAPAL_URLS.sandbox);
    expect(c.mpesa?.callbackUrl).toBe('https://whizperz.test/api/callbacks/mpesa/mpesa-cb-secret');
    expect(c.pesapal?.ipnUrl).toBe('https://whizperz.test/api/callbacks/pesapal/pesapal-cb-secret');
    expect(pesapalReady(c)).toBe(true);
    expect(c.warnings).toEqual([]);
  });

  it('runs with nothing configured and explains what is missing', () => {
    const c = loadPaymentConfig({});
    expect(c.mpesa).toBeUndefined();
    expect(c.pesapal).toBeUndefined();
    expect(c.siteUrl).toBe('http://localhost:4321');
    expect(c.dataDir).toBe('./data');
    expect(c.warnings.join(' ')).toMatch(/M-Pesa is off. Missing: MPESA_CONSUMER_KEY/);
  });

  it('treats blank values as missing', () => {
    const c = loadPaymentConfig({ ...FULL_ENV, MPESA_PASSKEY: '   ' });
    expect(c.mpesa).toBeUndefined();
    expect(c.warnings.join(' ')).toContain('MPESA_PASSKEY');
  });

  it('keeps Pesapal checkout off until the IPN id exists', () => {
    const c = loadPaymentConfig({ ...FULL_ENV, PESAPAL_IPN_ID: '' });
    expect(c.pesapal).toBeDefined();
    expect(pesapalReady(c)).toBe(false);
    expect(c.warnings.join(' ')).toMatch(/IPN is registered/);
  });

  it('forgets an IPN id registered for an older site address', () => {
    const ipnUrl = 'https://whizperz.test/api/callbacks/pesapal/pesapal-cb-secret';
    expect(loadPaymentConfig({ ...FULL_ENV, PESAPAL_IPN_URL: ipnUrl }).pesapal?.ipnId).toBe('ipn-123');
    const moved = loadPaymentConfig({ ...FULL_ENV, PESAPAL_IPN_URL: 'https://old.example/api/callbacks/pesapal/pesapal-cb-secret' });
    expect(moved.pesapal?.ipnId).toBeUndefined();
    expect(moved.warnings.join(' ')).toMatch(/site address changed/);
  });

  it('uses production URLs in production mode and warns about http', () => {
    const c = loadPaymentConfig({ ...FULL_ENV, PAYMENTS_MODE: 'production', SITE_URL: 'http://whizperz.test/' });
    expect(c.mpesa?.baseUrl).toBe(MPESA_URLS.production);
    expect(c.pesapal?.baseUrl).toBe(PESAPAL_URLS.production);
    expect(c.siteUrl).toBe('http://whizperz.test');
    expect(c.warnings.join(' ')).toMatch(/https in production/);
  });

  it('lets one provider stay in sandbox while the other goes live', () => {
    const c = loadPaymentConfig({ ...FULL_ENV, PAYMENTS_MODE: 'production', SITE_URL: 'https://x.test', MPESA_ENV: 'sandbox' });
    expect(c.mpesa?.baseUrl).toBe(MPESA_URLS.sandbox);
    expect(c.pesapal?.baseUrl).toBe(PESAPAL_URLS.production);
  });

  it('rejects an unknown mode', () => {
    expect(() => loadPaymentConfig({ PAYMENTS_MODE: 'live' })).toThrow();
  });

  it('URL-encodes callback secrets', () => {
    const c = loadPaymentConfig({ ...FULL_ENV, MPESA_CALLBACK_SECRET: 'a/b c' });
    expect(c.mpesa?.callbackUrl.endsWith('/a%2Fb%20c')).toBe(true);
  });
});
