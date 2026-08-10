import { useEffect, useState } from "react";
import type { Product } from "../lib/types";
import { managerListProducts, managerSetStock } from "../lib/api";

function StockRow({
  p,
  managerPin,
  onChange,
}: {
  p: Product;
  managerPin: string;
  onChange: (p: Product) => void;
}) {
  const [value, setValue] = useState<string>(
    p.stock_qty != null ? String(p.stock_qty) : ""
  );
  const [busy, setBusy] = useState(false);
  const tracked = p.stock_qty != null;
  const out = tracked && (p.stock_qty as number) <= 0;
  const low = tracked && !out && (p.stock_qty as number) <= 5;

  const commit = async (qty: number | null) => {
    setBusy(true);
    try {
      const saved = await managerSetStock(managerPin, p.id, qty);
      onChange(saved);
      setValue(saved.stock_qty != null ? String(saved.stock_qty) : "");
    } catch {
      setValue(p.stock_qty != null ? String(p.stock_qty) : "");
    } finally {
      setBusy(false);
    }
  };

  const adjust = (delta: number) =>
    commit(Math.max(0, (p.stock_qty ?? 0) + delta));

  return (
    <div className="flex items-center gap-3 p-3 border-b border-stone-100 last:border-0">
      <div className="w-10 h-10 rounded-lg bg-brand-light overflow-hidden flex items-center justify-center shrink-0">
        {p.image_url ? (
          <img src={p.image_url} alt={p.name} className="w-full h-full object-cover" />
        ) : (
          <span className="font-bold text-brand/40">
            {p.name.charAt(0).toUpperCase()}
          </span>
        )}
      </div>
      <div className="flex-1 min-w-0">
        <p className="font-medium text-stone-800 truncate">{p.name}</p>
        <p className="text-xs text-taupe">{p.category}</p>
      </div>

      {tracked && (
        <span
          className={`text-[10px] font-bold px-2 py-0.5 rounded-full ${
            out
              ? "bg-stone-700 text-white"
              : low
              ? "bg-amber-500 text-white"
              : "bg-brand-light text-brand-dark"
          }`}
        >
          {out ? "Out" : low ? "Low" : "OK"}
        </span>
      )}

      {tracked ? (
        <div className="flex items-center gap-1.5">
          <button
            onClick={() => adjust(-1)}
            disabled={busy || (p.stock_qty as number) <= 0}
            className="w-9 h-9 rounded-lg bg-stone-100 text-xl text-stone-700 active:bg-stone-200 disabled:opacity-40"
          >
            −
          </button>
          <input
            value={value}
            onChange={(e) => setValue(e.target.value.replace(/\D/g, ""))}
            onBlur={() => {
              const n = value === "" ? 0 : Number(value);
              if (n !== p.stock_qty) commit(n);
            }}
            inputMode="numeric"
            className="w-14 h-9 text-center rounded-lg border border-stone-300 focus:border-brand outline-none"
          />
          <button
            onClick={() => adjust(1)}
            disabled={busy}
            className="w-9 h-9 rounded-lg bg-stone-100 text-xl text-stone-700 active:bg-stone-200"
          >
            +
          </button>
          <button
            onClick={() => commit(null)}
            disabled={busy}
            className="ml-1 text-xs text-taupe-light underline"
          >
            untrack
          </button>
        </div>
      ) : (
        <button
          onClick={() => commit(0)}
          disabled={busy}
          className="h-9 px-3 rounded-lg bg-stone-100 text-stone-600 text-sm font-medium active:bg-stone-200"
        >
          Track stock
        </button>
      )}
    </div>
  );
}

export default function InventoryManager({
  managerPin,
  onChanged,
}: {
  managerPin: string;
  onChanged: () => void;
}) {
  const [products, setProducts] = useState<Product[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    managerListProducts(managerPin)
      .then(setProducts)
      .catch((e) => setError(e instanceof Error ? e.message : "Failed to load"));
  }, [managerPin]);

  const onChange = (saved: Product) => {
    setProducts((prev) =>
      (prev ?? []).map((p) => (p.id === saved.id ? saved : p))
    );
    onChanged();
  };

  const tracked = (products ?? []).filter((p) => p.stock_qty != null);
  const lowOrOut = tracked.filter((p) => (p.stock_qty as number) <= 5).length;

  return (
    <div className="p-4">
      <div className="max-w-3xl mx-auto">
        {error && <p className="text-red-600">{error}</p>}
        {!products && !error && <p className="text-stone-400">Loading…</p>}

        {products && (
          <>
            <p className="text-taupe text-sm mb-3">
              {tracked.length} tracked ·{" "}
              <span className={lowOrOut ? "text-amber-600 font-medium" : ""}>
                {lowOrOut} low/out
              </span>
            </p>
            <div className="bg-white border border-stone-200 rounded-xl">
              {products.map((p) => (
                <StockRow
                  key={p.id}
                  p={p}
                  managerPin={managerPin}
                  onChange={onChange}
                />
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
