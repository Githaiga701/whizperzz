import { defineCollection, reference } from 'astro:content';
import { glob } from 'astro/loaders';
import { z } from 'astro/zod';

/** A photo can be a remote URL or a file in /public/photos (e.g. "/photos/mara-sunrise.jpg"). */
const photo = z.object({
  src: z.string(),
  alt: z.string(),
  /** Credit line, e.g. "Photo: Whizperz guide team". Optional. */
  credit: z.string().optional(),
});

const month = z.number().int().min(1).max(12);

const destinations = defineCollection({
  loader: glob({ pattern: '**/*.md', base: './src/content/destinations' }),
  schema: z.object({
    name: z.string(),
    /** Short line under the name, e.g. "The great plains". */
    tagline: z.string(),
    kind: z.enum(['safari', 'coast', 'highlands', 'lakes']),
    region: z.string(),
    /** Position on the map. Longitude/latitude in decimal degrees. */
    lon: z.number().min(33.5).max(42),
    lat: z.number().min(-5).max(5.5),
    /** Which side of the pin the map label sits on. */
    labelSide: z.enum(['left', 'right']).default('right'),
    photo,
    summary: z.string(),
    /** A guide's note from the road. Shown in handwriting. */
    whisper: z.string(),
    bestFor: z.string(),
    suggestedNights: z.number().int().min(1).max(14),
    goodMonths: z.array(month).min(1),
    gettingThere: z.string(),
    order: z.number().int(),
  }),
});

const packages = defineCollection({
  loader: glob({ pattern: '**/*.md', base: './src/content/packages' }),
  schema: z.object({
    name: z.string(),
    /** Destinations in the order the route visits them. */
    route: z.array(reference('destinations')).min(1),
    days: z.number().int().min(1),
    styles: z.array(z.enum(['safari', 'coast', 'family', 'lakes', 'highlands'])).min(1),
    photo,
    summary: z.string(),
    whisper: z.string(),
    /** Starting price per person in KES. Leave out to show "Priced to your dates". */
    priceFromKes: z.number().int().positive().optional(),
    itinerary: z
      .array(
        z.object({
          title: z.string(),
          note: z.string(),
          /** How many days this entry covers, e.g. 3 for "Days 4 to 6". */
          span: z.number().int().min(1).default(1),
        }),
      )
      .min(1),
    order: z.number().int(),
  }).refine((j) => j.itinerary.reduce((sum, d) => sum + d.span, 0) === j.days, {
    message: 'The itinerary days (counting each entry\'s span) must add up to "days".',
    path: ['itinerary'],
  }),
});

export const collections = { destinations, packages };
