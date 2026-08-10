import { useEffect, useMemo, useRef, useState } from "react";
import { money } from "../lib/format";
import type { Category, Product } from "../lib/types";

/**
 * Finding a product in a hardware shop.
 *
 * The cafe's photo-tile grid works for forty items and falls apart at four
 * thousand, so the primary input here is the keyboard: type a few characters of
 * a name or a SKU and the list narrows. A barcode scanner is just a keyboard
 * that types fast and presses Enter, so scanning works through the same box
 * with no extra hardware integration — an exact barcode match adds the item to
 * the cart immediately and clears the field, ready for the next scan.
 *
 * Category tiles remain as a fallback for the loose goods that have no barcode
 * and whose names nobody can spell (sand, stone, cut lengths).
 */
export default function ProductSearch({
  products,
  categories,
  trade,
  onAdd,
}: {
  products: Product[];
  categories: Category[];
  trade: boolean;
  onAdd: (p: Product) => void;
}) {
  const [term, setTerm] = useState("");
  const [category, setCategory] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Keep focus in the search box: a scanner types wherever the caret is, and a
  // scan that lands in a quantity field would be a silent mis-sale.
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const price = (p: Product) =>
    trade && p.price_trade != null ? p.price_trade : p.price_retail;

  const matches = useMemo(() => {
    const q = term.trim().toLowerCase();
    let list = products;
    if (category) list = list.filter((p) => p.category_id === category);
    if (!q) return list.slice(0, 60);
    return list
      .filter(
        (p) =>
          p.name.toLowerCase().includes(q) ||
          p.sku.toLowerCase().includes(q) ||
          (p.barcode ?? "").includes(q)
      )
      .slice(0, 60);
  }, [products, term, category]);

  function submit(e: React.FormEvent) {
    e.preventDefault();
    const q = term.trim();
    if (!q) return;

    // An exact barcode or SKU is unambiguous — treat it as a scan and ring it
    // straight through rather than making the cashier pick from a list of one.
    const exact =
      products.find((p) => p.barcode && p.barcode === q) ??
      products.find((p) => p.sku.toLowerCase() === q.toLowerCase());
    if (exact) {
      onAdd(exact);
      setTerm("");
      return;
    }
    // Otherwise, if the search has narrowed to a single line, take it.
    if (matches.length === 1) {
      onAdd(matches[0]);
      setTerm("");
    }
  }

  return (
    <div className="flex flex-col h-full min-h-0">
      <form onSubmit={submit} className="p-3 pb-2">
        <input
          ref={inputRef}
          type="search"
          value={term}
          onChange={(e) => setTerm(e.target.value)}
          placeholder="Scan barcode, or type a name or SKU…"
          autoComplete="off"
          className="w-full rounded-xl border border-stone-300 px-4 py-3 text-lg
                     focus:outline-none focus:ring-2 focus:ring-emerald-500"
        />
      </form>

      <div className="flex gap-2 overflow-x-auto px-3 pb-2 shrink-0">
        <button
          onClick={() => setCategory(null)}
          className={`px-3 py-1.5 rounded-full text-sm whitespace-nowrap ${
            category === null
              ? "bg-stone-800 text-white"
              : "bg-stone-100 text-stone-700"
          }`}
        >
          All
        </button>
        {categories.map((c) => (
          <button
            key={c.id}
            onClick={() => setCategory(c.id === category ? null : c.id)}
            className={`px-3 py-1.5 rounded-full text-sm whitespace-nowrap ${
              category === c.id
                ? "bg-stone-800 text-white"
                : "bg-stone-100 text-stone-700"
            }`}
          >
            {c.name}
          </button>
        ))}
      </div>

      <div className="flex-1 overflow-y-auto px-3 pb-3">
        {matches.length === 0 && (
          <p className="text-stone-500 text-sm p-4 text-center">
            Nothing matches “{term}”.
          </p>
        )}
        <ul className="divide-y divide-stone-100">
          {matches.map((p) => {
            const out = p.stock_qty != null && p.stock_qty <= 0;
            const low =
              p.stock_qty != null &&
              p.reorder_level != null &&
              p.stock_qty > 0 &&
              p.stock_qty <= p.reorder_level;
            return (
              <li key={p.id}>
                <button
                  disabled={out}
                  onClick={() => onAdd(p)}
                  className="w-full text-left py-2.5 px-2 flex items-center gap-3
                             hover:bg-stone-50 disabled:opacity-40
                             disabled:cursor-not-allowed rounded-lg"
                >
                  <div className="min-w-0 flex-1">
                    <div className="font-medium text-stone-900 truncate">
                      {p.name}
                    </div>
                    <div className="text-xs text-stone-500 flex gap-2">
                      <span className="font-mono">{p.sku}</span>
                      <span>per {p.unit_code}</span>
                      {out && (
                        <span className="text-red-600 font-medium">
                          out of stock
                        </span>
                      )}
                      {low && (
                        <span className="text-amber-600 font-medium">
                          low: {p.stock_qty} left
                        </span>
                      )}
                    </div>
                  </div>
                  <div className="text-right shrink-0">
                    <div className="font-semibold tabular-nums">
                      {money(price(p))}
                    </div>
                    {trade && p.price_trade != null && (
                      <div className="text-[11px] text-emerald-700">trade</div>
                    )}
                  </div>
                </button>
              </li>
            );
          })}
        </ul>
      </div>
    </div>
  );
}
