/**
 * Browser requests with the unhappy paths handled: a timeout, a "this is slow" signal, and a clear answer to
 * "did it fail because we're offline, because it took too long, or because the server said no?".
 *
 * Connectivity is judged by real requests: a request that can't connect marks us offline, any reply from the
 * server marks us online. `navigator.onLine` only says whether there's a network, not whether it works.
 */

export type RequestOutcome =
  | { kind: 'reply'; res: Response }
  /** Never reached the server: no connection, DNS, blocked. */
  | { kind: 'offline' }
  /** Gave up waiting (our timeout). The server may still have done the work. */
  | { kind: 'timeout' }
  /** Cancelled by the caller's own signal. */
  | { kind: 'cancelled' };

export interface RequestOptions {
  /** Give up after this long. Default 30 s. */
  timeoutMs?: number;
  /** Call `onSlow` once if there's no reply after this long. Default 8 s. */
  slowMs?: number;
  onSlow?: () => void;
  /** Lets the caller cancel (e.g. the guest leaves the page or starts again). */
  signal?: AbortSignal;
}

export const SLOW_MS = 8_000;
export const TIMEOUT_MS = 30_000;

/* ---------- Connectivity, shared by every request on the page ---------- */

type Listener = (online: boolean) => void;
const listeners = new Set<Listener>();
let online = true;

/** Whether the last real request reached the server. */
export function isOnline(): boolean {
  return online;
}

/** Hear about the connection dropping or coming back. Returns a function that stops listening. */
export function onConnectivity(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function reportConnectivity(now: boolean): void {
  if (now === online) return;
  online = now;
  listeners.forEach((fn) => fn(now));
}

/* ---------- Requests ---------- */

export async function request(url: string, init: RequestInit = {}, opts: RequestOptions = {}): Promise<RequestOutcome> {
  const { timeoutMs = TIMEOUT_MS, slowMs = SLOW_MS, onSlow, signal } = opts;
  if (signal?.aborted) return { kind: 'cancelled' };
  const ctrl = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    ctrl.abort();
  }, timeoutMs);
  const slow = onSlow ? setTimeout(onSlow, slowMs) : undefined;
  const cancel = () => ctrl.abort();
  signal?.addEventListener('abort', cancel, { once: true });
  try {
    const res = await fetch(url, { ...init, signal: ctrl.signal });
    reportConnectivity(true);
    return { kind: 'reply', res };
  } catch {
    if (timedOut) return { kind: 'timeout' };
    if (signal?.aborted) return { kind: 'cancelled' };
    // Chrome says "Failed to fetch", Safari "Load failed", Firefox "NetworkError": all mean no connection.
    reportConnectivity(false);
    return { kind: 'offline' };
  } finally {
    clearTimeout(timer);
    if (slow !== undefined) clearTimeout(slow);
    signal?.removeEventListener('abort', cancel);
  }
}

/** Wait before retry number `attempt` (0-based): 2 s, 4 s, 8 s… up to `max`, with a little jitter. */
export function backoff(attempt: number, base = 2_000, max = 30_000, random = Math.random): number {
  const ms = Math.min(max, base * 2 ** Math.max(0, attempt));
  return Math.round(ms * (0.85 + random() * 0.3));
}

/** A random id for one booking attempt, so a retry can't book twice. */
export function attemptId(): string {
  const c = globalThis.crypto;
  if (c?.randomUUID) return c.randomUUID();
  const bytes = new Uint8Array(16);
  c.getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/* ---------- Words for the guest ---------- */

export const MESSAGES = {
  offline: 'You’re offline, so nothing was sent. Your details are still here: try again once you’re connected.',
  slow: 'Still working on it. Your connection seems slow, so please keep this page open.',
  timeout: 'That took too long and we stopped waiting. Please try again.',
} as const;
