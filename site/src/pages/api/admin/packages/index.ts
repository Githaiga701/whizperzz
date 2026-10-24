import type { APIRoute } from 'astro';
import { PackageError, validatePackage } from '@/lib/packages/store';
import { PaymentError } from '@/lib/payments/service';
import { getDestinations } from '@/lib/content';
import { getPackageStore } from '@/lib/server/packages';
import { handle, json, rateLimit, readJson, requireAdmin } from '@/lib/server/payments';

export const prerender = false;

/** All journeys, drafts included. */
export const GET: APIRoute = ({ request, clientAddress, locals }) =>
  handle(async () => {
    rateLimit(`admin:${clientAddress}`, 30, 60_000);
    requireAdmin(request, locals);
    return json(200, { packages: await getPackageStore().list() });
  });

/**
 * Adds a journey. Body: { id?, name, route: string[], styles: string[], photoSrc, photoAlt?, summary, whisper?,
 * itinerary: {title, note, span}[], order?, published?, adultKes?, childKes?, minGuests?, maxGuests? }.
 */
export const POST: APIRoute = ({ request, clientAddress, locals }) =>
  handle(async () => {
    rateLimit(`admin:${clientAddress}`, 30, 60_000);
    requireAdmin(request, locals);
    const ids = (await getDestinations()).map((d) => d.id);
    try {
      const pkg = await getPackageStore().create(validatePackage(await readJson(request), ids));
      return json(201, { package: pkg });
    } catch (err) {
      if (err instanceof PackageError) throw new PaymentError(400, 'invalid_package', err.message);
      throw err;
    }
  });
