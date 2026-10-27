import type { PaymentStatus, Provider, QuoteStatus, RefundStatus } from '@/lib/payments/store';

export const STATUS_LABEL: Record<QuoteStatus, string> = {
  awaiting_payment: 'Waiting for payment',
  paid: 'Paid',
  cancelled: 'Cancelled',
  refunded: 'Refunded',
};

export const PAYMENT_STATUS_LABEL: Record<PaymentStatus, string> = {
  pending: 'In progress',
  paid: 'Paid',
  failed: 'Failed',
};

export const REFUND_STATUS_LABEL: Record<RefundStatus, string> = {
  requested: 'In progress',
  completed: 'Done',
  failed: 'Failed',
};

export const PROVIDER_LABEL: Record<Provider, string> = {
  mpesa: 'M-Pesa',
  pesapal: 'Card (Pesapal)',
  ipos: 'iPOS Pay',
  unipesa: 'Unipesa',
  crypto: 'Crypto',
  paystack: 'Paystack',
  manual: 'Recorded by hand',
};

const NAIROBI = 'Africa/Nairobi';

export function shortDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-KE', { timeZone: NAIROBI, day: 'numeric', month: 'short', year: 'numeric' });
}

export function dateTime(iso: string): string {
  return new Date(iso).toLocaleString('en-KE', { timeZone: NAIROBI, day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}
