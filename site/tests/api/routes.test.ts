import type { APIContext } from 'astro';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { setPaymentDeps, resetRateLimits, rateLimit } from '@/lib/server/payments';
import { createQuote } from '@/lib/payments/service';
import * as mpesaRoute from '@/pages/api/pay/mpesa';
import * as cardRoute from '@/pages/api/pay/card';
import * as statusRoute from '@/pages/api/pay/status';
import * as mpesaCallback from '@/pages/api/callbacks/mpesa/[secret]';
import * as pesapalCallback from '@/pages/api/callbacks/pesapal/[secret]';
import * as adminRoute from '@/pages/api/admin/quotes';
import * as healthRoute from '@/pages/api/health';
import * as reversalRoute from '@/pages/api/callbacks/mpesa-reversal/[secret]/[kind]';
import { refundPayment } from '@/lib/payments/service';
import { makeDeps, pesapalStatus, stkCallback } from '../helpers';

type Handler = (ctx: APIContext) => Response | Promise<Response>;

function call(handler: Handler | undefined, opts: { method?: string; url?: string; body?: unknown; raw?: string; headers?: Record<string, string>; params?: Record<string, string>; ip?: string } = {}) {
  const url = new URL(opts.url ?? 'http://localhost/api');
  const init: RequestInit = { method: opts.method ?? 'POST', headers: { 'Content-Type': 'application/json', ...opts.headers } };
  if (opts.raw !== undefined) init.body = opts.raw;
  else if (opts.body !== undefined) init.body = JSON.stringify(opts.body);
  const request = new Request(url, init);
  const ctx = { request, url, params: opts.params ?? {}, clientAddress: opts.ip ?? '10.0.0.1', locals: { ip: opts.ip ?? '10.0.0.1' } } as unknown as APIContext;
  return handler!(ctx);
}

let t: ReturnType<typeof makeDeps>;
let ref: string;

beforeEach(async () => {
  resetRateLimits();
  t = makeDeps();
  setPaymentDeps(t.deps);
  ref = (await createQuote(t.deps, { guestName: 'Jane Wanjiku', description: 'Wild to blue', amountKes: 85000, email: 'jane@example.com' })).ref;
});
afterEach(() => setPaymentDeps(undefined));

describe('all routes run on the server', () => {
  it.each([mpesaRoute, cardRoute, statusRoute, mpesaCallback, pesapalCallback, adminRoute, healthRoute, reversalRoute])('prerender is off', (mod) => {
    expect(mod.prerender).toBe(false);
  });
});

describe('POST /api/pay/mpesa', () => {
  it('accepts a valid request', async () => {
    const res = await call(mpesaRoute.POST, { body: { ref, phone: '0712345678' } });
    expect(res.status).toBe(202);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect((await res.json()).message).toMatch(/Check your phone/);
  });

  it('ignores any amount the browser sends', async () => {
    await call(mpesaRoute.POST, { body: { ref, phone: '0712345678', amount: 1, amountKes: 1 } });
    expect(t.daraja.stkPush.mock.calls[0]![0].amount).toBe(85000);
  });

  it.each([
    [{ raw: '{not json' }, 400, 'invalid_json'],
    [{ raw: '[1,2]' }, 400, 'invalid_json'],
    [{ body: { phone: '0712345678' } }, 404, 'not_found'],
    [{ body: { ref: 'WZ-AAAAAA', phone: '0712345678' } }, 404, 'not_found'],
    [{ body: { ref: '__REF__', phone: 'abc' } }, 400, 'invalid_phone'],
    [{ raw: 'x'.repeat(40_000) }, 413, 'too_large'],
  ])('rejects %j with %i', async (opts, status, code) => {
    const o = 'body' in opts && opts.body ? { body: JSON.parse(JSON.stringify(opts.body).replace('__REF__', ref)) } : opts;
    const res = await call(mpesaRoute.POST, o);
    expect(res.status).toBe(status);
    expect((await res.json()).error).toBe(code);
  });

  it('hides unexpected errors behind a generic message', async () => {
    t.deps.store.get = async () => {
      throw new Error('disk on fire');
    };
    const res = await call(mpesaRoute.POST, { body: { ref, phone: '0712345678' } });
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(JSON.stringify(body)).not.toContain('disk on fire');
    expect(body.error).toBe('server_error');
  });

  it('rate-limits one address hammering the endpoint', async () => {
    for (let i = 0; i < 20; i++) await call(mpesaRoute.POST, { body: { ref: 'WZ-AAAAAA', phone: 'x' } });
    const res = await call(mpesaRoute.POST, { body: { ref, phone: '0712345678' } });
    expect(res.status).toBe(429);
    const other = await call(mpesaRoute.POST, { body: { ref, phone: '0712345678' }, ip: '10.0.0.2' });
    expect(other.status).toBe(202);
  });
});

describe('POST /api/pay/card', () => {
  it('returns the Pesapal link', async () => {
    const res = await call(cardRoute.POST, { body: { ref } });
    expect(res.status).toBe(200);
    expect((await res.json()).redirectUrl).toContain('pesapal.com');
  });
});

describe('GET /api/pay/status', () => {
  it('returns status without private details', async () => {
    const res = await call(statusRoute.GET, { method: 'GET', url: `http://localhost/api/pay/status?ref=${ref}` });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'awaiting_payment', message: 'Ready to pay.', receipt: null });
  });
  it('404s for an unknown ref', async () => {
    const res = await call(statusRoute.GET, { method: 'GET', url: 'http://localhost/api/pay/status?ref=WZ-AAAAAA' });
    expect(res.status).toBe(404);
  });
});

describe('POST /api/callbacks/mpesa/[secret]', () => {
  it('404s with the wrong secret and changes nothing', async () => {
    await call(mpesaRoute.POST, { body: { ref, phone: '0712345678' } });
    const res = await call(mpesaCallback.POST, { params: { secret: 'guess' }, body: stkCallback('ws_CO_001') });
    expect(res.status).toBe(404);
    expect((await t.deps.store.get(ref))!.status).toBe('awaiting_payment');
  });

  it('accepts Safaricom’s callback and marks the booking paid', async () => {
    await call(mpesaRoute.POST, { body: { ref, phone: '0712345678' } });
    const res = await call(mpesaCallback.POST, { params: { secret: 'mpesa-cb-secret' }, body: stkCallback('ws_CO_001') });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ResultCode: 0, ResultDesc: 'Accepted' });
    expect((await t.deps.store.get(ref))!.status).toBe('paid');
  });

  it('acknowledges junk so Safaricom stops retrying, but rejects bad JSON', async () => {
    expect((await call(mpesaCallback.POST, { params: { secret: 'mpesa-cb-secret' }, body: { foo: 1 } })).status).toBe(200);
    expect((await call(mpesaCallback.POST, { params: { secret: 'mpesa-cb-secret' }, raw: 'nope' })).status).toBe(400);
  });

  it('asks Safaricom to retry when saving fails', async () => {
    await call(mpesaRoute.POST, { body: { ref, phone: '0712345678' } });
    t.deps.store.update = async () => {
      throw new Error('disk full');
    };
    const res = await call(mpesaCallback.POST, { params: { secret: 'mpesa-cb-secret' }, body: stkCallback('ws_CO_001') });
    expect(res.status).toBe(500);
  });
});

describe('/api/callbacks/pesapal/[secret]', () => {
  it('handles a POST IPN', async () => {
    await call(cardRoute.POST, { body: { ref } });
    t.pesapal.transactionStatus.mockResolvedValueOnce(pesapalStatus({ merchant_reference: `${ref}-1` }));
    const res = await call(pesapalCallback.POST, {
      params: { secret: 'pesapal-cb-secret' },
      body: { OrderTrackingId: `track-${ref}-1`, OrderMerchantReference: `${ref}-1`, OrderNotificationType: 'IPNCHANGE' },
    });
    expect(res.status).toBe(200);
    expect((await res.json()).status).toBe(200);
    expect((await t.deps.store.get(ref))!.status).toBe('paid');
  });

  it('handles a GET IPN', async () => {
    await call(cardRoute.POST, { body: { ref } });
    t.pesapal.transactionStatus.mockResolvedValueOnce(pesapalStatus({ merchant_reference: `${ref}-1` }));
    const res = await call(pesapalCallback.GET, {
      method: 'GET',
      params: { secret: 'pesapal-cb-secret' },
      url: `http://localhost/x?OrderTrackingId=track-${ref}-1&OrderMerchantReference=${ref}-1&OrderNotificationType=IPNCHANGE`,
    });
    expect(res.status).toBe(200);
    expect((await t.deps.store.get(ref))!.status).toBe('paid');
  });

  it('rejects the wrong secret and missing fields', async () => {
    expect((await call(pesapalCallback.POST, { params: { secret: 'x' }, body: {} })).status).toBe(404);
    expect((await call(pesapalCallback.POST, { params: { secret: 'pesapal-cb-secret' }, body: {} })).status).toBe(400);
    expect((await call(pesapalCallback.POST, { params: { secret: 'pesapal-cb-secret' }, raw: 'garbage' })).status).toBe(400);
  });
});

describe('/api/admin/quotes', () => {
  const auth = { Authorization: 'Bearer admin-secret-token' };

  it('needs the admin token', async () => {
    expect((await call(adminRoute.GET, { method: 'GET' })).status).toBe(401);
    expect((await call(adminRoute.POST, { body: {}, headers: { Authorization: 'Bearer wrong' } })).status).toBe(401);
  });

  it('creates a quote and returns the pay link', async () => {
    const res = await call(adminRoute.POST, { headers: auth, body: { guestName: 'Ali', description: 'Into the open', amountKes: 42000 } });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.payUrl).toBe(`https://whizperz.test/pay/${body.quote.ref}/`);
    const list = await (await call(adminRoute.GET, { method: 'GET', headers: auth })).json();
    expect(list.quotes).toHaveLength(2);
  });

  it('validates input', async () => {
    const res = await call(adminRoute.POST, { headers: auth, body: { guestName: 'Ali', description: 'x', amountKes: -5 } });
    expect(res.status).toBe(400);
  });
});

describe('GET /api/health', () => {
  it('reports which methods are on', async () => {
    const res = await call(healthRoute.GET, { method: 'GET' });
    expect(await res.json()).toEqual({ ok: true, mode: 'sandbox', mpesa: true, card: true });
  });
});

describe('rateLimit', () => {
  it('resets after the window', () => {
    resetRateLimits();
    for (let i = 0; i < 3; i++) rateLimit('k', 3, 1000, 0);
    expect(() => rateLimit('k', 3, 1000, 10)).toThrow(/Too many/);
    expect(() => rateLimit('k', 3, 1000, 1001)).not.toThrow();
  });
});

describe('POST /api/callbacks/mpesa-reversal/[secret]/[kind]', () => {
  const result = { Result: { ResultType: 0, ResultCode: 0, ResultDesc: 'ok', OriginatorConversationID: 'orig-001', ConversationID: 'AG_001', TransactionID: 'REV1' } };

  it('404s with the wrong secret or an unknown kind', async () => {
    expect((await call(reversalRoute.POST, { params: { secret: 'nope', kind: 'result' }, body: result })).status).toBe(404);
    expect((await call(reversalRoute.POST, { params: { secret: 'mpesa-cb-secret', kind: 'other' }, body: result })).status).toBe(404);
  });

  it('completes a refund from Safaricom’s result', async () => {
    await call(mpesaRoute.POST, { body: { ref, phone: '0712345678' } });
    await call(mpesaCallback.POST, { params: { secret: 'mpesa-cb-secret' }, body: stkCallback('ws_CO_001') });
    const paid = (await t.deps.store.get(ref))!;
    await refundPayment(t.deps, ref, { paymentId: paid.payments[0]!.id, amountKes: 85000, reason: 'x' }, 'spence');
    const res = await call(reversalRoute.POST, { params: { secret: 'mpesa-cb-secret', kind: 'result' }, body: result });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ResultCode: 0, ResultDesc: 'Accepted' });
    expect((await t.deps.store.get(ref))!.status).toBe('refunded');
  });

  it('rejects bad JSON', async () => {
    expect((await call(reversalRoute.POST, { params: { secret: 'mpesa-cb-secret', kind: 'timeout' }, raw: 'x' })).status).toBe(400);
  });
});
