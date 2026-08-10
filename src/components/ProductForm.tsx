import { useMemo, useState, type ChangeEvent } from "react";
import type { Product } from "../lib/types";
import {
  managerDeleteProduct,
  managerSaveProduct,
  uploadProductImage,
  type VariantInput,
} from "../lib/api";
import { CURRENCY } from "../lib/config";

// One editable variant row in the form.
interface VariantRow {
  id: string | null;
  name: string;
  size: string;
  price: string;
  cost: string;
  stock: string;
  active: boolean;
}

const blankVariant = (): VariantRow => ({
  id: null,
  name: "",
  size: "",
  price: "",
  cost: "",
  stock: "",
  active: true,
});

// Markup % = (price − cost) / cost × 100. Null when either value is missing.
function markup(priceStr: string, costStr: string): number | null {
  const price = Number(priceStr);
  const cost = Number(costStr);
  if (priceStr.trim() === "" || costStr.trim() === "" || !(cost > 0)) return null;
  return ((price - cost) / cost) * 100;
}

function MarkupHint({ price, cost }: { price: string; cost: string }) {
  const m = markup(price, cost);
  if (m === null) return null;
  return (
    <span
      className={`text-xs font-medium ${
        m < 0 ? "text-red-600" : "text-emerald-700"
      }`}
    >
      Markup {m.toFixed(0)}%
    </span>
  );
}

interface Props {
  initial: Product | null;
  categories: string[];
  managerPin: string;
  onSaved: (p: Product) => void;
  onDeleted: (id: string) => void;
  onCancel: () => void;
}

export default function ProductForm({
  initial,
  categories,
  managerPin,
  onSaved,
  onDeleted,
  onCancel,
}: Props) {
  const [name, setName] = useState(initial?.name ?? "");
  const [category, setCategory] = useState(initial?.category ?? "");
  const [price, setPrice] = useState(
    initial ? String(initial.price) : ""
  );
  const [cost, setCost] = useState(
    initial?.cost != null ? String(initial.cost) : ""
  );
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [imageUrl, setImageUrl] = useState<string | null>(
    initial?.image_url ?? null
  );
  const [active, setActive] = useState(initial?.active ?? true);
  const [stock, setStock] = useState(
    initial?.stock_qty != null ? String(initial.stock_qty) : ""
  );
  const [variants, setVariants] = useState<VariantRow[]>(
    () =>
      (initial?.variants ?? []).map((v) => ({
        id: v.id,
        name: v.name ?? "",
        size: v.size ?? "",
        price: String(v.price),
        cost: v.cost != null ? String(v.cost) : "",
        stock: v.stock_qty != null ? String(v.stock_qty) : "",
        active: v.active,
      }))
  );
  const [uploading, setUploading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const hasVariants = variants.length > 0;
  const setVariant = (i: number, patch: Partial<VariantRow>) =>
    setVariants((prev) => prev.map((v, j) => (j === i ? { ...v, ...patch } : v)));
  const addVariant = () => setVariants((prev) => [...prev, blankVariant()]);
  const removeVariant = (i: number) =>
    setVariants((prev) => prev.filter((_, j) => j !== i));

  // Each variant needs a price and at least a name or a size.
  const variantsValid = variants.every(
    (v) =>
      v.price.trim() !== "" &&
      Number(v.price) >= 0 &&
      (v.name.trim() !== "" || v.size.trim() !== "")
  );

  // Known categories for the dropdown, including this item's own (in case it's
  // no longer used elsewhere). A "New category…" choice reveals a text field.
  const knownCategories = useMemo(() => {
    const list = [...categories];
    if (initial?.category && !list.includes(initial.category)) {
      list.unshift(initial.category);
    }
    return list;
  }, [categories, initial]);
  const [customCategory, setCustomCategory] = useState(false);

  // With variants the per-variant prices drive sales, so the base price is
  // optional (defaults to 0); without variants it's required.
  const priceNum = price.trim() === "" ? 0 : Number(price);
  const valid =
    name.trim() !== "" &&
    priceNum >= 0 &&
    (hasVariants ? variantsValid : price.trim() !== "");

  const handleImage = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploading(true);
    setError(null);
    try {
      const url = await uploadProductImage(file);
      setImageUrl(url);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Upload failed");
    } finally {
      setUploading(false);
    }
  };

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const variantPayload: VariantInput[] = variants.map((v, i) => ({
        id: v.id,
        name: v.name.trim() || null,
        size: v.size.trim() || null,
        price: Number(v.price),
        cost: v.cost.trim() === "" ? null : Number(v.cost),
        stock_qty:
          v.stock.trim() === "" ? null : Math.max(0, Math.floor(Number(v.stock))),
        active: v.active,
        sort_order: i,
      }));
      const saved = await managerSaveProduct(
        managerPin,
        {
          id: initial?.id ?? null,
          name: name.trim(),
          category: category.trim() || "Other",
          price: priceNum,
          cost: cost.trim() === "" ? null : Number(cost),
          image_url: imageUrl,
          active,
          sort_order: initial?.sort_order ?? 0,
          stock_qty:
            stock.trim() === "" ? null : Math.max(0, Math.floor(Number(stock))),
        },
        variantPayload
      );
      onSaved(saved);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Save failed");
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!initial) return;
    setBusy(true);
    setError(null);
    try {
      await managerDeleteProduct(managerPin, initial.id);
      onDeleted(initial.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Delete failed");
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center p-4 z-50 animate-fade-in">
      <div className="bg-white rounded-2xl p-6 w-full max-w-md animate-scale-in max-h-[90vh] overflow-y-auto">
        <h2 className="text-xl font-bold text-stone-800 mb-4">
          {initial ? "Edit item" : "New item"}
        </h2>

        <div className="flex gap-4 mb-4">
          <div className="w-24 h-24 rounded-xl bg-brand-light border border-stone-200 overflow-hidden flex items-center justify-center shrink-0">
            {imageUrl ? (
              <img
                src={imageUrl}
                alt="preview"
                className="w-full h-full object-cover"
              />
            ) : (
              <span className="text-3xl text-brand/40">
                {name.charAt(0).toUpperCase() || "?"}
              </span>
            )}
          </div>
          <label className="flex-1 flex flex-col justify-center">
            <span className="text-sm font-medium text-stone-600 mb-1">Photo</span>
            <input
              type="file"
              accept="image/*"
              onChange={handleImage}
              className="text-sm text-stone-500 file:mr-3 file:py-2 file:px-3 file:rounded-lg file:border-0 file:bg-brand-light file:text-brand-dark file:font-medium"
            />
            {uploading && (
              <span className="text-sm text-brand mt-1">Uploading…</span>
            )}
          </label>
        </div>

        <label className="block text-sm font-medium text-stone-600 mb-1">
          Name
        </label>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          autoFocus
          className="w-full h-12 px-3 rounded-lg border border-stone-300 mb-4 focus:border-brand outline-none"
          placeholder="e.g. Cement 42.5N 50kg"
        />

        <div className="grid grid-cols-2 gap-3 mb-4">
          <div>
            <label className="block text-sm font-medium text-stone-600 mb-1">
              Category
            </label>
            <select
              value={customCategory ? "__new__" : category}
              onChange={(e) => {
                const v = e.target.value;
                if (v === "__new__") {
                  setCustomCategory(true);
                  setCategory("");
                } else {
                  setCustomCategory(false);
                  setCategory(v);
                }
              }}
              className="w-full h-12 px-3 rounded-lg border border-stone-300 focus:border-brand outline-none bg-white"
            >
              <option value="" disabled>
                Select…
              </option>
              {knownCategories.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
              <option value="__new__">+ New category…</option>
            </select>
            {customCategory && (
              <input
                value={category}
                onChange={(e) => setCategory(e.target.value)}
                autoFocus
                placeholder="New category name"
                className="w-full h-12 px-3 mt-2 rounded-lg border border-stone-300 focus:border-brand outline-none"
              />
            )}
          </div>
          <div>
            <label className="block text-sm font-medium text-stone-600 mb-1">
              Price ({CURRENCY})
            </label>
            <input
              type="number"
              inputMode="decimal"
              value={price}
              onChange={(e) => setPrice(e.target.value)}
              className="w-full h-12 px-3 rounded-lg border border-stone-300 focus:border-brand outline-none"
              placeholder="0.00"
            />
          </div>
        </div>

        <div className="mb-4">
          <div className="flex items-center justify-between mb-1">
            <label className="block text-sm font-medium text-stone-600">
              Cost ({CURRENCY}){" "}
              <span className="text-taupe-light">(optional)</span>
            </label>
            <MarkupHint price={price} cost={cost} />
          </div>
          <input
            type="number"
            inputMode="decimal"
            value={cost}
            onChange={(e) => setCost(e.target.value)}
            className="w-full h-12 px-3 rounded-lg border border-stone-300 focus:border-brand outline-none"
            placeholder="0.00"
          />
          {hasVariants && (
            <p className="text-xs text-taupe mt-1">
              For sized items, set each size's cost below to see its markup.
            </p>
          )}
        </div>

        <label className="block text-sm font-medium text-stone-600 mb-1">
          {hasVariants ? "Base price stock" : "Stock"}{" "}
          <span className="text-taupe-light">(leave blank = not tracked)</span>
        </label>
        <input
          type="number"
          inputMode="numeric"
          value={stock}
          onChange={(e) => setStock(e.target.value)}
          className="w-full h-12 px-3 rounded-lg border border-stone-300 mb-4 focus:border-brand outline-none"
          placeholder="e.g. 24"
        />

        {/* Variants / sizes */}
        <div className="mb-4">
          <div className="flex items-center justify-between mb-1">
            <label className="block text-sm font-medium text-stone-600">
              Sizes / options
            </label>
            <button
              type="button"
              onClick={addVariant}
              className="text-sm font-medium text-brand-dark px-2 py-1 rounded active:bg-brand-light"
            >
              + Add size
            </button>
          </div>
          {hasVariants ? (
            <>
              <p className="text-xs text-taupe mb-2">
                When an item has sizes, the cashier picks one and its price is
                used. The base price/stock above is ignored on the till.
              </p>
              <datalist id="size-suggestions">
                <option value="Small" />
                <option value="Medium" />
                <option value="Large" />
                <option value="Regular" />
              </datalist>
              <div className="space-y-2">
                {variants.map((v, i) => (
                  <div
                    key={v.id ?? `new-${i}`}
                    className="rounded-lg border border-stone-200 p-2.5"
                  >
                    <div className="grid grid-cols-2 gap-2 mb-2">
                      <input
                        value={v.size}
                        onChange={(e) => setVariant(i, { size: e.target.value })}
                        list="size-suggestions"
                        placeholder="Size (e.g. Large)"
                        className="h-10 px-2.5 rounded-lg border border-stone-300 text-sm focus:border-brand outline-none"
                      />
                      <input
                        value={v.name}
                        onChange={(e) => setVariant(i, { name: e.target.value })}
                        placeholder="Name (optional)"
                        className="h-10 px-2.5 rounded-lg border border-stone-300 text-sm focus:border-brand outline-none"
                      />
                    </div>
                    <div className="grid grid-cols-3 gap-2 mb-2">
                      <div className="relative">
                        <span className="absolute left-2 top-1/2 -translate-y-1/2 text-stone-400 text-xs">
                          {CURRENCY}
                        </span>
                        <input
                          type="number"
                          inputMode="decimal"
                          value={v.price}
                          onChange={(e) => setVariant(i, { price: e.target.value })}
                          placeholder="Price"
                          className="w-full h-10 pl-6 pr-2 rounded-lg border border-stone-300 text-sm focus:border-brand outline-none"
                        />
                      </div>
                      <div className="relative">
                        <span className="absolute left-2 top-1/2 -translate-y-1/2 text-stone-400 text-xs">
                          {CURRENCY}
                        </span>
                        <input
                          type="number"
                          inputMode="decimal"
                          value={v.cost}
                          onChange={(e) => setVariant(i, { cost: e.target.value })}
                          placeholder="Cost"
                          className="w-full h-10 pl-6 pr-2 rounded-lg border border-stone-300 text-sm focus:border-brand outline-none"
                        />
                      </div>
                      <input
                        type="number"
                        inputMode="numeric"
                        value={v.stock}
                        onChange={(e) => setVariant(i, { stock: e.target.value })}
                        placeholder="Stock"
                        className="h-10 px-2 rounded-lg border border-stone-300 text-sm focus:border-brand outline-none"
                      />
                    </div>
                    <div className="flex gap-2 items-center">
                      <span className="flex-1">
                        <MarkupHint price={v.price} cost={v.cost} />
                      </span>
                      <button
                        type="button"
                        onClick={() => setVariant(i, { active: !v.active })}
                        className={`h-10 px-2 rounded-lg text-xs font-medium shrink-0 ${
                          v.active
                            ? "bg-brand-light text-brand-dark"
                            : "bg-stone-200 text-stone-500"
                        }`}
                      >
                        {v.active ? "On" : "Off"}
                      </button>
                      <button
                        type="button"
                        onClick={() => removeVariant(i)}
                        aria-label="Remove size"
                        className="w-9 h-10 rounded-lg text-stone-400 active:bg-stone-100 text-lg shrink-0"
                      >
                        ✕
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </>
          ) : (
            <p className="text-xs text-taupe">
              No sizes — sold at the single price above. Add sizes (e.g. Small /
              Medium / Large) to let the cashier choose one with its own price.
            </p>
          )}
        </div>

        <label className="flex items-center gap-2 mb-4 select-none">
          <input
            type="checkbox"
            checked={active}
            onChange={(e) => setActive(e.target.checked)}
            className="w-5 h-5 accent-brand"
          />
          <span className="text-stone-700">
            Available for sale (shows on the till)
          </span>
        </label>

        {error && (
          <p className="text-red-600 text-sm mb-3 animate-fade-in">{error}</p>
        )}

        <div className="flex gap-2">
          <button
            onClick={onCancel}
            disabled={busy}
            className="flex-1 h-12 rounded-lg bg-stone-100 text-stone-600 font-medium active:bg-stone-200 disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            onClick={save}
            disabled={!valid || busy || uploading}
            className="flex-1 h-12 rounded-lg bg-brand text-white font-semibold active:bg-brand-dark disabled:opacity-40"
          >
            {busy ? "Saving…" : "Save"}
          </button>
        </div>

        {initial && (
          <div className="mt-4 pt-4 border-t border-stone-100">
            {confirmDelete ? (
              <div>
                <p className="text-sm text-stone-700 mb-2">
                  Delete “{initial.name}” for good? This can't be undone. Past
                  sales keep their record.
                </p>
                <div className="flex gap-2">
                  <button
                    onClick={() => setConfirmDelete(false)}
                    disabled={busy}
                    className="flex-1 h-11 rounded-lg bg-stone-100 text-stone-600 font-medium active:bg-stone-200 disabled:opacity-50"
                  >
                    Cancel
                  </button>
                  <button
                    onClick={remove}
                    disabled={busy}
                    className="flex-1 h-11 rounded-lg bg-red-600 text-white font-semibold active:bg-red-700 disabled:opacity-50"
                  >
                    {busy ? "Deleting…" : "Delete item"}
                  </button>
                </div>
              </div>
            ) : (
              <button
                onClick={() => setConfirmDelete(true)}
                disabled={busy}
                className="w-full h-11 rounded-lg bg-white border border-red-300 text-red-700 font-medium active:bg-red-50 disabled:opacity-50"
              >
                Delete item
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
