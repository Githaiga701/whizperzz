import { gatewayCallback } from '@/lib/server/gateway-callback';

export const prerender = false;

export const { POST, GET } = gatewayCallback('unipesa');
