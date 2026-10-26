import { join } from 'node:path';
import { docsFor, type DocStore } from '@/lib/storage/docs';
import { slugify } from './slug';

export { slugify };

/**
 * Journeys (packages) are saved in DATA_DIR/packages.json so they can be added and edited in the admin.
 * The first time the site runs, they are copied from src/content/packages (the starting set).
 */

export const STYLES = ['safari', 'coast', 'family', 'lakes', 'highlands'] as const;
export type Style = (typeof STYLES)[number];

export interface ItineraryDay {
  title: string;
  note: string;
  /** How many days this entry covers. */
  span: number;
}

export interface Pricing {
  /** Per adult, in KES. null = not priced yet ("Priced to your dates", enquiries only). */
  adultKes: number | null;
  /** Per child, in KES. null = children pay the adult price. */
  childKes: number | null;
  minGuests: number;
  maxGuests: number;
}

export interface TripPackage {
  id: string;
  name: string;
  /** Destination ids, in the order the route visits them. */
  route: string[];
  /** Total days; always the sum of the itinerary spans. */
  days: number;
  styles: Style[];
  photo: { src: string; alt: string };
  summary: string;
  whisper: string;
  itinerary: ItineraryDay[];
  order: number;
  published: boolean;
  pricing: Pricing;
  createdAt: string;
  updatedAt: string;
}

export class PackageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PackageError';
  }
}


/* ---------- Validation ---------- */

export interface PackageInput {
  id?: unknown;
  name?: unknown;
  route?: unknown;
  styles?: unknown;
  photoSrc?: unknown;
  photoAlt?: unknown;
  summary?: unknown;
  whisper?: unknown;
  itinerary?: unknown;
  order?: unknown;
  published?: unknown;
  adultKes?: unknown;
  childKes?: unknown;
  minGuests?: unknown;
  maxGuests?: unknown;
}

function str(v: unknown, label: string, max: number, required = true): string {
  const s = typeof v === 'string' ? v.trim() : '';
  if (required && !s) throw new PackageError(`${label} is required.`);
  if (s.length > max) throw new PackageError(`${label} must be ${max} characters or fewer.`);
  return s;
}

function optionalKes(v: unknown, label: string): number | null {
  const raw = typeof v === 'number' ? String(v) : typeof v === 'string' ? v.replace(/[,\s]/g, '') : '';
  if (raw === '') return null;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > 50_000_000) throw new PackageError(`${label} must be a whole number of shillings.`);
  return n;
}

function int(v: unknown, label: string, min: number, max: number, fallback: number): number {
  if (v === undefined || v === null || v === '') return fallback;
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max) throw new PackageError(`${label} must be a whole number from ${min} to ${max}.`);
  return n;
}

/** Checks and tidies what the admin typed. `destinationIds` are the places a route can use. */
export function validatePackage(input: PackageInput, destinationIds: readonly string[], existing?: TripPackage, now = new Date()): TripPackage {
  const name = str(input.name, 'Name', 80);
  const id = existing?.id ?? slugify(typeof input.id === 'string' && input.id.trim() ? input.id : name);
  if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(id)) throw new PackageError('The web address can only use letters, numbers and dashes.');

  const route = (Array.isArray(input.route) ? input.route : [input.route])
    .filter((x): x is string => typeof x === 'string' && x !== '')
    .filter((x, i, all) => all.indexOf(x) === i);
  if (route.length === 0) throw new PackageError('Choose at least one place for the route.');
  const unknown = route.find((r) => !destinationIds.includes(r));
  if (unknown) throw new PackageError(`Unknown place in the route: ${unknown}.`);

  const styles = (Array.isArray(input.styles) ? input.styles : [input.styles]).filter((s): s is Style => STYLES.includes(s as Style));
  if (styles.length === 0) throw new PackageError('Choose at least one trip style.');

  const rows = Array.isArray(input.itinerary) ? input.itinerary : [];
  const itinerary: ItineraryDay[] = [];
  for (const row of rows) {
    const r = row as Record<string, unknown>;
    const title = typeof r['title'] === 'string' ? r['title'].trim() : '';
    const note = typeof r['note'] === 'string' ? r['note'].trim() : '';
    if (!title && !note) continue;
    if (!title) throw new PackageError('Every itinerary day needs a title.');
    itinerary.push({ title: str(title, 'Day title', 100), note: str(note, 'Day description', 600, false), span: int(r['span'], 'Days covered', 1, 30, 1) });
  }
  if (itinerary.length === 0) throw new PackageError('Add at least one itinerary day.');
  const days = itinerary.reduce((s, d) => s + d.span, 0);
  if (days > 60) throw new PackageError('A journey can be at most 60 days.');

  const photoSrc = str(input.photoSrc, 'Photo', 1000, false);
  if (!photoSrc) throw new PackageError('Add a photo: upload one, or paste an image address.');
  if (!/^(https:\/\/|\/media\/|\/photos\/)/.test(photoSrc)) throw new PackageError('The photo must be an uploaded image or an https:// address.');

  const adultKes = optionalKes(input.adultKes, 'Adult price');
  const childKes = optionalKes(input.childKes, 'Child price');
  if (childKes !== null && adultKes === null) throw new PackageError('Set the adult price before a child price.');
  const minGuests = int(input.minGuests, 'Minimum group size', 1, 50, 1);
  const maxGuests = int(input.maxGuests, 'Maximum group size', 1, 50, 12);
  if (minGuests > maxGuests) throw new PackageError('The minimum group size can’t be bigger than the maximum.');

  const at = now.toISOString();
  return {
    id,
    name,
    route,
    days,
    styles,
    photo: { src: photoSrc, alt: str(input.photoAlt, 'Photo description', 200, false) || name },
    summary: str(input.summary, 'Summary', 300),
    whisper: str(input.whisper, 'Guide’s tip', 200, false),
    itinerary,
    order: int(input.order, 'Order', 0, 999, existing?.order ?? 100),
    published: input.published === true || input.published === 'on' || input.published === 'true',
    pricing: { adultKes, childKes, minGuests, maxGuests },
    createdAt: existing?.createdAt ?? at,
    updatedAt: at,
  };
}

/* ---------- Store ---------- */

interface PackagesFile {
  version: 1;
  packages: TripPackage[];
}

export class PackageStore {
  readonly file: string;
  private readonly docs: DocStore;
  private seeding: Promise<PackagesFile> | undefined;

  /** `seed` provides the starting journeys the first time, when there is no packages.json yet. */
  constructor(
    dataDir: string,
    private readonly seed: () => Promise<TripPackage[]>,
  ) {
    this.file = join(dataDir, 'packages.json');
    this.docs = docsFor(dataDir);
  }

  private async load(): Promise<PackagesFile> {
    const saved = this.docs.read<PackagesFile>('packages.json');
    if (saved) return saved;
    this.seeding ??= this.seed().then((packages) => {
      const data: PackagesFile = { version: 1, packages };
      this.docs.write('packages.json', data);
      return data;
    });
    try {
      return structuredClone(await this.seeding);
    } finally {
      this.seeding = undefined;
    }
  }

  /** Sorted by order, then name. */
  async list(opts: { publishedOnly?: boolean } = {}): Promise<TripPackage[]> {
    const { packages } = await this.load();
    return packages
      .filter((p) => !opts.publishedOnly || p.published)
      .map((p) => structuredClone(p))
      .sort((a, b) => a.order - b.order || a.name.localeCompare(b.name));
  }

  async get(id: string): Promise<TripPackage | undefined> {
    const { packages } = await this.load();
    const p = packages.find((x) => x.id === id);
    return p ? structuredClone(p) : undefined;
  }

  async create(pkg: TripPackage): Promise<TripPackage> {
    const data = await this.load();
    if (data.packages.some((p) => p.id === pkg.id)) throw new PackageError(`There is already a journey at /packages/${pkg.id}/. Choose another name or web address.`);
    this.write({ ...data, packages: [...data.packages, structuredClone(pkg)] });
    return structuredClone(pkg);
  }

  async update(pkg: TripPackage): Promise<TripPackage> {
    const data = await this.load();
    if (!data.packages.some((p) => p.id === pkg.id)) throw new PackageError('That journey no longer exists.');
    this.write({ ...data, packages: data.packages.map((p) => (p.id === pkg.id ? structuredClone(pkg) : p)) });
    return structuredClone(pkg);
  }

  async remove(id: string): Promise<void> {
    const data = await this.load();
    if (!data.packages.some((p) => p.id === id)) throw new PackageError('That journey no longer exists.');
    this.write({ ...data, packages: data.packages.filter((p) => p.id !== id) });
  }

  private write(next: PackagesFile): void {
    this.docs.write('packages.json', next);
  }
}

/** "Maasai Mara, Amboseli & Diani Coast" */
export function routeLabel(route: readonly string[], names: (id: string) => string): string {
  const n = route.map(names);
  return n.length <= 1 ? n.join('') : `${n.slice(0, -1).join(', ')} & ${n.at(-1)}`;
}

export const STYLE_LABEL: Record<Style, string> = {
  safari: 'Safari',
  coast: 'Coast',
  family: 'Family',
  lakes: 'Lakes',
  highlands: 'Highlands',
};
