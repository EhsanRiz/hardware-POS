// On-device snapshot of the server's open orders (with items), refreshed every
// time we successfully fetch them online. It keeps previously-saved tabs visible
// and reopenable after the connection drops, since the server can't be reached
// offline to re-list them.
import { cacheGet, cacheSet } from "./localCache";
import type { OpenOrderFull } from "./types";

const KEY = "orders.serverCache";

export function cacheServerOrders(orders: OpenOrderFull[]): void {
  cacheSet(KEY, orders);
}

export function getCachedServerOrders(): OpenOrderFull[] {
  return cacheGet<OpenOrderFull[]>(KEY, []);
}
