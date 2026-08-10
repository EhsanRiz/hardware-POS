import { useCallback, useEffect, useState } from "react";
import type { Sale, User } from "../lib/types";
import { managerListSales } from "../lib/api";
import { money } from "../lib/format";
import { buildInvoicesSlip } from "../lib/receipt";
import { printReceipt } from "../lib/print";

// yyyy-mm-dd for <input type="date"> in local time.
function isoDate(d: Date): string {
  const local = new Date(d.getTime() - d.getTimezoneOffset() * 60000);
  return local.toISOString().slice(0, 10);
}

export default function InvoicesReport({
  managerPin,
  actor,
  onOpen,
}: {
  managerPin: string;
  actor: User;
  onOpen: (sale: Sale) => void;
}) {
  const today = new Date();
  const monthStart = new Date(today.getFullYear(), today.getMonth(), 1);
  const [from, setFrom] = useState(isoDate(monthStart));
  const [to, setTo] = useState(isoDate(today));
  const [sales, setSales] = useState<Sale[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = useCallback(() => {
    setLoading(true);
    setError(null);
    const fromD = new Date(`${from}T00:00:00`);
    const toD = new Date(`${to}T00:00:00`);
    toD.setDate(toD.getDate() + 1); // inclusive end day
    managerListSales(managerPin, fromD, toD, {})
      .then(setSales)
      .catch((e) => setError(e instanceof Error ? e.message : "Failed to load"))
      .finally(() => setLoading(false));
  }, [managerPin, from, to]);

  useEffect(() => {
    run();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const total = sales?.reduce((s, x) => s + x.total, 0) ?? 0;
  const rangeLabel = from === to ? from : `${from} to ${to}`;

  const print = () => {
    if (!sales) return;
    printReceipt(
      buildInvoicesSlip({
        rangeLabel,
        invoices: sales.map((s) => ({
          no: s.id.slice(0, 8),
          at: new Date(s.created_at).toLocaleString([], {
            day: "2-digit",
            month: "2-digit",
            hour: "2-digit",
            minute: "2-digit",
          }),
          total: s.total,
        })),
        count: sales.length,
        total,
        printedBy: actor.name,
      }),
      "Invoices"
    );
  };

  return (
    <div className="space-y-4 animate-fade-in">
      <div className="bg-white border border-stone-200 rounded-xl p-4">
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="block text-sm font-medium text-stone-600 mb-1">From</label>
            <input
              type="date"
              value={from}
              max={to}
              onChange={(e) => setFrom(e.target.value)}
              className="w-full h-11 px-3 rounded-lg border border-stone-300 focus:border-brand outline-none"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-stone-600 mb-1">To</label>
            <input
              type="date"
              value={to}
              min={from}
              onChange={(e) => setTo(e.target.value)}
              className="w-full h-11 px-3 rounded-lg border border-stone-300 focus:border-brand outline-none"
            />
          </div>
        </div>
        <button
          onClick={run}
          disabled={loading}
          className="w-full h-12 mt-3 rounded-lg bg-brand text-white font-semibold active:bg-brand-dark disabled:opacity-40"
        >
          {loading ? "Loading…" : "Show invoices"}
        </button>
      </div>

      {error && <p className="text-red-600">{error}</p>}

      {sales && (
        <>
          <div className="flex items-center justify-between bg-white border border-stone-200 rounded-xl p-4">
            <div>
              <p className="text-taupe text-sm">
                {sales.length} invoice{sales.length === 1 ? "" : "s"}
              </p>
              <p className="text-2xl font-bold text-stone-800">{money(total)}</p>
            </div>
            <button
              onClick={print}
              disabled={sales.length === 0}
              className="h-11 px-4 rounded-lg bg-brand text-white font-semibold active:bg-brand-dark disabled:opacity-40"
            >
              🖨 Print
            </button>
          </div>

          <div className="bg-white border border-stone-200 rounded-xl divide-y divide-stone-100">
            {sales.length === 0 && (
              <p className="p-4 text-stone-400">No invoices in this period.</p>
            )}
            {sales.map((s) => (
              <button
                key={s.id}
                onClick={() => onOpen(s)}
                className="w-full flex items-center gap-3 p-3 text-left active:bg-stone-50"
              >
                <div className="flex-1 min-w-0">
                  <p className="font-medium text-stone-800">#{s.id.slice(0, 8)}</p>
                  <p className="text-xs text-taupe-light">
                    {new Date(s.created_at).toLocaleString([], {
                      day: "2-digit",
                      month: "short",
                      hour: "2-digit",
                      minute: "2-digit",
                    })}
                    {" · "}
                    {s.cashier_name}
                    {s.payment_method ? ` · ${s.payment_method}` : ""}
                  </p>
                </div>
                <span className="font-semibold text-stone-800">{money(s.total)}</span>
                <span className="text-taupe-light">›</span>
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
