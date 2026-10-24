export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export type ProviderName = 'mpesa' | 'pesapal' | 'ipos' | 'unipesa' | 'crypto';

/** An error from a payment provider, with enough detail to log but no secrets. */
export class ProviderError extends Error {
  constructor(
    readonly provider: ProviderName,
    message: string,
    readonly status?: number,
    readonly detail?: unknown,
  ) {
    super(message);
    this.name = 'ProviderError';
  }
}

const TIMEOUT_MS = 20_000;

/** POST/GET JSON with a timeout. Throws ProviderError on network errors, non-2xx and non-JSON replies. */
export async function requestJson<T>(
  provider: ProviderName,
  fetchImpl: FetchLike,
  url: string,
  init: RequestInit,
): Promise<T> {
  let res: Response;
  try {
    res = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (err) {
    throw new ProviderError(provider, `Could not reach ${provider}: ${(err as Error).message}`);
  }
  const text = await res.text();
  let body: unknown;
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    throw new ProviderError(provider, `${provider} replied with something that isn't JSON (HTTP ${res.status})`, res.status, text.slice(0, 300));
  }
  if (!res.ok) {
    const b = body as Record<string, unknown>;
    const nested = b['error'];
    const msg = String(
      b['errorMessage'] ??
        (nested && typeof nested === 'object' ? (nested as Record<string, unknown>)['message'] : nested) ??
        b['message'] ??
        b['responseMessage'] ??
        `HTTP ${res.status}`,
    );
    throw new ProviderError(provider, `${provider} error: ${msg}`, res.status, body);
  }
  return body as T;
}
