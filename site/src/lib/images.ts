/**
 * Responsive photos. Every photo gets a `srcset`, so a phone downloads a phone-sized file
 * instead of the 1800-2200px original, and the browser picks WebP/AVIF where it can.
 *
 * - Unsplash photos: Unsplash resizes on its CDN through the `w` / `q` / `auto=format` URL settings.
 * - Admin uploads (/media/<file>): resized by our own /media route (`?w=`), which caches each size.
 * - Anything else: used as it is.
 */

/** Widths offered to the browser. Covers phones (1x-3x) through large desktop screens. */
export const WIDTHS = [480, 720, 960, 1280, 1600, 2000] as const;
/** Widths the /media route will make. Requests for other widths are rounded up to the next of these. */
export const MEDIA_WIDTHS = WIDTHS;

const QUALITY = 70;

function isUnsplash(src: string): boolean {
  return src.startsWith('https://images.unsplash.com/');
}

function isMedia(src: string): boolean {
  return /^\/media\/[a-z0-9-]{1,60}\.(jpg|png|webp)$/.test(src.split('?')[0] ?? '');
}

/** The photo's address at a given width. */
export function imageAt(src: string, width: number): string {
  if (isUnsplash(src)) {
    const url = new URL(src);
    url.searchParams.set('auto', 'format');
    url.searchParams.set('fit', url.searchParams.get('fit') ?? 'crop');
    url.searchParams.set('w', String(width));
    url.searchParams.set('q', String(QUALITY));
    return url.toString();
  }
  if (isMedia(src)) return `${src.split('?')[0]}?w=${width}`;
  return src;
}

export interface ResponsiveImage {
  src: string;
  srcset?: string;
  sizes?: string;
}

/**
 * `src`, `srcset` and `sizes` for an <img>.
 * @param sizes How wide the photo shows on screen, e.g. '100vw' or '(max-width: 760px) 100vw, 33vw'.
 * @param max The largest width worth offering (a card never needs 2000px).
 */
export function responsive(src: string, sizes: string, max = 2000): ResponsiveImage {
  if (!isUnsplash(src) && !isMedia(src)) return { src };
  const widths = WIDTHS.filter((w) => w <= max);
  const fallback = widths.find((w) => w >= 960) ?? widths[widths.length - 1] ?? 960;
  return {
    src: imageAt(src, fallback),
    srcset: widths.map((w) => `${imageAt(src, w)} ${w}w`).join(', '),
    sizes,
  };
}
