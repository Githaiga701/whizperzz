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
  /** The registered company; the site trades under `name`. Shown in the footer copyright and the privacy policy. */
  legalName: 'Whizperz Dawn Tours Limited',
  /** Registration number on the certificate of incorporation (Companies Act, 2015). */
  companyNo: 'PVT-L51MKKA6',
  shortName: 'Whizperz',
  motto: 'Good journeys leave a little wild in you.',
  description:
    'Small-group and private journeys through Kenya, planned by people who know the road. Safaris, coast and highlands, shaped around you.',
  contact: {
    phones: ['+254792916616', '+254722176027'],
    whatsapp: '+254741955190',
    email: 'whizperzdawn@gmail.com',
    address: 'Donholm, inside Total Petrol Station, Nairobi, Kenya',
    postal: 'P.O. Box 78687-00507, Nairobi',
    greeting: 'Hello Whizperz Tours, I would like to plan a trip.',
  } satisfies SiteContact,
  /** Languages offered by the Google Translate widget. */
  translateLanguages: ['en', 'sw', 'fr', 'de', 'es', 'it', 'zh-CN', 'ar'],
} as const;

/** Bodies Whizperz works in cooperation with (shown on Our story and the home page). */
export const partners = [
  { short: 'MOTW', name: 'Ministry of Tourism & Wildlife', role: 'Sets Kenya’s tourism and wildlife policy.', url: 'https://www.tourism.go.ke/' },
  { short: 'KWS', name: 'Kenya Wildlife Service', role: 'Protects Kenya’s wildlife and runs its national parks.', url: 'https://www.kws.go.ke/' },
  { short: 'KATO', name: 'Kenya Association of Tour Operators', role: 'The association of Kenya’s tour operators.', url: 'https://katokenya.org/' },
  { short: 'NMK', name: 'National Museums of Kenya', role: 'Keepers of Kenya’s museums, heritage sites and collections.', url: 'https://museums.or.ke/' },
  { short: 'Counties', name: 'County governments', role: 'Who look after the reserves and places in their counties.', url: '' },
] as const;

export const nav = [
  { href: '/destinations/', label: 'Destinations' },
  { href: '/packages/', label: 'Journeys' },
  { href: '/how-to-book/', label: 'How to book' },
  { href: '/plan/', label: 'Sketch a route' },
  { href: '/gallery/', label: 'Gallery' },
  { href: '/about/', label: 'Our story' },
  { href: '/faq/', label: 'FAQs' },
] as const;
