// Durable on-device queue of payments taken while offline (or when a payment
// request failed mid-flight). Items are replayed to the server by sync.ts.
// Stored in localStorage so they survive refreshes and reboots.
import { cacheGet, cacheSet } from "./localCache";
import type { CartLine, PaymentMethod } from "./types";

export interface QueuedPaymentPayload {
  clientUuid: string; // idempotency key — also the local sale id
  cashierId: string;
  cashierName: string;
  orderId: string | null;
  lines: CartLine[];
  discountAmount: number;
  discountReason: string | null;
  tipAmount: number;
  paymentMethod: PaymentMethod;
  amountTendered: number | null;
  changeDue: number | null;
  subtotal: number;
  total: number;
  // For discounts approved offline: the approver's id/name (verified against
  // the device credential cache). We deliberately do NOT store the PIN.
  approvedBy: string | null;
  approvedByName: string | null;
  // Set when the sale is charged to a customer account.
  accountId: string | null;
  accountName: string | null;
  // Set for split payments (part cash, part card).
  paidCash: number | null;
  paidCard: number | null;
  createdAt: string; // ISO time the sale was taken
}

export interface QueuedPayment extends QueuedPaymentPayload {
  attempts: number;
  lastError?: string;
}

const Q_KEY = "queue.payments";
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

export function listQueue(): QueuedPayment[] {
  return cacheGet<QueuedPayment[]>(Q_KEY, []);
}
export function queueCount(): number {
  return listQueue().length;
}
export function listFailed(): QueuedPayment[] {
  return cacheGet<QueuedPayment[]>(DEAD_KEY, []);
}
export function failedCount(): number {
  return listFailed().length;
}

export function enqueue(payload: QueuedPaymentPayload): void {
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

// Move a permanently-rejected item (server validation error, not a network
// blip) out of the active queue so it stops blocking the rest, but keep it so a
// manager can see/re-key it.
export function moveToFailed(item: QueuedPayment, error: string): void {
  const dead = listFailed();
  dead.push({ ...item, lastError: error });
  cacheSet(DEAD_KEY, dead);
  removeFromQueue(item.clientUuid);
}

export function clearFailed(): void {
  cacheSet(DEAD_KEY, []);
  notify();
}

// Discard a single failed item.
export function removeFailed(clientUuid: string): void {
  cacheSet(
    DEAD_KEY,
    listFailed().filter((i) => i.clientUuid !== clientUuid)
  );
  notify();
}

// Move a failed item back into the active queue to try syncing it again.
export function requeueFailed(clientUuid: string): void {
  const item = listFailed().find((i) => i.clientUuid === clientUuid);
  if (!item) return;
  removeFailed(clientUuid);
  const { attempts: _a, lastError: _e, ...payload } = item;
  void _a;
  void _e;
  enqueue(payload);
}
