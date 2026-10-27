export interface Faq {
  q: string;
  a: string;
  /** Shown on the home page as well as the FAQ page. */
  featured?: boolean;
}

export const faqs: Faq[] = [
  {
    q: 'Can you plan a trip around our dates and interests?',
    a: 'Yes, that’s how every trip starts. Tell us when you’re travelling, who’s coming and what you’d love to see. We’ll suggest a route and pace, then adjust it with you until it feels right.',
    featured: true,
  },
  {
    q: 'What’s included in a safari?',
    a: 'It depends on the trip. Your quote lists exactly what’s covered: transport, stays, meals, park fees, guiding and activities. Anything optional, like a balloon flight, is priced separately so there are no surprises.',
    featured: true,
  },
  {
    q: 'When is the best time to visit Kenya?',
    a: 'Kenya is good all year. The driest months, roughly January to February and June to October, are easiest for game viewing. July to October is migration season in the Mara. The long rains usually fall in April and May, when prices drop and the country turns green. Each destination page shows its best months.',
    featured: true,
  },
  {
    q: 'How can I pay?',
    a: 'Yes. Book any priced journey from its page and pay a deposit or the full amount by M-Pesa (a prompt comes to your phone), by card or M-Pesa through Pesapal or Paystack, by card through iPOS Pay, through Unipesa, or in crypto. For tailored trips we send a private pay link instead. See How to book for the details.',
    featured: true,
  },
  {
    q: 'Do you arrange airport transfers and stays?',
    a: 'Yes. We can meet you at the airport, book every night of your stay and handle internal flights, the SGR train and road transfers.',
  },
  {
    q: 'Can children come on safari?',
    a: 'Many trips work well for families. Tell us the children’s ages so we can choose stays, activities and drive times that suit them. Some camps have minimum ages, and we’ll flag those early.',
  },
  {
    q: 'Is it a private trip or a group?',
    a: 'Either. Most of our trips are private, in your own vehicle with your own guide. We also run small groups, which keep costs down while staying small enough to feel personal.',
  },
  {
    q: 'What should I pack?',
    a: 'We send a packing list for your trip before you leave. Neutral layers, a warm fleece for early drives, sun protection, binoculars and a soft bag (not a hard case) are a good start.',
  },
];
