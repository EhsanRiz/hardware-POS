import { useEffect, useState } from "react";
import type { Sale } from "../lib/types";
import { managerListSales } from "../lib/api";
import { money } from "../lib/format";

export interface SalesFilter {
  title: string;
  cashier?: string;
  onlyDiscounted?: boolean;
  itemName?: string;
}

interface Props {
  managerPin: string;
  from: Date;
  to: Date;
  filter: SalesFilter;
  onBack: () => void;
  onOpen: (sale: Sale) => void;
}

export default function SalesList({
  managerPin,
  from,
  to,
  filter,
  onBack,
  onOpen,
}: Props) {
  const [sales, setSales] = useState<Sale[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setSales(null);
    managerListSales(managerPin, from, to, {
      cashier: filter.cashier,
      onlyDiscounted: filter.onlyDiscounted,
      itemName: filter.itemName,
    })
      .then(setSales)
      .catch((e) => setError(e instanceof Error ? e.message : "Failed to load"));
  }, [managerPin, from, to, filter]);

  const totalNet = sales?.reduce((s, x) => s + x.total, 0) ?? 0;

  return (
    <div className="animate-fade-in">
      <div className="flex items-center gap-3 mb-4">
        <button
          onClick={onBack}
          className="h-9 px-3 rounded-lg bg-stone-100 text-stone-600 font-medium active:bg-stone-200"
        >
          ← Back
        </button>
        <div>
          <h3 className="font-semibold text-stone-800">{filter.title}</h3>
          {sales && (
            <p className="text-sm text-taupe">
              {sales.length} sales · {money(totalNet)}
            </p>
          )}
        </div>
      </div>

      {error && <p className="text-red-600">{error}</p>}
      {!sales && !error && <p className="text-stone-400">Loading…</p>}

      <div className="bg-white border border-stone-200 rounded-xl divide-y divide-stone-100">
        {sales?.length === 0 && (
          <p className="p-4 text-stone-400">No sales found.</p>
        )}
        {sales?.map((s) => (
          <button
            key={s.id}
            onClick={() => onOpen(s)}
            className="w-full flex items-center gap-3 p-3 text-left active:bg-stone-50"
          >
            <div className="flex-1 min-w-0">
              <p className="font-medium text-stone-800">
                {new Date(s.created_at).toLocaleTimeString([], {
                  hour: "2-digit",
                  minute: "2-digit",
                })}
                <span className="text-taupe font-normal">
                  {" "}
                  · {s.cashier_name}
                </span>
              </p>
              <p className="text-xs text-taupe-light">
                #{s.id.slice(0, 8)}
                {s.discount_amount > 0 && (
                  <span className="ml-2 text-amber-600">
                    −{money(s.discount_amount)} discount
                  </span>
                )}
              </p>
            </div>
            <span className="font-semibold text-stone-800">
              {money(s.total)}
            </span>
            <span className="text-taupe-light">›</span>
          </button>
        ))}
      </div>
    </div>
  );
}
