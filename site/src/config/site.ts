/**
 * Business details used across the site.
 * Empty strings hide the matching contact button instead of showing a broken link.
 */
export interface SiteContact {
  /** Numbers to call, main one first (the call button uses the first). */
  phones: readonly string[];
  whatsapp: string;
  email: string;
  /** Where to find us. */
  address: string;
  /** Postal address (P.O. Box). */
  postal: string;
  /** Opening line for WhatsApp messages started from the site. */
  greeting: string;
}

export const site = {
  name: 'Whizperz Tours & Safaris',
  shortName: 'Whizperz',
  motto: 'Good journeys leave a little wild in you.',
  description:
    'Small-group and private journeys through Kenya, planned by people who know the road. Safaris, coast and highlands, shaped around you.',
  contact: {
    phones: ['+254792916616', '+254722176027'],
    whatsapp: '+254741955190',
    email: 'whizperzpizza@gmail.com',
    address: 'Donholm, inside Total Petrol Station, Nairobi, Kenya',
    postal: 'P.O. Box 78687-00507, Nairobi',
    greeting: 'Hello Whizperz Tours, I would like to plan a trip.',
  } satisfies SiteContact,
  /** Languages offered by the Google Translate widget. */
  translateLanguages: ['en', 'sw', 'fr', 'de', 'es', 'it', 'zh-CN', 'ar'],
} as const;

export const nav = [
  { href: '/destinations/', label: 'Destinations' },
  { href: '/packages/', label: 'Journeys' },
  { href: '/how-to-book/', label: 'How to book' },
  { href: '/plan/', label: 'Sketch a route' },
  { href: '/gallery/', label: 'Gallery' },
  { href: '/about/', label: 'Our story' },
  { href: '/faq/', label: 'FAQs' },
] as const;
