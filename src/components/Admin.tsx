import { useCallback, useEffect, useMemo, useState } from "react";
import {
  adminDeleteProduct,
  adminImportProducts,
  adminListProducts,
  adminListUsers,
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

type CatalogueView = "all" | "live" | "hidden" | "low" | "nobarcode";
type SortKey = "name" | "dept" | "retail" | "stock";

function compareBy(key: SortKey, a: AdminProduct, b: AdminProduct): number {
  switch (key) {
    case "name":
      return a.name.localeCompare(b.name);
    case "dept":
      return (a.category_name ?? "—").localeCompare(b.category_name ?? "—") || a.name.localeCompare(b.name);
    case "retail":
      return a.price_retail - b.price_retail || a.name.localeCompare(b.name);
    case "stock":
      // Unknown stock sorts last either way, so "least first" starts at the
      // lines that are actually running out.
      return (a.stock_qty ?? Infinity) - (b.stock_qty ?? Infinity) || a.name.localeCompare(b.name);
  }
}
import ProductEditor from "./ProductEditor";
import CashUp from "./admin/CashUp";
import Reports from "./admin/Reports";
import SalesHistory from "./admin/SalesHistory";
import ShopSettings from "./admin/ShopSettings";
import Approvals from "./admin/Approvals";
import StaffAdmin from "./admin/StaffAdmin";
import Shelf from "./admin/Shelf";
import Buying from "./admin/Buying";
import Suppliers from "./admin/Suppliers";

type TabKey =
  | "catalogue"
  | "import"
  | "shelf"
  | "suppliers"
  | "buying"
  | "sales"
  | "approvals"
  | "cashup"
  | "reports"
  | "staff"
  | "shop";

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
  initialTab,
}: {
  user: User | null;
  pin: string;
  onClose: () => void;
  /** Land on a section rather than the first one — the till's "Cash up"
      notice opens straight onto the drawer. */
  initialTab?: TabKey;
}) {
  // Only the tabs this person is actually allowed to open. The RPCs behind each
  // re-check the permission anyway; this is so a counter supervisor is not
  // shown a Staff tab that will only refuse them.
  const tabs = useMemo(() => {
    const t: { key: TabKey; label: string }[] = [];
    // Catalogue and Bulk import were unconditional, which was harmless while
    // everybody who could open Manage held manage_catalogue. The shelf grant
    // ends that: somebody whose only right is photographing shelves must not
    // be shown a catalogue screen that would only refuse them.
    if (can(user, "manage_catalogue")) {
      t.push({ key: "catalogue", label: "Catalogue" });
      t.push({ key: "import", label: "Bulk import" });
    }
    if (can(user, "shelf_capture") || can(user, "manage_catalogue")) {
      t.push({ key: "shelf", label: "Shelf" });
    }
    if (can(user, "view_reports")) t.push({ key: "sales", label: "Sales" });
    // The drawer of supplier paperwork, for whoever does the buying.
    if (can(user, "manage_purchasing")) t.push({ key: "suppliers", label: "Suppliers" });
    // Ordering, and what is owed for it. Its own tab rather than a corner of
    // Suppliers: filing a supplier's paperwork and deciding what to buy are
    // done by the same person at completely different moments.
    if (can(user, "manage_purchasing")) t.push({ key: "buying", label: "Buying" });
    // Its own tab rather than a corner of Settings: issuing a code is something
    // a manager does standing in a bank queue with a phone to their ear, not
    // something they configure.
    if (can(user, "approve_discount")) t.push({ key: "approvals", label: "Approvals" });
    if (can(user, "cash_management")) t.push({ key: "cashup", label: "Cash-up" });
    if (can(user, "view_reports")) t.push({ key: "reports", label: "Reports" });
    if (can(user, "manage_staff")) t.push({ key: "staff", label: "Staff" });
    if (can(user, "manage_settings")) t.push({ key: "shop", label: "Shop" });
    return t;
  }, [user]);

  // The first tab this person may actually open — a shelf-only user's Manage
  // is the camera, not a catalogue that would refuse to load.
  const [tab, setTab] = useState<TabKey>(
    initialTab && tabs.some((t) => t.key === initialTab) ? initialTab : tabs[0]?.key ?? "catalogue"
  );
  // On a phone the tabs live behind a burger (see the header); this is it.
  const [menuOpen, setMenuOpen] = useState(false);
  // How many colleagues are on the list but cannot sign in yet. Carried on the
  // menu's Staff row, because a closed menu is the one place that problem
  // could otherwise hide on a phone. A hint, not a screen: if the roster
  // cannot be read the badge simply stays absent, and the demo backend does
  // not serve the roster at all.
  const [staffWaiting, setStaffWaiting] = useState(0);
  const refreshWaiting = useCallback(async () => {
    if (!can(user, "manage_staff")) return;
    try {
      const roster = await adminListUsers(pin);
      setStaffWaiting(roster.filter((s) => s.active && s.status === "invited").length);
    } catch {
      /* the badge is a hint; the Staff screen itself reports load failures */
    }
  }, [user, pin]);
  useEffect(() => {
    void refreshWaiting();
  }, [refreshWaiting]);

  const [products, setProducts] = useState<AdminProduct[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [units, setUnits] = useState<UnitOfMeasure[]>([]);
  const [editing, setEditing] = useState<AdminProduct | null | "new">(null);
  const [term, setTerm] = useState("");
  // An imported supplier catalogue arrives as thousands of hidden lines. The
  // job then is to work through them, so the list has to be narrowable by the
  // two things that actually divide it: whether the till sells it, and which
  // department it belongs to.
  const [view, setView] = useState<CatalogueView>("all");
  const [dept, setDept] = useState<string>("all");
  // Alphabetical until somebody taps a heading; a second tap turns it round.
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: "name", dir: 1 });
  // The column legend is one line on a tablet and a tap away on a phone.
  const [legendOpen, setLegendOpen] = useState(false);
  // A tablet renders ~1,400 rows slowly and nobody reads past the first
  // screenful anyway. The cap is lifted by narrowing, and the footer always
  // says what is being withheld — a silent truncation would be a lie.
  const [showAll, setShowAll] = useState(false);
  const ROW_CAP = 300;
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const canSeeCost = can(user, "view_cost_prices");

  const load = useCallback(async () => {
    // The catalogue load feeds the Catalogue, Bulk import and Staff screens —
    // none of which a shelf-only user is shown. Asking anyway would put a
    // permission refusal in the error bar of a screen that did nothing wrong.
    if (!can(user, "manage_catalogue")) {
      setLoading(false);
      return;
    }
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
  }, [pin, user]);

  useEffect(() => {
    void load();
  }, [load]);

  const isLow = (p: AdminProduct) =>
    p.stock_qty != null && p.reorder_level != null && p.stock_qty <= p.reorder_level;
  const matching = products
    .filter((p) => {
      if (view === "live" && !p.active) return false;
      if (view === "hidden" && p.active) return false;
      if (view === "low" && !isLow(p)) return false;
      if (view === "nobarcode" && p.barcode) return false;
      if (dept !== "all" && (p.category_name ?? "—") !== dept) return false;
      const q = term.trim().toLowerCase();
      if (!q) return true;
      return (
        p.name.toLowerCase().includes(q) ||
        p.sku.toLowerCase().includes(q) ||
        (p.barcode ?? "").includes(q)
      );
    })
    .sort((a, b) => sort.dir * compareBy(sort.key, a, b));
  const shown = showAll ? matching : matching.slice(0, ROW_CAP);
  const withheld = matching.length - shown.length;

  const depts = Array.from(
    new Set(products.map((p) => p.category_name ?? "—"))
  ).sort();
  const liveCount = products.filter((p) => p.active).length;
  const lowCount = products.filter(isLow).length;
  const noBarcodeCount = products.filter((p) => !p.barcode).length;

  function sortBy(key: SortKey) {
    setSort((s) => (s.key === key ? { key, dir: s.dir === 1 ? -1 : 1 } : { key, dir: 1 }));
  }

  /** A heading that sorts. The label stays plain text so it reads the same to
      a screen reader whether or not it is the sorted column. */
  const heading = (key: SortKey, label: string, cls = "") => (
    <th
      className={`p-2 font-medium ${cls}`}
      aria-sort={sort.key === key ? (sort.dir === 1 ? "ascending" : "descending") : "none"}
    >
      <button type="button" onClick={() => sortBy(key)} className="inline-flex items-center gap-1">
        {label}
        {sort.key === key && (
          <span aria-hidden="true" className="text-[10px]">{sort.dir === 1 ? "▲" : "▼"}</span>
        )}
      </button>
    </th>
  );

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
    // 100dvh, not just inset-0: a phone's address bar overlays the layout
    // viewport, so the bottom of the last card sat underneath it with no way to
    // scroll clear. The dynamic unit tracks the chrome as it comes and goes.
    <div className="fixed inset-0 h-[100dvh] bg-paper z-40 flex flex-col">
      <header className="flex items-center gap-2 px-4 py-3 bg-colophon">
        {/* On a phone the tabs collapse behind this burger. A strip of seven
            scrolled sideways there, and the far tabs — Staff and Shop, the
            ones a manager pulls a phone out FOR — were three screen-widths
            away with nothing to say so. On a tablet the strip below is the
            better tool (every section one tap, none hidden), so the burger
            exists only under sm. */}
        <button
          className="sm:hidden shrink-0 w-9 h-9 flex flex-col items-center justify-center gap-1 rounded-lg border border-white/30"
          aria-label="Sections"
          aria-expanded={menuOpen}
          onClick={() => {
            setMenuOpen((o) => !o);
            // Opening is the moment the count is looked at, so it is the
            // moment it is refreshed — an invite made moments ago on this very
            // screen must show here without a reload.
            if (!menuOpen) void refreshWaiting();
          }}
        >
          <span aria-hidden="true" className="block w-4 h-0.5 bg-paper rounded-full" />
          <span aria-hidden="true" className="block w-4 h-0.5 bg-paper rounded-full" />
          <span aria-hidden="true" className="block w-4 h-0.5 bg-paper rounded-full" />
        </button>
        <h1 className="text-lg font-semibold shrink-0 text-paper">Manage</h1>
        {/* A burger hides where you are, so the header says it instead. */}
        <span className="sm:hidden min-w-0 truncate text-white/60">
          · <span className="font-medium text-paper">
            {tabs.find((t) => t.key === tab)?.label}
          </span>
        </span>
        {/* Built for a tablet, then opened on a manager's phone — where seven
            tabs do not fit, "Bulk import" wrapped onto two lines, and Staff and
            Shop were off the right-hand edge with nothing to say so. The row
            scrolls now: min-w-0 lets it shrink below its content so the
            overflow actually engages, and nothing inside it wraps. Under sm it
            yields to the burger above instead. */}
        <nav className="hidden sm:flex gap-1 ml-1 min-w-0 overflow-x-auto">
          {tabs.map((t) => (
            <button
              key={t.key}
              onClick={() => setTab(t.key)}
              className={`px-3 py-1.5 rounded-lg text-sm shrink-0 whitespace-nowrap ${
                tab === t.key ? "bg-white/10 text-gold-400 font-medium" : "text-white/70"
              }`}
            >
              {t.label}
            </button>
          ))}
        </nav>
        {/* Never inside the menu: the way out must not need finding. */}
        <button
          onClick={onClose}
          className="ml-auto shrink-0 text-white/70 px-2 py-1.5 text-sm whitespace-nowrap"
        >
          Back to till
        </button>
      </header>

      {/* The burger's menu: a compact card under the button, not a screen of
          its own. The page stays visible behind a light scrim — a menu that
          swallows the display reads as "you have left", and losing sight of
          the work in progress is the cost. Rows keep their full height; a
          menu you mis-tap is worse than a menu that is a little tall. */}
      {menuOpen && (
        <div className="sm:hidden">
          <div
            className="fixed inset-0 z-40 bg-black/20"
            onClick={() => setMenuOpen(false)}
          />
          <div className="absolute left-2 top-16 z-50 w-72 bg-white border border-stone-200 rounded-2xl shadow-xl overflow-hidden">
            {tabs.map((t) => (
              <button
                key={t.key}
                onClick={() => {
                  setTab(t.key);
                  setMenuOpen(false);
                }}
                aria-current={tab === t.key ? "page" : undefined}
                className={`w-full flex items-center gap-2 text-left px-4 py-3 text-[15px] border-b border-stone-100 last:border-b-0 ${
                  tab === t.key ? "bg-gold-100 font-medium" : "hover:bg-stone-50"
                }`}
              >
                {t.label}
                {/* Somebody stuck at "PIN not set" must be visible from here,
                    or a closed menu is where that problem goes to hide. */}
                {t.key === "staff" && staffWaiting > 0 && (
                  <span className="text-xs px-2 py-0.5 rounded-full bg-amber-100 text-amber-800">
                    {staffWaiting} waiting
                  </span>
                )}
                {tab === t.key && (
                  <span aria-hidden="true" className="ml-auto">
                    ✓
                  </span>
                )}
              </button>
            ))}
          </div>
        </div>
      )}

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
              className="px-4 rounded-xl bg-gold-400 text-colophon font-semibold"
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
                ["low", `Low stock ${lowCount}`],
                ["nobarcode", `No barcode ${noBarcodeCount}`],
              ] as const
            ).map(([key, label]) => (
              <button
                key={key}
                onClick={() => {
                  setView(key);
                  setShowAll(false);
                }}
                aria-pressed={view === key}
                className={`px-3 py-1.5 rounded-full text-sm border ${
                  view === key
                    ? "bg-colophon text-paper border-colophon"
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

          {/* What the money columns mean, said once where the columns are.
              Tooltips would not do: nobody can hover on a tablet. One line on
              a tablet; on a phone it sits behind a tap so the list starts
              higher. */}
          <div className="px-3 py-1.5 bg-stone-50 border-b border-stone-200 text-xs text-stone-500">
            <button
              type="button"
              className="sm:hidden underline"
              onClick={() => setLegendOpen((o) => !o)}
              aria-expanded={legendOpen}
            >
              What the columns mean
            </button>
            <p className={`${legendOpen ? "block mt-1" : "hidden"} sm:block sm:mt-0`}>
              <b className="font-medium text-stone-600">Retail</b> is what the till charges, incl. VAT.{" "}
              <b className="font-medium text-stone-600">Trade</b> is what account customers pay.{" "}
              {canSeeCost && (
                <>
                  <b className="font-medium text-stone-600">Cost</b> is what you paid the supplier, ex VAT, with the margin under it.{" "}
                </>
              )}
              <b className="font-medium text-stone-600">Stock</b> is on hand now; amber means at or below the reorder level.
            </p>
          </div>

          {/* overflow-x too: the catalogue is a wide table and on a phone it
              was pushing the whole page sideways, so the header and the tab
              strip slid off with it. A table that scrolls inside its own box
              keeps that to the table.

              Nine columns edge to edge read as clipped on a laptop, so the
              last column keeps a gutter, the name takes what is left and
              stops at two lines, and department and unit step aside below a
              laptop's width — both are on the editor a tap away. */}
          <div className="flex-1 overflow-y-auto overflow-x-auto">
            {loading ? (
              <p className="p-6 text-center text-stone-500">Loading…</p>
            ) : (
              <table className="w-full text-sm">
                <thead className="sticky top-0 bg-stone-100 text-stone-600 text-left">
                  <tr>
                    <th className="p-2 font-medium sr-only">Photo</th>
                    <th className="p-2 font-medium">SKU</th>
                    {heading("name", "Name", "w-full")}
                    {heading("dept", "Dept", "hidden lg:table-cell")}
                    <th className="p-2 font-medium hidden lg:table-cell">Unit</th>
                    {heading("retail", "Retail", "text-right whitespace-nowrap")}
                    <th className="p-2 font-medium text-right whitespace-nowrap">Trade</th>
                    {canSeeCost && (
                      <th className="p-2 font-medium text-right whitespace-nowrap">Cost</th>
                    )}
                    {heading("stock", "Stock", "pr-4 text-right whitespace-nowrap")}
                  </tr>
                </thead>
                <tbody>
                  {shown.map((p) => {
                    const low = isLow(p);
                    const exVat = p.price_retail > 0 ? p.price_retail / 1.15 : 0;
                    const margin =
                      canSeeCost && p.cost != null && p.cost > 0 && exVat > 0
                        ? ((exVat - p.cost) / exVat) * 100
                        : null;
                    return (
                      <tr
                        key={p.id}
                        onClick={() => setEditing(p)}
                        // Zebra rows: nine columns is a long way for the eye
                        // to travel, and a faint band keeps it on the line.
                        // A whole catalogue awaiting prices should not look
                        // broken: the row keeps full contrast and says
                        // "not priced" in words instead of fading out.
                        className="border-b border-stone-100 cursor-pointer even:bg-stone-50/70 hover:bg-amber-50"
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
                        <td className="p-2 font-mono text-xs whitespace-nowrap">
                          {p.sku}
                          {/* The barcode under the code, because this week's
                              question is "will a gun find it?" */}
                          <span className="block text-[11px] text-stone-400 font-normal">
                            {p.barcode ?? "no barcode"}
                          </span>
                        </td>
                        <td className="p-2">
                          <span className="line-clamp-2" title={p.name}>{p.name}</span>
                          {!p.active && (
                            <span className="ml-2 align-middle text-[11px] font-medium
                                             px-1.5 py-0.5 rounded bg-amber-100 text-amber-800">
                              not priced
                            </span>
                          )}
                        </td>
                        <td className="p-2 text-stone-500 hidden lg:table-cell">
                          {p.category_name ?? "—"}
                        </td>
                        <td className="p-2 text-stone-500 hidden lg:table-cell">{p.unit_code}</td>
                        <td className="p-2 text-right tabular-nums whitespace-nowrap">
                          {money(p.price_retail)}
                        </td>
                        <td className="p-2 text-right tabular-nums whitespace-nowrap text-stone-500">
                          {p.price_trade != null ? money(p.price_trade) : "—"}
                        </td>
                        {canSeeCost && (
                          <td className="p-2 text-right tabular-nums whitespace-nowrap text-stone-500">
                            {p.cost != null ? money(p.cost) : "—"}
                            {margin != null && (
                              <span
                                className={`block text-[11px] ${
                                  margin < 15 ? "text-amber-700" : "text-stone-400"
                                }`}
                              >
                                {margin.toFixed(1)}% margin
                              </span>
                            )}
                          </td>
                        )}
                        <td
                          className={`p-2 pr-4 text-right tabular-nums whitespace-nowrap ${
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

      {tab === "shelf" && <Shelf user={user} pin={pin} />}
      {tab === "suppliers" && <Suppliers pin={pin} />}
      {tab === "buying" && <Buying pin={pin} products={products} />}

      {tab === "sales" && <SalesHistory pin={pin} user={user} />}

      {tab === "approvals" && <Approvals pin={pin} />}

      {tab === "cashup" && <CashUp pin={pin} />}
      {tab === "reports" && <Reports pin={pin} />}

      {tab === "staff" && <StaffAdmin user={user} pin={pin} products={products} />}

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
          className="px-5 py-2.5 rounded-xl bg-gold-400 text-colophon font-semibold disabled:opacity-40"
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
