import { site } from '@/config/site';
import type { Payment, Quote, Refund } from '@/lib/payments/store';
import type { EmailMessage } from './mailer';
import { travellersLabel } from '@/lib/packages/pricing';

/** Escapes text for HTML email bodies. */
export function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

const kes = (n: number) => `KES ${n.toLocaleString('en-KE')}`;
const firstName = (q: Quote) => q.guestName.split(/\s+/)[0] ?? q.guestName;

function methodLabel(p: Payment): string {
  if (p.provider === 'mpesa') return 'M-Pesa';
  if (p.provider === 'pesapal') return p.method ? `${p.method} (Pesapal)` : 'Card (Pesapal)';
  return p.method ?? 'Recorded by our team';
}

/** A plain, readable email: one column, no images, works in every mail app. */
function layout(title: string, paragraphs: string[], rows: [string, string][] = [], button?: { href: string; label: string }): string {
  const table = rows.length
    ? `<table role="presentation" style="border-collapse:collapse;margin:20px 0;width:100%">${rows
        .map(
          ([k, v]) =>
            `<tr><td style="padding:8px 0;border-top:1px solid #e0d6bb;color:#65583f;width:40%">${esc(k)}</td><td style="padding:8px 0;border-top:1px solid #e0d6bb;font-weight:600">${esc(v)}</td></tr>`,
        )
        .join('')}</table>`
    : '';
  const btn = button
    ? `<p style="margin:24px 0"><a href="${esc(button.href)}" style="background:#2a2017;color:#f6f1e4;padding:12px 20px;text-decoration:none;border-radius:3px;font-weight:600;display:inline-block">${esc(button.label)}</a></p>`
    : '';
  return `<!doctype html><html><body style="margin:0;background:#ebe4d0;padding:24px 12px;font-family:Arial,Helvetica,sans-serif;color:#2a2017;font-size:16px;line-height:1.5">
<div style="max-width:560px;margin:0 auto;background:#f6f1e4;padding:28px 24px;border-radius:3px">
<p style="margin:0 0 20px;font-family:Georgia,serif;font-size:20px">whizperz <span style="font-size:13px;color:#65583f">Tours &amp; Safaris</span></p>
<h1 style="font-family:Georgia,serif;font-weight:400;font-size:26px;margin:0 0 16px">${esc(title)}</h1>
${paragraphs.map((p) => `<p style="margin:0 0 14px">${esc(p)}</p>`).join('')}
${table}${btn}
<p style="margin:24px 0 0;font-size:13px;color:#65583f">${esc(site.name)} · ${esc(site.contact.address)}${site.contact.phone ? ` · ${esc(site.contact.phone)}` : ''}</p>
</div></body></html>`;
}

function plain(title: string, paragraphs: string[], rows: [string, string][] = [], link?: { href: string; label: string }): string {
  return [
    title,
    '',
    ...paragraphs.flatMap((p) => [p, '']),
    ...rows.map(([k, v]) => `${k}: ${v}`),
    ...(link ? ['', `${link.label}: ${link.href}`] : []),
    '',
    `${site.name}, ${site.contact.address}`,
  ].join('\n');
}

function message(to: string, subject: string, title: string, paragraphs: string[], rows: [string, string][] = [], button?: { href: string; label: string }): EmailMessage {
  return { to, subject, text: plain(title, paragraphs, rows, button), html: layout(title, paragraphs, rows, button) };
}

export function payLinkEmail(q: Quote, url: string): EmailMessage {
  return message(
    q.email!,
    `Your Whizperz booking ${q.ref}: payment link`,
    `Your trip is ready to book, ${firstName(q)}`,
    ['Here is your private payment link. You can pay with M-Pesa or by card. The amount is already set, so there is nothing to type except your phone number or card details.'],
    [
      ['Booking', q.ref],
      ['Trip', q.description],
      ['Amount', kes(q.amountKes)],
    ],
    { href: url, label: 'Pay for your trip' },
  );
}

export function receiptEmail(q: Quote, p: Payment): EmailMessage {
  const rows: [string, string][] = [
    ['Booking', q.ref],
    ['Trip', q.description],
    ['Amount paid', kes(p.amountKes)],
    ['Paid with', methodLabel(p)],
  ];
  if (p.receipt) rows.push(['Receipt', p.receipt]);
  rows.push(['Date', new Date(p.updatedAt).toLocaleString('en-KE', { timeZone: 'Africa/Nairobi', dateStyle: 'long', timeStyle: 'short' })]);
  const b = q.booking;
  const intro = ['We’ve received your payment. Keep this email as your receipt. We’ll be in touch with your trip details and anything you need to know before you travel.'];
  if (b) {
    rows.push(['Journey', b.packageName]);
    rows.push(['Starts', new Date(`${b.travelDate}T12:00:00Z`).toLocaleDateString('en-KE', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' })]);
    rows.push(['Travellers', travellersLabel(b.adults, b.children)]);
    rows.push(['Trip total', kes(b.totalKes)]);
    if (b.plan === 'deposit') {
      rows.push(['Balance to pay', kes(b.balanceKes)]);
      intro.push(`This was your ${b.depositPercent}% deposit. We’ll send you a link for the balance of ${kes(b.balanceKes)} before you travel.`);
    } else if (b.plan === 'balance') {
      intro.push('That was the balance. Your trip is now paid in full.');
    }
  }
  return message(q.email!, `Payment received: Whizperz booking ${q.ref}`, `Thank you, ${firstName(q)}. You’re booked.`, intro, rows);
}

export function refundEmail(q: Quote, r: Refund): EmailMessage {
  const rows: [string, string][] = [
    ['Booking', q.ref],
    ['Refund', kes(r.amountKes)],
  ];
  if (r.reference) rows.push(['Reference', r.reference]);
  return message(
    q.email!,
    `Refund for Whizperz booking ${q.ref}`,
    `Your refund is on its way, ${firstName(q)}`,
    [
      r.via === 'mpesa'
        ? 'The money has been sent back to the M-Pesa number you paid from.'
        : r.via === 'pesapal'
          ? 'The money has been returned to the card or account you paid with. Banks can take a few days to show it.'
          : 'We’ve refunded your payment.',
      'If you have any questions, just reply to this email.',
    ],
    rows,
  );
}

/* ---------- Alerts for the Whizperz team ---------- */

export function adminPaidEmail(to: string, q: Quote, p: Payment, adminUrl: string): EmailMessage {
  return message(
    to,
    `Paid: ${kes(p.amountKes)} for ${q.ref} (${q.guestName})`,
    'Payment received',
    [`${q.guestName} has paid for ${q.description}.`],
    [
      ['Booking', q.ref],
      ['Amount', kes(p.amountKes)],
      ['Method', methodLabel(p)],
      ['Receipt', p.receipt ?? 'none'],
    ],
    { href: adminUrl, label: 'Open in admin' },
  );
}

export function adminAttentionEmail(to: string, q: Quote, what: string, adminUrl: string): EmailMessage {
  return message(to, `Needs checking: ${q.ref} (${q.guestName})`, 'A booking needs checking', [what], [['Booking', q.ref], ['Guest', q.guestName]], {
    href: adminUrl,
    label: 'Open in admin',
  });
}

export function adminRefundEmail(to: string, q: Quote, r: Refund, adminUrl: string): EmailMessage {
  return message(
    to,
    `Refund ${r.status === 'completed' ? 'completed' : 'failed'}: ${kes(r.amountKes)} for ${q.ref}`,
    r.status === 'completed' ? 'Refund completed' : 'Refund failed',
    [r.status === 'completed' ? `The refund to ${q.guestName} went through.` : `The refund to ${q.guestName} did not go through: ${r.failureReason ?? 'no reason given'}.`],
    [
      ['Booking', q.ref],
      ['Amount', kes(r.amountKes)],
    ],
    { href: adminUrl, label: 'Open in admin' },
  );
}

export function testEmail(to: string): EmailMessage {
  return message(to, 'Whizperz test email', 'Email is working', ['This is a test from your Whizperz admin. Receipts and payment alerts will be sent the same way.']);
}
