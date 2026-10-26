import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

export type Provider = 'mpesa' | 'pesapal' | 'ipos' | 'unipesa' | 'crypto' | 'manual';
/** Payment services that send the guest to their own checkout page and tell us the result afterwards. */
export type GatewayId = 'ipos' | 'unipesa' | 'crypto';
export type QuoteStatus = 'awaiting_payment' | 'paid' | 'cancelled' | 'refunded';
export type PaymentStatus = 'pending' | 'paid' | 'failed';
export type RefundStatus = 'requested' | 'completed' | 'failed';

export interface Payment {
  id: string;
  provider: Provider;
  status: PaymentStatus;
  amountKes: number;
  /** M-Pesa CheckoutRequestID or Pesapal OrderTrackingId. */
  providerRef: string;
  /** Pesapal merchant reference (our id sent to Pesapal). */
  merchantRef?: string;
  /** Phone the M-Pesa prompt went to (normalised). */
  phone?: string;
  /** M-Pesa receipt number or Pesapal confirmation code. */
  receipt?: string;
  failureReason?: string;
  /** Set when something looked wrong (e.g. amount mismatch) and a person should check it. */
  flag?: string;
  /** How it was paid: "Visa", "cash", "bank transfer"… */
  method?: string;
  /** Free-text note from whoever recorded a manual payment. */
  note?: string;
  /** What the guest was actually charged when it wasn't in shillings (iPOS Pay and crypto charge in US dollars). */
  charged?: { amount: number; currency: string; rate?: number };
  /** The gateway's own id for the payment, when it's different from providerRef (NOWPayments payment_id). */
  txnId?: string;
  createdAt: string;
  updatedAt: string;
}

export interface Refund {
  id: string;
  paymentId: string;
  /** "mpesa" / "pesapal" when sent through the provider; "manual" when recorded after refunding another way. */
  via: Provider;
  status: RefundStatus;
  amountKes: number;
  reason: string;
  /** M-Pesa reversal transaction id, Pesapal reference, or what the admin typed for a manual refund. */
  reference?: string;
  /** Daraja ids used to match the reversal result. */
  conversationId?: string;
  originatorConversationId?: string;
  failureReason?: string;
  by: string;
  createdAt: string;
  updatedAt: string;
}

export interface HistoryEntry {
  at: string;
  /** Admin username, or "guest" / "system". */
  by: string;
  text: string;
}

/** Present when the guest booked a journey from its page (or for the balance of such a booking). */
export interface Booking {
  packageId: string;
  packageName: string;
  /** YYYY-MM-DD */
  travelDate: string;
  adults: number;
  children: number;
  totalKes: number;
  /** deposit / full: paid at booking. balance: the rest of a deposit booking. */
  plan: 'deposit' | 'full' | 'balance';
  depositPercent: number;
  balanceKes: number;
  /** On a deposit booking: the quote created for the balance. */
  balanceRef?: string;
  /** On a balance quote: the original booking. */
  parentRef?: string;
}

export interface Quote {
  ref: string;
  guestName: string;
  description: string;
  amountKes: number;
  email?: string;
  phone?: string;
  status: QuoteStatus;
  createdAt: string;
  paidAt?: string;
  cancelledAt?: string;
  payments: Payment[];
  refunds?: Refund[];
  history?: HistoryEntry[];
  booking?: Booking;
}

interface State {
  version: 1;
  quotes: Record<string, Quote>;
}

export interface Persistence {
  read(): Promise<State | null>;
  write(state: State): Promise<void>;
}

/** Saves to a JSON file. Writes go to a temp file first, then replace the real one, so a crash never leaves half a file. */
export function filePersistence(dataDir: string): Persistence {
  const file = join(dataDir, 'payments.json');
  return {
    async read() {
      try {
        return JSON.parse(await readFile(file, 'utf8')) as State;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw err;
      }
    },
    async write(state) {
      await mkdir(dirname(file), { recursive: true });
      const tmp = `${file}.${process.pid}.tmp`;
      await writeFile(tmp, JSON.stringify(state, null, 2), 'utf8');
      await rename(tmp, file);
    },
  };
}

export function memoryPersistence(): Persistence & { snapshot(): State | null } {
  let saved: State | null = null;
  return {
    async read() {
      return saved ? structuredClone(saved) : null;
    },
    async write(state) {
      saved = structuredClone(state);
    },
    snapshot: () => saved,
  };
}

/**
 * How quotes are kept. `change` runs one change to one quote at a time (here and, with Redis, across every copy
 * of the site), so a payment confirmation and a status check arriving together can't overwrite each other.
 */
export interface QuoteRecords {
  all(): Promise<Quote[]>;
  get(ref: string): Promise<Quote | undefined>;
  change<T>(ref: string, fn: (current: Quote | undefined) => { next: Quote; result: T }): Promise<T>;
}

/** All quotes in one saved state (a JSON file, or memory in tests), changed one at a time in this process. */
export function stateRecords(persistence: Persistence): QuoteRecords {
  let state: State | undefined;
  let queue: Promise<unknown> = Promise.resolve();
  const load = async (): Promise<State> => (state ??= (await persistence.read()) ?? { version: 1, quotes: {} });
  return {
    async all() {
      return Object.values((await load()).quotes);
    },
    async get(ref) {
      return (await load()).quotes[ref];
    },
    change(ref, fn) {
      const run = queue.then(async () => {
        const s = await load();
        const { next, result } = fn(s.quotes[ref] ? structuredClone(s.quotes[ref]) : undefined);
        const before = s.quotes[ref];
        s.quotes[ref] = next;
        try {
          await persistence.write(s);
        } catch (err) {
          // Keep memory in step with what was actually saved.
          if (before) s.quotes[ref] = before;
          else delete s.quotes[ref];
          throw err;
        }
        return result;
      });
      queue = run.catch(() => undefined);
      return run;
    },
  };
}

export class QuoteStore {
  private readonly records: QuoteRecords;

  constructor(persistence: Persistence | QuoteRecords) {
    this.records = 'change' in persistence ? persistence : stateRecords(persistence);
  }

  async get(ref: string): Promise<Quote | undefined> {
    const q = await this.records.get(ref);
    return q ? structuredClone(q) : undefined;
  }

  async list(): Promise<Quote[]> {
    return (await this.records.all()).map((q) => structuredClone(q)).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  /** Finds a payment by the reference we sent the provider (our merchant reference). */
  async findByMerchantRef(provider: Provider, merchantRef: string): Promise<{ quote: Quote; payment: Payment } | undefined> {
    for (const q of await this.records.all()) {
      const p = q.payments.find((x) => x.provider === provider && x.merchantRef === merchantRef);
      if (p) return { quote: structuredClone(q), payment: structuredClone(p) };
    }
    return undefined;
  }

  async findPayment(provider: Provider, providerRef: string): Promise<{ quote: Quote; payment: Payment } | undefined> {
    for (const q of await this.records.all()) {
      const p = q.payments.find((x) => x.provider === provider && x.providerRef === providerRef);
      if (p) return { quote: structuredClone(q), payment: structuredClone(p) };
    }
    return undefined;
  }

  /** First quote matching a test, e.g. the one holding a refund with a given Daraja conversation id. */
  async find(test: (q: Quote) => boolean): Promise<Quote | undefined> {
    const q = (await this.records.all()).find(test);
    return q ? structuredClone(q) : undefined;
  }

  create(quote: Quote): Promise<Quote> {
    return this.records.change(quote.ref, (current) => {
      if (current) throw new Error(`Quote ${quote.ref} already exists`);
      return { next: structuredClone(quote), result: structuredClone(quote) };
    });
  }

  /** Applies a change to one quote and saves it. The change function gets a copy; returning it commits. */
  update(ref: string, change: (q: Quote) => Quote | void): Promise<Quote> {
    return this.records.change(ref, (current) => {
      if (!current) throw new Error(`Quote ${ref} not found`);
      const next = change(current) ?? current;
      return { next, result: structuredClone(next) };
    });
  }
}
