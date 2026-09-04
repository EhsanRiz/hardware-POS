import { useCallback, useEffect, useMemo, useState } from "react";
import {
  adminListProducts,
  purchasingReceiveDocument,
  purchasingReceiveLines,
  type ReceiveLine,
  type SupplierDocument,
} from "../../lib/adminApi";
import { fetchCatalogue } from "../../lib/api";
import { errorMessage } from "../../lib/errors";
import { money } from "../../lib/money";
import { fmtQty } from "../../lib/receipt";
import type { Product } from "../../lib/types";

/** The least a product needs to be findable and comparable on this screen. */
interface Pickable {
  id: string;
  name: string;
  sku: string;
  barcode: string | null;
  stock_qty: number | null;
  cost: number | null;
}

/** What the manager has decided about one line of the delivery. */
interface Row {
  line: ReceiveLine;
  /** The product it will be received against, once decided. */
  productId: string | null;
  productName: string | null;
  /** A line for something the shop has never sold: make it. */
  create: boolean;
  /** What actually arrived, which is not always what was invoiced. */
  qty: string;
  cost: string;
  /** Open the picker for this line. */
  picking: boolean;
  /**
   * What the picked product costs today. Carried on the row because the
   * server only knows it for a line it could match on its own — a line a
   * person has just matched by hand needs its old cost from here, and that
   * comparison is the whole point of showing it.
   */
  costNow: number | null;
}

/**
 * Booking a delivery in from the supplier's own paperwork.
 *
 * The lines were read off the page when it was scanned. What is left is the
 * part only a person can do: saying that Jasbro's "PL 0065 COMP ELBOW 15MM"
 * is this shop's copper elbow, and that nineteen arrived rather than the
 * twenty on the invoice. Confirmed once, the pairing is remembered, and the
 * next delivery from that supplier matches itself.
 *
 * Cost is recorded from the page because it is a fact about what was paid.
 * The retail price is never touched: that is the owner's decision, and a cost
 * that has outgrown its margin is worth being told about rather than silently
 * corrected. Lines whose cost has changed are marked here before anything is
 * booked in.
 */
export default function ReceiveDocument({
  pin,
  doc,
  onClose,
  onDone,
}: {
  pin: string;
  doc: SupplierDocument;
  onClose: () => void;
  onDone: (summary: string) => Promise<void>;
}) {
  const [rows, setRows] = useState<Row[] | null>(null);
  const [products, setProducts] = useState<Pickable[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [term, setTerm] = useState("");

  const load = useCallback(async () => {
    setError(null);
    try {
      // The admin list carries cost, which is what makes a change in cost
      // visible when somebody matches a line by hand. Anybody who can buy but
      // not manage the catalogue still gets the picker, just without the
      // comparison — better than refusing to open the screen.
      const [lines, cat] = await Promise.all([
        purchasingReceiveLines(pin, doc.id),
        adminListProducts(pin)
          .then((ps) =>
            ps.map((p) => ({
              id: p.id, name: p.name, sku: p.sku, barcode: p.barcode,
              stock_qty: p.stock_qty, cost: p.cost ?? null,
            }))
          )
          .catch(() =>
            fetchCatalogue()
              .then((ps: Product[]) =>
                ps.map((p) => ({
                  id: p.id, name: p.name, sku: p.sku, barcode: p.barcode,
                  stock_qty: p.stock_qty, cost: null as number | null,
                }))
              )
              .catch(() => [] as Pickable[])
          ),
      ]);
      setProducts(cat);
      setRows(
        lines.map((line) => ({
          line,
          productId: line.product_id,
          productName: line.product_name,
          create: false,
          // What the paper says arrived, which the person checking corrects.
          qty: line.qty != null ? String(line.qty) : "",
          cost: line.unit_price != null ? String(line.unit_price) : "",
          picking: false,
          costNow: line.current_cost,
        }))
      );
    } catch (e) {
      setError(errorMessage(e, "Could not open the delivery"));
    }
  }, [pin, doc.id]);

  useEffect(() => {
    void load();
  }, [load]);

  const set = (i: number, patch: Partial<Row>) =>
    setRows((rs) => rs?.map((r, j) => (j === i ? { ...r, ...patch } : r)) ?? rs);

  const ready = useMemo(
    () => (rows ?? []).filter((r) => Number(r.qty) > 0 && (r.productId || r.create)),
    [rows]
  );
  const undecided = useMemo(
    () => (rows ?? []).filter((r) => Number(r.qty) > 0 && !r.productId && !r.create),
    [rows]
  );

  async function receive() {
    setBusy(true);
    setError(null);
    try {
      const out = await purchasingReceiveDocument(
        pin,
        doc.id,
        ready.map((r) => ({
          line_no: r.line.line_no,
          product_id: r.productId,
          create: r.create,
          qty: Number(r.qty),
          unit_cost: r.cost.trim() === "" ? null : Number(r.cost),
          remember: true,
        }))
      );
      const made = out.filter((o) => o.created).length;
      const repriced = out.filter(
        (o) => o.old_cost != null && o.new_cost != null && Math.abs(o.new_cost - o.old_cost) > 0.0001
      ).length;
      await onDone(
        `${out.length} ${out.length === 1 ? "line" : "lines"} booked in` +
        (made ? `, ${made} new ${made === 1 ? "item" : "items"} created and waiting to be priced` : "") +
        (repriced ? `, ${repriced} cost ${repriced === 1 ? "price" : "prices"} updated` : "") +
        "."
      );
    } catch (e) {
      setError(errorMessage(e, "The delivery could not be booked in"));
      setBusy(false);
    }
  }

  return (
    <div className="modal-backdrop" onClick={busy ? undefined : onClose}>
      <div
        className="modal-card"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-label="Receive this delivery"
        style={{ maxWidth: 820 }}
      >
        <h2 className="modal-title">Receive {doc.doc_number ?? "this delivery"}</h2>
        <p className="acc-note" style={{ marginTop: 0 }}>
          What actually arrived, against what the {doc.kind === "invoice" ? "invoice" : "note"} says.
          Correct any quantity that came up short — the shelf follows this, not the paper.
        </p>

        {error && <p className="acc-note is-bad" role="alert">{error}</p>}
        {rows === null && <p className="acc-note">Opening…</p>}
        {undecided.length > 0 && (
          <p className="acc-note is-warning">
            {undecided.length} {undecided.length === 1 ? "line is" : "lines are"} not
            matched to anything yet. Match {undecided.length === 1 ? "it" : "them"}, or
            set the quantity to zero to leave {undecided.length === 1 ? "it" : "them"} off.
          </p>
        )}

        <div className="modal-list">
          {rows?.map((r, i) => {
            const costNow = r.costNow;
            const costNew = r.cost.trim() === "" ? null : Number(r.cost);
            const changed =
              costNow != null && costNew != null && Math.abs(costNew - costNow) > 0.0001;
            const shown = term.trim().toLowerCase();
            const matches = shown
              ? products.filter(
                  (p) =>
                    p.name.toLowerCase().includes(shown) ||
                    p.sku.toLowerCase().includes(shown) ||
                    (p.barcode ?? "").includes(shown)
                ).slice(0, 8)
              : [];
            return (
              <div key={r.line.line_no} className="recv-row">
                <div className="recv-what">
                  <span className="acc-name">{r.line.description}</span>
                  <span className="acc-sub">
                    {[r.line.supplier_code, r.line.unit_price != null ? `${money(r.line.unit_price)} each` : null]
                      .filter(Boolean).join(" · ")}
                  </span>
                  {r.productId ? (
                    <span className="acc-sub">
                      → {r.productName}
                      {r.line.remembered ? " · remembered" : ""}
                      {r.line.stock_qty != null ? ` · ${fmtQty(r.line.stock_qty)} on hand` : ""}
                    </span>
                  ) : r.create ? (
                    <span className="acc-sub">→ a new item, priced later</span>
                  ) : (
                    <span className="acc-sub is-bad">not matched yet</span>
                  )}
                </div>

                <div className="recv-nums">
                  <label>
                    <span className="text-xs text-stone-500">Received</span>
                    <input
                      className="stock-qty-input"
                      inputMode="decimal"
                      value={r.qty}
                      onChange={(e) => set(i, { qty: e.target.value })}
                      aria-label={`Quantity received of ${r.line.description}`}
                      disabled={busy}
                    />
                  </label>
                  <label>
                    <span className="text-xs text-stone-500">Unit cost</span>
                    <input
                      className="stock-qty-input"
                      inputMode="decimal"
                      value={r.cost}
                      onChange={(e) => set(i, { cost: e.target.value })}
                      aria-label={`Unit cost of ${r.line.description}`}
                      disabled={busy}
                    />
                  </label>
                  <button
                    type="button"
                    className="btn-line"
                    onClick={() => { set(i, { picking: !r.picking }); setTerm(""); }}
                    disabled={busy}
                  >
                    {r.productId ? "Change" : "Match"}
                  </button>
                </div>

                {/* Said before it is done: a cost that moved is the thing that
                    quietly eats a shop's margin, and the moment to notice it
                    is while the delivery is still on the counter. */}
                {changed && (
                  <p className="recv-drift">
                    Cost {money(costNow!)} → {money(costNew!)}
                    {costNew! > costNow! ? " (up)" : " (down)"}
                    {r.line.retail != null && r.line.retail > 0 && costNew! > 0
                      ? ` · retail ${money(r.line.retail)} leaves ${Math.round(((r.line.retail / 1.15 - costNew!) / (r.line.retail / 1.15)) * 100)}% margin`
                      : ""}
                  </p>
                )}

                {r.picking && (
                  <div className="recv-pick">
                    <input
                      className="modal-input"
                      style={{ marginBottom: 6 }}
                      value={term}
                      onChange={(e) => setTerm(e.target.value)}
                      placeholder="Find it by name, SKU or barcode…"
                      aria-label={`Find a product for ${r.line.description}`}
                      autoFocus
                    />
                    {matches.map((p) => (
                      <button
                        key={p.id}
                        type="button"
                        className="modal-row"
                        onClick={() =>
                          set(i, {
                            productId: p.id, productName: p.name, create: false,
                            picking: false, costNow: p.cost,
                          })
                        }
                      >
                        <span className="modal-row-name">{p.name}</span>
                        <span className="modal-row-meta">
                          {p.sku} · {fmtQty(p.stock_qty ?? 0)} on hand
                        </span>
                      </button>
                    ))}
                    <button
                      type="button"
                      className="btn-line"
                      onClick={() =>
                        set(i, {
                          create: true, productId: null, productName: null,
                          picking: false, costNow: null,
                        })
                      }
                    >
                      Not on our list — create it
                    </button>
                  </div>
                )}
              </div>
            );
          })}
        </div>

        <div className="modal-actions">
          <button type="button" className="btn-line" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button
            type="button"
            className="btn-fill"
            disabled={busy || ready.length === 0 || undecided.length > 0}
            onClick={() => void receive()}
          >
            {busy ? "Booking in…" : `Book in ${ready.length} ${ready.length === 1 ? "line" : "lines"}`}
          </button>
        </div>
      </div>
    </div>
  );
}
