import type { PackageInput } from '@/lib/packages/store';

/** A valid journey as the admin form would send it. */
export function sampleInput(over: Partial<PackageInput> = {}): PackageInput {
  return {
    name: 'Wild to Blue',
    route: ['maasai-mara', 'diani'],
    styles: ['safari', 'coast'],
    photoSrc: 'https://images.example.com/mara.jpg',
    photoAlt: 'Lions in the Mara',
    summary: 'Plains, then the sea.',
    whisper: 'Ask for the hippo pool.',
    itinerary: [
      { title: 'Into the Mara', note: 'Fly in.', span: '3' },
      { title: 'To the coast', note: 'Sand.', span: 4 },
    ],
    order: '5',
    published: 'on',
    adultKes: '185,000',
    childKes: '',
    minGuests: '2',
    maxGuests: '8',
    ...over,
  };
}
