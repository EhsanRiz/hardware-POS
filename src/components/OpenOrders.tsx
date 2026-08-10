import { useEffect, useState } from "react";
import type { OpenOrder } from "../lib/types";
import { cancelOrder, listOpenOrdersFull } from "../lib/api";
import {
  listLocalOrders,
  onLocalOrdersChange,
  removeLocalOrder,
} from "../lib/localOrders";
import {
  cacheServerOrders,
  getCachedServerOrders,
} from "../lib/openOrdersCache";
import { isNetworkError } from "../lib/offline";
import { money } from "../lib/format";

interface Props {
  cashierId: string;
  onReopen: (order: OpenOrder) => void;
  onClose: () => void;
}

// Map the on-device parked orders into the same shape as server orders, tagged
// so the UI can badge them and route reopen/cancel locally.
function localAsOpenOrders(): OpenOrder[] {
  return listLocalOrders().map((o) => ({
    id: o.localId,
    localId: o.localId,
    pending: true,
    label: o.label,
    cashier_name: o.cashierName,
    total: o.total,
    item_count: o.lines.reduce((s, l) => s + l.qty, 0),
    created_at: o.createdAt,
  }));
}

export default function OpenOrders({ cashierId, onReopen, onClose }: Props) {
  const [serverOrders, setServerOrders] = useState<OpenOrder[] | null>(null);
  const [local, setLocal] = useState<OpenOrder[]>(localAsOpenOrders());
  const [error, setError] = useState<string | null>(null);

  useEffect(
    () => onLocalOrdersChange(() => setLocal(localAsOpenOrders())),
    []
  );

  const load = () => {
    listOpenOrdersFull(cashierId)
      .then((o) => {
        cacheServerOrders(o); // keep a copy for offline use
        setServerOrders(o);
        setError(null);
      })
      .catch((e) => {
        // Can't reach the server — fall back to the cached snapshot so tabs
        // saved before going offline stay visible. Only surface a real error.
        setServerOrders(getCachedServerOrders());
        if (!isNetworkError(e)) {
          setError(e instanceof Error ? e.message : "Failed to load");
        }
      });
  };
  useEffect(load, [cashierId]);

  const cancel = async (o: OpenOrder) => {
    if (o.localId) {
      removeLocalOrder(o.localId);
      return;
    }
    try {
      await cancelOrder(cashierId, o.id);
      setServerOrders((prev) => (prev ?? []).filter((x) => x.id !== o.id));
    } catch {
      /* ignore */
    }
  };

  // Parked (offline) orders first, then the server's.
  const orders = [...local, ...(serverOrders ?? [])];
  const loading = serverOrders === null;

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center p-4 z-50 animate-fade-in">
      <div className="bg-white rounded-2xl w-full max-w-md animate-scale-in max-h-[85vh] flex flex-col">
        <div className="flex items-center justify-between p-5 border-b border-stone-200">
          <h2 className="text-xl font-bold text-stone-800">Open orders</h2>
          <button onClick={onClose} className="text-stone-400 text-2xl leading-none">
            ×
          </button>
        </div>

        <div className="p-4 overflow-y-auto">
          {error && <p className="text-red-600">{error}</p>}
          {!loading && orders.length === 0 && (
            <p className="text-stone-400 text-center py-8">No open orders.</p>
          )}
          {loading && orders.length === 0 && !error && (
            <p className="text-stone-400">Loading…</p>
          )}

          <div className="space-y-2">
            {orders.map((o) => (
              <div
                key={o.id}
                className="flex items-center gap-3 p-3 rounded-xl border border-stone-200 animate-fade-in"
              >
                <div className="flex-1 min-w-0">
                  <p className="font-semibold text-stone-800 truncate">
                    {o.label || "Unnamed order"}
                    {o.pending && (
                      <span className="ml-2 align-middle text-[10px] font-semibold bg-amber-100 text-amber-800 px-1.5 py-0.5 rounded">
                        not synced
                      </span>
                    )}
                  </p>
                  <p className="text-xs text-taupe">
                    {o.item_count} item{o.item_count === 1 ? "" : "s"} ·{" "}
                    {o.cashier_name} ·{" "}
                    {new Date(o.created_at).toLocaleTimeString([], {
                      hour: "2-digit",
                      minute: "2-digit",
                    })}
                  </p>
                </div>
                <span className="font-semibold text-stone-800">
                  {money(o.total)}
                </span>
                <button
                  onClick={() => cancel(o)}
                  className="text-xs text-red-500 px-2 py-1 rounded active:bg-red-50"
                >
                  Cancel
                </button>
                <button
                  onClick={() => onReopen(o)}
                  className="h-9 px-3 rounded-lg bg-brand text-white text-sm font-semibold active:bg-brand-dark"
                >
                  Open
                </button>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
