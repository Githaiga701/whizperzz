import { Redis } from '@upstash/redis';

/**
 * Upstash Redis, used for saved data when the site runs on Vercel (which can't keep files).
 * Adding Upstash in Vercel → Storage sets KV_REST_API_URL / KV_REST_API_TOKEN (or the UPSTASH_REDIS_REST_* names).
 * Without them the site keeps using files in DATA_DIR, as on cPanel and your computer.
 */
export interface RedisSettings {
  url: string;
  token: string;
  /** Put in front of every key, so one database could serve more than one copy of the site. */
  prefix: string;
}

export function redisSettings(env: Record<string, string | undefined> = process.env): RedisSettings | undefined {
  const url = (env['UPSTASH_REDIS_REST_URL'] || env['KV_REST_API_URL'])?.trim();
  const token = (env['UPSTASH_REDIS_REST_TOKEN'] || env['KV_REST_API_TOKEN'])?.trim();
  if (!url || !token) return undefined;
  return { url, token, prefix: (env['REDIS_PREFIX']?.trim() || 'whizperz') + ':' };
}

let client: { settings: RedisSettings; redis: Redis } | undefined;

/** The shared client, or undefined when Redis isn't configured. */
export function getRedis(env: Record<string, string | undefined> = process.env): { redis: Redis; key: (name: string) => string } | undefined {
  const settings = redisSettings(env);
  if (!settings) return undefined;
  if (!client || client.settings.url !== settings.url || client.settings.token !== settings.token || client.settings.prefix !== settings.prefix) {
    // Plain strings in and out: we do our own JSON, so nothing is changed on the way.
    client = { settings, redis: new Redis({ url: settings.url, token: settings.token, automaticDeserialization: false, responseEncoding: false }) };
  }
  const { redis } = client;
  return { redis, key: (name) => `${settings.prefix}${name}` };
}
