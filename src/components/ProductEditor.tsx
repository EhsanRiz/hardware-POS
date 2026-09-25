import { useEffect, useState } from "react";
import {
  adminAdjustStock, adminStockHistory, startCounting, type ProductInput,
} from "../lib/adminApi";
import { CURRENCY } from "../lib/config";
import { errorMessage } from "../lib/errors";
import { money } from "../lib/format";
import { imageSrc } from "../lib/images";
import { fmtQty } from "../lib/receipt";
import BarcodeScanner from "./BarcodeScanner";
import ProductPhotos from "./ProductPhotos";
import type { AdminProduct, Category, StockMovement, UnitOfMeasure } from "../lib/types";
import { fmtDate } from "../lib/dates";
import { useCamera } from "../lib/useCamera";

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
  initial,
  fromCount,
}: {
  pin: string;
  product: AdminProduct | null;
  categories: Category[];
  units: UnitOfMeasure[];
  canSeeCost: boolean;
  onSave: (p: ProductInput) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
  onClose: () => void;
  /** What a new product starts with — a counted item's name, barcode, unit. */
  initial?: Partial<ProductInput>;
  /**
   * Opened from a count's review list (0116): the stock figure is the
   * count's to set when it is posted, so there is no opening stock to type,
   * and the counters' photos go onto the product when it is saved.
   */
  fromCount?: { photos: string[] };
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
    sold_in_packs: product?.sold_in_packs ?? false,
    pack_size: product?.pack_size ?? null,
    pack_label: product?.pack_label ?? null,
    price_cut_retail: product?.price_cut_retail ?? null,
    price_cut_trade: product?.price_cut_trade ?? null,
    ...(product ? {} : initial),
  }));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [countTo, setCountTo] = useState("");
  const [countNote, setCountNote] = useState("");
  const [history, setHistory] = useState<StockMovement[] | null>(null);

  /**
   * What the shelf reads NOW, as opposed to when this dialog opened.
   *
   * `f` is a snapshot taken at mount, and it has to be — it is the edit in
   * progress. Stock is the one field on it that something else can move while
   * the dialog is open, because Apply below goes straight to the server. Two
   * things followed from reading stock off `f`: the screen kept showing the
   * old figure after a count, and — until 0111 — pressing Save afterwards
   * wrote that stale figure back over the balance with no movement to explain
   * it. The server no longer accepts stock on an update, so this is now about
   * the screen telling the truth rather than about losing anything.
   */
  const [stockNow, setStockNow] = useState<number | null>(
    product?.stock_qty ?? null
  );
  /** The first count of something never counted. See startCounting. */
  const [firstCount, setFirstCount] = useState("");

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

  /**
   * What is in a number box WHILE somebody is typing in it.
   *
   * Reported from the shop: "the cost doesn't take decimals". It did not, and
   * no number box here did, because each one was a controlled input whose
   * value was the PARSED number. Type "82." and Number("82.") is 82, the box
   * re-renders as "82", and the decimal point the person just pressed is gone
   * — so the next key lands against the whole number and 82.80 comes out 8280.
   *
   * The model still holds a number; this holds the keystrokes until they stop.
   * On blur the raw text is dropped and the box re-reads the model, so a half
   * typed "82." settles to 82 and nothing invalid can be saved.
   */
  const [raw, setRaw] = useState<Partial<Record<keyof ProductInput, string>>>({});
  const numField = <K extends keyof ProductInput>(k: K) => ({
    inputMode: "decimal" as const,
    value: raw[k] ?? (f[k] == null || f[k] === 0 ? "" : String(f[k])),
    onChange: (e: React.ChangeEvent<HTMLInputElement>) => {
      setRaw((r) => ({ ...r, [k]: e.target.value }));
      set(k, num(e.target.value) as ProductInput[K]);
    },
    onBlur: () => setRaw((r) => { const n = { ...r }; delete n[k]; return n; }),
    className: inputCls,
  });

  // Both figures, both ex VAT. Margin is profit over the ex-VAT selling
  // price, which is what margin reports use; markup is profit over cost,
  // which is how a shop that buys at 25 and sells at 50 thinks of it. Shown
  // together because R50 on R25 read as "100%" to the first person who
  // tried it, and the VAT the shop hands on is nobody's profit.
  const exVat = f.price_retail > 0 ? f.price_retail / (1 + 0.15) : 0;
  const marginHint =
    canSeeCost && f.cost != null && f.cost > 0 && exVat > 0
      ? `Margin ${(((exVat - f.cost) / exVat) * 100).toFixed(1)}% · markup ${(
          ((exVat - f.cost) / f.cost) *
          100
        ).toFixed(1)}%, ex VAT`
      : undefined;

  // A phone has a camera and no scanner gun; the tablet has the reverse, and
  // there a gun types straight into the field.
  const [scanning, setScanning] = useState(false);
  // Whether a camera EXISTS, not whether the browser has the API for one.
  // `!!navigator.mediaDevices?.getUserMedia` is true in Chrome on a desktop
  // with nothing plugged in, which is how a "scan it" button came to sit on a
  // counter machine that has no lens. See lib/device.ts.
  const canScan = useCamera();

  // Every catch below goes through errorMessage, NOT `e instanceof Error`.
  // supabase-js does not throw — api.ts rethrows the plain object it returns,
  // so the instanceof check misses every server message and the counter gets
  // the fallback instead. That is how "The code CEM50 is already used by
  // Cement 50kg" arrived at this screen as "Could not save". See lib/errors.
  async function save() {
    setBusy(true);
    setError(null);
    try {
      await onSave(f);
    } catch (e) {
      setError(errorMessage(e, "Could not save"));
      setBusy(false);
    }
  }

  async function recount() {
    const n = num(countTo);
    if (n == null || !product) return;
    setBusy(true);
    setError(null);
    try {
      setStockNow(await adminAdjustStock(pin, product.id, n, countNote || null));
      setCountTo("");
      setCountNote("");
      setHistory(await adminStockHistory(pin, product.id));
    } catch (e) {
      setError(errorMessage(e, "Could not adjust stock"));
    } finally {
      setBusy(false);
    }
  }

  /**
   * Start counting something that has never been counted.
   *
   * The screen this replaces told the truth and was still a dead end: it said
   * to go to Stock, Receive a delivery — a screen for goods that arrived, and
   * one that refuses an item not yet live, which is every item sitting in
   * "Not priced yet". Meanwhile the person is here, holding the thing, and
   * knows how many there are.
   */
  async function beginCount() {
    const n = num(firstCount);
    if (n == null || !product) return;
    setBusy(true);
    setError(null);
    try {
      const now = await startCounting(
        pin, product.id, n, countNote || "First count"
      );
      setStockNow(now);
      setFirstCount("");
      setCountNote("");
      setHistory(await adminStockHistory(pin, product.id));
    } catch (e) {
      setError(errorMessage(e, "Could not start counting this"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="vv-fixed bg-black/40 flex items-start justify-center p-4 z-50 overflow-y-auto">
      {scanning && (
        <BarcodeScanner
          onCode={(code) => {
            set("barcode", code);
            setScanning(false);
          }}
          onClose={() => setScanning(false)}
        />
      )}
      <div className="bg-white rounded-2xl w-full max-w-2xl my-6">
        <div className="flex items-center justify-between p-4 border-b border-stone-200">
          <h2 className="text-lg font-semibold">
            {fromCount && isNew ? "Add to the catalogue" : isNew ? "New product" : f.name}
          </h2>
          <button onClick={onClose} className="text-stone-400 text-2xl leading-none">
            ×
          </button>
        </div>

        <div className="p-4 space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <Field
              label="SKU"
              hint={
                product
                  ? "Your own code. Must be unique."
                  : "Your own code, or leave blank and the next number (SKU-000412) is assigned."
              }
            >
              <input
                value={f.sku}
                onChange={(e) => set("sku", e.target.value)}
                className={inputCls}
                placeholder={product ? "CEM-425-50" : "Assigned if blank"}
              />
            </Field>
            <Field label="Barcode" hint="Scanned at the till. Leave blank if none.">
              <div className="flex gap-2">
                <input
                  value={f.barcode ?? ""}
                  onChange={(e) => set("barcode", e.target.value || null)}
                  className={inputCls}
                  placeholder="6001234000015"
                />
                {canScan && (
                  <button
                    type="button"
                    onClick={() => setScanning(true)}
                    className="shrink-0 px-3 rounded-lg border border-stone-300 text-sm text-stone-700"
                  >
                    Scan
                  </button>
                )}
              </div>
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
            <Field
              label={
                f.sold_in_packs
                  ? `Retail per ${f.pack_label?.trim() || "whole one"} (${CURRENCY}, incl VAT)`
                  : `Retail (${CURRENCY}, incl VAT)`
              }
            >
              <input
                {...numField("price_retail")}
              />
            </Field>
            <Field
              label={f.sold_in_packs ? "Trade per whole one" : "Trade"}
              hint="Blank = trade pays retail."
            >
              <input
                {...numField("price_trade")}
              />
            </Field>
            {canSeeCost ? (
              <Field
                label="Cost"
                hint={marginHint}
              >
                <input
                  {...numField("cost")}
                />
              </Field>
            ) : (
              <Field label="Cost" hint="You don't have permission to see costs.">
                <input disabled className={inputCls + " bg-stone-100"} value="—" />
              </Field>
            )}
          </div>

          {/* SOLD TWO WAYS.
              Behind a tick because most of a hardware range is not: a padlock
              is a padlock. Ticking it changes what the two prices above MEAN —
              they become the price of a whole one — which is why their labels
              above read differently once it is on. */}
          <div className="rounded-xl border border-stone-200 p-3">
            <label className="flex items-center gap-3 cursor-pointer">
              <input
                type="checkbox"
                className="h-5 w-5"
                checked={f.sold_in_packs ?? false}
                onChange={(e) => {
                  const on = e.target.checked;
                  setF((cur) => ({
                    ...cur,
                    sold_in_packs: on,
                    // Unticking clears the lot rather than leaving a stale cut
                    // price on an item nothing can sell cut — somebody ticks
                    // the box again next season and trusts what is in the box.
                    ...(on ? {} : {
                      pack_size: null, pack_label: null,
                      price_cut_retail: null, price_cut_trade: null,
                    }),
                  }));
                }}
              />
              <span className="text-[15px] font-medium">
                Also sold cut to length
              </span>
            </label>
            <p className="text-xs text-stone-500 mt-1">
              For pipe sold as a 6 m length and cut to size, or wire sold as a
              bundle and off the drum. Two prices, one item.
            </p>

            {/* THE UNIT IS THE CUT, and this is the trap the first shop to use
                this fell into. "Sold by" decides what one CUT one is — so a
                50 m roll of wire sold by Each cuts into "eaches", the till
                offers "R60.00 / Each" for what is R60 a metre, and because
                Each refuses a fraction nobody can sell 2.5 m of it.

                Not refused, because it is legitimate for a box of fifty screws
                sold singly — whole screws are exactly right there. It is only
                wrong when the thing is MEASURED, which is the common case and
                the one the words above describe. So it is said plainly rather
                than guessed at. */}
            {f.sold_in_packs && unit && !unit.allows_fraction && (
              <div className="rounded-xl bg-amber-50 p-3 mt-3">
                <div className="text-sm font-medium">
                  Cutting this will only take whole numbers
                </div>
                <p className="text-xs text-stone-600 mt-1">
                  <strong>Sold by</strong> is{" "}
                  <strong>{unit.name}</strong>, so a cut is priced and counted
                  per {unit.name.toLowerCase()} and cannot be split — no 2.5 of
                  it. Right for a box of screws sold singly. If this is
                  measured, set <strong>Sold by</strong> to the measure (Metre,
                  Kilogram) and the cut price becomes a price per metre.
                </p>
              </div>
            )}

            {f.sold_in_packs && (
              <div className="mt-3 space-y-3">
                <div className="grid grid-cols-2 gap-3">
                  <Field
                    label="One whole one is called"
                    hint="As the counter says it."
                  >
                    <input
                      value={f.pack_label ?? ""}
                      placeholder="6 m length"
                      onChange={(e) =>
                        set("pack_label", e.target.value || null)}
                      className={inputCls}
                    />
                  </Field>
                  <Field
                    label={`How many ${f.unit_code} in one`}
                    hint="A 6 m length is 6."
                  >
                    <input
                      {...numField("pack_size")}
                    />
                  </Field>
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <Field label={`Cut price per ${f.unit_code} (retail)`}>
                    <input
                      {...numField("price_cut_retail")}
                    />
                  </Field>
                  <Field
                    label={`Cut price per ${f.unit_code} (trade)`}
                    hint="Blank = trade pays the retail cut price."
                  >
                    <input
                      {...numField("price_cut_trade")}
                    />
                  </Field>
                </div>

                {/* WHAT ON HAND NOW MEANS.
                    Stock has to be counted in the base unit, because one pool
                    serves both ways of selling. So ticking this box on an item
                    that already has a count changes what that number means,
                    and nothing can work out which it was — twenty lengths and
                    twenty metres are both perfectly sensible readings of 20.
                    Said out loud, with the arithmetic done, rather than
                    silently multiplied: a shop that loses a stock count to a
                    helpful migration has lost a day. */}
                {!isNew
                  && !product?.sold_in_packs
                  && stockNow != null
                  && (f.pack_size ?? 0) > 0 && (
                  <div className="rounded-xl bg-amber-50 p-3">
                    <div className="text-sm font-medium">
                      Check On hand before you save
                    </div>
                    <p className="text-xs text-stone-600 mt-1">
                      On hand is counted in {f.unit_code} for an item sold both
                      ways. It reads <strong>{stockNow}</strong> — if that
                      meant {stockNow}{" "}
                      {f.pack_label?.trim() || "whole ones"}, it should be{" "}
                      <strong>
                        {Math.round(stockNow * (f.pack_size ?? 1) * 1000) / 1000}
                      </strong>
                      . Nothing is changed for you.
                    </p>
                  </div>
                )}
              </div>
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

            {fromCount && isNew ? (
              <Field label="Stock" hint="Comes from the count when it is posted — with anything sold meanwhile taken off.">
                <input value="From the count" disabled aria-label="Stock" className={inputCls + " bg-stone-100"} />
              </Field>
            ) : (
            <Field
              label={isNew ? "Opening stock" : "On hand"}
              // Greyed after creation on purpose: stock moves through the
              // ledger so the balance can always be explained. That is right,
              // and it said nothing at all about where to go instead — a
              // manager who scanned an item on the shelf found the figure
              // locked and reasonably concluded it could not be set.
              hint={
                isNew
                  ? "Blank = don't track stock."
                  : stockNow == null
                    ? "Not counted yet — start below."
                    : "Changed by the stock count below."
              }
            >
              {/* Reads stockNow, not the form, so a count applied a moment ago
                  shows here instead of the figure this dialog opened with. */}
              <input
                {...numField("stock_qty")}
                {...(isNew ? {} : { value: stockNow ?? "" })}
                disabled={!isNew}
                className={inputCls + (isNew ? "" : " bg-stone-100")}
              />
            </Field>
            )}

            <Field
              label="Reorder at"
              hint={
                stockNow == null
                  ? "Needs a stock count first — see below."
                  : "Warns on the till below this."
              }
            >
              <input
                {...numField("reorder_level")}
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
                  {...numField("max_discount_percent")}
                  aria-label="Maximum discount percent"
                  placeholder="—"
                />
              </Field>
              <Field
                label={`${CURRENCY} off, at most`}
                hint={`Per ${unit?.name?.toLowerCase() ?? f.unit_code} — ten of them allows ten times as much.`}
              >
                <input
                  {...numField("max_discount_amount")}
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
            {fromCount && isNew ? (
              fromCount.photos.length ? (
                <div className="flex flex-wrap gap-2" role="group" aria-label="Counters' photos">
                  {fromCount.photos.map((p, i) => (
                    <img key={p} src={imageSrc(p) ?? undefined} alt={`Counter's photo ${i + 1}`}
                      className="w-24 h-24 object-cover rounded border border-stone-200 bg-stone-50" />
                  ))}
                  <p className="text-xs text-stone-500 w-full">
                    The counters' photos. They become this product's pictures when you save.
                  </p>
                </div>
              ) : (
                <p className="text-xs text-stone-500">
                  No photos from the count. Add some after saving, in Manage → Catalogue.
                </p>
              )
            ) : (
              <ProductPhotos productId={product?.id ?? null} pin={pin} />
            )}
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

          {/* Never counted: the case a shelf scan leaves behind. The editor
              said nothing here at all — no count box, because there is no
              balance to correct, and a locked figure above it. So the item
              read as broken. It is not: it sells perfectly well untracked
              (apply_stock only moves rows WHERE stock_qty is not null), and
              Receive is what starts counting it. A stock count cannot, and
              says so from the server in words nobody can act on:
              "Stock is not tracked for X". */}
          {!isNew && stockNow == null && (
            <div className="rounded-xl bg-stone-50 p-3 space-y-2">
              <div className="text-sm font-medium">Stock is not counted for this item</div>
              <p className="text-xs text-stone-500">
                It still sells, and nothing is deducted — so it never runs out,
                never warns you it is low and never reaches a reorder list.
                Count what is on the shelf to start tracking it.
              </p>
              <div className="flex items-center gap-2">
                <input
                  inputMode="decimal"
                  value={firstCount}
                  onChange={(e) => setFirstCount(e.target.value)}
                  placeholder="On shelf"
                  aria-label="First count"
                  style={{ width: "6.5rem" }}
                  className={inputCls + " flex-none"}
                  disabled={busy}
                />
                <button
                  onClick={beginCount}
                  disabled={busy || !firstCount}
                  className="flex-none px-4 py-2 rounded-xl bg-colophon text-paper text-sm disabled:opacity-40"
                >
                  Start counting
                </button>
              </div>
              <input
                value={countNote}
                onChange={(e) => setCountNote(e.target.value)}
                placeholder="Reason (e.g. first count, found on shelf)"
                aria-label="Reason for the count"
                className={inputCls}
                disabled={busy}
              />
              {/* Zero is a real answer and the box takes it: it starts the
                  counting without inventing a receipt for goods nobody has. */}
              <p className="text-xs text-stone-500">
                None on the shelf? Enter 0 — that still starts the tracking.
              </p>
              {/* A reorder level on an untracked item is a number that can
                  never fire: every notice and reorder query requires BOTH a
                  reorder level and a stock figure. The box took it, saved it
                  and showed it back, which reads as "covered" to the person
                  who set it. It is kept rather than refused — it starts
                  working the moment this item is counted — but it no longer
                  pretends to be doing something. */}
              {f.reorder_level != null && (
                <p className="text-xs text-amber-700">
                  "Reorder at {f.reorder_level}" cannot warn you until this
                  item is counted. Counting it here is what switches it on.
                </p>
              )}
            </div>
          )}

          {/* Stock is only changed through a counted adjustment, so the movement
              ledger can always explain the balance. */}
          {!isNew && stockNow != null && (
            <div className="rounded-xl bg-stone-50 p-3 space-y-2">
              <div className="text-sm font-medium">
                Stock count — currently {fmtQty(stockNow)}{" "}
                {f.unit_code}
              </div>
              {/* Three controls on one line came to about 370px of content
                  in a 340px row on a phone, and the one that gave way was
                  the reason — squeezed to an empty oval nobody could see was
                  a field. The count and its button hold one line, because
                  they are the pair; the reason takes a line of its own until
                  there is room for it beside them. */}
              {/* Two rows, not three controls crammed into one. The count
                  and the button that applies it are a pair and hold a line;
                  the reason is a sentence and gets its own. It used to share
                  the line and was squeezed to an oval a few pixels wide that
                  nobody could see was a field at all. The width is set
                  inline because inputCls leads with w-full, which no Tailwind
                  width put after it in the class list reliably beats. */}
              <div className="flex items-center gap-2">
                <input
                  inputMode="decimal"
                  value={countTo}
                  onChange={(e) => setCountTo(e.target.value)}
                  placeholder="Counted"
                  aria-label="Counted quantity"
                  style={{ width: "6.5rem" }}
                  className={inputCls + " flex-none"}
                />
                <button
                  onClick={recount}
                  disabled={busy || !countTo}
                  className="flex-none px-4 py-2 rounded-xl bg-colophon text-paper text-sm disabled:opacity-40"
                >
                  Apply
                </button>
              </div>
              <input
                value={countNote}
                onChange={(e) => setCountNote(e.target.value)}
                placeholder="Reason (e.g. stocktake, breakage)"
                aria-label="Reason for the count"
                className={inputCls}
              />

              {history && history.length > 0 && (
                <ul className="text-xs text-stone-600 divide-y divide-stone-200 max-h-40 overflow-y-auto">
                  {history.map((m, i) => (
                    <li key={i} className="py-1 flex gap-2">
                      <span className="w-28 shrink-0 text-stone-400">
                        {fmtDate(new Date(m.at))}
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
            className="btn-cancel ml-auto"
          >
            Cancel
          </button>
          <button
            onClick={save}
            disabled={busy || !f.name}
            className="px-6 py-2.5 rounded-xl bg-gold-400 text-colophon font-semibold disabled:opacity-40"
          >
            {busy ? "Saving…" : "Save"}
          </button>
        </div>
      </div>
    </div>
  );
}

const inputCls =
  "w-full rounded-xl border border-stone-300 px-3 py-2 focus:outline-none focus:ring-2 focus:ring-gold-400";

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
