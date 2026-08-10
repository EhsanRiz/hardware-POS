// Durable on-device queue of sales taken while offline (or when a request
// failed mid-flight). Items are replayed to the server by sync.ts. Stored in
// localStorage so they survive refreshes and reboots.
//
// Note what is *not* stored: no PIN, ever. A queued sale carries the register's
// token implicitly (it belongs to this device) and the cashier's id, which is
// all the server needs to replay it.
import { cacheGet, cacheSet } from "./localCache";
import type { CartLine, PaymentMethod } from "./types";

export interface QueuedSalePayload {
  /** Idempotency key — also the local sale id until the server assigns one. */
  clientUuid: string;
  cashierId: string;
  cashierName: string;
  lines: CartLine[];
  discountAmount: number;
  discountReason: string | null;
  paymentMethod: PaymentMethod;
  amountTendered: number | null;
  changeDue: number | null;
  subtotal: number;
  total: number;
  /** Verified against the device credential cache at the time of sale. */
  approvedBy: string | null;
  approvedByName: string | null;
  customerId: string | null;
  customerName: string | null;
  tradePricing: boolean;
  paidCash: number | null;
  paidCard: number | null;
  /** ISO time the sale was actually taken, not when it syncs. */
  createdAt: string;
}

export interface QueuedSale extends QueuedSalePayload {
  attempts: number;
  lastError?: string;
}

const Q_KEY = "queue.sales";
const DEAD_KEY = "queue.failed";

type Listener = () => void;
const listeners = new Set<Listener>();
export function onQueueChange(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
function notify() {
  listeners.forEach((l) => l());
}

export function listQueue(): QueuedSale[] {
  return cacheGet<QueuedSale[]>(Q_KEY, []);
}
export function queueCount(): number {
  return listQueue().length;
}
export function listFailed(): QueuedSale[] {
  return cacheGet<QueuedSale[]>(DEAD_KEY, []);
}
export function failedCount(): number {
  return listFailed().length;
}

export function enqueue(payload: QueuedSalePayload): void {
  const q = listQueue();
  // Guard against a double-enqueue of the same sale.
  if (q.some((i) => i.clientUuid === payload.clientUuid)) return;
  q.push({ ...payload, attempts: 0 });
  cacheSet(Q_KEY, q);
  notify();
}

export function removeFromQueue(clientUuid: string): void {
  cacheSet(
    Q_KEY,
    listQueue().filter((i) => i.clientUuid !== clientUuid)
  );
  notify();
}

export function bumpAttempt(clientUuid: string, error?: string): void {
  cacheSet(
    Q_KEY,
    listQueue().map((i) =>
      i.clientUuid === clientUuid
        ? { ...i, attempts: i.attempts + 1, lastError: error }
        : i
    )
  );
  notify();
}

// Move a permanently-rejected item (a server validation error, not a network
// blip) out of the active queue so it stops blocking the rest, but keep it so a
// manager can see and re-key it.
export function moveToFailed(item: QueuedSale, error: string): void {
  const dead = listFailed();
  dead.push({ ...item, lastError: error });
  cacheSet(DEAD_KEY, dead);
  removeFromQueue(item.clientUuid);
}

export function clearFailed(): void {
  cacheSet(DEAD_KEY, []);
  notify();
}

/** Discard a single failed item. */
export function removeFailed(clientUuid: string): void {
  cacheSet(
    DEAD_KEY,
    listFailed().filter((i) => i.clientUuid !== clientUuid)
  );
  notify();
}

/** Move a failed item back into the active queue to try syncing it again. */
export function requeueFailed(clientUuid: string): void {
  const item = listFailed().find((i) => i.clientUuid === clientUuid);
  if (!item) return;
  removeFailed(clientUuid);
  const { attempts: _a, lastError: _e, ...payload } = item;
  void _a;
  void _e;
  enqueue(payload);
}
