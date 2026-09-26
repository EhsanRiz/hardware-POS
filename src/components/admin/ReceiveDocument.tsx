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
  /** The same item as this earlier line of the delivery (0117). */
  sameAs: number | null;
  /** What a new item will be called, starting from the supplier's words. */
  newName: string;
  /** An item offered on its name, waiting for a person to say yes or no. */
  offer: { id: string; name: string } | null;
  /** Sorted as a note or a charge, and so left off until someone says not. */
  leftOff: boolean;
}

/** Two new items the till could not tell apart. */
const nameKey = (n: string) => n.trim().toLowerCase().replace(/\s+/g, " ");

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
          // What the paper says arrived, which the person checking corrects.
          qty: line.qty != null ? String(line.qty) : "",
          // What one actually cost, when the server could work it out
          // (0119) — the listed price is before discount, and sometimes
          // with VAT. Otherwise the listed price, for a person to check.
          cost:
            line.net_cost != null ? String(line.net_cost)
            : line.unit_price != null ? String(line.unit_price) : "",
          picking: false,
          costNow: line.current_cost,
          // Sorted by the server (0117) when the shop has switched it on;
          // otherwise every one of these is its empty value and the screen
          // is what it always was.
          ...(line.sorted === "not_stock" ? { qty: "0" } : {}),
          create: line.sorted === "new",
          sameAs: line.sorted === "same_as_line" ? line.same_as_line ?? null : null,
          // Without the supplier's repeated tail (0122); still editable.
          newName: line.clean_name ?? line.description,
          offer:
            line.sorted === "likely" && line.suggestion_id
              ? { id: line.suggestion_id, name: line.suggestion_name ?? "" }
              : null,
          leftOff: line.sorted === "not_stock",
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

  const sorted = (rows ?? []).some((r) => r.line.sorted != null);

  /** Lines being received, by line number, for "the same as line N". */
  const coming = useMemo(
    () => new Set((rows ?? []).filter((r) => Number(r.qty) > 0).map((r) => r.line.line_no)),
    [rows]
  );
  const decided = (r: Row) =>
    !!r.productId || r.create || (r.sameAs != null && coming.has(r.sameAs));
  const ready = useMemo(
    () => (rows ?? []).filter((r) => Number(r.qty) > 0 && decided(r)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [rows, coming]
  );
  const undecided = useMemo(
    () => (rows ?? []).filter((r) => Number(r.qty) > 0 && !decided(r)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [rows, coming]
  );
  /**
   * New items that would share a name: Meinan's nine "cornice". Made like
   * that, the till shows nine identical rows and a cashier guesses. Booking
   * in waits until each has a name of its own.
   */
  const clashing = useMemo(() => {
    const makes = (rows ?? []).filter((r) => Number(r.qty) > 0 && r.create && !r.productId);
    const seen = new Map<string, number>();
    for (const r of makes) seen.set(nameKey(r.newName), (seen.get(nameKey(r.newName)) ?? 0) + 1);
    return new Set(makes.filter((r) => (seen.get(nameKey(r.newName)) ?? 0) > 1).map((r) => r.line.line_no));
  }, [rows]);

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
          create: !r.productId && r.sameAs == null && r.create,
          same_as_line: r.productId ? null : r.sameAs,
          name:
            r.create && !r.productId && r.sameAs == null && r.newName.trim() !== r.line.description.trim()
              ? r.newName.trim()
              : null,
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

        {sorted && rows && (
          <p className="acc-note" aria-label="How the delivery was sorted">
            {[
              [ready.filter((r) => r.productId).length, "matched"],
              [ready.filter((r) => !r.productId).length, "new"],
              [rows.filter((r) => r.leftOff && !(Number(r.qty) > 0)).length, "left off"],
              [undecided.length + clashing.size, "to check"],
            ]
              .filter(([n]) => (n as number) > 0)
              .map(([n, what]) => `${n} ${what}`)
              .join(" · ")}
          </p>
        )}
        {sorted && rows && rows[0]?.line.price_basis && (
          <p
            className={rows[0].line.price_basis === "unclear" ? "acc-note is-warning" : "acc-note"}
            aria-label="How costs were worked out"
          >
            {rows[0].line.price_basis === "ex_vat"
              ? "Costs are what one cost after any discount, without VAT — this invoice adds VAT on its total."
              : rows[0].line.price_basis === "incl_vat"
              ? "This invoice's prices include VAT. Costs are what one cost after any discount, without VAT."
              : "The lines don't add up to this invoice's totals, so each cost is the listed price. Check them before booking in."}
          </p>
        )}
        {clashing.size > 0 && (
          <p className="acc-note is-warning">
            {clashing.size} new items would have the same name as another. Give each one a
            name the till can tell apart — the colour or size is usually enough.
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
                    {r.line.net_cost != null && r.line.unit_price != null &&
                      Math.abs(r.line.net_cost - r.line.unit_price) > 0.005 && (
                      <span aria-label={`What line ${r.line.line_no} cost`}>
                        {" · "}paid {money(r.line.net_cost)} ex VAT
                        {r.line.price_basis === "ex_vat" && r.line.net_cost < r.line.unit_price
                          ? ` (${Math.round((1 - r.line.net_cost / r.line.unit_price) * 100)}% off)` : ""}
                      </span>
                    )}
                  </span>
                  {r.productId ? (
                    <span className="acc-sub">
                      → {r.productName}
                      {r.line.remembered && r.productId === r.line.product_id ? " · remembered" : ""}
                      {r.line.stock_qty != null && r.productId === r.line.product_id
                        ? ` · ${fmtQty(r.line.stock_qty)} on hand` : ""}
                    </span>
                  ) : r.sameAs != null ? (
                    <span className={coming.has(r.sameAs) ? "acc-sub" : "acc-sub is-bad"}>
                      → the same item as line {r.sameAs}
                      {coming.has(r.sameAs) ? "" : ", which is left off"}
                    </span>
                  ) : r.create ? (
                    <span className="acc-sub">→ a new item, priced later</span>
                  ) : r.leftOff && !(Number(r.qty) > 0) ? (
                    <span className="acc-sub">Not stock — a note or a charge, left off</span>
                  ) : r.offer ? (
                    <span className="acc-sub is-warning">Is it {r.offer.name}?</span>
                  ) : (
                    <span className="acc-sub is-bad">not matched yet</span>
                  )}
                  {r.line.sort_note?.startsWith("code_reused_") && !r.productId && (
                    <span className="acc-sub">
                      {r.line.sort_note === "code_reused_price"
                        ? `Their code ${r.line.supplier_code} is already on something at a very different price`
                        : `Their code ${r.line.supplier_code} is already on a different ` +
                          `${r.line.sort_note.slice("code_reused_".length)} of this`}
                    </span>
                  )}
                  {/* Every new item's name, when the delivery was sorted: it is
                      what the till will show, and a supplier's "*EMJAY® …" is
                      not how the counter says it. */}
                  {r.create && !r.productId && r.sameAs == null && Number(r.qty) > 0 &&
                    (sorted || clashing.has(r.line.line_no)) && (
                    <input
                      className={clashing.has(r.line.line_no) ? "modal-input is-bad" : "modal-input"}
                      style={{ marginTop: 4, marginBottom: 0 }}
                      value={r.newName}
                      onChange={(e) => set(i, { newName: e.target.value })}
                      aria-label={`Name for the new item on line ${r.line.line_no}`}
                      disabled={busy}
                    />
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
                  {sorted ? (
                    <>
                      {/* Sorted, every line has the same one button, whatever
                          state it is in: Change. An offer adds a Yes beside
                          it. "Match" on one line and "Receive it" on the next
                          read as two different jobs, and they were one. */}
                      {r.offer && !r.productId && (
                        <button
                          type="button"
                          className="btn-fill"
                          onClick={() =>
                            set(i, {
                              productId: r.offer!.id, productName: r.offer!.name, create: false,
                              costNow: products.find((p) => p.id === r.offer!.id)?.cost ?? null,
                            })
                          }
                          disabled={busy}
                          aria-label={`Yes, line ${r.line.line_no} is ${r.offer.name}`}
                        >
                          Yes
                        </button>
                      )}
                      <button
                        type="button"
                        className="btn-line"
                        onClick={() => { set(i, { picking: !r.picking, offer: null }); setTerm(""); }}
                        disabled={busy}
                        aria-label={`Change line ${r.line.line_no}`}
                      >
                        Change
                      </button>
                    </>
                  ) : r.offer && !r.productId ? (
                    <>
                      <button
                        type="button"
                        className="btn-fill"
                        onClick={() =>
                          set(i, {
                            productId: r.offer!.id, productName: r.offer!.name, create: false,
                            costNow: products.find((p) => p.id === r.offer!.id)?.cost ?? null,
                          })
                        }
                        disabled={busy}
                        aria-label={`Yes, line ${r.line.line_no} is ${r.offer.name}`}
                      >
                        Yes
                      </button>
                      <button
                        type="button"
                        className="btn-line"
                        onClick={() => { set(i, { offer: null, picking: true }); setTerm(""); }}
                        disabled={busy}
                        aria-label={`No, line ${r.line.line_no} is something else`}
                      >
                        No
                      </button>
                    </>
                  ) : r.leftOff && !(Number(r.qty) > 0) ? (
                    <button
                      type="button"
                      className="btn-line"
                      onClick={() =>
                        set(i, { qty: r.line.qty != null ? String(r.line.qty) : "1", leftOff: false })
                      }
                      disabled={busy}
                      aria-label={`Receive line ${r.line.line_no} anyway`}
                    >
                      Receive it
                    </button>
                  ) : (
                    <button
                      type="button"
                      className="btn-line"
                      onClick={() => { set(i, { picking: !r.picking }); setTerm(""); }}
                      disabled={busy}
                    >
                      {r.productId || r.sameAs != null ? "Change" : "Match"}
                    </button>
                  )}
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
                            picking: false, costNow: p.cost, sameAs: null, offer: null,
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
                          picking: false, costNow: null, sameAs: null, offer: null,
                          // Left off as a note, and a person says it is stock.
                          ...(r.leftOff && !(Number(r.qty) > 0)
                            ? { qty: r.line.qty != null ? String(r.line.qty) : "1", leftOff: false }
                            : {}),
                        })
                      }
                    >
                      Not on our list — create it
                    </button>
                    {sorted && !(r.leftOff && !(Number(r.qty) > 0)) && (
                      <button
                        type="button"
                        className="btn-line"
                        onClick={() =>
                          set(i, {
                            qty: "0", leftOff: true, create: false, productId: null,
                            productName: null, sameAs: null, offer: null, picking: false,
                          })
                        }
                      >
                        Leave it off — not stock
                      </button>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>

        <div className="modal-actions">
          <button type="button" className="btn-cancel" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button
            type="button"
            className="btn-fill"
            disabled={busy || ready.length === 0 || undecided.length > 0 || clashing.size > 0}
            onClick={() => void receive()}
          >
            {busy ? "Booking in…" : `Book in ${ready.length} ${ready.length === 1 ? "line" : "lines"}`}
          </button>
        </div>
      </div>
    </div>
  );
}
