import { site } from '@/config/site';

export const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
] as const;

export interface RouteStop {
  name: string;
  nights: number;
}

export interface Enquiry {
  name?: string | undefined;
  email?: string | undefined;
  month?: string | undefined;
  travellers?: number | undefined;
  style?: string | undefined;
  stops?: RouteStop[] | undefined;
  message?: string | undefined;
  /** Journey the enquiry came from, if any. */
  journey?: string | undefined;
}

/** Turns an enquiry into a plain-text message a person can read in WhatsApp or email. */
export function formatEnquiry(e: Enquiry): string {
  const lines: string[] = [site.contact.greeting, ''];
  if (e.journey) lines.push(`Journey: ${e.journey}`);
  if (e.stops && e.stops.length > 0) {
    const nights = e.stops.reduce((sum, s) => sum + s.nights, 0);
    lines.push(`My route (${nights} night${nights === 1 ? '' : 's'}): Nairobi → ${e.stops
      .map((s) => `${s.name} (${s.nights})`)
      .join(' → ')} → Nairobi`);
  }
  if (e.month) lines.push(`When: ${e.month}`);
  if (e.travellers) lines.push(`Travellers: ${e.travellers}`);
  if (e.style) lines.push(`Style: ${e.style}`);
  if (e.message) lines.push('', e.message.trim());
  if (e.name || e.email) lines.push('', [e.name, e.email].filter(Boolean).join(' · '));
  return lines.join('\n');
}

export function whatsappUrl(text: string): string | null {
  const digits = site.contact.whatsapp.replace(/\D/g, '');
  return digits ? `https://wa.me/${digits}?text=${encodeURIComponent(text)}` : null;
}

/**
 * Opens a WhatsApp link from a button press. Phones and tablets go there in the same tab (wa.me hands over to the
 * app, and in-app browsers like Instagram's often block new windows). Computers get a new tab, falling back to the
 * same tab if the browser blocked it, so the button never silently does nothing.
 */
export function openWhatsApp(url: string): void {
  const touch = window.matchMedia('(hover: none) and (pointer: coarse)').matches;
  if (!touch) {
    const tab = window.open(url, '_blank');
    if (tab) {
      tab.opener = null;
      return;
    }
  }
  window.location.href = url;
}

export function emailUrl(subject: string, text: string): string | null {
  return site.contact.email
    ? `mailto:${site.contact.email}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(text)}`
    : null;
}

export function phoneUrl(): string | null {
  const digits = site.contact.phone.replace(/[^+\d]/g, '');
  return digits ? `tel:${digits}` : null;
}

/** "+254722176027" → "+254 722 176 027" */
export function prettyPhone(raw: string): string {
  const m = raw.replace(/\s/g, '').match(/^\+254(\d{3})(\d{3})(\d{3})$/);
  return m ? `+254 ${m[1]} ${m[2]} ${m[3]}` : raw;
}

export function formatKes(amount: number): string {
  return `KES ${amount.toLocaleString('en-KE')}`;
}
