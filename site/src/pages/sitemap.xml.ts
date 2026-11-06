import type { APIRoute } from 'astro';
import { getRuntime } from '@/lib/server/payments';
import { getPackageStore } from '@/lib/server/packages';
import { getDestinations } from '@/lib/content';

/** Every public page, for search engines. Journeys come from the admin, so new or hidden ones update by themselves. */
const PAGES = ['/', '/destinations/', '/packages/', '/how-to-book/', '/plan/', '/gallery/', '/about/', '/faq/', '/contact/', '/terms/', '/refund-policy/', '/privacy/'];

export const GET: APIRoute = async () => {
  const site = getRuntime().deps.config.siteUrl;
  const [destinations, journeys] = await Promise.all([getDestinations(), getPackageStore().list({ publishedOnly: true })]);
  const entries = [
    ...PAGES.map((path) => ({ path, lastmod: undefined as string | undefined })),
    ...destinations.map((d) => ({ path: `/destinations/${d.id}/`, lastmod: undefined })),
    ...journeys.map((p) => ({ path: `/packages/${p.id}/`, lastmod: p.updatedAt.slice(0, 10) })),
  ];
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
  const xml = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    ...entries.map((e) => `  <url><loc>${esc(site + e.path)}</loc>${e.lastmod ? `<lastmod>${e.lastmod}</lastmod>` : ''}</url>`),
    '</urlset>',
    '',
  ].join('\n');
  return new Response(xml, { headers: { 'Content-Type': 'application/xml; charset=utf-8', 'Cache-Control': 'public, max-age=3600' } });
};
