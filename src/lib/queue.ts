// Durable on-device queue of sales taken while offline (or when a request
// failed mid-flight). Items are replayed to the server by sync.ts. Stored in
// localStorage so they survive refreshes and reboots.
//
// Note what is *not* stored: no PIN, ever. A queued sale carries the register's
// token implicitly (it belongs to this device) and the cashier's id, which is
// all the server needs to replay it.
import { cacheGet, cacheSet } from "./localCache";
import type { CartLine, Payment, PaymentMethod } from "./types";

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
  /**
   * A manager's single-use approval code, if one released this sale. It cannot
   * be verified on the device, so it rides the queue and is spent at sync — a
   * sale taken while the code was live is honoured even if the line comes back
   * after it expired.
   */
  approvalCode?: string | null;
  customerId: string | null;
  customerName: string | null;
  tradePricing: boolean;
  paidCash: number | null;
  paidCard: number | null;
  /** Every tender taken. Replayed verbatim so the server rebuilds the same sale. */
  payments?: Payment[] | null;
  poNumber?: string | null;
  customerVatNumber?: string | null;
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

/**
 * Actions from a phone taken with the line down, replayed like sales are.
 *
 * The first is a delivery marked off at the site, where the signal is worst
 * and the page is signed. It carries the ids the server needs and the time
 * it was marked; no PIN, because pos_mark_delivered takes none.
 */
export interface QueuedAction {
  id: string;
  kind: "mark_delivered";
  deliveryId: string;
  userId: string;
  /** ISO time it was marked on the phone, kept when it syncs. */
  at: string;
  attempts: number;
  lastError?: string;
}

const A_KEY = "queue.actions";
const A_DEAD_KEY = "queue.actions_failed";

export function listActions(): QueuedAction[] {
  return cacheGet<QueuedAction[]>(A_KEY, []);
}
export function actionCount(): number {
  return listActions().length;
}
/** Deliveries this device has marked off but not yet told the server about. */
export function pendingDeliveryIds(): Set<string> {
  return new Set(listActions().filter((a) => a.kind === "mark_delivered").map((a) => a.deliveryId));
}
export function enqueueAction(a: Omit<QueuedAction, "attempts">): void {
  const q = listActions();
  if (q.some((x) => x.kind === a.kind && x.deliveryId === a.deliveryId)) return;
  cacheSet(A_KEY, [...q, { ...a, attempts: 0 }]);
  notify();
}
export function removeAction(id: string): void {
  cacheSet(A_KEY, listActions().filter((a) => a.id !== id));
  notify();
}
export function failAction(a: QueuedAction, why: string): void {
  cacheSet(A_KEY, listActions().filter((x) => x.id !== a.id));
  cacheSet(A_DEAD_KEY, [...cacheGet<QueuedAction[]>(A_DEAD_KEY, []), { ...a, lastError: why }].slice(-50));
  notify();
}
