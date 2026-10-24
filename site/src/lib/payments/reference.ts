import { randomInt } from 'node:crypto';

/** No 0/O, 1/I/L or U, so references are easy to read out over the phone. */
const ALPHABET = '23456789ABCDEFGHJKMNPQRSTVWXYZ';

/** A short booking reference like "WZ-7K3P9Q". */
export function newQuoteRef(): string {
  let s = '';
  for (let i = 0; i < 6; i++) s += ALPHABET[randomInt(ALPHABET.length)];
  return `WZ-${s}`;
}

export function isQuoteRef(value: unknown): value is string {
  return typeof value === 'string' && /^WZ-[2-9A-HJKMNP-TV-Z]{6}$/.test(value);
}

export function newId(prefix: string): string {
  let s = '';
  for (let i = 0; i < 10; i++) s += ALPHABET[randomInt(ALPHABET.length)];
  return `${prefix}_${s}`;
}
