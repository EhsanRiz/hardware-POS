import { useEffect, useMemo, useState } from "react";
import {
  itemHistory,
  managerListProducts,
  type ItemHistory as ItemHistoryData,
} from "../lib/api";
import type { Product } from "../lib/types";
import { money } from "../lib/format";

// yyyy-mm-dd for <input type="date"> (local date, not UTC).
function isoDate(d: Date): string {
  const local = new Date(d.getTime() - d.getTimezoneOffset() * 60000);
  return local.toISOString().slice(0, 10);
}

// Quick ranges return [from, to] as local yyyy-mm-dd strings.
function quickRange(key: "today" | "yesterday" | "week" | "month"): [string, string] {
  const today = new Date();
  const start = new Date(today);
  const end = new Date(today);
  if (key === "yesterday") {
    start.setDate(start.getDate() - 1);
    end.setDate(end.getDate() - 1);
  } else if (key === "week") {
    start.setDate(start.getDate() - 6);
  } else if (key === "month") {
    start.setDate(start.getDate() - 29);
  }
  return [isoDate(start), isoDate(end)];
}

const QUICK: { key: "today" | "yesterday" | "week" | "month"; label: string }[] = [
  { key: "today", label: "Today" },
  { key: "yesterday", label: "Yesterday" },
  { key: "week", label: "Last week" },
  { key: "month", label: "Last month" },
];

export default function ItemHistory({ managerPin }: { managerPin: string }) {
  const [products, setProducts] = useState<Product[]>([]);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<Product | null>(null);

  // Default to the last 7 days.
  const today = new Date();
  const weekAgo = new Date();
  weekAgo.setDate(weekAgo.getDate() - 6);
  const [from, setFrom] = useState(isoDate(weekAgo));
  const [to, setTo] = useState(isoDate(today));

  const [result, setResult] = useState<ItemHistoryData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    managerListProducts(managerPin)
      .then(setProducts)
      .catch((e) =>
        setError(e instanceof Error ? e.message : "Failed to load products")
      );
  }, [managerPin]);

  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    return products
      .filter(
        (p) =>
          p.name.toLowerCase().includes(q) ||
          p.category.toLowerCase().includes(q)
      )
      .slice(0, 8);
  }, [products, query]);

  const fetchFor = async (fromStr: string, toStr: string) => {
    if (!selected) return;
    setLoading(true);
    setError(null);
    setResult(null);
    try {
      const fromD = new Date(`${fromStr}T00:00:00`);
      // Make the end date inclusive (up to the end of that day).
      const toD = new Date(`${toStr}T00:00:00`);
      toD.setDate(toD.getDate() + 1);
      setResult(await itemHistory(managerPin, selected.id, fromD, toD));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load history");
    } finally {
      setLoading(false);
    }
  };

  const run = () => fetchFor(from, to);

  // Quick range: set the date fields and (if a product is chosen) run it.
  const applyQuick = (key: "today" | "yesterday" | "week" | "month") => {
    const [f, t] = quickRange(key);
    setFrom(f);
    setTo(t);
    if (selected) void fetchFor(f, t);
  };

  return (
    <div className="space-y-4 animate-fade-in">
      {/* Product picker */}
      <div className="bg-white border border-stone-200 rounded-xl p-4">
        <label className="block text-sm font-medium text-stone-600 mb-1">
          Product
        </label>
        {selected ? (
          <div className="flex items-center justify-between gap-2">
            <div className="min-w-0">
              <p className="font-semibold text-stone-800 truncate">
                {selected.name}
              </p>
              <p className="text-sm text-taupe">{selected.category}</p>
            </div>
            <button
              onClick={() => {
                setSelected(null);
                setResult(null);
                setQuery("");
              }}
              className="h-9 px-3 rounded-lg bg-stone-100 text-stone-700 text-sm font-medium active:bg-stone-200 shrink-0"
            >
              Change
            </button>
          </div>
        ) : (
          <>
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search a product…"
              className="w-full h-11 px-3 rounded-lg border border-stone-300 focus:border-brand outline-none"
            />
            {matches.length > 0 && (
              <div className="mt-2 rounded-lg border border-stone-200 divide-y divide-stone-100 max-h-56 overflow-y-auto">
                {matches.map((p) => (
                  <button
                    key={p.id}
                    onClick={() => setSelected(p)}
                    className="w-full flex items-center justify-between px-3 h-11 text-left active:bg-stone-50"
                  >
                    <span className="font-medium text-stone-800 truncate">
                      {p.name}
                    </span>
                    <span className="text-xs text-taupe shrink-0 ml-2">
                      {p.category}
                    </span>
                  </button>
                ))}
              </div>
            )}
          </>
        )}
      </div>

      {/* Date range */}
      <div className="bg-white border border-stone-200 rounded-xl p-4">
        <div className="flex flex-wrap gap-2 mb-3">
          {QUICK.map((q) => (
            <button
              key={q.key}
              onClick={() => applyQuick(q.key)}
              className="h-9 px-3 rounded-full text-sm font-medium bg-stone-100 text-stone-700 active:bg-stone-200"
            >
              {q.label}
            </button>
          ))}
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="block text-sm font-medium text-stone-600 mb-1">
              From
            </label>
            <input
              type="date"
              value={from}
              max={to}
              onChange={(e) => setFrom(e.target.value)}
              className="w-full h-11 px-3 rounded-lg border border-stone-300 focus:border-brand outline-none"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-stone-600 mb-1">
              To
            </label>
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
          disabled={!selected || loading}
          className="w-full h-12 mt-3 rounded-lg bg-brand text-white font-semibold active:bg-brand-dark disabled:opacity-40"
        >
          {loading ? "Loading…" : "Show history"}
        </button>
      </div>

      {error && <p className="text-red-600">{error}</p>}

      {result && (
        <div className="animate-fade-in space-y-3">
          <div className="grid grid-cols-3 gap-3">
            <div className="bg-white border border-stone-200 rounded-xl p-4">
              <p className="text-taupe text-sm">Total sold</p>
              <p className="text-2xl font-bold text-stone-800 mt-1">
                {result.total_qty}
              </p>
            </div>
            <div className="bg-white border border-stone-200 rounded-xl p-4">
              <p className="text-taupe text-sm">Revenue</p>
              <p className="text-2xl font-bold text-stone-800 mt-1">
                {money(result.total_revenue)}
              </p>
            </div>
            <div className="bg-white border border-stone-200 rounded-xl p-4">
              <p className="text-taupe text-sm">No. of sales</p>
              <p className="text-2xl font-bold text-stone-800 mt-1">
                {result.sale_count}
              </p>
            </div>
          </div>

          <div>
            <h3 className="font-semibold text-stone-700 mb-2">
              Each sale ({selected?.name})
            </h3>
            <div className="bg-white border border-stone-200 rounded-xl divide-y divide-stone-100">
              {result.entries.length === 0 && (
                <p className="p-4 text-stone-400">
                  No sales of this item in the selected dates.
                </p>
              )}
              {result.entries.map((e, i) => (
                <div
                  key={`${e.sale_id}-${i}`}
                  className="flex items-center gap-3 p-3"
                >
                  <div className="flex-1 min-w-0">
                    <p className="font-medium text-stone-800 truncate">
                      {e.name}
                    </p>
                    <p className="text-xs text-taupe">
                      {new Date(e.at).toLocaleString([], {
                        weekday: "short",
                        day: "2-digit",
                        month: "short",
                        hour: "2-digit",
                        minute: "2-digit",
                      })}
                      {e.cashier_name ? ` · ${e.cashier_name}` : ""}
                    </p>
                  </div>
                  <span className="text-taupe shrink-0">×{e.qty}</span>
                  <span className="w-20 text-right font-semibold text-brand shrink-0">
                    {money(e.line_total)}
                  </span>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
