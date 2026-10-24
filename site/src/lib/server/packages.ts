import { getCollection } from 'astro:content';
import { join } from 'node:path';
import { PackageStore, type TripPackage } from '@/lib/packages/store';
import { getDestinations } from '@/lib/content';
import { dataDir } from './payments';

/** The starting journeys, from src/content/packages. Used once, when packages.json doesn't exist yet. */
async function seedFromContent(): Promise<TripPackage[]> {
  const entries = await getCollection('packages');
  const now = new Date().toISOString();
  return entries.map((e) => ({
    id: e.id,
    name: e.data.name,
    route: e.data.route.map((r) => r.id),
    days: e.data.days,
    styles: [...e.data.styles],
    photo: { src: e.data.photo.src, alt: e.data.photo.alt },
    summary: e.data.summary,
    whisper: e.data.whisper,
    itinerary: e.data.itinerary.map((d) => ({ title: d.title, note: d.note, span: d.span })),
    order: e.data.order,
    published: true,
    pricing: { adultKes: e.data.priceFromKes ?? null, childKes: null, minGuests: 1, maxGuests: 12 },
    createdAt: now,
    updatedAt: now,
  }));
}

let store: PackageStore | undefined;

export function getPackageStore(): PackageStore {
  store ??= new PackageStore(dataDir(), seedFromContent);
  return store;
}

/** Destination names by id, for route labels like "Maasai Mara & Diani Coast". */
export async function destinationNames(): Promise<(id: string) => string> {
  const all = await getDestinations();
  const map = new Map(all.map((d) => [d.id, d.data.name]));
  return (id) => map.get(id) ?? id;
}

export function uploadsDir(): string {
  return join(dataDir(), 'uploads');
}
