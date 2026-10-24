import type { GatewayId } from '../store';

export type { GatewayId };

/** What a gateway tells us about one payment. Amounts are in the gateway's own currency (dollars, not cents). */
export interface GatewayResult {
  outcome: 'paid' | 'failed' | 'pending' | 'underpaid';
  /** The reference we sent them, as they report it back. Checked against ours. */
  merchantRef?: string | undefined;
  amount?: number | undefined;
  currency?: string | undefined;
  /** Receipt / confirmation / transaction number to show the guest and the team. */
  receipt?: string | undefined;
  /** e.g. "VISA ••4242" or "USDT (TRC20)". */
  method?: string | undefined;
  reason?: string | undefined;
}

export interface CheckoutInput {
  merchantRef: string;
  /** In the gateway's currency. */
  amount: number;
  description: string;
  /** Where the guest comes back to (our pay page). */
  returnUrl: string;
  email: string | undefined;
  /** Kenyan mobile in 2547… form, if we have one. */
  phone: string | undefined;
  name: string;
}

/** A notification as it arrived: we never trust it on its own unless the gateway signs it. */
export interface GatewayNotice {
  headers: Headers;
  body: Record<string, unknown>;
  raw: string;
}

export interface ReadNotice {
  merchantRef?: string | undefined;
  /** The gateway's own payment id, when it needs one to look the payment up later. */
  txnId?: string | undefined;
  /** Present only when the notice carried a valid signature, so its contents can be believed. */
  verified?: GatewayResult | undefined;
}

export interface Gateway {
  id: GatewayId;
  /** Shown to guests and in the admin. */
  label: string;
  /** The currency this gateway charges in. */
  currency: 'KES' | 'USD';
  /** Our reference for the n-th attempt on a quote, in a format the gateway accepts. */
  merchantRef(quoteRef: string, attempt: number): string;
  startCheckout(input: CheckoutInput): Promise<{ redirectUrl: string; providerRef: string }>;
  /** Asks the gateway directly. undefined when this gateway can't be asked (yet). */
  checkStatus(payment: { merchantRef: string; providerRef: string; txnId?: string | undefined; amount?: number | undefined }): Promise<GatewayResult | undefined>;
  /** Reads a notification. null = not ours / invalid signature, ignore it. */
  readNotice(notice: GatewayNotice): ReadNotice | null;
  /** Checks the keys work (Settings → Test connection). */
  ping(): Promise<void>;
}

/** Converts shillings to US dollars at our rate, rounded up to the cent. */
export function kesToUsd(kes: number, kesPerUsd: number): number {
  return Math.ceil((kes / kesPerUsd) * 100 - 1e-9) / 100;
}

export function sameMoney(a: number, b: number): boolean {
  return Math.abs(a - b) < 0.005;
}
