import { describe, expect, it } from 'vitest';
import { behindProxy, clientIp } from '@/lib/server/client-ip';
import { isLocalRequest } from '@/lib/admin/web';

const req = (headers: Record<string, string> = {}) => new Request('https://tours.whizperzpizza.co.ke/', { headers });

describe('visitor IP behind cPanel', () => {
  it('uses the socket address when not behind a proxy', () => {
    expect(clientIp({ request: req({ 'x-forwarded-for': '9.9.9.9' }), clientAddress: '41.90.1.1' }, {})).toBe('41.90.1.1');
  });

  it('behind Passenger, trusts only the last forwarded address (the one our proxy added)', () => {
    const env = { PASSENGER_APP_ENV: 'production' };
    expect(behindProxy(env)).toBe(true);
    expect(clientIp({ request: req({ 'x-forwarded-for': '6.6.6.6, 41.90.1.1' }), clientAddress: '127.0.0.1' }, env)).toBe('41.90.1.1');
    expect(clientIp({ request: req({ 'x-real-ip': '41.90.1.2' }), clientAddress: '127.0.0.1' }, env)).toBe('41.90.1.2');
  });

  it('survives Astro throwing when there is no socket address', () => {
    const ctx = {
      request: req({ 'x-forwarded-for': '41.90.1.1' }),
      get clientAddress(): string {
        throw new Error('ClientAddressNotAvailable');
      },
    };
    expect(clientIp(ctx, { BEHIND_PROXY: '1' })).toBe('41.90.1.1');
    expect(clientIp({ request: req(), get clientAddress(): string { throw new Error('x'); } }, {})).toBe('unknown');
  });

  it('never treats proxied requests as coming from the server itself', () => {
    const before = process.env['BEHIND_PROXY'];
    process.env['BEHIND_PROXY'] = '1';
    try {
      expect(isLocalRequest(req(), '127.0.0.1')).toBe(false);
    } finally {
      if (before === undefined) delete process.env['BEHIND_PROXY'];
      else process.env['BEHIND_PROXY'] = before;
    }
    expect(isLocalRequest(req(), '127.0.0.1')).toBe(true);
  });
});
