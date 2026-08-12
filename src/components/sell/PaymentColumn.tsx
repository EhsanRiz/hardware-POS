import { useEffect, useMemo, useState } from "react";
import { VAT_RATE } from "../../lib/config";
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
  const [taken, setTaken] = useState<Payment[]>([]);
  // Notes physically handed over, which is NOT the same as the amount applied
  // to the sale: a customer paying R115 with a R200 note tenders 200 and the
  // sale takes 115. Conflating the two overpays the invoice.
  const [cashTendered, setCashTendered] = useState(0);
  const [entry, setEntry] = useState("");
  const [poNumber, setPoNumber] = useState("");
  const [vatNumber, setVatNumber] = useState("");
  const [showInvoiceFields, setShowInvoiceFields] = useState(false);

  // A cleared sale clears the tender with it, or the next customer's change is
  // computed from the last one's cash.
  useEffect(() => {
    if (lines.length === 0) {
      setTaken([]);
      setCashTendered(0);
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
  const vat = vatWithin(total, VAT_RATE);

  const nonCashTaken = taken
    .filter((p) => p.method !== "cash")
    .reduce((s, p) => s + p.amount, 0);
  const cashTaken = taken
    .filter((p) => p.method === "cash")
    .reduce((s, p) => s + p.amount, 0);
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

    if (method === "cash") setCashTendered((c) => c + offered);

    setTaken((prev) => [...prev, { method, amount: Math.round(applied * 100) / 100 }]);
    setEntry("");
  }

  function complete() {
    if (!ready) return;
    onComplete({
      payments: taken,
      // The notes handed over, so the server can work out the change.
      amountTendered: cashTendered > 0 ? cashTendered : null,
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
      .filter((p) => p.method === "account")
      .reduce((s, p) => s + p.amount, 0);
    return Math.round((customer.available - already) * 100) / 100;
  }, [customer, taken]);

  const accountBlocked = !!customer && accountHeadroom != null && accountHeadroom <= 0.005;

  return (
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
          <span>VAT at {Math.round(VAT_RATE * 100)}%</span>
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
            {taken.map((p, i) => (
              <div className="taken-row" key={i}>
                <span className="taken-method">{labelFor(p.method)}</span>
                <span className="taken-amt">{money(p.amount)}</span>
                <button
                  type="button"
                  aria-label={`Remove ${labelFor(p.method)} payment`}
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
                {money(
                  outstanding > 0.005
                    ? outstanding
                    : Math.max(0, Math.round((cashTendered - cashTaken) * 100) / 100)
                )}
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
              className="tender-btn"
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

        <div className="cash-in">
          <span className="kicker-sm">Amount</span>
          <input
            inputMode="decimal"
            value={entry}
            onChange={(e) => setEntry(e.target.value.replace(/[^\d.,]/g, ""))}
            onKeyDown={(e) => e.key === "Enter" && (ready ? complete() : take("cash"))}
            placeholder={money(Math.max(outstanding, 0), { currency: false })}
            aria-label="Cash received"
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
        <button className="btn-tender" disabled={!ready} onClick={complete}>
          <PrinterIcon />
          {busy ? "Working…" : `Tender & print ${money(settles)}`}
        </button>

        <p className="tender-caption">
          {trade ? "Trade pricing · " : ""}
          {taken.length === 0
            ? "Tap a tender · Enter takes cash"
            : "Enter to complete · drawer opens · invoice prints"}
        </p>
      </div>
    </aside>
  );
}

function labelFor(m: PaymentMethod): string {
  return TENDERS.find((t) => t.method === m)?.label ?? m;
}
