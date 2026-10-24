import type { APIRoute } from 'astro';
import { readImage } from '@/lib/packages/uploads';
import { uploadsDir } from '@/lib/server/packages';

export const prerender = false;

/** Photos uploaded in the admin (saved in the data folder). */
export const GET: APIRoute = ({ params }) => {
  const img = readImage(uploadsDir(), params['file'] ?? '');
  if (!img) return new Response('Not found', { status: 404 });
  return new Response(new Uint8Array(img.body), {
    headers: {
      'Content-Type': img.type,
      'Content-Length': String(img.size),
      'Cache-Control': 'public, max-age=31536000, immutable',
      'X-Content-Type-Options': 'nosniff',
    },
  });
};
