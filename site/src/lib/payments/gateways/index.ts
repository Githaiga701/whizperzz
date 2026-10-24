import type { PaymentConfig } from '../config';
import type { FetchLike } from '../http';
import { createIpos } from './ipos';
import { createNowPayments } from './nowpayments';
import { createUnipesa } from './unipesa';
import type { Gateway, GatewayId } from './types';

export type Gateways = Partial<Record<GatewayId, Gateway>>;

export const GATEWAY_IDS: readonly GatewayId[] = ['ipos', 'unipesa', 'crypto'];

/** The gateways whose settings are complete. */
export function createGateways(config: PaymentConfig, fetchImpl: FetchLike = fetch): Gateways {
  const g: Gateways = {};
  if (config.ipos) g.ipos = createIpos(config.ipos, fetchImpl);
  if (config.unipesa) g.unipesa = createUnipesa(config.unipesa, fetchImpl);
  if (config.crypto) g.crypto = createNowPayments(config.crypto, fetchImpl);
  return g;
}

export function isGatewayId(v: unknown): v is GatewayId {
  return typeof v === 'string' && (GATEWAY_IDS as readonly string[]).includes(v);
}

export * from './types';
