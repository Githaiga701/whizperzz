import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PackageError } from './store';
import { readMediaFromRedis, saveMediaToRedis, usingRedis } from '@/lib/storage/docs';

export const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;

const TYPES = { jpg: 'image/jpeg', png: 'image/png', webp: 'image/webp' } as const;
export type ImageExt = keyof typeof TYPES;

/** Works out the image type from the file's first bytes (not its name, which can lie). */
export function detectImage(bytes: Uint8Array): ImageExt | undefined {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'jpg';
  if (bytes.length >= 8 && [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((b, i) => bytes[i] === b)) return 'png';
  if (bytes.length >= 12 && String.fromCharCode(...bytes.slice(0, 4)) === 'RIFF' && String.fromCharCode(...bytes.slice(8, 12)) === 'WEBP') return 'webp';
  return undefined;
}

/** Saves an uploaded photo and returns its public address, /media/<file>. */
export function saveImage(dir: string, bytes: Uint8Array, prefix: string): string {
  if (bytes.length === 0) throw new PackageError('The photo file is empty.');
  if (bytes.length > MAX_UPLOAD_BYTES) throw new PackageError('The photo is too big. Use one under 5 MB.');
  const ext = detectImage(bytes);
  if (!ext) throw new PackageError('The photo must be a JPG, PNG or WebP image.');
  const safe = prefix.toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 40) || 'photo';
  const name = `${safe}-${randomBytes(4).toString('hex')}.${ext}`;
  if (usingRedis()) {
    saveMediaToRedis(name, bytes);
  } else {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, name), bytes);
  }
  return `/media/${name}`;
}

const NAME = /^[a-z0-9-]{1,60}\.(jpg|png|webp)$/;

/** Reads a saved photo for /media/<file>. Only names we generated are allowed, so no path tricks. */
export async function readImage(dir: string, name: string): Promise<{ body: Buffer; type: string; size: number } | undefined> {
  const m = NAME.exec(name);
  if (!m) return undefined;
  if (usingRedis()) {
    const body = await readMediaFromRedis(name);
    return body ? { body, type: TYPES[m[1] as ImageExt], size: body.length } : undefined;
  }
  try {
    const file = join(dir, name);
    const { size } = statSync(file);
    return { body: readFileSync(file), type: TYPES[m[1] as ImageExt], size };
  } catch {
    return undefined;
  }
}
