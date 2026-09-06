import { useCallback, useEffect, useMemo, useState } from "react";
import {
  PO_STATUS_LABEL,
  poCancel,
  poCreate,
  poFromReorder,
  poLines,
  poList,
  poReceive,
  poSend,
  poSetLine,
  purchasingSuppliers,
  reorderList,
  supplierMarkPaid,
  supplierPayables,
  supplierSetDue,
  type PayableRow,
  type Payables,
  type PurchaseOrder,
  type PurchaseOrderLine,
  type ReorderRow,
  type Supplier,
} from "../../lib/adminApi";
import { fmtDate } from "../../lib/dates";
import { errorMessage } from "../../lib/errors";
import { money } from "../../lib/money";
import { useOnline } from "../../lib/offline";
import { fmtQty } from "../../lib/receipt";
import type { AdminProduct } from "../../lib/types";

/**
 * Buying: what to order, what has been ordered, and what is owed for it.
 *
 * The purchasing side had both ends and no middle. A supplier's paperwork
 * could be photographed and read (Suppliers), and goods could be booked in
 * against it. But a shop that wanted to ORDER something had nowhere to say
 * so, which meant the order lived on a phone call and nobody could answer
 * "what is on its way?".
 *
 * Three tabs, in the order the work actually happens:
 *
 *   1. TO ORDER — everything under its reorder level, with how fast it has
 *      been going, because "short 4" and "short 4, sells 30 a month" are
 *      different problems. One button turns the list into an order.
 *   2. ORDERS — what is out with suppliers and what is still to come.
 *      Booking in is per line and partial by default: half a load is the
 *      normal case, not an error.
 *   3. WHAT YOU OWE — the mirror of the debtors report. A part payment is
 *      not a paid invoice; the balance stays on the list where it can be
 *      seen.
 */
export default function Buying({ pin, products }: { pin: string; products: AdminProduct[] }) {
  const online = useOnline();
  const [tab, setTab] = useState<"toorder" | "orders" | "owed">("toorder");
  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [banner, setBanner] = useState<string | null>(null);

  useEffect(() => {
    void purchasingSuppliers(pin)
      .then(setSuppliers)
      .catch((e) => setError(errorMessage(e, "Could not load the suppliers")));
  }, [pin]);

  // Opening an order from the reorder tab has to switch tab as well as select.
  const [openId, setOpenId] = useState<string | null>(null);
  function openOrder(id: string) {
    setOpenId(id);
    setTab("orders");
  }

  return (
    // The same frame Reports and Cash-up sit in. Without it this screen ran
    // flush to the left edge of the window with nothing to breathe against.
    <div className="flex-1 overflow-auto p-4">
      <div className="max-w-4xl space-y-3">
      {banner && <p className="acc-note is-good">{banner}</p>}
      {error && <p className="acc-note is-bad">{error}</p>}

      <div className="stock-receive-bar">
        <button
          className={`btn-line${tab === "toorder" ? " is-on" : ""}`}
          onClick={() => { setTab("toorder"); setBanner(null); }}
        >
          To order
        </button>
        <button
          className={`btn-line${tab === "orders" ? " is-on" : ""}`}
          onClick={() => { setTab("orders"); setBanner(null); }}
        >
          Orders
        </button>
        <button
          className={`btn-line${tab === "owed" ? " is-on" : ""}`}
          onClick={() => { setTab("owed"); setBanner(null); }}
        >
          What you owe
        </button>
      </div>

      {tab === "toorder" && (
        <ToOrder
          pin={pin}
          online={online}
          suppliers={suppliers}
          onRaised={(po) => {
            setBanner(`${po.doc_number} raised. Check it over before it goes out.`);
            openOrder(po.id);
          }}
        />
      )}
      {tab === "orders" && (
        <Orders
          pin={pin}
          online={online}
          suppliers={suppliers}
          products={products}
          openId={openId}
          setOpenId={setOpenId}
          // Once the sheet has something of its own to say, "PO-000001
          // raised" is stale and two banners stack up.
          onActed={() => setBanner(null)}
        />
      )}
      {tab === "owed" && <Owed pin={pin} online={online} />}
      </div>
    </div>
  );
}

// --- What to order ----------------------------------------------------------

function ToOrder({
  pin,
  online,
  suppliers,
  onRaised,
}: {
  pin: string;
  online: boolean;
  suppliers: Supplier[];
  onRaised: (po: PurchaseOrder) => void;
}) {
  const [rows, setRows] = useState<ReorderRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [supplier, setSupplier] = useState("");
  const [busy, setBusy] = useState(false);
  /**
   * Which lines go on the order.
   *
   * Nothing is ticked to begin with. Raising the whole list put allen keys, a
   * ladder and 100m of twin-and-earth on one merchant's order, and the first
   * thing anybody had to do was delete most of it — which is exactly where
   * mistakes get made. The person doing the buying knows who sells what, so
   * they say, deliberately, before anything is raised.
   */
  const [picked, setPicked] = useState<Set<string>>(new Set());

  useEffect(() => {
    void reorderList(pin)
      .then(setRows)
      .catch((e) => setError(errorMessage(e, "Could not work out what is short")));
  }, [pin]);

  if (error) return <p className="acc-note is-bad">{error}</p>;
  if (!rows) return <p className="acc-note">Working out what is short…</p>;

  return (
    <div className="space-y-3">
      <div className="stock-receive-bar">
        <select
          className="acc-search"
          value={supplier}
          onChange={(e) => setSupplier(e.target.value)}
          aria-label="Supplier to order from"
        >
          <option value="">Which supplier?</option>
          {suppliers.map((s) => (
            <option key={s.id} value={s.id}>{s.name}</option>
          ))}
        </select>
        <button
          className="btn-fill"
          disabled={busy || !online || !supplier || picked.size === 0}
          onClick={() => {
            setBusy(true);
            setError(null);
            void poFromReorder(pin, supplier, null, [...picked])
              .then(onRaised)
              .catch((e) => setError(errorMessage(e, "That order could not be raised")))
              .finally(() => setBusy(false));
          }}
        >
          {/* A dead button should say what is stopping it, not what it would
              have done. Ticking two lines and finding it greyed out left you
              to work out on your own that a supplier was missing. */}
          {!supplier
            ? "Choose a supplier"
            : picked.size === 0
              ? "Tick what to order"
              : `Raise an order for ${picked.size} ${picked.size === 1 ? "line" : "lines"}`}
        </button>
      </div>

      <p className="acc-note">
        {rows.length === 0
          ? "Nothing is below its reorder level."
          : `${rows.length} ${rows.length === 1 ? "line is" : "lines are"} at or below their reorder level. ` +
            "Tick the ones this supplier sells — one merchant does not sell everything that is short. " +
            "The order asks for the shortfall plus a month's selling, so it does not come straight back onto this list."}
      </p>

      {rows.length > 0 && (
        <table className="acc-table">
          <thead>
            <tr>
              <th>
                <input
                  type="checkbox"
                  aria-label="Tick every line"
                  checked={picked.size === rows.length && rows.length > 0}
                  onChange={(e) =>
                    setPicked(e.target.checked
                      ? new Set(rows.map((r) => r.product_id))
                      : new Set())}
                />
              </th>
              <th>Item</th>
              <th>Last bought from</th>
              <th className="num">On hand</th>
              <th className="num">Level</th>
              <th className="num">Short</th>
              <th className="num">Sold in 30 days</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr
                key={r.product_id}
                className={`acc-row is-clickable${picked.has(r.product_id) ? " is-on" : ""}`}
                onClick={() => setPicked((prev) => {
                  const next = new Set(prev);
                  if (!next.delete(r.product_id)) next.add(r.product_id);
                  return next;
                })}
              >
                <td>
                  <input
                    type="checkbox"
                    aria-label={`Order ${r.item}`}
                    checked={picked.has(r.product_id)}
                    onChange={() => setPicked((prev) => {
                      const next = new Set(prev);
                      if (!next.delete(r.product_id)) next.add(r.product_id);
                      return next;
                    })}
                    onClick={(e) => e.stopPropagation()}
                  />
                </td>
                <td>
                  <span className="acc-name">{r.item}</span>
                  <span className="acc-sub">{r.sku ?? "—"} · {r.department}</span>
                </td>
                <td className="quiet">{r.supplier ?? "—"}</td>
                <td className="num">{fmtQty(r.on_hand)} {r.unit}</td>
                <td className="num quiet">{fmtQty(r.reorder_level)}</td>
                <td className={`num${r.short > 0 ? " is-bad" : " quiet"}`}>
                  {r.short > 0 ? fmtQty(r.short) : "at level"}
                </td>
                <td className="num quiet">{fmtQty(r.sold_30d)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

// --- Orders -----------------------------------------------------------------

function Orders({
  pin,
  online,
  suppliers,
  products,
  openId,
  setOpenId,
  onActed,
}: {
  pin: string;
  online: boolean;
  suppliers: Supplier[];
  products: AdminProduct[];
  openId: string | null;
  setOpenId: (id: string | null) => void;
  onActed: () => void;
}) {
  const [orders, setOrders] = useState<PurchaseOrder[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [newSupplier, setNewSupplier] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      setOrders(await poList(pin));
    } catch (e) {
      setError(errorMessage(e, "Could not load the orders"));
    }
  }, [pin]);

  useEffect(() => {
    void load();
  }, [load]);

  const open = orders?.find((o) => o.id === openId) ?? null;
  if (openId && open) {
    return (
      <OrderSheet
        pin={pin}
        online={online}
        po={open}
        products={products}
        onBack={() => { setOpenId(null); void load(); }}
        onChanged={async () => { onActed(); await load(); }}
      />
    );
  }

  return (
    <div className="space-y-3">
      {error && <p className="acc-note is-bad">{error}</p>}
      <div className="stock-receive-bar">
        <select
          className="acc-search"
          value={newSupplier}
          onChange={(e) => setNewSupplier(e.target.value)}
          aria-label="Supplier for a new order"
        >
          <option value="">Which supplier?</option>
          {suppliers.map((s) => (
            <option key={s.id} value={s.id}>{s.name}</option>
          ))}
        </select>
        <button
          className="btn-fill"
          disabled={busy || !online || !newSupplier}
          onClick={() => {
            setBusy(true);
            void poCreate(pin, newSupplier)
              .then(async (po) => { await load(); setOpenId(po.id); })
              .catch((e) => setError(errorMessage(e, "That order could not be started")))
              .finally(() => setBusy(false));
          }}
        >
          Start an order
        </button>
      </div>

      {!orders ? (
        <p className="acc-note">Loading…</p>
      ) : orders.length === 0 ? (
        <p className="acc-note">Nothing has been ordered yet.</p>
      ) : (
        <table className="acc-table">
          <thead>
            <tr>
              <th>Order</th>
              <th>Supplier</th>
              <th>State</th>
              <th>Expected</th>
              <th className="num">Lines</th>
              <th className="num">Value</th>
            </tr>
          </thead>
          <tbody>
            {orders.map((o) => (
              <tr
                key={o.id}
                className="acc-row is-clickable"
                onClick={() => setOpenId(o.id)}
              >
                <td>
                  <span className="acc-name">{o.doc_number}</span>
                  <span className="acc-sub">{fmtDate(o.created_at)}</span>
                </td>
                <td>{o.supplier}</td>
                <td>
                  {PO_STATUS_LABEL[o.status]}
                  {o.outstanding_lines > 0 && o.status !== "cancelled" && (
                    <span className="acc-sub">{o.outstanding_lines} still to come</span>
                  )}
                </td>
                <td className="quiet">{o.expected_on ? fmtDate(o.expected_on) : "—"}</td>
                <td className="num quiet">{o.lines}</td>
                <td className="num">{money(o.total)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

/** One order: what was asked for, what has arrived, and what happens next. */
function OrderSheet({
  pin,
  online,
  po,
  products,
  onBack,
  onChanged,
}: {
  pin: string;
  online: boolean;
  po: PurchaseOrder;
  products: AdminProduct[];
  onBack: () => void;
  onChanged: () => Promise<void>;
}) {
  const [lines, setLines] = useState<PurchaseOrderLine[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [banner, setBanner] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [term, setTerm] = useState("");
  // What is being booked in this time round, per line.
  const [arrived, setArrived] = useState<Map<string, string>>(new Map());
  const [atCost, setAtCost] = useState<Map<string, string>>(new Map());

  const editable = po.status === "draft" || po.status === "sent";
  const receivable = po.status === "sent" || po.status === "part";

  const load = useCallback(async () => {
    setError(null);
    try {
      setLines(await poLines(pin, po.id));
    } catch (e) {
      setError(errorMessage(e, "Could not load that order"));
    }
  }, [pin, po.id]);

  useEffect(() => {
    void load();
  }, [load]);

  const candidates = useMemo(() => {
    const q = term.trim().toLowerCase();
    if (!q) return [];
    const already = new Set((lines ?? []).map((l) => l.product_id));
    return products
      .filter((p) => p.active && !already.has(p.id))
      .filter((p) => p.name.toLowerCase().includes(q) || p.sku.toLowerCase().includes(q))
      .slice(0, 8);
  }, [term, products, lines]);

  async function setQty(productId: string, raw: string) {
    const qty = raw.trim() === "" ? 0 : Number(raw.replace(",", "."));
    if (!Number.isFinite(qty) || qty < 0) return;
    setError(null);
    try {
      await poSetLine(pin, po.id, productId, qty);
      await load();
      await onChanged();
    } catch (e) {
      setError(errorMessage(e, "That line could not be changed"));
    }
  }

  async function bookIn() {
    if (!lines) return;
    const payload = lines
      .map((l) => {
        const qty = Number((arrived.get(l.id) ?? "").replace(",", "."));
        if (!Number.isFinite(qty) || qty <= 0) return null;
        const c = (atCost.get(l.id) ?? "").replace(",", ".");
        const cost = c.trim() === "" ? null : Number(c);
        return {
          line_id: l.id,
          qty,
          unit_cost: cost != null && Number.isFinite(cost) ? cost : null,
        };
      })
      .filter((x): x is { line_id: string; qty: number; unit_cost: number | null } => x !== null);
    if (payload.length === 0) {
      setError("Nothing has been entered as arrived.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await poReceive(pin, po.id, payload);
      setArrived(new Map());
      setAtCost(new Map());
      setBanner(
        res.lines_outstanding === 0
          ? "That is the whole order in. Stock has moved."
          : `Booked in. ${res.lines_outstanding} ${res.lines_outstanding === 1 ? "line is" : "lines are"} still to come.`
      );
      await load();
      await onChanged();
    } catch (e) {
      setError(errorMessage(e, "That delivery could not be booked in"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-3">
      {banner && <p className="acc-note is-good">{banner}</p>}
      {error && <p className="acc-note is-bad">{error}</p>}

      <div className="stock-receive-bar">
        <button className="btn-line" onClick={onBack}>Back</button>
        {editable && (
          <input
            className="acc-search"
            value={term}
            onChange={(e) => setTerm(e.target.value)}
            placeholder="Add something to this order"
            aria-label="Add something to this order"
          />
        )}
      </div>

      <p className="acc-note">
        {po.doc_number} · {po.supplier} · {PO_STATUS_LABEL[po.status]}
        {po.expected_on ? ` · expected ${fmtDate(po.expected_on)}` : ""}
        {po.note ? ` · ${po.note}` : ""}
      </p>

      {editable && candidates.length > 0 && (
        <table className="acc-table">
          <tbody>
            {candidates.map((p) => (
              <tr key={p.id} className="acc-row is-clickable" onClick={() => { void setQty(p.id, "1"); setTerm(""); }}>
                <td>
                  <span className="acc-name">{p.name}</span>
                  <span className="acc-sub">{p.sku}</span>
                </td>
                <td className="num quiet">{p.cost == null ? "—" : money(p.cost)}</td>
                <td className="num">Add</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {!lines ? (
        <p className="acc-note">Loading…</p>
      ) : lines.length === 0 ? (
        <p className="acc-note">Nothing on this order yet.</p>
      ) : (
        <table className="acc-table">
          <thead>
            <tr>
              <th>Item</th>
              <th className="num">Ordered</th>
              <th className="num">Each</th>
              <th className="num">Amount</th>
              <th className="num">In so far</th>
              <th className="num">Still to come</th>
              {receivable && <th className="num">Arrived now</th>}
              {receivable && <th className="num">At</th>}
            </tr>
          </thead>
          <tbody>
            {lines.map((l) => (
              <tr key={l.id} className="acc-row">
                <td>
                  <span className="acc-name">{l.name}</span>
                  <span className="acc-sub">{l.sku ?? "—"}</span>
                </td>
                <td className="num">
                  {editable ? (
                    <input
                      className="modal-input"
                      style={{ maxWidth: 80, textAlign: "right" }}
                      inputMode="decimal"
                      aria-label={`Ordered ${l.name}`}
                      defaultValue={String(l.qty)}
                      onBlur={(e) => l.product_id && void setQty(l.product_id, e.target.value)}
                      onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
                    />
                  ) : (
                    `${fmtQty(l.qty)} ${l.unit_code}`
                  )}
                </td>
                <td className="num quiet">{l.unit_cost == null ? "—" : money(l.unit_cost)}</td>
                <td className="num">
                  {l.unit_cost == null ? "—" : money(l.qty * l.unit_cost)}
                </td>
                <td className="num quiet">{fmtQty(l.received_qty)}</td>
                <td className={`num${l.outstanding > 0 ? " is-bad" : ""}`}>
                  {l.outstanding > 0 ? fmtQty(l.outstanding) : "all in"}
                </td>
                {receivable && (
                  <td className="num">
                    <input
                      className="modal-input"
                      style={{ maxWidth: 80, textAlign: "right" }}
                      inputMode="decimal"
                      aria-label={`Arrived ${l.name}`}
                      value={arrived.get(l.id) ?? ""}
                      onChange={(e) => {
                        const next = new Map(arrived);
                        next.set(l.id, e.target.value);
                        setArrived(next);
                      }}
                    />
                  </td>
                )}
                {receivable && (
                  <td className="num">
                    <input
                      className="modal-input"
                      style={{ maxWidth: 88, textAlign: "right" }}
                      inputMode="decimal"
                      aria-label={`Cost of ${l.name}`}
                      placeholder={l.unit_cost == null ? "" : String(l.unit_cost)}
                      value={atCost.get(l.id) ?? ""}
                      onChange={(e) => {
                        const next = new Map(atCost);
                        next.set(l.id, e.target.value);
                        setAtCost(next);
                      }}
                    />
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {lines && lines.length > 0 && (
        <p className="acc-note">
          <strong>{money(lines.reduce(
            (t, l) => t + (l.unit_cost == null ? 0 : l.qty * l.unit_cost), 0))}</strong>{" "}
          on this order
          {lines.some((l) => l.unit_cost == null) && (
            <>
              {" "}· <span className="is-bad">
                {lines.filter((l) => l.unit_cost == null).length} of these lines has no
                price on it, so the total is lower than what you will be invoiced.
                Put a cost against them before this goes out.
              </span>
            </>
          )}
        </p>
      )}

      {receivable && (
        <p className="acc-note">
          Book in what actually turned up. Half a load is the normal case — the rest
          stays on the order. A price entered here becomes what the item costs; it
          never moves the shelf price on its own.
        </p>
      )}

      <div className="modal-actions">
        {(po.status === "draft" || po.status === "sent") && (
          <button
            className="btn-line quiet"
            disabled={busy || !online}
            onClick={() => {
              const reason = window.prompt("Why is it being called off?") ?? null;
              setBusy(true);
              void poCancel(pin, po.id, reason)
                .then(async () => { await onChanged(); onBack(); })
                .catch((e) => setError(errorMessage(e, "That order could not be called off")))
                .finally(() => setBusy(false));
            }}
          >
            Call it off
          </button>
        )}
        {po.status === "draft" && (
          <button
            className="btn-fill"
            disabled={busy || !online || !lines || lines.length === 0}
            onClick={() => {
              setBusy(true);
              setError(null);
              void poSend(pin, po.id)
                .then(async () => { setBanner("Marked as with the supplier."); await onChanged(); })
                .catch((e) => setError(errorMessage(e, "That order could not be sent")))
                .finally(() => setBusy(false));
            }}
          >
            It has gone to the supplier
          </button>
        )}
        {receivable && (
          <button className="btn-fill" disabled={busy || !online} onClick={() => void bookIn()}>
            {busy ? "Booking in…" : "Book in what arrived"}
          </button>
        )}
      </div>
    </div>
  );
}

/**
 * A date, chosen from a calendar.
 *
 * This was a window.prompt asking for "YYYY-MM-DD", which is fine for a
 * developer and useless for somebody standing at a counter with a tablet:
 * no calendar, no validation, and a typo becomes a due date nobody notices.
 * `input type="date"` gives every platform its own native picker.
 */
function AskDate({
  title, subtitle, value, onSave, onCancel,
}: {
  title: string;
  subtitle?: string;
  value: string | null;
  onSave: (iso: string | null) => void;
  onCancel: () => void;
}) {
  const [when, setWhen] = useState(value ?? "");
  return (
    <div className="modal-backdrop" onClick={onCancel}>
      <div
        className="modal-card"
        role="dialog"
        aria-label={title}
        onClick={(e) => e.stopPropagation()}
        style={{ maxWidth: 380 }}
      >
        <h2 className="modal-title">{title}</h2>
        {subtitle && <p className="acc-note">{subtitle}</p>}
        <input
          autoFocus
          type="date"
          className="modal-input"
          value={when}
          aria-label="Due date"
          onChange={(e) => setWhen(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") onSave(when || null); }}
        />
        <div className="modal-actions">
          <button className="btn-line" onClick={onCancel}>Cancel</button>
          {/* A bill can lose its date as well as gain one. */}
          <button className="btn-line quiet" onClick={() => onSave(null)}>
            No date
          </button>
          <button className="btn-fill" onClick={() => onSave(when || null)}>
            Save
          </button>
        </div>
      </div>
    </div>
  );
}

/** An amount, on a keypad-friendly field rather than a browser prompt. */
function AskAmount({
  title, subtitle, value, onSave, onCancel,
}: {
  title: string;
  subtitle?: string;
  value: number;
  onSave: (amount: number) => void;
  onCancel: () => void;
}) {
  const [typed, setTyped] = useState(String(value));
  const amount = Number(typed.replace(",", "."));
  const ok = Number.isFinite(amount) && amount > 0;
  return (
    <div className="modal-backdrop" onClick={onCancel}>
      <div
        className="modal-card"
        role="dialog"
        aria-label={title}
        onClick={(e) => e.stopPropagation()}
        style={{ maxWidth: 430 }}
      >
        <h2 className="modal-title">{title}</h2>
        {subtitle && <p className="acc-note">{subtitle}</p>}
        <input
          autoFocus
          inputMode="decimal"
          className="modal-input"
          value={typed}
          aria-label="Amount paid"
          onChange={(e) => setTyped(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && ok) onSave(amount); }}
        />
        <div className="modal-actions">
          <button className="btn-line" onClick={onCancel}>Cancel</button>
          {/* The common case is settling it, one tap. */}
          <button className="btn-line" onClick={() => setTyped(String(value))}>
            Pay it all
          </button>
          <button className="btn-fill" disabled={!ok} onClick={() => onSave(amount)}>
            Record payment
          </button>
        </div>
      </div>
    </div>
  );
}

// --- What you owe -----------------------------------------------------------

function Owed({ pin, online }: { pin: string; online: boolean }) {
  const [data, setData] = useState<Payables | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [paying, setPaying] = useState<PayableRow | null>(null);
  const [dating, setDating] = useState<PayableRow | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      setData(await supplierPayables(pin));
    } catch (e) {
      setError(errorMessage(e, "Could not work out what is owed"));
    }
  }, [pin]);

  useEffect(() => {
    void load();
  }, [load]);

  async function pay(r: PayableRow, amount: number) {
    setPaying(null);
    setBusy(true);
    try {
      await supplierMarkPaid(pin, r.id, amount);
      await load();
    } catch (e) {
      setError(errorMessage(e, "That payment could not be recorded"));
    } finally {
      setBusy(false);
    }
  }

  async function setDue(r: PayableRow, iso: string | null) {
    setDating(null);
    setBusy(true);
    try {
      await supplierSetDue(pin, r.id, iso);
      await load();
    } catch (e) {
      setError(errorMessage(e, "That date could not be set"));
    } finally {
      setBusy(false);
    }
  }

  if (error) return <p className="acc-note is-bad">{error}</p>;
  if (!data) return <p className="acc-note">Adding it up…</p>;

  return (
    <div className="space-y-3">
      <p className="acc-note">
        <strong>{money(data.totals.total)}</strong> owed across {data.totals.documents}{" "}
        {data.totals.documents === 1 ? "invoice" : "invoices"}
        {data.totals.overdue > 0 && <> · <span className="is-bad">{money(data.totals.overdue)} overdue</span></>}
        {data.totals.undated > 0 && <> · {data.totals.undated} with no due date on {data.totals.undated === 1 ? "it" : "them"}</>}
      </p>

      {data.rows.length === 0 ? (
        <p className="acc-note">Nothing is owed to a supplier.</p>
      ) : (
        <table className="acc-table">
          <thead>
            <tr>
              <th>Supplier</th>
              <th>Invoice</th>
              <th>Due</th>
              <th className="num">Invoice</th>
              <th className="num">Paid</th>
              <th className="num">Still owed</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {data.rows.map((r) => (
              <tr key={r.id} className="acc-row">
                <td><span className="acc-name">{r.supplier}</span></td>
                <td>
                  {r.doc_number ?? "—"}
                  <span className="acc-sub">{r.doc_date ? fmtDate(r.doc_date) : ""}</span>
                </td>
                <td className={r.days_late != null && r.days_late > 0 ? "is-bad" : "quiet"}>
                  {r.due_date == null
                    ? "no date"
                    : r.days_late && r.days_late > 0
                      ? `${r.days_late} days late`
                      : fmtDate(r.due_date)}
                </td>
                <td className="num quiet">{money(r.total)}</td>
                <td className="num quiet">{r.paid > 0 ? money(r.paid) : "—"}</td>
                <td className="num">{money(r.outstanding)}</td>
                <td className="num">
                  <button
                    className="btn-line"
                    disabled={busy || !online}
                    onClick={() => setDating(r)}
                  >
                    Due date
                  </button>{" "}
                  <button
                    className="btn-line"
                    disabled={busy || !online}
                    onClick={() => setPaying(r)}
                  >
                    Pay
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {dating && (
        <AskDate
          title={`When is ${dating.doc_number ?? "this invoice"} due?`}
          subtitle={`${dating.supplier} · ${money(dating.outstanding)} still owed`}
          value={dating.due_date}
          onSave={(iso) => void setDue(dating, iso)}
          onCancel={() => setDating(null)}
        />
      )}

      {paying && (
        <AskAmount
          title={`Pay ${paying.supplier}`}
          subtitle={`${paying.doc_number ?? "Invoice"} · ${money(paying.outstanding)} still owed`}
          value={paying.outstanding}
          onSave={(amount) => void pay(paying, amount)}
          onCancel={() => setPaying(null)}
        />
      )}
    </div>
  );
}
