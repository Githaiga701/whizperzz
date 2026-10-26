import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { FAKE_UPSTASH_TOKEN, startFakeUpstash } from '../fake-upstash';
import { QuoteStore, type Quote } from '@/lib/payments/store';
import { redisQuoteRecords } from '@/lib/storage/redis-quotes';
import { beginRequest, docsFor, endRequest, onSettingsChanged, usingRedis } from '@/lib/storage/docs';
import { getRedis, redisSettings } from '@/lib/storage/redis';
import { UserStore } from '@/lib/admin/users';
import { SettingsStore } from '@/lib/settings/store';
import { PackageStore } from '@/lib/packages/store';
import { loadSessionKey } from '@/lib/admin/session';
import { readImage, saveImage } from '@/lib/packages/uploads';

/** The Vercel set-up: saved data in Upstash Redis (here, a fake one in memory). */

let fake: Awaited<ReturnType<typeof startFakeUpstash>>;
const saved = { ...process.env };

beforeAll(async () => {
  fake = await startFakeUpstash();
  process.env['KV_REST_API_URL'] = fake.url;
  process.env['KV_REST_API_TOKEN'] = FAKE_UPSTASH_TOKEN;
});
afterAll(async () => {
  process.env = saved;
  await new Promise((r) => fake.server.close(r));
});
beforeEach(async () => {
  await getRedis()!.redis.flushall();
  fake.commands.length = 0;
});

function quote(ref: string): Quote {
  return { ref, guestName: 'Jane', description: 'Trip', amountKes: 1000, status: 'awaiting_payment', createdAt: '2026-10-26T09:00:00.000Z', payments: [] };
}

describe('choosing where data is saved', () => {
  it('uses Redis when Vercel/Upstash keys are present, files otherwise', () => {
    expect(usingRedis()).toBe(true);
    expect(redisSettings({})).toBeUndefined();
    expect(redisSettings({ UPSTASH_REDIS_REST_URL: 'https://x.upstash.io', UPSTASH_REDIS_REST_TOKEN: 't' })?.prefix).toBe('whizperz:');
  });
});

describe('quotes in Redis', () => {
  it('creates, reads, lists and finds quotes', async () => {
    const store = new QuoteStore(redisQuoteRecords());
    await store.create(quote('WZ-AAAAAA'));
    await store.create({ ...quote('WZ-BBBBBB'), createdAt: '2026-10-27T09:00:00.000Z' });
    await expect(store.create(quote('WZ-AAAAAA'))).rejects.toThrow(/already exists/);
    expect((await store.get('WZ-AAAAAA'))?.guestName).toBe('Jane');
    expect((await store.list()).map((q) => q.ref)).toEqual(['WZ-BBBBBB', 'WZ-AAAAAA']);
    expect(await store.find((q) => q.ref === 'WZ-BBBBBB')).toBeTruthy();
  });

  it('never loses a change when two copies of the site update one quote at once', async () => {
    // Two separate stores = two Vercel instances sharing the database.
    const a = new QuoteStore(redisQuoteRecords());
    const b = new QuoteStore(redisQuoteRecords());
    await a.create(quote('WZ-RACE01'));
    await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        (i % 2 ? a : b).update('WZ-RACE01', (q) => {
          q.history = [...(q.history ?? []), { at: `t${i}`, by: 'system', text: `change ${i}` }];
        }),
      ),
    );
    expect((await a.get('WZ-RACE01'))?.history).toHaveLength(20);
    // Every lock was released.
    expect([...fake.data.keys()].filter((k) => k.includes('lock:'))).toEqual([]);
  });

  it('a failed change leaves the quote as it was and frees the lock', async () => {
    const store = new QuoteStore(redisQuoteRecords());
    await store.create(quote('WZ-FAIL01'));
    await expect(store.update('WZ-FAIL01', () => {
      throw new Error('nope');
    })).rejects.toThrow('nope');
    expect((await store.get('WZ-FAIL01'))?.amountKes).toBe(1000);
    await store.update('WZ-FAIL01', (q) => void (q.amountKes = 2000));
    expect((await store.get('WZ-FAIL01'))?.amountKes).toBe(2000);
  });
});

describe('users, settings, journeys and the login key in Redis', () => {
  it('saves during a request and loads them back in the next one', async () => {
    await beginRequest();
    new UserStore('/unused').create('admin', 'a-long-password-123');
    new SettingsStore('/unused').saveGeneral({ siteUrl: 'https://tours.example.com' });
    await endRequest();

    await beginRequest();
    expect(new UserStore('/unused').hasUsers()).toBe(true);
    expect(new SettingsStore('/unused').read().siteUrl).toBe('https://tours.example.com');
    await endRequest();
    // Saved in Redis, not on disk.
    expect(fake.data.has('whizperz:users.json')).toBe(true);
  });

  it('seeds journeys once and keeps edits', async () => {
    await beginRequest();
    const seed = vi.fn(async () => [{ id: 'trip', name: 'Trip', order: 1 } as never]);
    const store = new PackageStore('/unused', seed);
    expect((await store.list()).map((p) => p.id)).toEqual(['trip']);
    await endRequest();
    await beginRequest();
    expect((await new PackageStore('/unused', seed).list()).map((p) => p.id)).toEqual(['trip']);
    expect(seed).toHaveBeenCalledTimes(1);
    await endRequest();
  });

  it('makes one login key and every copy of the site uses it', async () => {
    await beginRequest();
    const key = loadSessionKey('/unused');
    expect(key).toHaveLength(32);
    await beginRequest();
    expect(loadSessionKey('/other').equals(key)).toBe(true);
  });

  it('notices settings saved by another copy of the site', async () => {
    const changed = vi.fn();
    onSettingsChanged(changed);
    await beginRequest();
    await getRedis()!.redis.set('whizperz:settings.json', JSON.stringify({ siteUrl: 'https://elsewhere.example.com' }));
    await beginRequest();
    expect(changed).toHaveBeenCalled();
    expect(docsFor('/x').read<{ siteUrl: string }>('settings.json')?.siteUrl).toBe('https://elsewhere.example.com');
  });

  it('keeps uploaded photos', async () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
    await beginRequest();
    const url = saveImage('/unused', png, 'photo');
    await endRequest();
    const img = await readImage('/unused', url.replace('/media/', ''));
    expect(img?.type).toBe('image/png');
    expect([...img!.body]).toEqual([...png]);
  });
});
