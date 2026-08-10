import { useCallback, useEffect, useMemo, useState } from "react";
import type { Product } from "../lib/types";
import {
  managerDeleteCategory,
  managerListProducts,
  managerRenameCategory,
} from "../lib/api";

// Admin: rename or remove menu categories. Categories live on the products
// (there's no separate table), so renaming moves every item in it and removing
// reassigns its items to "Other".
export default function CategoriesManager({
  managerPin,
  onChanged,
}: {
  managerPin: string;
  onChanged: () => void;
}) {
  const [products, setProducts] = useState<Product[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);

  const load = useCallback(() => {
    managerListProducts(managerPin)
      .then(setProducts)
      .catch((e) =>
        setError(e instanceof Error ? e.message : "Failed to load")
      );
  }, [managerPin]);
  useEffect(load, [load]);

  // Category -> item count, sorted by name.
  const categories = useMemo(() => {
    const counts = new Map<string, number>();
    for (const p of products ?? [])
      counts.set(p.category, (counts.get(p.category) ?? 0) + 1);
    return Array.from(counts.entries())
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [products]);

  const rename = async (oldName: string) => {
    const next = draft.trim();
    if (next === "" || next === oldName) {
      setEditing(null);
      return;
    }
    setBusy(oldName);
    setError(null);
    try {
      await managerRenameCategory(managerPin, oldName, next);
      setEditing(null);
      onChanged();
      load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Rename failed");
    } finally {
      setBusy(null);
    }
  };

  const remove = async (name: string) => {
    setBusy(name);
    setError(null);
    try {
      await managerDeleteCategory(managerPin, name);
      setConfirmDelete(null);
      onChanged();
      load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Delete failed");
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="p-4">
      <div className="max-w-2xl mx-auto space-y-3">
        <p className="text-taupe text-sm">
          Rename a category to move all its items at once. Deleting a category
          moves its items to “Other”.
        </p>

        {error && <p className="text-red-600">{error}</p>}
        {!products && !error && <p className="text-stone-400">Loading…</p>}
        {products && categories.length === 0 && (
          <p className="text-stone-400">No categories yet.</p>
        )}

        <div className="space-y-2">
          {categories.map((c) => (
            <div
              key={c.name}
              className="bg-white border border-stone-200 rounded-xl p-3"
            >
              {editing === c.name ? (
                <div className="flex gap-2">
                  <input
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    autoFocus
                    className="flex-1 h-10 px-3 rounded-lg border border-stone-300 focus:border-brand outline-none"
                  />
                  <button
                    onClick={() => rename(c.name)}
                    disabled={busy === c.name}
                    className="h-10 px-4 rounded-lg bg-brand text-white font-semibold active:bg-brand-dark disabled:opacity-50"
                  >
                    Save
                  </button>
                  <button
                    onClick={() => setEditing(null)}
                    className="h-10 px-3 rounded-lg bg-stone-100 text-stone-600 font-medium active:bg-stone-200"
                  >
                    Cancel
                  </button>
                </div>
              ) : confirmDelete === c.name ? (
                <div>
                  <p className="text-sm text-stone-700 mb-2">
                    Delete “{c.name}”? Its {c.count} item
                    {c.count === 1 ? "" : "s"} will move to “Other”.
                  </p>
                  <div className="flex gap-2">
                    <button
                      onClick={() => setConfirmDelete(null)}
                      className="flex-1 h-10 rounded-lg bg-stone-100 text-stone-600 font-medium active:bg-stone-200"
                    >
                      Cancel
                    </button>
                    <button
                      onClick={() => remove(c.name)}
                      disabled={busy === c.name}
                      className="flex-1 h-10 rounded-lg bg-red-600 text-white font-semibold active:bg-red-700 disabled:opacity-50"
                    >
                      {busy === c.name ? "…" : "Delete"}
                    </button>
                  </div>
                </div>
              ) : (
                <div className="flex items-center justify-between">
                  <div className="min-w-0">
                    <p className="font-semibold text-stone-800 truncate">
                      {c.name}
                    </p>
                    <p className="text-sm text-taupe">
                      {c.count} item{c.count === 1 ? "" : "s"}
                    </p>
                  </div>
                  <div className="flex gap-1.5 shrink-0">
                    <button
                      onClick={() => {
                        setEditing(c.name);
                        setDraft(c.name);
                      }}
                      className="h-9 px-3 rounded-lg bg-stone-100 text-stone-700 text-sm font-medium active:bg-stone-200"
                    >
                      Rename
                    </button>
                    {c.name !== "Other" && (
                      <button
                        onClick={() => setConfirmDelete(c.name)}
                        className="h-9 px-3 rounded-lg bg-white border border-red-300 text-red-700 text-sm font-medium active:bg-red-50"
                      >
                        Delete
                      </button>
                    )}
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
