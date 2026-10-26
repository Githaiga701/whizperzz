import type { APIRoute } from 'astro';
import { PackageError, validatePackage } from '@/lib/packages/store';
import { inputFromPackage } from '@/lib/packages/form-values';
import { PaymentError } from '@/lib/payments/service';
import { getDestinations } from '@/lib/content';
import { getPackageStore } from '@/lib/server/packages';
import { handle, json, rateLimit, readJson, requireAdmin } from '@/lib/server/payments';

export const prerender = false;

async function find(id: string | undefined) {
  const pkg = id ? await getPackageStore().get(id) : undefined;
  if (!pkg) throw new PaymentError(404, 'not_found', 'No journey with that id.');
  return pkg;
}

export const GET: APIRoute = ({ request, locals, params }) =>
  handle(async () => {
    rateLimit(`admin:${locals.ip}`, 30, 60_000);
    requireAdmin(request, locals);
    return json(200, { package: await find(params['id']) });
  });

/** Changes some fields, e.g. { "adultKes": 185000, "published": true }. Fields left out stay as they are. */
export const PATCH: APIRoute = ({ request, locals, params }) =>
  handle(async () => {
    rateLimit(`admin:${locals.ip}`, 30, 60_000);
    requireAdmin(request, locals);
    const existing = await find(params['id']);
    const body = await readJson(request);
    const ids = (await getDestinations()).map((d) => d.id);
    try {
      const next = validatePackage({ ...inputFromPackage(existing), ...body, id: existing.id }, ids, existing);
      return json(200, { package: await getPackageStore().update(next) });
    } catch (err) {
      if (err instanceof PackageError) throw new PaymentError(400, 'invalid_package', err.message);
      throw err;
    }
  });

export const DELETE: APIRoute = ({ request, locals, params }) =>
  handle(async () => {
    rateLimit(`admin:${locals.ip}`, 30, 60_000);
    requireAdmin(request, locals);
    const existing = await find(params['id']);
    await getPackageStore().remove(existing.id);
    return json(200, { deleted: existing.id });
  });
