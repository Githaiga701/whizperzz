import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PackageError, PackageStore, routeLabel, slugify, validatePackage, type PackageInput, type TripPackage } from '@/lib/packages/store';
import { detectImage, MAX_UPLOAD_BYTES, readImage, saveImage } from '@/lib/packages/uploads';
import { emptyValues, inputFromPackage, valuesFromInput, valuesFromPackage } from '@/lib/packages/form-values';
import { sampleInput } from '../package-helpers';

const PLACES = ['maasai-mara', 'amboseli', 'diani'];


const dirs: string[] = [];
function tempDir() {
  const d = mkdtempSync(join(tmpdir(), 'wz-pkg-'));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('slugify and routeLabel', () => {
  it('makes tidy web addresses', () => {
    expect(slugify('Wild to Blue & Back!')).toBe('wild-to-blue-and-back');
    expect(slugify('  Café   Naïvasha  ')).toBe('cafe-naivasha');
    expect(slugify('x'.repeat(100))).toHaveLength(60);
  });
  it('joins place names naturally', () => {
    const names = (id: string) => ({ a: 'Amboseli', b: 'Tsavo', c: 'Diani' })[id] ?? id;
    expect(routeLabel(['a'], names)).toBe('Amboseli');
    expect(routeLabel(['a', 'c'], names)).toBe('Amboseli & Diani');
    expect(routeLabel(['a', 'b', 'c'], names)).toBe('Amboseli, Tsavo & Diani');
  });
});

describe('validatePackage', () => {
  const now = new Date('2026-10-23T09:00:00Z');

  it('tidies a good journey and works out its length', () => {
    const p = validatePackage(sampleInput(), PLACES, undefined, now);
    expect(p).toMatchObject({
      id: 'wild-to-blue',
      days: 7,
      published: true,
      order: 5,
      pricing: { adultKes: 185000, childKes: null, minGuests: 2, maxGuests: 8 },
      itinerary: [{ span: 3 }, { span: 4 }],
      createdAt: now.toISOString(),
    });
  });

  it('accepts a chosen web address and keeps the old one when editing', () => {
    expect(validatePackage(sampleInput({ id: 'my-trip' }), PLACES).id).toBe('my-trip');
    expect(validatePackage(sampleInput({ id: 'My Trip!' }), PLACES).id).toBe('my-trip');
    const first = validatePackage(sampleInput(), PLACES, undefined, now);
    const later = new Date('2026-11-01T00:00:00Z');
    const edited = validatePackage(sampleInput({ id: 'something-else', name: 'Renamed' }), PLACES, first, later);
    expect(edited.id).toBe('wild-to-blue');
    expect(edited.createdAt).toBe(now.toISOString());
    expect(edited.updatedAt).toBe(later.toISOString());
  });

  it('leaves prices empty for enquiry-only journeys', () => {
    const p = validatePackage(sampleInput({ adultKes: '', childKes: '' }), PLACES);
    expect(p.pricing.adultKes).toBeNull();
    expect(p.pricing.childKes).toBeNull();
  });

  it('drops blank itinerary rows and duplicate stops', () => {
    const p = validatePackage(
      sampleInput({ route: ['diani', 'diani', '', 'amboseli'], itinerary: [{ title: 'One', note: '', span: '' }, { title: '', note: '', span: '1' }] }),
      PLACES,
    );
    expect(p.route).toEqual(['diani', 'amboseli']);
    expect(p.itinerary).toEqual([{ title: 'One', note: '', span: 1 }]);
    expect(p.days).toBe(1);
  });

  it('treats an unticked box as a draft', () => {
    expect(validatePackage(sampleInput({ published: '' }), PLACES).published).toBe(false);
    expect(validatePackage(sampleInput({ published: true }), PLACES).published).toBe(true);
  });

  it.each([
    [{ name: '' }, 'Name is required'],
    [{ route: [] }, 'at least one place'],
    [{ route: ['narnia'] }, 'Unknown place'],
    [{ styles: ['space'] }, 'trip style'],
    [{ itinerary: [] }, 'itinerary day'],
    [{ itinerary: [{ title: '', note: 'Only a note', span: 1 }] }, 'needs a title'],
    [{ itinerary: [{ title: 'Long', note: '', span: 31 }] }, 'Days covered'],
    [{ itinerary: [{ title: 'A', note: '', span: 30 }, { title: 'B', note: '', span: 30 }, { title: 'C', note: '', span: 1 }] }, 'at most 60 days'],
    [{ photoSrc: 'javascript:alert(1)' }, 'uploaded image or an https://'],
    [{ photoSrc: 'http://insecure.example/x.jpg' }, 'https://'],
    [{ adultKes: '12.5' }, 'whole number of shillings'],
    [{ adultKes: '-5' }, 'whole number of shillings'],
    [{ adultKes: '', childKes: '5000' }, 'adult price before a child price'],
    [{ minGuests: '6', maxGuests: '4' }, 'can’t be bigger'],
    [{ maxGuests: '51' }, 'from 1 to 50'],
    [{ id: '!!!', name: '???' }, 'letters, numbers and dashes'],
    [{ summary: 'x'.repeat(301) }, '300 characters'],
  ] as [Partial<PackageInput>, string][])('rejects %j', (over, message) => {
    expect(() => validatePackage(sampleInput(over), PLACES)).toThrow(PackageError);
    expect(() => validatePackage(sampleInput(over), PLACES)).toThrow(message);
  });

  it('accepts uploaded and built-in photos', () => {
    expect(validatePackage(sampleInput({ photoSrc: '/media/wild-to-blue-1a2b3c4d.jpg' }), PLACES).photo.src).toMatch(/^\/media\//);
    expect(validatePackage(sampleInput({ photoSrc: '/photos/mara.jpg', photoAlt: '' }), PLACES).photo.alt).toBe('Wild to Blue');
  });
});

describe('PackageStore', () => {
  const pkg = (id: string, over: Partial<TripPackage> = {}): TripPackage => ({ ...validatePackage(sampleInput({ id }), PLACES), ...over });

  it('copies the starting journeys the first time, and only then', async () => {
    const dir = tempDir();
    const seed = vi.fn(async () => [pkg('b-trip', { order: 2 }), pkg('a-trip', { order: 1 })]);
    const store = new PackageStore(dir, seed);
    expect((await store.list()).map((p) => p.id)).toEqual(['a-trip', 'b-trip']);
    expect(JSON.parse(readFileSync(join(dir, 'packages.json'), 'utf8')).packages).toHaveLength(2);

    const again = new PackageStore(dir, seed);
    await again.list();
    expect(seed).toHaveBeenCalledTimes(1);
  });

  it('seeds once even when several pages ask at the same time', async () => {
    const seed = vi.fn(async () => [pkg('one')]);
    const store = new PackageStore(tempDir(), seed);
    await Promise.all([store.list(), store.get('one'), store.list({ publishedOnly: true })]);
    expect(seed).toHaveBeenCalledTimes(1);
  });

  it('adds, edits, hides and removes journeys', async () => {
    const dir = tempDir();
    const store = new PackageStore(dir, async () => []);
    await store.create(pkg('trip'));
    await expect(store.create(pkg('trip'))).rejects.toThrow('already a journey');

    await store.update({ ...pkg('trip'), name: 'Changed', published: false });
    expect((await store.get('trip'))!.name).toBe('Changed');
    expect(await store.list({ publishedOnly: true })).toEqual([]);
    expect(await store.list()).toHaveLength(1);

    // A fresh store reads what was saved.
    expect((await new PackageStore(dir, async () => []).get('trip'))!.name).toBe('Changed');

    await store.remove('trip');
    expect(await store.get('trip')).toBeUndefined();
    await expect(store.remove('trip')).rejects.toThrow('no longer exists');
    await expect(store.update(pkg('ghost'))).rejects.toThrow('no longer exists');
  });

  it('hands out copies, so callers cannot change saved data by accident', async () => {
    const store = new PackageStore(tempDir(), async () => [pkg('trip')]);
    const p = (await store.get('trip'))!;
    p.name = 'Mutated';
    p.route.push('amboseli');
    expect((await store.get('trip'))!.name).toBe('Wild to Blue');
    expect((await store.get('trip'))!.route).toEqual(['maasai-mara', 'diani']);
  });
});

describe('photo uploads', () => {
  const jpg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0]);
  const webp = new Uint8Array([...'RIFF'].map((c) => c.charCodeAt(0)).concat([0, 0, 0, 0], [...'WEBP'].map((c) => c.charCodeAt(0))));

  it('recognises images by their contents, not their names', () => {
    expect(detectImage(jpg)).toBe('jpg');
    expect(detectImage(png)).toBe('png');
    expect(detectImage(webp)).toBe('webp');
    expect(detectImage(new TextEncoder().encode('<svg onload=alert(1)>'))).toBeUndefined();
    expect(detectImage(new Uint8Array())).toBeUndefined();
  });

  it('saves a photo and serves it back', () => {
    const dir = tempDir();
    const url = saveImage(dir, png, 'Wild To/Blue');
    expect(url).toMatch(/^\/media\/wildtoblue-[0-9a-f]{8}\.png$/);
    const img = readImage(dir, url.replace('/media/', ''))!;
    expect(img.type).toBe('image/png');
    expect([...img.body]).toEqual([...png]);
  });

  it('refuses files that are not photos, empty or too big', () => {
    const dir = tempDir();
    expect(() => saveImage(dir, new TextEncoder().encode('MZ executable'), 'x')).toThrow('JPG, PNG or WebP');
    expect(() => saveImage(dir, new Uint8Array(), 'x')).toThrow('empty');
    const big = new Uint8Array(MAX_UPLOAD_BYTES + 1);
    big.set(jpg);
    expect(() => saveImage(dir, big, 'x')).toThrow('under 5 MB');
  });

  it('only serves files it named itself', () => {
    const dir = tempDir();
    writeFileSync(join(dir, 'secret.json'), '{}');
    for (const name of ['../packages.json', 'secret.json', '..%2Fx.jpg', 'a/b.jpg', 'UPPER.jpg', 'x.svg', '']) {
      expect(readImage(dir, name), name).toBeUndefined();
    }
    expect(readImage(dir, 'missing-1234.jpg')).toBeUndefined();
  });
});

describe('admin form values', () => {
  it('round-trips a saved journey through the form', () => {
    const p = validatePackage(sampleInput(), PLACES);
    const v = valuesFromPackage(p);
    expect(v).toMatchObject({ adultKes: '185000', childKes: '', published: true, itinerary: [{ span: '3' }, { span: '4' }] });
    const again = validatePackage(inputFromPackage(p), PLACES, p);
    expect({ ...again, updatedAt: '' }).toEqual({ ...p, updatedAt: '' });
  });

  it('shows a rejected form back as it was typed', () => {
    const v = valuesFromInput(sampleInput({ adultKes: '12.5', route: ['diani', ''] }));
    expect(v.adultKes).toBe('12.5');
    expect(v.route).toEqual(['diani']);
    expect(v.itinerary[1]).toEqual({ title: 'To the coast', note: 'Sand.', span: '4' });
    expect(emptyValues()).toMatchObject({ published: false, minGuests: '1', maxGuests: '12' });
  });
});
