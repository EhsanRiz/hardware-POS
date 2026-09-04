import { useCallback, useEffect, useMemo, useState } from "react";
import {
  adminAdjustStock,
  receiveStock,
  stockMovements,
  type StockMovementRow,
} from "../../lib/adminApi";
import { fetchCatalogue } from "../../lib/api";
import { errorMessage } from "../../lib/errors";
import { cacheGet, cacheSet } from "../../lib/localCache";
import { useOnline } from "../../lib/offline";
import { fmtQty } from "../../lib/receipt";
import type { Product } from "../../lib/types";
import { fmtDayMonthTime } from "../../lib/dates";
import BarcodeScanner from "../BarcodeScanner";

const CATALOGUE_KEY = "catalogue.products";

/**
 * Stock — what is on the shelves, what is running out, what just arrived.
 *
 * Three jobs, in the order a shop actually does them:
 *
 *   1. LOW — what to reorder. Sorted by how far below the reorder level each
 *      item has fallen, because "12 things are low" is only useful if the worst
 *      one is at the top.
 *   2. RECEIVE — booking in a delivery. A pallet with many lines on one
 *      supplier invoice, entered as one document, all or nothing.
 *   3. COUNT — a stocktake correction, one product at a time, with the reason
 *      on the movement.
 *
 * Everything here needs manage_inventory; the PIN travels with each call and
 * is verified server-side every time (same pattern as the back office).
 */
export default function Stock({ pin }: { pin: string }) {
  const online = useOnline();
  const [products, setProducts] = useState<Product[]>(() =>
    cacheGet<Product[]>(CATALOGUE_KEY, [])
  );
  const [tab, setTab] = useState<"low" | "receive" | "all" | "moves">("low");
  const [term, setTerm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [banner, setBanner] = useState<string | null>(null);

  // The delivery being keyed in: product → qty as typed.
  const [delivery, setDelivery] = useState<Map<string, string>>(new Map());
  const [reference, setReference] = useState("");
  const [busy, setBusy] = useState(false);
  // The phone's camera as a scanner, on the delivery tab.
  const [scanning, setScanning] = useState(false);
  // The row the last scan landed on, lit for a moment so the eye finds it.
  const [hit, setHit] = useState<string | null>(null);

  // A pending count correction, one product at a time.
  const [counting, setCounting] = useState<Product | null>(null);
  const [counted, setCounted] = useState("");

  const [moves, setMoves] = useState<StockMovementRow[] | null>(null);

  const refresh = useCallback(async () => {
    try {
      const p = await fetchCatalogue();
      setProducts(p);
      cacheSet(CATALOGUE_KEY, p);
    } catch {
      // The cached catalogue still shows; stale numbers beat none.
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (tab !== "moves") return;
    stockMovements(pin)
      .then(setMoves)
      .catch((e) => setError(errorMessage(e, "Could not load the movements")));
  }, [tab, pin]);

  const tracked = useMemo(
    () => products.filter((p) => p.stock_qty != null),
    [products]
  );

  const low = useMemo(
    () =>
      tracked
        .filter((p) => p.reorder_level != null && p.stock_qty! <= p.reorder_level)
        .sort(
          (a, b) =>
            a.stock_qty! - a.reorder_level! - (b.stock_qty! - b.reorder_level!)
        ),
    [tracked]
  );

  const shown = useMemo(() => {
    const base = tab === "low" ? low : tracked;
    const q = term.trim().toLowerCase();
    if (!q) return base;
    return base.filter(
      (p) =>
        p.name.toLowerCase().includes(q) ||
        p.sku.toLowerCase().includes(q) ||
        (p.bin ?? "").toLowerCase().includes(q)
    );
  }, [tab, low, tracked, term]);

  const deliveryLines = useMemo(
    () =>
      [...delivery.entries()]
        .map(([id, qty]) => ({ id, qty: Number(qty) }))
        .filter((l) => l.qty > 0),
    [delivery]
  );

  /**
   * A barcode read on the delivery tab — from the gun into the search box, or
   * from the camera. One more of that item received. The quantity box stays
   * editable because a carton's barcode is not the unit's: scanning a box of
   * twelve taps should not have to mean twelve scans.
   */
  function receiveCode(raw: string): boolean {
    const code = raw.trim();
    if (!code) return false;
    const p = tracked.find((x) => x.barcode === code);
    if (!p) {
      // Only a barcode is reported as unknown; Enter on a typed search is
      // just Enter. Either way the gun's digits are cleared out of the box,
      // or the list stays filtered to nothing and the next read piles on.
      if (/^\d{6,14}$/.test(code)) {
        setError(`No item in the catalogue has barcode ${code}. Add it in Catalogue first.`);
        setTerm("");
      }
      return false;
    }
    setError(null);
    setDelivery((prev) => {
      const next = new Map(prev);
      const was = Number(next.get(p.id) ?? 0);
      next.set(p.id, String((Number.isFinite(was) ? was : 0) + 1));
      return next;
    });
    setTerm("");
    setHit(p.id);
    window.setTimeout(() => setHit((h) => (h === p.id ? null : h)), 1500);
    document.getElementById(`stock-row-${p.id}`)?.scrollIntoView({ block: "nearest" });
    return true;
  }

  async function bookIn() {
    setBusy(true);
    setError(null);
    setBanner(null);
    try {
      const res = await receiveStock(
        pin,
        deliveryLines.map((l) => ({ product_id: l.id, qty: l.qty })),
        reference || null,
        null
      );
      setBanner(
        `${res.length} line${res.length === 1 ? "" : "s"} booked in${
          reference ? ` against ${reference}` : ""
        }.`
      );
      setDelivery(new Map());
      setReference("");
      await refresh();
      setTab("all");
    } catch (e) {
      setError(errorMessage(e, "The delivery could not be booked in"));
    } finally {
      setBusy(false);
    }
  }

  async function saveCount() {
    if (!counting) return;
    const qty = Number(counted);
    if (!(qty >= 0)) return;
    setBusy(true);
    setError(null);
    try {
      await adminAdjustStock(pin, counting.id, qty, "Stock count");
      setBanner(
        `${counting.name}: ${fmtQty(counting.stock_qty ?? 0)} → ${fmtQty(qty)}.`
      );
      setCounting(null);
      setCounted("");
      await refresh();
    } catch (e) {
      setError(errorMessage(e, "The count could not be saved"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="acc">
      <div className="stock-tabs">
        <button
          className={`btn-line${tab === "low" ? " is-on" : ""}`}
          onClick={() => setTab("low")}
        >
          Running low{low.length ? ` · ${low.length}` : ""}
        </button>
        <button
          className={`btn-line${tab === "receive" ? " is-on" : ""}`}
          onClick={() => setTab("receive")}
        >
          Receive a delivery
          {deliveryLines.length ? ` · ${deliveryLines.length}` : ""}
        </button>
        <button
          className={`btn-line${tab === "all" ? " is-on" : ""}`}
          onClick={() => setTab("all")}
        >
          Everything
        </button>
        <button
          className={`btn-line${tab === "moves" ? " is-on" : ""}`}
          onClick={() => setTab("moves")}
        >
          Movements
        </button>
      </div>

      {banner && <p className="acc-note is-good">{banner}</p>}
      {error && <p className="acc-note is-bad">{error}</p>}
      {!online && (
        <p className="acc-note">
          Stock changes need a connection — the list shown is the till's cache.
        </p>
      )}

      {tab === "receive" && (
        <div className="stock-receive-bar">
          <input
            value={reference}
            onChange={(e) => setReference(e.target.value)}
            placeholder="Supplier invoice / GRN number…"
            className="modal-input"
            style={{ marginBottom: 0, maxWidth: 320 }}
            disabled={busy}
          />
          <button
            className="btn-fill"
            onClick={() => void bookIn()}
            disabled={busy || !online || deliveryLines.length === 0}
          >
            {busy
              ? "Booking in…"
              : `Book in ${deliveryLines.length || "the"} line${
                  deliveryLines.length === 1 ? "" : "s"
                }`}
          </button>
        </div>
      )}

      {tab !== "moves" && (
        <div className="stock-receive-bar">
          <input
            value={term}
            onChange={(e) => setTerm(e.target.value)}
            onKeyDown={(e) => {
              // A gun types the code and presses Enter; on the delivery tab
              // that is one more of the item received.
              if (e.key === "Enter" && tab === "receive") receiveCode(term);
            }}
            placeholder={
              tab === "receive"
                ? "Scan a barcode, or find an item by name, SKU or bin…"
                : "Find an item by name, SKU or bin…"
            }
            className="modal-input"
            style={{ marginBottom: 0, maxWidth: 420 }}
            aria-label={tab === "receive" ? "Scan or find an item" : "Find an item"}
          />
          {tab === "receive" && (
            <button
              type="button"
              className="btn-line"
              onClick={() => setScanning(true)}
              disabled={busy}
              title="Scan a barcode with the camera"
            >
              Scan
            </button>
          )}
        </div>
      )}

      <div className="acc-scroll">
        {tab === "moves" ? (
          <MovementsTable moves={moves} />
        ) : (
          <table className="acc-table">
            <thead>
              <tr>
                <th>Item</th>
                <th className="num">On hand</th>
                <th className="num">Reorder at</th>
                {tab === "receive" ? (
                  <th className="num">Received</th>
                ) : (
                  <th className="num" />
                )}
              </tr>
            </thead>
            <tbody>
              {shown.length === 0 && (
                <tr>
                  <td colSpan={4} className="acc-empty">
                    {tab === "low"
                      ? "Nothing is below its reorder level."
                      : "No tracked items match."}
                  </td>
                </tr>
              )}
              {shown.map((p) => {
                const isLow =
                  p.reorder_level != null && p.stock_qty! <= p.reorder_level;
                return (
                  <tr key={p.id} id={`stock-row-${p.id}`} className={hit === p.id ? "stock-row-hit" : undefined}>
                    <td>
                      <span className="acc-name">{p.name}</span>
                      <span className="acc-sub">
                        {[p.sku, p.bin ? `bin ${p.bin}` : null, `per ${p.unit_code}`]
                          .filter(Boolean)
                          .join(" · ")}
                      </span>
                    </td>
                    <td className={`num ${isLow ? "is-bad" : ""}`}>
                      {fmtQty(p.stock_qty!)} {p.unit_code}
                    </td>
                    <td className="num quiet">
                      {p.reorder_level != null ? fmtQty(p.reorder_level) : "—"}
                    </td>
                    {tab === "receive" ? (
                      <td className="num">
                        <input
                          inputMode="decimal"
                          value={delivery.get(p.id) ?? ""}
                          onChange={(e) => {
                            const next = new Map(delivery);
                            if (e.target.value.trim() === "") next.delete(p.id);
                            else next.set(p.id, e.target.value);
                            setDelivery(next);
                          }}
                          placeholder="0"
                          className="stock-qty-input"
                          disabled={busy}
                          aria-label={`Quantity received of ${p.name}`}
                        />
                      </td>
                    ) : (
                      <td className="num">
                        {counting?.id === p.id ? (
                          <span className="stock-count">
                            <input
                              autoFocus
                              inputMode="decimal"
                              value={counted}
                              onChange={(e) => setCounted(e.target.value)}
                              onKeyDown={(e) => {
                                if (e.key === "Enter") void saveCount();
                                if (e.key === "Escape") setCounting(null);
                              }}
                              placeholder={String(p.stock_qty)}
                              className="stock-qty-input"
                              aria-label={`Counted quantity of ${p.name}`}
                            />
                            <button
                              className="btn-line"
                              onClick={() => void saveCount()}
                              disabled={busy || counted.trim() === ""}
                            >
                              Save
                            </button>
                          </span>
                        ) : (
                          <button
                            className="btn-line quiet"
                            onClick={() => {
                              setCounting(p);
                              setCounted("");
                            }}
                            disabled={!online}
                          >
                            Count
                          </button>
                        )}
                      </td>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
      {scanning && (
        <BarcodeScanner
          onCode={(code) => {
            // One code, one more received, and the viewfinder closes — the
            // next box is a tap away, and a barcode left in view must not
            // keep counting on its own.
            setScanning(false);
            receiveCode(code);
          }}
          onClose={() => setScanning(false)}
        />
      )}
    </div>
  );
}

/** The shop-wide ledger: every movement, why, and who. */
function MovementsTable({ moves }: { moves: StockMovementRow[] | null }) {
  return (
    <table className="acc-table">
      <thead>
        <tr>
          <th>When</th>
          <th>Item</th>
          <th className="num">Change</th>
          <th className="num">After</th>
          <th>Why</th>
        </tr>
      </thead>
      <tbody>
        {moves === null && (
          <tr><td colSpan={5} className="acc-empty">Looking…</td></tr>
        )}
        {moves?.length === 0 && (
          <tr><td colSpan={5} className="acc-empty">Nothing has moved yet.</td></tr>
        )}
        {moves?.map((m, i) => (
          <tr key={i}>
            <td className="quiet">{when(m.at)}</td>
            <td><span className="acc-name">{m.product_name}</span></td>
            <td className={`num ${m.qty_delta < 0 ? "" : "is-late"}`}>
              {m.qty_delta > 0 ? "+" : ""}
              {fmtQty(m.qty_delta)}
            </td>
            <td className="num quiet">{fmtQty(m.qty_after)}</td>
            <td>
              <span className="acc-name">{REASON[m.reason] ?? m.reason}</span>
              <span className="acc-sub">
                {[m.by_name, m.note].filter(Boolean).join(" · ")}
              </span>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

const REASON: Record<string, string> = {
  sale: "Sold",
  void: "Sale voided",
  receipt: "Received",
  adjustment: "Adjusted",
  stocktake: "Stock count",
  opening: "Opening stock",
};

function when(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return fmtDayMonthTime(d);
}
