import { useEffect, useState } from "react";
import { adminAdjustStock, adminStockHistory, type ProductInput } from "../lib/adminApi";
import { CURRENCY } from "../lib/config";
import { money } from "../lib/format";
import { imageSrc } from "../lib/images";
import { fmtQty } from "../lib/receipt";
import ProductPhotos from "./ProductPhotos";
import type { AdminProduct, Category, StockMovement, UnitOfMeasure } from "../lib/types";

/**
 * Add or edit a line in the catalogue.
 *
 * The unit is the field to get right and the one most likely to be got wrong,
 * so it sits near the top and says out loud what it implies: choosing "Metre"
 * is what allows the till to sell 2.5 of something. Change it later and every
 * future sale of that line changes shape, which is why it is spelled out rather
 * than left as a dropdown of codes.
 */
export default function ProductEditor({
  pin,
  product,
  categories,
  units,
  canSeeCost,
  onSave,
  onDelete,
  onClose,
}: {
  pin: string;
  product: AdminProduct | null;
  categories: Category[];
  units: UnitOfMeasure[];
  canSeeCost: boolean;
  onSave: (p: ProductInput) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
  onClose: () => void;
}) {
  const [f, setF] = useState<ProductInput>(() => ({
    id: product?.id ?? null,
    sku: product?.sku ?? "",
    barcode: product?.barcode ?? null,
    name: product?.name ?? "",
    description: product?.description ?? null,
    category_id: product?.category_id ?? null,
    unit_code: product?.unit_code ?? "ea",
    price_retail: product?.price_retail ?? 0,
    price_trade: product?.price_trade ?? null,
    cost: product?.cost ?? null,
    tax_code: product?.tax_code ?? "standard",
    stock_qty: product?.stock_qty ?? null,
    reorder_level: product?.reorder_level ?? null,
    bin: product?.bin ?? null,
    active: product?.active ?? true,
    max_discount_percent: product?.max_discount_percent ?? null,
    max_discount_amount: product?.max_discount_amount ?? null,
  }));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [countTo, setCountTo] = useState("");
  const [countNote, setCountNote] = useState("");
  const [history, setHistory] = useState<StockMovement[] | null>(null);

  const unit = units.find((u) => u.code === f.unit_code);
  const isNew = !product;

  useEffect(() => {
    if (!product) return;
    adminStockHistory(pin, product.id).then(setHistory).catch(() => setHistory([]));
  }, [pin, product]);

  const set = <K extends keyof ProductInput>(k: K, v: ProductInput[K]) =>
    setF((prev) => ({ ...prev, [k]: v }));

  const num = (s: string): number | null => {
    const t = s.trim().replace(",", ".");
    if (t === "") return null;
    const n = Number(t);
    return Number.isFinite(n) ? n : null;
  };

  const margin =
    canSeeCost && f.cost != null && f.cost > 0 && f.price_retail > 0
      ? ((f.price_retail / (1 + 0.15) - f.cost) / (f.price_retail / (1 + 0.15))) * 100
      : null;

  async function save() {
    setBusy(true);
    setError(null);
    try {
      await onSave(f);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save");
      setBusy(false);
    }
  }

  async function recount() {
    const n = num(countTo);
    if (n == null || !product) return;
    setBusy(true);
    setError(null);
    try {
      await adminAdjustStock(pin, product.id, n, countNote || null);
      setCountTo("");
      setCountNote("");
      setHistory(await adminStockHistory(pin, product.id));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not adjust stock");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 bg-black/40 flex items-start justify-center p-4 z-50 overflow-y-auto">
      <div className="bg-white rounded-2xl w-full max-w-2xl my-6">
        <div className="flex items-center justify-between p-4 border-b border-stone-200">
          <h2 className="text-lg font-semibold">
            {isNew ? "New product" : f.name}
          </h2>
          <button onClick={onClose} className="text-stone-400 text-2xl leading-none">
            ×
          </button>
        </div>

        <div className="p-4 space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <Field label="SKU" hint="Your own code. Must be unique.">
              <input
                value={f.sku}
                onChange={(e) => set("sku", e.target.value)}
                className={inputCls}
                placeholder="CEM-425-50"
              />
            </Field>
            <Field label="Barcode" hint="Scanned at the till. Leave blank if none.">
              <input
                value={f.barcode ?? ""}
                onChange={(e) => set("barcode", e.target.value || null)}
                className={inputCls}
                placeholder="6001234000015"
              />
            </Field>
          </div>

          <Field label="Name">
            <input
              value={f.name}
              onChange={(e) => set("name", e.target.value)}
              className={inputCls}
              placeholder="Cement 42.5N 50kg"
            />
          </Field>

          <div className="grid grid-cols-2 gap-3">
            <Field label="Department">
              <select
                value={f.category_id ?? ""}
                onChange={(e) => set("category_id", e.target.value || null)}
                className={inputCls}
              >
                <option value="">(none)</option>
                {categories.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            </Field>

            <Field
              label="Sold by"
              hint={
                unit?.allows_fraction
                  ? "Can be sold in fractions — 2.5 is allowed at the till."
                  : "Whole units only — the till will refuse a fraction."
              }
            >
              <select
                value={f.unit_code}
                onChange={(e) => set("unit_code", e.target.value)}
                className={inputCls}
              >
                {units.map((u) => (
                  <option key={u.code} value={u.code}>
                    {u.name} ({u.code})
                  </option>
                ))}
              </select>
            </Field>
          </div>

          <div className="grid grid-cols-3 gap-3">
            <Field label={`Retail (${CURRENCY}, incl VAT)`}>
              <input
                inputMode="decimal"
                value={f.price_retail || ""}
                onChange={(e) => set("price_retail", num(e.target.value) ?? 0)}
                className={inputCls}
              />
            </Field>
            <Field label="Trade" hint="Blank = trade pays retail.">
              <input
                inputMode="decimal"
                value={f.price_trade ?? ""}
                onChange={(e) => set("price_trade", num(e.target.value))}
                className={inputCls}
              />
            </Field>
            {canSeeCost ? (
              <Field
                label="Cost"
                hint={margin != null ? `Margin ${margin.toFixed(1)}%` : undefined}
              >
                <input
                  inputMode="decimal"
                  value={f.cost ?? ""}
                  onChange={(e) => set("cost", num(e.target.value))}
                  className={inputCls}
                />
              </Field>
            ) : (
              <Field label="Cost" hint="You don't have permission to see costs.">
                <input disabled className={inputCls + " bg-stone-100"} value="—" />
              </Field>
            )}
          </div>

          <div className="grid grid-cols-3 gap-3">
            <Field label="VAT">
              <select
                value={f.tax_code}
                onChange={(e) => set("tax_code", e.target.value)}
                className={inputCls}
              >
                <option value="standard">Standard (15%)</option>
                <option value="zero">Zero rated</option>
                <option value="exempt">Exempt</option>
              </select>
            </Field>

            <Field
              label={isNew ? "Opening stock" : "On hand"}
              hint={isNew ? "Blank = don't track stock." : undefined}
            >
              <input
                inputMode="decimal"
                disabled={!isNew}
                value={f.stock_qty ?? ""}
                onChange={(e) => set("stock_qty", num(e.target.value))}
                className={inputCls + (isNew ? "" : " bg-stone-100")}
              />
            </Field>

            <Field label="Reorder at" hint="Warns on the till below this.">
              <input
                inputMode="decimal"
                value={f.reorder_level ?? ""}
                onChange={(e) => set("reorder_level", num(e.target.value))}
                className={inputCls}
              />
            </Field>
          </div>

          {/* The shop's own floor on this line.
              Unlike a staff discount limit, which only decides whether a
              manager is fetched, this refuses — including for the owner. That
              is the point of setting one: a thin-margin line stays priced
              where it was put, whoever is at the till and whoever they ask. */}
          <fieldset className="border border-stone-200 rounded-xl p-3">
            <legend className="px-1 text-sm text-stone-600">Discount cap</legend>
            <p className="text-xs text-stone-500 mb-2">
              The most that may ever come off this line. Nobody can go past it —
              not a manager, not the owner. Leave both blank for no cap.
            </p>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Percent off, at most">
                <input
                  inputMode="decimal"
                  value={f.max_discount_percent ?? ""}
                  onChange={(e) => set("max_discount_percent", num(e.target.value))}
                  className={inputCls}
                  aria-label="Maximum discount percent"
                  placeholder="—"
                />
              </Field>
              <Field
                label={`${CURRENCY} off, at most`}
                hint={`Per ${unit?.name?.toLowerCase() ?? f.unit_code} — ten of them allows ten times as much.`}
              >
                <input
                  inputMode="decimal"
                  value={f.max_discount_amount ?? ""}
                  onChange={(e) => set("max_discount_amount", num(e.target.value))}
                  className={inputCls}
                  aria-label="Maximum discount amount"
                  placeholder="—"
                />
              </Field>
            </div>
            {f.max_discount_percent != null && f.max_discount_amount != null && (
              <p className="text-xs text-stone-500 mt-2">
                Both set — whichever comes to less is the one that holds.
              </p>
            )}
          </fieldset>

          {/* Where the thing physically is. In a shop with thousands of SKUs
              this is how a cashier tells a customer which aisle to walk to. */}
          <Field label="Bin / shelf" hint="Shown on the till, e.g. H1 or Garden.">
            <input
              value={f.bin ?? ""}
              onChange={(e) => set("bin", e.target.value || null)}
              className={inputCls}
            />
          </Field>

          {/* Photographs, taken at the shelf. A near-identical item is chosen
              correctly far more often from a picture than a description. */}
          <Field label="Photos" hint="Shown in the till's search results.">
            {/* A picture that came in with a supplier catalogue lives on the
                product itself, not in the uploaded set. Without showing it
                here, a manager sees a thumbnail in the list and "no photos"
                on the very same product. */}
            {imageSrc(product?.image_url) && (
              <div className="flex items-start gap-3 mb-3">
                <img
                  src={imageSrc(product!.image_url)!}
                  alt=""
                  className="w-24 h-24 object-cover rounded border border-stone-200 bg-stone-50"
                />
                <p className="text-xs text-stone-500 max-w-[220px]">
                  From the supplier catalogue. Take a photo below to add your
                  own — the first one becomes what the till shows.
                </p>
              </div>
            )}
            <ProductPhotos productId={product?.id ?? null} pin={pin} />
          </Field>

          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={f.active}
              onChange={(e) => set("active", e.target.checked)}
            />
            Available to sell
            <span className="text-stone-500">
              — until this is ticked and priced, the till will not show it
            </span>
          </label>

          {/* Stock is only changed through a counted adjustment, so the movement
              ledger can always explain the balance. */}
          {!isNew && f.stock_qty != null && (
            <div className="rounded-xl bg-stone-50 p-3 space-y-2">
              <div className="text-sm font-medium">
                Stock count — currently {fmtQty(product!.stock_qty ?? 0)}{" "}
                {f.unit_code}
              </div>
              <div className="flex gap-2">
                <input
                  inputMode="decimal"
                  value={countTo}
                  onChange={(e) => setCountTo(e.target.value)}
                  placeholder="Counted"
                  className={inputCls + " w-28"}
                />
                <input
                  value={countNote}
                  onChange={(e) => setCountNote(e.target.value)}
                  placeholder="Reason (e.g. stocktake, breakage)"
                  className={inputCls + " flex-1"}
                />
                <button
                  onClick={recount}
                  disabled={busy || !countTo}
                  className="px-4 rounded-xl bg-stone-800 text-white text-sm disabled:opacity-40"
                >
                  Apply
                </button>
              </div>

              {history && history.length > 0 && (
                <ul className="text-xs text-stone-600 divide-y divide-stone-200 max-h-40 overflow-y-auto">
                  {history.map((m, i) => (
                    <li key={i} className="py-1 flex gap-2">
                      <span className="w-28 shrink-0 text-stone-400">
                        {new Date(m.at).toLocaleDateString()}
                      </span>
                      <span
                        className={`w-16 shrink-0 tabular-nums ${
                          m.qty_delta < 0 ? "text-red-600" : "text-emerald-700"
                        }`}
                      >
                        {m.qty_delta > 0 ? "+" : ""}
                        {fmtQty(m.qty_delta)}
                      </span>
                      <span className="w-20 shrink-0">{m.reason}</span>
                      <span className="truncate">
                        {m.note ?? m.by_name ?? ""}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}

          {error && <p className="text-sm text-red-600">{error}</p>}
        </div>

        <div className="flex gap-2 p-4 border-t border-stone-200">
          {!isNew && (
            <button
              onClick={() => onDelete(product!.id)}
              disabled={busy}
              className="px-4 py-2.5 rounded-xl text-red-600 text-sm"
            >
              Retire
            </button>
          )}
          <button
            onClick={onClose}
            className="ml-auto px-4 py-2.5 rounded-xl bg-stone-100"
          >
            Cancel
          </button>
          <button
            onClick={save}
            disabled={busy || !f.sku || !f.name}
            className="px-6 py-2.5 rounded-xl bg-emerald-600 text-white font-semibold disabled:opacity-40"
          >
            {busy ? "Saving…" : "Save"}
          </button>
        </div>
      </div>
    </div>
  );
}

const inputCls =
  "w-full rounded-xl border border-stone-300 px-3 py-2 focus:outline-none focus:ring-2 focus:ring-emerald-500";

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <span className="text-sm font-medium text-stone-700">{label}</span>
      <div className="mt-1">{children}</div>
      {hint && <span className="text-xs text-stone-500 mt-0.5 block">{hint}</span>}
    </label>
  );
}

export { money };
