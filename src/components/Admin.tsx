import { useCallback, useEffect, useMemo, useState } from "react";
import {
  adminDeleteProduct,
  adminImportProducts,
  adminListProducts,
  adminSaveProduct,
  fetchAllCategories,
  fetchUnits,
  type ImportResult,
  type ProductInput,
} from "../lib/adminApi";
import { errorMessage } from "../lib/errors";
import { imageSrc } from "../lib/images";
import { money } from "../lib/format";
import { can } from "../lib/permissions";
import { fmtQty } from "../lib/receipt";
import type { AdminProduct, Category, UnitOfMeasure, User } from "../lib/types";
import ProductEditor from "./ProductEditor";
import CashUp from "./admin/CashUp";
import SalesHistory from "./admin/SalesHistory";
import ShopSettings from "./admin/ShopSettings";
import StaffAdmin from "./admin/StaffAdmin";

type TabKey = "catalogue" | "import" | "sales" | "cashup" | "staff" | "shop";

/**
 * The back office.
 *
 * The manager's PIN is taken once when this opens and held in memory for the
 * session — every RPC re-checks it server-side, so it has to travel with each
 * call, but it is never written to the device.
 */
export default function Admin({
  user,
  pin,
  onClose,
}: {
  user: User | null;
  pin: string;
  onClose: () => void;
}) {
  // Only the tabs this person is actually allowed to open. The RPCs behind each
  // re-check the permission anyway; this is so a counter supervisor is not
  // shown a Staff tab that will only refuse them.
  const tabs = useMemo(() => {
    const t: { key: TabKey; label: string }[] = [
      { key: "catalogue", label: "Catalogue" },
      { key: "import", label: "Bulk import" },
    ];
    if (can(user, "view_reports")) t.push({ key: "sales", label: "Sales" });
    if (can(user, "cash_management")) t.push({ key: "cashup", label: "Cash-up" });
    if (can(user, "manage_staff")) t.push({ key: "staff", label: "Staff" });
    if (can(user, "manage_settings")) t.push({ key: "shop", label: "Shop" });
    return t;
  }, [user]);

  const [tab, setTab] = useState<TabKey>("catalogue");
  const [products, setProducts] = useState<AdminProduct[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [units, setUnits] = useState<UnitOfMeasure[]>([]);
  const [editing, setEditing] = useState<AdminProduct | null | "new">(null);
  const [term, setTerm] = useState("");
  // An imported supplier catalogue arrives as thousands of hidden lines. The
  // job then is to work through them, so the list has to be narrowable by the
  // two things that actually divide it: whether the till sells it, and which
  // department it belongs to.
  const [onSale, setOnSale] = useState<"all" | "live" | "hidden">("all");
  const [dept, setDept] = useState<string>("all");
  // A tablet renders ~1,400 rows slowly and nobody reads past the first
  // screenful anyway. The cap is lifted by narrowing, and the footer always
  // says what is being withheld — a silent truncation would be a lie.
  const [showAll, setShowAll] = useState(false);
  const ROW_CAP = 300;
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const canSeeCost = can(user, "view_cost_prices");

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [p, c, u] = await Promise.all([
        adminListProducts(pin),
        fetchAllCategories(),
        fetchUnits(),
      ]);
      setProducts(p);
      setCategories(c);
      setUnits(u);
      setError(null);
    } catch (e) {
      setError(errorMessage(e, "Could not load the catalogue"));
    } finally {
      setLoading(false);
    }
  }, [pin]);

  useEffect(() => {
    void load();
  }, [load]);

  const matching = products.filter((p) => {
    if (onSale === "live" && !p.active) return false;
    if (onSale === "hidden" && p.active) return false;
    if (dept !== "all" && (p.category_name ?? "—") !== dept) return false;
    const q = term.trim().toLowerCase();
    if (!q) return true;
    return (
      p.name.toLowerCase().includes(q) ||
      p.sku.toLowerCase().includes(q) ||
      (p.barcode ?? "").includes(q)
    );
  });
  const shown = showAll ? matching : matching.slice(0, ROW_CAP);
  const withheld = matching.length - shown.length;

  const depts = Array.from(
    new Set(products.map((p) => p.category_name ?? "—"))
  ).sort();
  const liveCount = products.filter((p) => p.active).length;

  async function save(input: ProductInput) {
    await adminSaveProduct(pin, input);
    setEditing(null);
    await load();
  }

  async function remove(id: string) {
    const outcome = await adminDeleteProduct(pin, id);
    setEditing(null);
    await load();
    setError(
      outcome === "deactivated"
        ? "That product has been sold before, so it was hidden from the till rather than deleted — its invoices still need to make sense."
        : null
    );
  }

  return (
    <div className="fixed inset-0 bg-stone-50 z-40 flex flex-col">
      <header className="flex items-center gap-3 px-4 py-3 bg-white border-b border-stone-200">
        <h1 className="text-lg font-semibold">Manage</h1>
        <nav className="flex gap-1 ml-4">
          {tabs.map((t) => (
            <button
              key={t.key}
              onClick={() => setTab(t.key)}
              className={`px-3 py-1.5 rounded-lg text-sm ${
                tab === t.key ? "bg-stone-800 text-white" : "text-stone-600"
              }`}
            >
              {t.label}
            </button>
          ))}
        </nav>
        <button onClick={onClose} className="ml-auto text-stone-500 px-3 py-1.5">
          Back to till
        </button>
      </header>

      {error && (
        <div
          onClick={() => setError(null)}
          className="px-4 py-2 bg-amber-100 text-amber-900 text-sm cursor-pointer"
        >
          {error}
        </div>
      )}

      {tab === "catalogue" && (
        <div className="flex-1 flex flex-col min-h-0">
          <div className="flex gap-2 p-3 bg-white border-b border-stone-200">
            <input
              value={term}
              onChange={(e) => setTerm(e.target.value)}
              placeholder="Search by name, SKU or barcode…"
              className="flex-1 rounded-xl border border-stone-300 px-3 py-2"
            />
            <button
              onClick={() => setEditing("new")}
              className="px-4 rounded-xl bg-emerald-600 text-white font-medium"
            >
              New product
            </button>
          </div>

          <div className="flex flex-wrap items-center gap-2 px-3 pb-3 bg-white border-b border-stone-200">
            {(
              [
                ["all", `All ${products.length}`],
                ["live", `On the till ${liveCount}`],
                ["hidden", `Not priced yet ${products.length - liveCount}`],
              ] as const
            ).map(([key, label]) => (
              <button
                key={key}
                onClick={() => {
                  setOnSale(key);
                  setShowAll(false);
                }}
                className={`px-3 py-1.5 rounded-full text-sm border ${
                  onSale === key
                    ? "bg-stone-800 text-white border-stone-800"
                    : "bg-white text-stone-600 border-stone-300"
                }`}
              >
                {label}
              </button>
            ))}

            {depts.length > 1 && (
              <select
                value={dept}
                onChange={(e) => {
                  setDept(e.target.value);
                  setShowAll(false);
                }}
                className="ml-auto rounded-xl border border-stone-300 px-3 py-1.5 text-sm bg-white"
                aria-label="Department"
              >
                <option value="all">Every department</option>
                {depts.map((d) => (
                  <option key={d} value={d}>
                    {d}
                  </option>
                ))}
              </select>
            )}
          </div>

          <div className="flex-1 overflow-y-auto">
            {loading ? (
              <p className="p-6 text-center text-stone-500">Loading…</p>
            ) : (
              <table className="w-full text-sm">
                <thead className="sticky top-0 bg-stone-100 text-stone-600 text-left">
                  <tr>
                    <th className="p-2 font-medium sr-only">Photo</th>
                    <th className="p-2 font-medium">SKU</th>
                    <th className="p-2 font-medium">Name</th>
                    <th className="p-2 font-medium">Dept</th>
                    <th className="p-2 font-medium">Unit</th>
                    <th className="p-2 font-medium text-right">Retail</th>
                    <th className="p-2 font-medium text-right">Trade</th>
                    {canSeeCost && (
                      <th className="p-2 font-medium text-right">Cost</th>
                    )}
                    <th className="p-2 font-medium text-right">Stock</th>
                  </tr>
                </thead>
                <tbody>
                  {shown.map((p) => {
                    const low =
                      p.stock_qty != null &&
                      p.reorder_level != null &&
                      p.stock_qty <= p.reorder_level;
                    return (
                      <tr
                        key={p.id}
                        onClick={() => setEditing(p)}
                        // A whole catalogue awaiting prices should not look
                        // broken: the row keeps full contrast and says
                        // "not priced" in words instead of fading out.
                        className="border-b border-stone-100 cursor-pointer hover:bg-stone-50"
                      >
                        {/* The catalogue shows what the till will show. */}
                        <td className="p-2">
                          {imageSrc(p.image_url) ? (
                            <img
                              src={imageSrc(p.image_url)!}
                              alt=""
                              loading="lazy"
                              className="w-10 h-10 object-cover rounded border border-stone-200"
                            />
                          ) : (
                            <span className="block w-10 h-10 rounded border border-dashed border-stone-200" />
                          )}
                        </td>
                        <td className="p-2 font-mono text-xs">{p.sku}</td>
                        <td className="p-2">
                          {p.name}
                          {!p.active && (
                            <span className="ml-2 align-middle text-[11px] font-medium
                                             px-1.5 py-0.5 rounded bg-amber-100 text-amber-800">
                              not priced
                            </span>
                          )}
                        </td>
                        <td className="p-2 text-stone-500">
                          {p.category_name ?? "—"}
                        </td>
                        <td className="p-2 text-stone-500">{p.unit_code}</td>
                        <td className="p-2 text-right tabular-nums">
                          {money(p.price_retail)}
                        </td>
                        <td className="p-2 text-right tabular-nums text-stone-500">
                          {p.price_trade != null ? money(p.price_trade) : "—"}
                        </td>
                        {canSeeCost && (
                          <td className="p-2 text-right tabular-nums text-stone-500">
                            {p.cost != null ? money(p.cost) : "—"}
                          </td>
                        )}
                        <td
                          className={`p-2 text-right tabular-nums ${
                            low ? "text-amber-600 font-medium" : ""
                          }`}
                        >
                          {p.stock_qty != null ? fmtQty(p.stock_qty) : "—"}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </div>
          <div className="px-4 py-2 bg-white border-t border-stone-200 text-xs text-stone-500">
            {shown.length} of {matching.length} lines
            {matching.length !== products.length && ` (${products.length} in all)`}
            {withheld > 0 && (
              <>
                {" · "}
                <button
                  onClick={() => setShowAll(true)}
                  className="underline underline-offset-2"
                >
                  show the other {withheld}
                </button>
              </>
            )}
          </div>
        </div>
      )}

      {tab === "import" && (
        <ImportPanel pin={pin} onDone={load} />
      )}

      {tab === "sales" && <SalesHistory pin={pin} />}

      {tab === "cashup" && <CashUp pin={pin} />}

      {tab === "staff" && <StaffAdmin user={user} pin={pin} />}

      {tab === "shop" && <ShopSettings pin={pin} />}

      {editing && (
        <ProductEditor
          pin={pin}
          product={editing === "new" ? null : editing}
          categories={categories}
          units={units}
          canSeeCost={canSeeCost}
          onSave={save}
          onDelete={remove}
          onClose={() => setEditing(null)}
        />
      )}
    </div>
  );
}

/**
 * Bulk import.
 *
 * A shop arrives with a price list in a spreadsheet, so this takes pasted CSV.
 * Rows match on SKU — existing lines are updated, new ones created — and each
 * row reports its own outcome, because a single bad line in four thousand
 * should not reject the other 3,999.
 */
function ImportPanel({ pin, onDone }: { pin: string; onDone: () => void }) {
  const [text, setText] = useState("");
  const [results, setResults] = useState<ImportResult[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run() {
    setBusy(true);
    setError(null);
    try {
      const rows = text
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean)
        .filter((l) => !/^sku\s*,/i.test(l)) // tolerate a header row
        .map((line) => {
          const c = line.split(",").map((s) => s.trim());
          const n = (v: string | undefined) =>
            v === undefined || v === "" ? undefined : Number(v.replace(/[^\d.-]/g, ""));
          return {
            sku: c[0] ?? "",
            name: c[1] || undefined,
            category: c[2] || undefined,
            unit: c[3] || undefined,
            price: n(c[4]),
            trade: n(c[5]),
            cost: n(c[6]),
            stock: n(c[7]),
            reorder: n(c[8]),
            barcode: c[9] || undefined,
          };
        });
      setResults(await adminImportProducts(pin, rows));
      onDone();
    } catch (e) {
      setError(errorMessage(e, "Import failed"));
    } finally {
      setBusy(false);
    }
  }

  const counts = results
    ? {
        created: results.filter((r) => r.outcome === "created").length,
        updated: results.filter((r) => r.outcome === "updated").length,
        rejected: results.filter((r) => r.outcome === "rejected").length,
      }
    : null;

  return (
    <div className="flex-1 overflow-y-auto p-4 space-y-3">
      <div className="bg-white rounded-xl p-4 space-y-2">
        <h2 className="font-semibold">Paste a price list</h2>
        <p className="text-sm text-stone-600">
          One line per product, comma separated, in this order. Only{" "}
          <strong>SKU</strong> is required — leave a field blank to keep whatever
          is already there.
        </p>
        <code className="block text-xs bg-stone-100 rounded-lg p-2 overflow-x-auto">
          SKU, Name, Department, Unit, Retail, Trade, Cost, Stock, Reorder, Barcode
        </code>
        <p className="text-xs text-stone-500">
          Unit is a code — <code>ea</code>, <code>m</code>, <code>kg</code>,{" "}
          <code>bag</code>, <code>m3</code>, <code>roll</code>, <code>box</code>,{" "}
          <code>L</code>, <code>sheet</code>. It decides whether the till will
          accept a fractional quantity, so it is worth getting right. Departments
          are created automatically if they don't exist.
        </p>
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          rows={10}
          placeholder={
            "CEM-425-50, Cement 42.5N 50kg, Building, bag, 115, 108, 92.50, 240, 40, 6001234000015\n" +
            "CHN-06, Chain 6mm Galvanised, Building, m, 35, 31.50, 24, 120, 30\n" +
            "NAL-100, Wire Nails 100mm loose, Fasteners, kg, 42, 38, 29.50, 85, 20"
          }
          className="w-full rounded-xl border border-stone-300 p-3 font-mono text-xs"
        />
        <button
          onClick={run}
          disabled={busy || !text.trim()}
          className="px-5 py-2.5 rounded-xl bg-emerald-600 text-white font-semibold disabled:opacity-40"
        >
          {busy ? "Importing…" : "Import"}
        </button>
        {error && <p className="text-sm text-red-600">{error}</p>}
      </div>

      {counts && (
        <div className="bg-white rounded-xl p-4">
          <p className="text-sm mb-2">
            <strong>{counts.created}</strong> created,{" "}
            <strong>{counts.updated}</strong> updated,{" "}
            <strong className={counts.rejected ? "text-red-600" : ""}>
              {counts.rejected}
            </strong>{" "}
            rejected.
          </p>
          {counts.rejected > 0 && (
            <ul className="text-xs divide-y divide-stone-100">
              {results!
                .filter((r) => r.outcome === "rejected")
                .map((r) => (
                  <li key={r.row_no} className="py-1">
                    <span className="text-stone-400">line {r.row_no}</span>{" "}
                    <span className="font-mono">{r.sku || "(no SKU)"}</span> —{" "}
                    <span className="text-red-600">{r.detail}</span>
                  </li>
                ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
