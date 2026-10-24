import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { QuoteStore, filePersistence, memoryPersistence, type Quote } from '@/lib/payments/store';
import { isQuoteRef, newId, newQuoteRef } from '@/lib/payments/reference';

function quote(ref: string, over: Partial<Quote> = {}): Quote {
  return {
    ref,
    guestName: 'Jane Wanjiku',
    description: 'Wild to blue',
    amountKes: 85000,
    status: 'awaiting_payment',
    createdAt: '2026-10-23T09:00:00.000Z',
    payments: [],
    ...over,
  };
}

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

describe('QuoteStore', () => {
  it('creates, reads and lists quotes (newest first)', async () => {
    const store = new QuoteStore(memoryPersistence());
    await store.create(quote('WZ-AAAAAA'));
    await store.create(quote('WZ-BBBBBB', { createdAt: '2026-10-24T09:00:00.000Z' }));
    expect((await store.get('WZ-AAAAAA'))?.guestName).toBe('Jane Wanjiku');
    expect((await store.list()).map((q) => q.ref)).toEqual(['WZ-BBBBBB', 'WZ-AAAAAA']);
    expect(await store.get('WZ-ZZZZZZ')).toBeUndefined();
  });

  it('refuses duplicate references', async () => {
    const store = new QuoteStore(memoryPersistence());
    await store.create(quote('WZ-AAAAAA'));
    await expect(store.create(quote('WZ-AAAAAA'))).rejects.toThrow(/already exists/);
  });

  it('hands out copies, so callers cannot change stored data by accident', async () => {
    const store = new QuoteStore(memoryPersistence());
    await store.create(quote('WZ-AAAAAA'));
    const q = (await store.get('WZ-AAAAAA'))!;
    q.amountKes = 1;
    expect((await store.get('WZ-AAAAAA'))!.amountKes).toBe(85000);
  });

  it('finds a payment by provider reference', async () => {
    const store = new QuoteStore(memoryPersistence());
    await store.create(
      quote('WZ-AAAAAA', {
        payments: [{ id: 'p1', provider: 'mpesa', status: 'pending', amountKes: 85000, providerRef: 'ws_1', createdAt: 'x', updatedAt: 'x' }],
      }),
    );
    expect((await store.findPayment('mpesa', 'ws_1'))?.quote.ref).toBe('WZ-AAAAAA');
    expect(await store.findPayment('pesapal', 'ws_1')).toBeUndefined();
  });

  it('applies concurrent updates one at a time without losing any', async () => {
    const store = new QuoteStore(memoryPersistence());
    await store.create(quote('WZ-AAAAAA'));
    await Promise.all(
      Array.from({ length: 25 }, (_, i) =>
        store.update('WZ-AAAAAA', (q) => {
          q.payments.push({ id: `p${i}`, provider: 'mpesa', status: 'pending', amountKes: 1, providerRef: `r${i}`, createdAt: 'x', updatedAt: 'x' });
        }),
      ),
    );
    expect((await store.get('WZ-AAAAAA'))!.payments).toHaveLength(25);
  });

  it('keeps working after a failed update', async () => {
    const store = new QuoteStore(memoryPersistence());
    await store.create(quote('WZ-AAAAAA'));
    await expect(store.update('WZ-NOPE00', () => undefined)).rejects.toThrow(/not found/);
    await expect(
      store.update('WZ-AAAAAA', () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    const q = await store.update('WZ-AAAAAA', (x) => {
      x.status = 'paid';
    });
    expect(q.status).toBe('paid');
  });

  it('does not save a change that threw halfway', async () => {
    const store = new QuoteStore(memoryPersistence());
    await store.create(quote('WZ-AAAAAA'));
    await store
      .update('WZ-AAAAAA', (q) => {
        q.status = 'paid';
        throw new Error('stop');
      })
      .catch(() => undefined);
    expect((await store.get('WZ-AAAAAA'))!.status).toBe('awaiting_payment');
  });

  it('saves to disk and reloads in a new process', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'wz-'));
    dirs.push(dir);
    const first = new QuoteStore(filePersistence(join(dir, 'nested')));
    await first.create(quote('WZ-AAAAAA'));
    await first.update('WZ-AAAAAA', (q) => {
      q.status = 'paid';
    });
    const second = new QuoteStore(filePersistence(join(dir, 'nested')));
    expect((await second.get('WZ-AAAAAA'))!.status).toBe('paid');
    const files = await readdir(join(dir, 'nested'));
    expect(files).toEqual(['payments.json']);
    expect(JSON.parse(await readFile(join(dir, 'nested', 'payments.json'), 'utf8')).version).toBe(1);
  });

  it('starts empty when there is no file yet', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'wz-'));
    dirs.push(dir);
    expect(await new QuoteStore(filePersistence(dir)).list()).toEqual([]);
  });
});

describe('references', () => {
  it('makes readable, valid quote references', () => {
    const refs = new Set(Array.from({ length: 500 }, newQuoteRef));
    expect(refs.size).toBe(500);
    for (const r of refs) {
      expect(isQuoteRef(r)).toBe(true);
      expect(r.slice(3)).not.toMatch(/[01ILOU]/);
    }
  });
  it.each(['WZ-ABC', 'wz-ABCDEF', 'WZ-ABCDE0', 'WZ-ABCDEFG', 'XX-ABCDEF', '', null, 42])('rejects %j', (v) => {
    expect(isQuoteRef(v)).toBe(false);
  });
  it('makes prefixed ids', () => {
    expect(newId('pay')).toMatch(/^pay_[2-9A-Z]{10}$/);
  });
});
