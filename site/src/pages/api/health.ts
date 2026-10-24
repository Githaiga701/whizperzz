import type { APIRoute } from 'astro';
import { pesapalReady } from '@/lib/payments/config';
import { getPaymentDeps, json } from '@/lib/server/payments';

export const prerender = false;

/** Quick check for uptime monitors: is the server up, and which payment methods are on? */
export const GET: APIRoute = () => {
  const { config } = getPaymentDeps();
  return json(200, { ok: true, mode: config.mode, mpesa: Boolean(config.mpesa), card: pesapalReady(config) });
};
