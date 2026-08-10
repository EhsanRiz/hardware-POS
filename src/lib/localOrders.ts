// Durable on-device store of open orders saved while offline (or when a save
// request failed mid-flight). Mirrors queue.ts but for "park this tab" orders
// rather than completed payments. Synced to the server by sync.ts when the
// connection returns. Stored in localStorage so they survive refreshes.
import { cacheGet, cacheSet } from "./localCache";
import type { CartLine } from "./types";

export interface LocalOrder {
  localId: string; // local id (also the list key); never sent to the server
  label: string | null;
  lines: CartLine[]; // full product + qty so the order can be reopened offline
  cashierId: string;
  cashierName: string;
  total: number;
  createdAt: string; // ISO time the order was parked
}

const KEY = "orders.local";

type Listener = () => void;
const listeners = new Set<Listener>();
export function onLocalOrdersChange(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
function notify() {
  listeners.forEach((l) => l());
}

export function listLocalOrders(): LocalOrder[] {
  return cacheGet<LocalOrder[]>(KEY, []);
}

export function localOrdersCount(): number {
  return listLocalOrders().length;
}

// Create or update (by localId) a parked order.
export function saveLocalOrder(order: LocalOrder): void {
  const all = listLocalOrders();
  const idx = all.findIndex((o) => o.localId === order.localId);
  if (idx >= 0) all[idx] = order;
  else all.push(order);
  cacheSet(KEY, all);
  notify();
}

export function removeLocalOrder(localId: string): void {
  cacheSet(
    KEY,
    listLocalOrders().filter((o) => o.localId !== localId)
  );
  notify();
}
