import { useEffect, useMemo, useState } from "react";
import { vatRate } from "../../lib/settings";
import { cashRounding, money, quantity, vatWithin } from "../../lib/money";
import type { CartLine, Customer, Payment, PaymentMethod } from "../../lib/types";
import {
  AccountIcon,
  BackspaceIcon,
  CardIcon,
  CashIcon,
  EftIcon,
  PrinterIcon,
  QrIcon,
} from "./Icons";

/** The tenders a South African hardware counter actually takes. */
const TENDERS: { method: PaymentMethod; label: string; icon: React.ReactNode }[] = [
  { method: "cash", label: "Cash", icon: <CashIcon /> },
  { method: "card", label: "Card", icon: <CardIcon /> },
  { method: "eft", label: "EFT", icon: <EftIcon /> },
  { method: "zapper", label: "Zapper", icon: <QrIcon /> },
  { method: "account", label: "Account", icon: <AccountIcon /> },
];

/**
 * A tender, plus what was physically handed over for it.
 *
 * The two are not the same and must travel together: R900 handed over for an
 * R891 sale applies R891 and leaves R9 as change. Keeping the notes in a
 * counter of their own was the bug — removing the tender left its notes behind,
 * so re-tendering added a second lot and the change grew each time.
 */
interface TakenTender {
  payment: Payment;
  /** Notes handed over. Equal to the amount applied for anything but cash. */
  offered: number;
}

/**
 * The payment column — design_handoff_innovapos §1.5, rebuilt around a LIST of
 * tenders after watching a real counter work.
 *
 * A sale is settled by however many payments it takes: R2 000 cash, the rest on
 * card, R500 on account is an ordinary builder's transaction. Each tender is
 * added as its own line and the sale completes when they cover the total.
 *
 * CASH ROUNDING. South Africa stopped minting 1c, 2c and 5c coins, so R187.05
 * cannot be paid in cash. The invoice total stays exact — VAT is computed on
 * it — and only the CASH portion settles to the nearest 10c, halves rounding
 * down in the customer's favour. The server recomputes all of this; what is
 * here is so the cashier sees the same number before they take the money.
 *
 * Taking payment happens IN the screen rather than in a modal on top of it, so
 * the cashier can see the lines they are charging for while they take the cash.
 */
export default function PaymentColumn({
  lines,
  subtotal,
  discount,
  total,
  trade,
  customer,
  busy,
  canPay,
  open,
  onClose,
  onPickCustomer,
  onComplete,
}: {
  lines: CartLine[];
  subtotal: number;
  discount: number;
  total: number;
  trade: boolean;
  customer: Customer | null;
  busy: boolean;
  canPay: boolean;
  /** On a tablet this column is a sheet; on a wide screen it is always docked. */
  open: boolean;
  onClose: () => void;
  /**
   * Choose the account this sale goes on. Reached from the Account tender, for
   * the ordinary case of finding out at the till that the buyer has an account.
   */
  onPickCustomer: () => void;
  onComplete: (p: {
    payments: Payment[];
    amountTendered: number | null;
    rounding: number;
    poNumber: string | null;
    customerVatNumber: string | null;
  }) => void;
}) {
  const [taken, setTaken] = useState<TakenTender[]>([]);
  const [entry, setEntry] = useState("");
  const [poNumber, setPoNumber] = useState("");
  const [vatNumber, setVatNumber] = useState("");
  const [showInvoiceFields, setShowInvoiceFields] = useState(false);
  // Selling more than the shelf count, acknowledged once for this set of short
  // lines. Change a quantity and it is asked again — an acknowledgement of
  // "2 m short" must not silently cover 20.
  const [shortAck, setShortAck] = useState(false);
  const [askShort, setAskShort] = useState(false);

  // A cleared sale clears the tender with it, or the next customer's change is
  // computed from the last one's cash.
  useEffect(() => {
    if (lines.length === 0) {
      setTaken([]);
      setEntry("");
      setPoNumber("");
      setVatNumber("");
    }
  }, [lines.length]);

  // An account's own VAT number fills the field, and the cashier can still
  // type one for a walk-in who happens to be a VAT vendor.
  useEffect(() => {
    setVatNumber(customer?.vat_number ?? "");
  }, [customer]);

  const units = lines.reduce((s, l) => s + l.qty, 0);
  // Served, not compiled in: the rate on screen has to be the rate the
  // server will charge, or the two disagree the day a new one takes effect.
  const rate = vatRate();
  const vat = vatWithin(total, rate);

  const nonCashTaken = taken
    .filter((t) => t.payment.method !== "cash")
    .reduce((s, t) => s + t.payment.amount, 0);
  const cashTaken = taken
    .filter((t) => t.payment.method === "cash")
    .reduce((s, t) => s + t.payment.amount, 0);
  // The notes behind the cash tenders that are still in this sale. Summed from
  // the tenders rather than accumulated in a counter of its own, so removing a
  // tender takes its notes with it.
  const cashOffered = taken
    .filter((t) => t.payment.method === "cash")
    .reduce((s, t) => s + t.offered, 0);
  const paid = cashTaken + nonCashTaken;

  // What the remaining cash would settle at, if the rest were paid in coins.
  const cashDue = Math.max(0, Math.round((total - nonCashTaken) * 100) / 100);
  const rounding = useMemo(
    () => (cashTaken > 0 || taken.length === 0 ? cashRounding(cashDue) : 0),
    [cashDue, cashTaken, taken.length]
  );
  const settles = Math.round((total + rounding) * 100) / 100;
  const outstanding = Math.round((settles - paid) * 100) / 100;

  const typed = Number(entry.replace(",", ".")) || 0;
  const hasTyped = entry.trim() !== "";

  /**
   * The notes physically handed over.
   *
   * Read only from the tenders that are actually in this sale. The box does not
   * get a vote once a tender is placed — an earlier version let it keep
   * meaning "cash received" afterwards, so typing into it moved the change on a
   * settled sale and the same figure could be edited after the fact. One box
   * that means two different things depending on what has already happened is
   * not a box anybody can trust with money.
   *
   * The order is the one every till uses: count what is in your hand, type it,
   * then tap the tender. Getting it wrong is undone by removing the tender and
   * taking it again.
   */
  const handedOver = useMemo(() => {
    // No cash in the sale, no change to give — a card sale must not invent
    // change from a stray figure left in the box.
    if (cashTaken <= 0.005) return 0;
    return cashOffered;
  }, [cashTaken, cashOffered]);

  const changeDue = Math.max(0, Math.round((handedOver - cashTaken) * 100) / 100);

  // Nothing left to pay. Used to shut the amount entry, so the figures that
  // decide what leaves the drawer stop being editable once they are decided.
  const settled = lines.length > 0 && outstanding <= 0.005;

  const ready = !busy && canPay && lines.length > 0 && outstanding <= 0.005;

  /**
   * Add a tender. With no amount typed it settles whatever is outstanding.
   *
   * Cash is capped at what is owed and the surplus becomes change — handing
   * over a R200 note for a R115 sale must never record a R200 payment.
   * Everything else is applied as entered, because a card cannot overpay.
   */
  function take(method: PaymentMethod) {
    if (lines.length === 0) return;
    // "Put it on my account" is said AT the till, after the goods are rung up,
    // by a builder the cashier may not have recognised. So Account is a live
    // button on a walk-in sale: it asks who, and the picker re-prices the lines
    // to the trade band on the way back.
    if (method === "account" && !customer) return onPickCustomer();

    // Cash settles to the nearest 10c; everything else to the exact cent.
    const remaining =
      method === "cash"
        ? Math.round((total + cashRounding(total - nonCashTaken) - paid) * 100) / 100
        : Math.round((total - paid) * 100) / 100;
    if (remaining <= 0) return;

    const offered = hasTyped ? typed : remaining;
    if (offered <= 0) return;

    // Never apply more than is owed: the surplus on a cash tender is change,
    // and a card is simply capped.
    let applied = Math.min(offered, remaining);

    // An account tender is capped at the headroom left on the limit, rather
    // than refused for exceeding it. A builder with R500 left on a R1 200 sale
    // puts R500 on the account and settles the rest — which is what actually
    // happens at the counter, and is what refusing the whole tender prevented.
    // The server recomputes the limit and is the authority.
    if (method === "account" && accountHeadroom != null) {
      applied = Math.min(applied, accountHeadroom);
    }
    if (applied <= 0.005) return;

    setTaken((prev) => [
      ...prev,
      {
        payment: { method, amount: Math.round(applied * 100) / 100 },
        // What was physically handed over for this tender. Only cash can be
        // more than the amount applied; a card is settled exactly.
        offered: method === "cash" ? offered : Math.round(applied * 100) / 100,
      },
    ]);
    setEntry("");
  }

  /**
   * Lines this sale takes further than the shelf count goes.
   *
   * Read off the cached catalogue, which is the only stock figure the till has
   * when the line is down — and the line being down is exactly when nothing
   * else is going to catch this. Items with no stock figure are not tracked
   * and cannot be short.
   */
  const shortLines = useMemo(
    () =>
      lines
        .filter((l) => l.product.stock_qty != null && l.qty > l.product.stock_qty!)
        .map((l) => ({
          line: l,
          onHand: l.product.stock_qty!,
          by: Math.round((l.qty - l.product.stock_qty!) * 1000) / 1000,
        })),
    [lines]
  );

  const shortKey = shortLines.map((s) => `${s.line.product.id}:${s.line.qty}`).join("|");
  useEffect(() => setShortAck(false), [shortKey]);

  function complete() {
    if (!ready) return;
    // Selling short is the shop's call, not the till's — a hardware yard really
    // does hold stock the count has lost track of, and refusing the money would
    // be worse than asking. But it must be a decision, not a slip, so it is put
    // in front of the cashier at the one moment they are committing.
    if (shortLines.length > 0 && !shortAck) {
      setAskShort(true);
      return;
    }
    finish();
  }

  /** Take the money. Past every question the till gets to ask. */
  function finish() {
    if (!ready) return;
    onComplete({
      payments: taken.map((t) => t.payment),
      // The notes handed over, so the server can work out the change.
      amountTendered: handedOver > 0 ? handedOver : null,
      rounding,
      poNumber: poNumber.trim() || null,
      customerVatNumber: vatNumber.trim() || null,
    });
  }

  function key(k: string) {
    setEntry((v) => {
      if (k === "⌫") return v.slice(0, -1);
      if (k === ".") return v.includes(".") ? v : (v || "0") + ".";
      if (v.includes(".") && v.split(".")[1].length >= 2) return v;
      return (v === "0" ? "" : v) + k;
    });
  }

  // Headroom left on the account, after anything already put on it in this
  // sale. Null means an unlimited account; no customer means there is nothing
  // to measure yet, and the Account button asks who instead of standing dead.
  const accountHeadroom = useMemo(() => {
    if (!customer || customer.available == null) return null;
    const already = taken
      .filter((t) => t.payment.method === "account")
      .reduce((s, t) => s + t.payment.amount, 0);
    return Math.round((customer.available - already) * 100) / 100;
  }, [customer, taken]);

  const accountBlocked = !!customer && accountHeadroom != null && accountHeadroom <= 0.005;

  return (
    <>
    <aside className={`pay${open ? " is-open" : ""}`} aria-label="Payment">
      {/* Visible only when this column is a sheet; CSS hides it when docked. */}
      <div className="pay-close">
        <span className="kicker-sm">Payment</span>
        <button type="button" onClick={onClose}>
          Back to the sale
        </button>
      </div>

      <div className="totals">
        <div className="totals-row">
          <span>
            {lines.length} {lines.length === 1 ? "line" : "lines"} ·{" "}
            {quantity(units)} units
          </span>
          <span>{money(subtotal, { currency: false })}</span>
        </div>

        {discount > 0 && (
          <div className="totals-row is-discount">
            <span>Discount</span>
            <span>−{money(discount, { currency: false })}</span>
          </div>
        )}

        <div className="totals-row">
          <span>VAT at {+(rate * 100).toFixed(2)}%</span>
          <span>{money(vat, { currency: false })}</span>
        </div>

        {rounding !== 0 && (
          <div className="totals-row is-discount">
            <span>Cash rounding</span>
            <span>
              {rounding > 0 ? "+" : "−"}
              {money(Math.abs(rounding), { currency: false })}
            </span>
          </div>
        )}

        {/* The accountant's double rule: everything above is working, the
            figure below is what is owed. */}
        <div className="double-rule" />

        <div className="total-row">
          <span className="lbl">{rounding !== 0 ? "To pay" : "Total"}</span>
          <span className="fig">{money(settles)}</span>
        </div>
      </div>

      <div className="tender">
        {taken.length > 0 && (
          <div className="taken" aria-label="Payments taken">
            {taken.map((t, i) => (
              <div className="taken-row" key={i}>
                <span className="taken-method">{labelFor(t.payment.method)}</span>
                <span className="taken-amt">{money(t.payment.amount)}</span>
                <button
                  type="button"
                  aria-label={`Remove ${labelFor(t.payment.method)} payment`}
                  onClick={() => setTaken((prev) => prev.filter((_, j) => j !== i))}
                >
                  ×
                </button>
              </div>
            ))}
            <div className="taken-row is-outstanding">
              <span className="taken-method">
                {outstanding > 0.005 ? "Still owing" : "Change due"}
              </span>
              <span className="taken-amt">
                {money(outstanding > 0.005 ? outstanding : changeDue)}
              </span>
              <span />
            </div>
          </div>
        )}

        <span className="kicker-sm">
          {taken.length > 0 ? "Add another tender" : "Tender"}
        </span>

        <div className="tender-grid">
          {TENDERS.map((t) => (
            <button
              key={t.method}
              type="button"
              className={`tender-btn${
                taken.some((x) => x.payment.method === t.method) ? " is-taken" : ""
              }`}
              disabled={
                lines.length === 0 ||
                (t.method === "account" && accountBlocked) ||
                outstanding <= 0.005
              }
              title={
                t.method !== "account"
                  ? undefined
                  : !customer
                    ? "Put this sale on an account — choose the customer"
                    : accountBlocked
                      ? `No credit left on ${customer.name}'s account`
                      : accountHeadroom != null
                        ? `${money(accountHeadroom)} left on this account`
                        : undefined
              }
              onClick={() => take(t.method)}
            >
              {t.icon}
              {t.label}
            </button>
          ))}
        </div>

        {/* Settled means settled. With nothing outstanding there is no tender
            left to size, so the box is shut rather than left looking editable —
            a field that still accepts digits after the money is counted invites
            somebody to change a figure that has already been decided. */}
        <div className={`cash-in${settled ? " is-shut" : ""}`}>
          <span className="kicker-sm">{settled ? "Settled" : "Amount"}</span>
          {/* The keys for this are directly underneath, so raising the device
              keyboard on top of them helps nobody — on a tablet it covers the
              keypad, the change due and the tender button. A real keyboard
              still types here; only the on-screen one is refused. */}
          <input
            inputMode="none"
            value={settled ? "" : entry}
            disabled={settled}
            onChange={(e) => setEntry(e.target.value.replace(/[^\d.,]/g, ""))}
            onKeyDown={(e) => e.key === "Enter" && (ready ? complete() : take("cash"))}
            placeholder={
              settled ? "—" : money(Math.max(outstanding, 0), { currency: false })
            }
            aria-label="Amount for the next tender"
          />
        </div>

        <div className="keypad">
          {[
            ["7", "8", "9", "R200"],
            ["4", "5", "6", "R100"],
            ["1", "2", "3", "R50"],
            ["0", "00", ".", "⌫"],
          ].map((row) =>
            row.map((k) => {
              const quick = k.startsWith("R");
              return (
                <button
                  key={k}
                  type="button"
                  className={quick ? "quick" : undefined}
                  disabled={settled}
                  onClick={() => (quick ? setEntry(k.slice(1)) : key(k))}
                  aria-label={k === "⌫" ? "Backspace" : quick ? `${k} note` : k}
                >
                  {k === "⌫" ? <BackspaceIcon /> : k}
                </button>
              );
            })
          )}
        </div>

        {/* Folded away by default: most sales are a walk-in paying cash, and
            these two fields matter only to a contractor's bookkeeper. */}
        <button
          type="button"
          className="disclose"
          aria-expanded={showInvoiceFields}
          onClick={() => setShowInvoiceFields((v) => !v)}
        >
          {showInvoiceFields ? "− " : "+ "}
          Invoice details
          {(poNumber || vatNumber) && !showInvoiceFields ? " ·  set" : ""}
        </button>

        {showInvoiceFields && (
          <div className="invoice-fields">
            <label>
              <span className="kicker-sm">Order number</span>
              <input
                value={poNumber}
                onChange={(e) => setPoNumber(e.target.value)}
                placeholder="Their PO number"
                aria-label="Purchase order number"
              />
            </label>
            <label>
              <span className="kicker-sm">Buyer's VAT number</span>
              <input
                value={vatNumber}
                onChange={(e) => setVatNumber(e.target.value)}
                placeholder="Required over R5 000"
                inputMode="numeric"
                aria-label="Buyer's VAT number"
              />
            </label>
          </div>
        )}
      </div>

      {/* Pinned, never scrolled away. On a 768-tall tablet the keypad alone
          fills the column, and a till whose "take the money" button is below
          the fold is a till that loses sales at a queue. */}
      <div className="pay-foot">
        {/* The shortfall said again where the money is taken. It was a red
            number on a line the cashier has since scrolled past, and this is
            the last screen before the drawer opens. */}
        {shortLines.length > 0 && (
          <p className="pay-short" role="status">
            <span className="pay-short-head">More than the shelf count</span>
            {shortLines.map((s) => (
              <span key={s.line.product.id}>
                {s.line.product.name} — {quantity(s.onHand, s.line.product.unit_code)} on
                hand, selling {quantity(s.line.qty)}
              </span>
            ))}
          </p>
        )}

        <button className="btn-tender" disabled={!ready} onClick={complete}>
          <PrinterIcon />
          {busy ? "Working…" : `Tender & print ${money(settles)}`}
        </button>

        <p className="tender-caption">
          {trade ? "Trade pricing · " : ""}
          {taken.length === 0
            ? "Type what they hand over, then tap a tender · Enter takes cash"
            : settled
              ? "Enter to complete · drawer opens · invoice prints"
              : "Take the rest on another tender"}
        </p>
      </div>
    </aside>

      {/* Outside the aside deliberately. On a tablet the payment column is a
          sheet that slides on a transform, and a transformed ancestor becomes
          the containing block for position:fixed — a dialog rendered inside it
          would be clipped to the sheet on exactly the devices this till runs
          on. Its siblings here are in .sell-body, which is untransformed. */}
      {askShort && (
        <div className="modal-backdrop" onClick={() => setAskShort(false)}>
          <div
            className="modal-card"
            onClick={(e) => e.stopPropagation()}
            role="dialog"
            aria-modal="true"
            aria-label="Selling more than the shelf count"
          >
            <h2 className="modal-title">Selling more than the shelf count</h2>

            <div className="modal-list">
              {shortLines.map((s) => (
                <div className="short-row" key={s.line.product.id}>
                  <span className="modal-row-name">{s.line.product.name}</span>
                  <span className="modal-row-meta">
                    {quantity(s.onHand, s.line.product.unit_code)} on hand · selling{" "}
                    {quantity(s.line.qty)} ·{" "}
                    <span className="is-short">{quantity(s.by)} short</span>
                  </span>
                </div>
              ))}
            </div>

            {/* Both halves of what happens next, because the cashier is the one
                who knows which it is. The count is often simply wrong; when it
                is not, somebody has promised goods the yard has not got, and
                the customer needs telling now rather than on collection. */}
            <p className="short-note">
              If the stock is really there, book it in afterwards so the count
              agrees again. If it is not, the customer is waiting on a delivery —
              tell them before they pay.
            </p>

            <div className="modal-actions">
              <button className="btn-line" onClick={() => setAskShort(false)}>
                Go back
              </button>
              {/* This takes the money — the cashier came here by pressing
                  Tender, and a confirmation that only closes itself would send
                  them back to press it again wondering what they missed. */}
              <button
                className="btn-fill"
                onClick={() => {
                  setShortAck(true);
                  setAskShort(false);
                  finish();
                }}
              >
                Sell short · {money(settles)}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

function labelFor(m: PaymentMethod): string {
  return TENDERS.find((t) => t.method === m)?.label ?? m;
}
