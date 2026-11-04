import type { APIRoute } from 'astro';
import { getRuntime } from '@/lib/server/payments';

/** Tells search engines what to index: the public site, not the admin, pay links or the API. */
export const GET: APIRoute = () => {
  const site = getRuntime().deps.config.siteUrl;
  const body = ['User-agent: *', 'Disallow: /admin/', 'Disallow: /pay/', 'Disallow: /api/', '', `Sitemap: ${site}/sitemap.xml`, ''].join('\n');
  return new Response(body, { headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'public, max-age=3600' } });
};
