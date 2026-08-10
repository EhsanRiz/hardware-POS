import { useEffect, useMemo, useRef, useState } from "react";
import { searchProducts } from "../lib/api";
import { money } from "../lib/format";
import { isNetworkError, useOnline } from "../lib/offline";
import { exactMatch, searchProductsLocal } from "../lib/search";
import type { Category, Product } from "../lib/types";

/**
 * Finding a product in a hardware shop.
 *
 * The cafe's photo-tile grid works for forty items and falls apart at four
 * thousand, so the primary input here is the keyboard. Three things a counter
 * actually needs, in order of how often they matter:
 *
 *   1. SCANNING. A barcode scanner is a keyboard that types fast and presses
 *      Enter, so it works through this same box with no hardware integration.
 *      An exact code rings straight through rather than showing a list of one.
 *   2. THE SHOP'S NAME vs THE CUSTOMER'S WORDS. Someone asks for a "concrete
 *      nail 2.5x5"; the shelf label says "Nail Concrete 2.5 x 50mm". Matching
 *      each word independently and normalising size notation bridges that.
 *   3. TYPOS, because the counter is busy.
 *
 * The server does this better — it sees the whole catalogue and has real
 * indexes — so it is used when the network is up. When it is not, the same
 * logic runs on the cached catalogue, because a search that dies with the
 * connection is useless at exactly the moment the shop needs it.
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
  const [remote, setRemote] = useState<Product[] | null>(null);
  const [searching, setSearching] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const online = useOnline();

  // Keep focus in the search box: a scanner types wherever the caret happens to
  // be, and a scan that lands in a quantity field is a silent mis-sale.
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const price = (p: Product) =>
    trade && p.price_trade != null ? p.price_trade : p.price_retail;

  // Results shown while the server request is in flight, and whenever offline.
  const local = useMemo(() => {
    let list = products;
    if (category) list = list.filter((p) => p.category_id === category);
    return searchProductsLocal(list, term, 60);
  }, [products, term, category]);

  // Ask the server, debounced. Typing is faster than a round trip, so a stale
  // response must never overwrite a newer one.
  useEffect(() => {
    const q = term.trim();
    if (!online || q.length < 2) {
      setRemote(null);
      return;
    }
    let cancelled = false;
    setSearching(true);
    const timer = setTimeout(() => {
      searchProducts(q, 60)
        .then((rows) => {
          if (!cancelled) setRemote(rows);
        })
        .catch((e) => {
          // Falling back to the local list is the right answer for a dropped
          // connection; anything else is worth surfacing rather than hiding.
          if (!cancelled && !isNetworkError(e)) console.error(e);
          if (!cancelled) setRemote(null);
        })
        .finally(() => {
          if (!cancelled) setSearching(false);
        });
    }, 180);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [term, online]);

  const matches = useMemo(() => {
    const base = remote ?? local;
    return category ? base.filter((p) => p.category_id === category) : base;
  }, [remote, local, category]);

  function submit(e: React.FormEvent) {
    e.preventDefault();
    const q = term.trim();
    if (!q) return;

    // An exact barcode or SKU is unambiguous — treat it as a scan.
    const hit = exactMatch(products, q);
    if (hit) {
      onAdd(hit);
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
        <div className="relative">
          <input
            ref={inputRef}
            type="search"
            value={term}
            onChange={(e) => setTerm(e.target.value)}
            placeholder="Scan barcode, or describe the item…"
            autoComplete="off"
            className="w-full rounded-xl border border-stone-300 px-4 py-3 text-lg
                       focus:outline-none focus:ring-2 focus:ring-emerald-500"
          />
          {searching && (
            <span className="absolute right-3 top-1/2 -translate-y-1/2 text-xs text-stone-400">
              searching…
            </span>
          )}
        </div>
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
        {matches.length === 0 && term.trim() !== "" && (
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
