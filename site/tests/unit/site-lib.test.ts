import { describe, expect, it } from 'vitest';
import { emailUrl, formatEnquiry, formatKes, prettyPhone, whatsappUrl } from '@/lib/enquiry';
import { MAP_HEIGHT, MAP_WIDTH, NAIROBI, kenyaPath, project, routePath } from '@/lib/geo';

describe('formatEnquiry', () => {
  it('writes a route out in plain text', () => {
    const text = formatEnquiry({
      stops: [
        { name: 'Maasai Mara', nights: 3 },
        { name: 'Diani Coast', nights: 1 },
      ],
      month: 'July',
      travellers: 2,
      style: 'Private trip',
    });
    expect(text).toContain('My route (4 nights): Nairobi → Maasai Mara (3) → Diani Coast (1) → Nairobi');
    expect(text).toContain('When: July');
    expect(text).toContain('Travellers: 2');
    expect(text).toContain('Style: Private trip');
  });
  it('uses singular for one night and skips empty fields', () => {
    const text = formatEnquiry({ stops: [{ name: 'Lamu', nights: 1 }], month: undefined });
    expect(text).toContain('(1 night)');
    expect(text).not.toContain('When:');
  });
  it('includes the journey, message and sender', () => {
    const text = formatEnquiry({ journey: 'Wild to blue', message: '  Two adults  ', name: 'Jane', email: 'j@x.co' });
    expect(text).toMatch(/Journey: Wild to blue[\s\S]*Two adults[\s\S]*Jane · j@x.co/);
  });
});

describe('contact links', () => {
  it('builds a wa.me link with the business number and encoded text', () => {
    expect(whatsappUrl('Hi & bye')).toBe('https://wa.me/254795144687?text=Hi%20%26%20bye');
  });
  it('builds a mailto link', () => {
    expect(emailUrl('Trip', 'a b')).toBe('mailto:whizperzpizza@gmail.com?subject=Trip&body=a%20b');
  });
  it('formats phone numbers and shillings', () => {
    expect(prettyPhone('+254722176027')).toBe('+254 722 176 027');
    expect(prettyPhone('12345')).toBe('12345');
    expect(formatKes(85000)).toBe('KES 85,000');
  });
});

describe('map geometry', () => {
  it('puts every place inside the map', () => {
    const places = [
      [35.1, -1.5], [37.25, -2.65], [38.5, -3.0], [39.58, -4.32], [36.9, 0.3], [36.25, -0.62], [37.53, 0.62], [40.9, -2.27],
    ] as const;
    for (const [lon, lat] of places) {
      const p = project(lon, lat);
      expect(p.x).toBeGreaterThan(0);
      expect(p.x).toBeLessThan(MAP_WIDTH);
      expect(p.y).toBeGreaterThan(0);
      expect(p.y).toBeLessThan(MAP_HEIGHT);
    }
  });
  it('draws a curve through each stop and nothing for a single point', () => {
    expect(routePath([NAIROBI])).toBe('');
    const d = routePath([NAIROBI, project(35.1, -1.5), project(39.58, -4.32)]);
    expect(d.startsWith(`M${NAIROBI.x} ${NAIROBI.y}`)).toBe(true);
    expect(d.match(/Q/g)).toHaveLength(2);
    expect(d).not.toContain('NaN');
  });
  it('has a closed Kenya outline', () => {
    expect(kenyaPath.endsWith('Z')).toBe(true);
    expect(kenyaPath).not.toContain('NaN');
  });
});
