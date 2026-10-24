/**
 * A simple, hand-drawn style map of Kenya.
 * Coordinates are projected linearly (fine at this scale) into an SVG viewBox.
 * The outline is deliberately simplified: it is an illustration, not a survey map.
 */

/** A place shown on the map. */
export interface MapPin {
  id: string;
  name: string;
  lon: number;
  lat: number;
  labelSide: 'left' | 'right';
  href?: string;
}

export interface Point {
  x: number;
  y: number;
}

const SCALE = 56;
const LON0 = 33.4;
const LAT0 = 5.6;

export const MAP_WIDTH = Math.round((42.2 - LON0) * SCALE);
export const MAP_HEIGHT = Math.round((LAT0 + 5.0) * SCALE);

export function project(lon: number, lat: number): Point {
  return {
    x: Math.round((lon - LON0) * SCALE * 10) / 10,
    y: Math.round((LAT0 - lat) * SCALE * 10) / 10,
  };
}

type LonLat = readonly [number, number];

const KENYA: readonly LonLat[] = [
  [33.99, 4.22], [34.38, 4.62], [35.3, 5.0], [35.82, 4.78], [36.04, 4.45], [36.85, 4.45],
  [38.12, 3.6], [38.67, 3.62], [39.56, 3.42], [39.86, 3.84], [40.77, 4.26], [41.17, 3.92],
  [41.86, 3.92], [40.99, 2.78], [40.99, -0.85], [41.56, -1.68], [40.88, -2.08], [40.6, -2.5],
  [40.25, -2.8], [40.12, -3.27], [39.85, -3.85], [39.66, -4.06], [39.4, -4.4], [39.2, -4.68],
  [37.72, -3.6], [37.6, -3.0], [34.07, -1.0], [33.92, -1.0], [33.92, 0.1], [34.1, 0.46],
  [34.56, 1.1], [34.83, 1.69], [34.96, 2.5], [34.6, 3.2], [34.42, 3.7],
];

const TURKANA: readonly LonLat[] = [
  [36.0, 4.45], [36.25, 4.4], [36.35, 3.9], [36.5, 3.5], [36.55, 3.0], [36.7, 2.5],
  [36.6, 2.35], [36.4, 2.6], [36.15, 3.0], [35.95, 3.6], [35.85, 4.1],
];

const VICTORIA: readonly LonLat[] = [
  [32.8, 0.38], [33.3, 0.3], [33.7, 0.22], [33.95, 0.08], [34.05, -0.1], [34.35, -0.16], [34.6, -0.2],
  [34.78, -0.12], [34.72, -0.3], [34.45, -0.42], [34.15, -0.58], [34.15, -0.85], [34.0, -1.05],
  [33.6, -1.18], [33.2, -1.3], [32.8, -1.35],
];

function toPath(points: readonly LonLat[], close = true): string {
  const d = points
    .map(([lon, lat], i) => {
      const p = project(lon, lat);
      return `${i === 0 ? 'M' : 'L'}${p.x} ${p.y}`;
    })
    .join(' ');
  return close ? `${d} Z` : d;
}

export const kenyaPath = toPath(KENYA);
export const turkanaPath = toPath(TURKANA);
export const victoriaPath = toPath(VICTORIA);
export const equatorY = project(LON0, 0).y;

/** Nairobi is where every route starts and ends. */
export const NAIROBI = { id: 'nairobi', name: 'Nairobi', ...project(36.82, -1.29) } as const;

/**
 * A gently curved path through the given points, so routes look drawn by hand
 * rather than ruled. Each leg bows slightly to one side.
 */
export function routePath(points: readonly Point[]): string {
  if (points.length < 2) return '';
  const [first, ...rest] = points;
  let d = `M${first!.x} ${first!.y}`;
  let prev = first!;
  rest.forEach((p, i) => {
    const mx = (prev.x + p.x) / 2;
    const my = (prev.y + p.y) / 2;
    const dx = p.x - prev.x;
    const dy = p.y - prev.y;
    const bow = (i % 2 === 0 ? 0.18 : -0.18);
    const cx = mx - dy * bow;
    const cy = my + dx * bow;
    d += ` Q${cx.toFixed(1)} ${cy.toFixed(1)} ${p.x} ${p.y}`;
    prev = p;
  });
  return d;
}
