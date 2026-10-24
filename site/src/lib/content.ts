import { getCollection, type CollectionEntry } from 'astro:content';
import type { MapPin } from '@/lib/geo';

export type Destination = CollectionEntry<'destinations'>;

export async function getDestinations(): Promise<Destination[]> {
  const all = await getCollection('destinations');
  return all.sort((a, b) => a.data.order - b.data.order);
}

export function toPin(d: Destination): MapPin {
  return {
    id: d.id,
    name: d.data.name,
    lon: d.data.lon,
    lat: d.data.lat,
    labelSide: d.data.labelSide,
    href: `/destinations/${d.id}/`,
  };
}

export const kindLabel: Record<Destination['data']['kind'], string> = {
  safari: 'Safari',
  coast: 'Coast',
  highlands: 'Highlands',
  lakes: 'Lakes',
};

