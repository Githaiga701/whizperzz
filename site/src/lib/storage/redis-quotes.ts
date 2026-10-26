import { randomBytes } from 'node:crypto';
import type { Quote, QuoteRecords } from '@/lib/payments/store';
import { getRedis } from './redis';

const LOCK_MS = 10_000;
const WAIT_MS = 8_000;

/**
 * Quotes in Redis: one record per quote (a hash field per reference), so changing one never rewrites the others.
 * A short lock per quote makes changes take turns across every copy of the site that Vercel runs.
 */
export function redisQuoteRecords(): QuoteRecords {
  const conn = () => {
    const r = getRedis();
    if (!r) throw new Error('Redis is not configured');
    return r;
  };
  const parse = (raw: unknown): Quote | undefined => (typeof raw === 'string' && raw ? (JSON.parse(raw) as Quote) : undefined);

  return {
    async all() {
      const r = conn();
      // Without automatic decoding, Upstash returns HGETALL as [field, value, field, value, ...].
      const raw = (await r.redis.hgetall(r.key('quotes'))) as unknown;
      const values = Array.isArray(raw) ? raw.filter((_, i) => i % 2 === 1) : Object.values((raw as Record<string, unknown> | null) ?? {});
      return values.flatMap((v) => parse(v) ?? []);
    },

    async get(ref) {
      const r = conn();
      return parse(await r.redis.hget<string>(r.key('quotes'), ref));
    },

    async change(ref, fn) {
      const r = conn();
      const lock = r.key(`lock:quote:${ref}`);
      const token = randomBytes(12).toString('hex');
      const deadline = Date.now() + WAIT_MS;
      while ((await r.redis.set(lock, token, { nx: true, px: LOCK_MS })) !== 'OK') {
        if (Date.now() > deadline) throw new Error(`Quote ${ref} is busy. Please try again.`);
        await new Promise((res) => setTimeout(res, 120));
      }
      try {
        const current = parse(await r.redis.hget<string>(r.key('quotes'), ref));
        const { next, result } = fn(current);
        await r.redis.hset(r.key('quotes'), { [ref]: JSON.stringify(next) });
        return result;
      } finally {
        // Only remove the lock if it is still ours (it may have expired and been taken by someone else).
        if ((await r.redis.get<string>(lock)) === token) await r.redis.del(lock);
      }
    },
  };
}
