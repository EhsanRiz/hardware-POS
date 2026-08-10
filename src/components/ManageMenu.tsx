import { useCallback, useEffect, useMemo, useState } from "react";
import type { Product } from "../lib/types";
import { managerListProducts, managerUpsertProduct } from "../lib/api";
import { activeVariants, variantOptionLabel } from "../lib/variants";
import { money } from "../lib/format";
import ProductForm from "./ProductForm";
import ImportMenu from "./ImportMenu";

interface Props {
  managerPin: string;
  // Called whenever the menu changes so the till can refresh its grid.
  onChanged: () => void;
}

export default function ManageMenu({ managerPin, onChanged }: Props) {
  const [products, setProducts] = useState<Product[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [editing, setEditing] = useState<Product | null>(null);
  const [creating, setCreating] = useState(false);
  const [importing, setImporting] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [query, setQuery] = useState("");

  const load = useCallback(() => {
    managerListProducts(managerPin)
      .then(setProducts)
      .catch((e) =>
        setLoadError(e instanceof Error ? e.message : "Failed to load")
      );
  }, [managerPin]);

  useEffect(load, [load]);

  const categories = useMemo(
    () => Array.from(new Set((products ?? []).map((p) => p.category))),
    [products]
  );

  // Filter the list by name / category / any variant name or size.
  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return products ?? [];
    return (products ?? []).filter(
      (p) =>
        p.name.toLowerCase().includes(q) ||
        p.category.toLowerCase().includes(q) ||
        (p.variants ?? []).some((v) =>
          `${v.name ?? ""} ${v.size ?? ""}`.toLowerCase().includes(q)
        )
    );
  }, [products, query]);

  const upsertLocal = (saved: Product) => {
    setProducts((prev) => {
      const base = prev ?? [];
      const exists = base.some((p) => p.id === saved.id);
      const next = exists
        ? base.map((p) =>
            p.id === saved.id
              ? // Preserve variants when the saved row didn't include them
                // (e.g. the availability toggle returns a plain product).
                { ...saved, variants: saved.variants ?? p.variants }
              : p
          )
        : [...base, saved];
      return next.sort(
        (a, b) =>
          a.category.localeCompare(b.category) ||
          a.sort_order - b.sort_order ||
          a.name.localeCompare(b.name)
      );
    });
    onChanged();
  };

  const toggleActive = async (p: Product) => {
    setBusyId(p.id);
    try {
      const saved = await managerUpsertProduct(managerPin, {
        id: p.id,
        name: p.name,
        category: p.category,
        price: p.price,
        cost: p.cost ?? null,
        image_url: p.image_url,
        active: !p.active,
        sort_order: p.sort_order,
        stock_qty: p.stock_qty,
      });
      upsertLocal(saved);
    } catch {
      // Non-fatal; leave row as-is.
    } finally {
      setBusyId(null);
    }
  };

  // Edit + availability buttons, reused by single items and each size row.
  const actions = (p: Product) => (
    <div className="flex flex-col gap-1.5 items-end shrink-0">
      <button
        onClick={() => setEditing(p)}
        className="text-sm font-medium text-info px-2 py-1 rounded active:bg-stone-100"
      >
        Edit
      </button>
      <button
        onClick={() => toggleActive(p)}
        disabled={busyId === p.id}
        className={`text-xs font-medium px-2 py-1 rounded-full ${
          p.active
            ? "bg-brand-light text-brand-dark"
            : "bg-stone-200 text-stone-500"
        }`}
      >
        {p.active ? "Available" : "Hidden"}
      </button>
    </div>
  );

  return (
    <div className="p-4">
      <div className="max-w-5xl mx-auto">
        <div className="flex flex-wrap items-center gap-2 mb-3">
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search items…"
            className="flex-1 min-w-[180px] h-10 px-3 rounded-lg border border-stone-300 bg-white text-sm focus:border-brand outline-none"
          />
          <button
            onClick={() => setImporting(true)}
            className="h-10 px-4 rounded-lg bg-stone-100 text-stone-700 font-medium active:bg-stone-200"
          >
            Import
          </button>
          <button
            onClick={() => setCreating(true)}
            className="h-10 px-4 rounded-lg bg-brand text-white font-semibold shadow-sm active:!scale-95"
          >
            + Add item
          </button>
        </div>
        <p className="text-taupe text-sm mb-3">
          {query.trim()
            ? `${visible.length} of ${products?.length ?? 0} items`
            : `${products?.length ?? 0} items`}
        </p>

        {loadError && <p className="text-red-600">{loadError}</p>}
        {!products && !loadError && <p className="text-stone-400">Loading…</p>}
        {products && visible.length === 0 && query.trim() && (
          <p className="text-stone-400">No items match “{query.trim()}”.</p>
        )}

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
          {visible.map((p) => {
            const variants = activeVariants(p);
            const sized = (p.variants ?? []).length > 0;
            return (
              <div
                key={p.id}
                className={`p-3 rounded-xl bg-white border border-stone-200 animate-fade-in ${
                  p.active ? "" : "opacity-60"
                }`}
              >
                <div className="flex gap-3">
                  <div className="w-16 h-16 rounded-lg bg-brand-light overflow-hidden flex items-center justify-center shrink-0">
                    {p.image_url ? (
                      <img
                        src={p.image_url}
                        alt={p.name}
                        className="w-full h-full object-cover"
                      />
                    ) : (
                      <span className="text-xl font-bold text-brand/40">
                        {p.name.charAt(0).toUpperCase()}
                      </span>
                    )}
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="font-semibold text-stone-800 truncate">
                      {p.name}
                    </p>
                    <p className="text-sm text-taupe">{p.category}</p>
                    {sized ? (
                      <p className="text-brand font-semibold">
                        <span className="text-xs text-taupe font-normal">
                          from{" "}
                        </span>
                        {money(
                          Math.min(...(p.variants ?? []).map((v) => v.price))
                        )}
                      </p>
                    ) : (
                      <>
                        <p className="text-brand font-semibold">
                          {money(p.price)}
                        </p>
                        <p className="text-xs text-taupe-light">
                          {p.stock_qty == null
                            ? "Stock not tracked"
                            : `${p.stock_qty} in stock`}
                        </p>
                      </>
                    )}
                  </div>
                  {actions(p)}
                </div>

                {sized && (
                  <div className="mt-2 pt-2 border-t border-stone-100 divide-y divide-stone-100">
                    {(p.variants ?? []).map((v) => (
                      <div
                        key={v.id}
                        className={`flex items-center gap-2 py-1.5 ${
                          v.active ? "" : "opacity-50"
                        }`}
                      >
                        <div className="flex-1 min-w-0">
                          <p className="text-sm font-medium text-stone-800 truncate">
                            {variantOptionLabel(v)}
                            {!v.active && (
                              <span className="ml-1 text-xs text-stone-400">
                                (hidden)
                              </span>
                            )}
                          </p>
                          <p className="text-xs text-taupe-light">
                            {v.stock_qty == null
                              ? "Stock not tracked"
                              : `${v.stock_qty} in stock`}
                          </p>
                        </div>
                        <span className="text-brand font-semibold shrink-0">
                          {money(v.price)}
                        </span>
                      </div>
                    ))}
                  </div>
                )}
                {variants.length === 0 && sized && (
                  <p className="mt-2 text-xs text-amber-600">
                    All sizes hidden — this item won't show on the till.
                  </p>
                )}
              </div>
            );
          })}
        </div>
      </div>

      {(creating || editing) && (
        <ProductForm
          initial={editing}
          categories={categories}
          managerPin={managerPin}
          onSaved={(p) => {
            upsertLocal(p);
            setCreating(false);
            setEditing(null);
          }}
          onDeleted={(id) => {
            setProducts((prev) => (prev ?? []).filter((p) => p.id !== id));
            onChanged();
            setCreating(false);
            setEditing(null);
          }}
          onCancel={() => {
            setCreating(false);
            setEditing(null);
          }}
        />
      )}

      {importing && (
        <ImportMenu
          managerPin={managerPin}
          startSort={(products?.length ?? 0) + 1}
          onDone={() => {
            load();
            onChanged();
          }}
          onCancel={() => setImporting(false)}
        />
      )}
    </div>
  );
}
