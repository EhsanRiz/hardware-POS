import { useEffect, useState } from "react";
import {
  listFailed,
  onQueueChange,
  removeFailed,
  requeueFailed,
  type QueuedSale,
} from "../lib/queue";
import { syncNow } from "../lib/sync";
import { useOnline } from "../lib/offline";
import { money } from "../lib/format";
import { itemLabel } from "../lib/receipt";
import { fmtDayMonthTime } from "../lib/dates";

// Manager view of sales that were taken offline on this device but the server
// rejected on sync. Lets them read the reason and retry or discard each one.
export default function FailedSales({ onClose }: { onClose: () => void }) {
  const online = useOnline();
  const [items, setItems] = useState<QueuedSale[]>(listFailed());

  useEffect(() => onQueueChange(() => setItems(listFailed())), []);
  // Nothing left to show → close automatically.
  useEffect(() => {
    if (items.length === 0) onClose();
  }, [items.length, onClose]);

  const summary = (it: QueuedSale) =>
    it.lines
      .map((l) => itemLabel(l.qty, l.product.unit_code, l.product.name))
      .join(", ") || "—";

  return (
    <div className="vv-fixed bg-black/50 flex items-center justify-center p-4 z-50 animate-fade-in">
      <div className="bg-white rounded-2xl w-full max-w-md animate-scale-in max-h-[85vh] flex flex-col">
        <div className="flex items-center justify-between p-5 border-b border-stone-200">
          <h2 className="text-xl font-bold text-stone-800">Failed sales</h2>
          <button onClick={onClose} className="text-stone-400 text-2xl leading-none">
            ×
          </button>
        </div>

        <div className="p-4 overflow-y-auto">
          <p className="text-sm text-stone-500 mb-3">
            These sales were taken on this device while offline, but the server
            rejected them on sync — so they are <b>not</b> in your totals. Retry
            once the menu is up to date, or discard if the sale wasn't real.
          </p>

          <div className="space-y-3">
            {items.map((it) => (
              <div
                key={it.clientUuid}
                className="rounded-xl border border-red-200 bg-red-50/40 p-3"
              >
                <div className="flex items-center justify-between">
                  <span className="font-semibold text-stone-800">
                    {money(it.total)}
                    <span className="ml-2 text-xs font-normal text-stone-500 capitalize">
                      {it.paymentMethod}
                    </span>
                  </span>
                  <span className="text-xs text-stone-500">
                    {fmtDayMonthTime(it.createdAt)}
                  </span>
                </div>
                <p className="text-sm text-stone-600 mt-1">{summary(it)}</p>
                <p className="text-xs text-stone-400 mt-0.5">
                  by {it.cashierName}
                </p>
                {it.lastError && (
                  <p className="mt-2 text-xs text-red-700 bg-red-100 rounded-lg px-2 py-1">
                    Reason: {it.lastError}
                  </p>
                )}
                <div className="flex gap-2 mt-3">
                  <button
                    onClick={() => {
                      requeueFailed(it.clientUuid);
                      void syncNow();
                    }}
                    disabled={!online}
                    className="flex-1 h-10 rounded-lg bg-gold-400 text-colophon text-sm font-semibold active:bg-gold disabled:opacity-40"
                  >
                    {online ? "Try again" : "Offline"}
                  </button>
                  <button
                    onClick={() => removeFailed(it.clientUuid)}
                    className="flex-1 h-10 rounded-lg bg-white border border-red-300 text-red-700 text-sm font-medium active:bg-red-50"
                  >
                    Discard
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
