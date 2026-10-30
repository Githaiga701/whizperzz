import type { APIRoute } from 'astro';
import { readImage } from '@/lib/packages/uploads';
import { uploadsDir } from '@/lib/server/packages';
import { MEDIA_WIDTHS } from '@/lib/images';

export const prerender = false;

/** Each file name is unique and never reused, so every size can be cached for good (browser and CDN). */
const FOREVER = 'public, max-age=31536000, s-maxage=31536000, immutable';

/** Recently made sizes, kept in memory so a warm server doesn't resize the same photo twice. */
const made = new Map<string, Uint8Array>();
const MADE_LIMIT = 40;

type Sharp = typeof import('sharp').default;
let sharpLoader: Promise<Sharp | undefined> | undefined;
function loadSharp(): Promise<Sharp | undefined> {
  sharpLoader ??= import('sharp').then((m) => m.default).catch(() => undefined);
  return sharpLoader;
}

/** Rounds a requested width up to one we make, so the cache isn't filled with odd sizes. */
function pickWidth(raw: string | null): number | undefined {
  const w = Number(raw);
  if (!raw || !Number.isFinite(w) || w <= 0) return undefined;
  return MEDIA_WIDTHS.find((x) => x >= w) ?? MEDIA_WIDTHS[MEDIA_WIDTHS.length - 1];
}

/**
 * Photos uploaded in the admin (saved in the data folder, or Redis on Vercel).
 * `?w=720` returns a WebP no wider than 720px; without it, the original file.
 */
export const GET: APIRoute = async ({ params, url }) => {
  const name = params['file'] ?? '';
  const width = pickWidth(url.searchParams.get('w'));
  const key = `${name}@${width ?? 'orig'}`;

  const hit = made.get(key);
  if (hit) return send(hit, 'image/webp');

  const img = await readImage(uploadsDir(), name);
  if (!img) return new Response('Not found', { status: 404, headers: { 'Cache-Control': 'public, max-age=60' } });
  if (!width) return send(new Uint8Array(img.body), img.type);

  const sharp = await loadSharp();
  if (!sharp) return send(new Uint8Array(img.body), img.type);
  try {
    const out = await sharp(img.body).rotate().resize({ width, withoutEnlargement: true }).webp({ quality: 72 }).toBuffer();
    const bytes = new Uint8Array(out);
    made.set(key, bytes);
    if (made.size > MADE_LIMIT) made.delete(made.keys().next().value!);
    return send(bytes, 'image/webp');
  } catch {
    return send(new Uint8Array(img.body), img.type);
  }
};

function send(body: Uint8Array, type: string): Response {
  return new Response(body as Uint8Array<ArrayBuffer>, {
    headers: {
      'Content-Type': type,
      'Content-Length': String(body.byteLength),
      'Cache-Control': FOREVER,
      'X-Content-Type-Options': 'nosniff',
    },
  });
}
