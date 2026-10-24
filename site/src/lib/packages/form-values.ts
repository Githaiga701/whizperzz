import type { PackageInput, TripPackage } from './store';

/** What the admin journey form shows: everything as text, so a rejected form can be shown again as typed. */
export interface PackageFormValues {
  id: string;
  name: string;
  route: string[];
  styles: string[];
  photoSrc: string;
  photoAlt: string;
  summary: string;
  whisper: string;
  itinerary: { title: string; note: string; span: string }[];
  order: string;
  published: boolean;
  adultKes: string;
  childKes: string;
  minGuests: string;
  maxGuests: string;
}

export function emptyValues(): PackageFormValues {
  return {
    id: '',
    name: '',
    route: [],
    styles: [],
    photoSrc: '',
    photoAlt: '',
    summary: '',
    whisper: '',
    itinerary: [],
    order: '100',
    published: false,
    adultKes: '',
    childKes: '',
    minGuests: '1',
    maxGuests: '12',
  };
}

export function valuesFromPackage(p: TripPackage): PackageFormValues {
  return {
    id: p.id,
    name: p.name,
    route: [...p.route],
    styles: [...p.styles],
    photoSrc: p.photo.src,
    photoAlt: p.photo.alt,
    summary: p.summary,
    whisper: p.whisper,
    itinerary: p.itinerary.map((d) => ({ title: d.title, note: d.note, span: String(d.span) })),
    order: String(p.order),
    published: p.published,
    adultKes: p.pricing.adultKes === null ? '' : String(p.pricing.adultKes),
    childKes: p.pricing.childKes === null ? '' : String(p.pricing.childKes),
    minGuests: String(p.pricing.minGuests),
    maxGuests: String(p.pricing.maxGuests),
  };
}

const s = (v: unknown) => (typeof v === 'string' ? v : typeof v === 'number' ? String(v) : '');
const list = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x !== '') : []);

export function valuesFromInput(input: PackageInput): PackageFormValues {
  return {
    id: s(input.id),
    name: s(input.name),
    route: list(input.route),
    styles: list(input.styles),
    photoSrc: s(input.photoSrc),
    photoAlt: s(input.photoAlt),
    summary: s(input.summary),
    whisper: s(input.whisper),
    itinerary: (Array.isArray(input.itinerary) ? input.itinerary : []).map((r) => {
      const row = r as Record<string, unknown>;
      return { title: s(row['title']), note: s(row['note']), span: s(row['span']) || '1' };
    }),
    order: s(input.order),
    published: input.published === 'on' || input.published === 'true' || input.published === true,
    adultKes: s(input.adultKes),
    childKes: s(input.childKes),
    minGuests: s(input.minGuests),
    maxGuests: s(input.maxGuests),
  };
}

/** The other way round: a saved journey as validatePackage input, so an API caller can change just a few fields. */
export function inputFromPackage(p: TripPackage): PackageInput {
  const v = valuesFromPackage(p);
  return { ...v, published: v.published ? 'true' : 'false' };
}
