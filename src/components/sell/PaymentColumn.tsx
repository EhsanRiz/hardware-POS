import { useEffect, useMemo, useState } from "react";
import { VAT_RATE } from "../../lib/config";
import { money, quantity, vatWithin } from "../../lib/money";
import type { CartLine, Customer, PaymentMethod } from "../../lib/types";
import { AccountIcon, BackspaceIcon, CardIcon, CashIcon, PrinterIcon } from "./Icons";

/**
 * The payment column — design_handoff_innovapos §1.5.
 *
 * Taking the money happens IN the screen, not in a modal on top of it. That is
 * the handoff's design and it is the right one for a counter: the cashier can
 * see the lines they are charging for while they take the cash, and the whole
 * sale stays completable from the keyboard — scan, amount, Enter — which a
 * modal that steals focus makes worse rather than better.
 *
 * Split payments have no button of their own. Type a cash amount smaller than
 * the total and press Card, and the card takes the remainder — which is what
 * actually happens at a counter when someone empties their wallet first.
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
  onComplete: (p: {
    method: PaymentMethod;
    amountTendered: number | null;
    paidCash: number | null;
    paidCard: number | null;
  }) => void;
}) {
  const [method, setMethod] = useState<PaymentMethod>("cash");
  const [cashIn, setCashIn] = useState("");

  // A cleared sale must clear the tender with it, or the next customer's
  // change is computed from the last one's cash.
  useEffect(() => {
    if (lines.length === 0) {
      setCashIn("");
      setMethod("cash");
    }
  }, [lines.length]);

  const typed = Number(cashIn.replace(",", ".")) || 0;
  const hasTyped = cashIn.trim() !== "";
  // An empty cash field means exact money — much the commonest cash sale, and
  // it keeps the handoff's keyboard flow honest: scan, Enter, done, with no
  // keystroke that tells the till something it can already work out.
  const cash = method === "cash" && !hasTyped ? total : typed;
  const change = Math.max(0, cash - total);
  const units = lines.reduce((s, l) => s + l.qty, 0);
  const vat = vatWithin(total, VAT_RATE);

  // The card covers whatever the cash did not — the split path, without a
  // fourth button to explain.
  const isSplit = method === "card" && hasTyped && typed > 0 && typed < total;
  const cardPart = isSplit ? Math.max(0, total - typed) : 0;

  const overLimit =
    method === "account" &&
    customer?.available != null &&
    total > customer.available;

  const ready = useMemo(() => {
    if (busy || !canPay || lines.length === 0) return false;
    if (method === "cash") return cash >= total;
    if (method === "account") return !!customer && !overLimit;
    return true;
  }, [busy, canPay, lines.length, method, cash, total, customer, overLimit]);

  function complete() {
    if (!ready) return;
    onComplete({
      method: isSplit ? "split" : method,
      amountTendered: method === "cash" ? cash : null,
      paidCash: isSplit ? typed : null,
      paidCard: isSplit ? cardPart : null,
    });
  }

  function key(k: string) {
    setCashIn((v) => {
      if (k === "⌫") return v.slice(0, -1);
      if (k === ".") return v.includes(".") ? v : (v || "0") + ".";
      // Two decimal places is all money has; more digits are a mis-key.
      if (v.includes(".") && v.split(".")[1].length >= 2) return v;
      return (v === "0" ? "" : v) + k;
    });
  }

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

        {/* The accountant's double rule: everything above is working, the
            figure below is what is owed. */}
        <div className="double-rule" />

        <div className="total-row">
          <span className="lbl">Total</span>
          <span className="fig">{money(total)}</span>
        </div>
      </div>

      <div className="tender">
        <span className="kicker-sm">Tender</span>

        <div className="tender-grid">
          <TenderButton
            label="Cash"
            icon={<CashIcon />}
            active={method === "cash"}
            onClick={() => setMethod("cash")}
          />
          <TenderButton
            label="Card"
            icon={<CardIcon />}
            active={method === "card"}
            onClick={() => setMethod("card")}
          />
          <TenderButton
            label="Account"
            icon={<AccountIcon />}
            active={method === "account"}
            // An account sale needs an account. The button says so by being
            // unavailable rather than by failing after the bakkie is loaded.
            disabled={!customer}
            title={customer ? undefined : "Choose an account customer first"}
            onClick={() => setMethod("account")}
          />
        </div>

        {method !== "account" && (
          <>
            <div className="cash-in">
              <span className="kicker-sm">{method === "cash" ? "Cash in" : "Cash part"}</span>
              <input
                inputMode="decimal"
                value={cashIn}
                onChange={(e) => setCashIn(e.target.value.replace(/[^\d.,]/g, ""))}
                onKeyDown={(e) => e.key === "Enter" && complete()}
                placeholder={method === "cash" ? money(total, { currency: false }) : "0.00"}
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
                      onClick={() =>
                        quick ? setCashIn(k.slice(1)) : key(k)
                      }
                      aria-label={
                        k === "⌫" ? "Backspace" : quick ? `${k} note` : k
                      }
                    >
                      {k === "⌫" ? <BackspaceIcon /> : k}
                    </button>
                  );
                })
              )}
            </div>

            <div className="change-row">
              <span className="kicker-sm">
                {isSplit ? "Card takes" : "Change due"}
              </span>
              <span className="fig">
                {money(isSplit ? cardPart : change)}
              </span>
            </div>
          </>
        )}

        {method === "account" && customer && (
          <div className="change-row">
            <span className="kicker-sm">
              {overLimit ? "Over the limit" : "Available credit"}
            </span>
            <span
              className="fig"
              style={overLimit ? { color: "var(--color-owing)" } : undefined}
            >
              {customer.available != null ? money(customer.available) : "No limit"}
            </span>
          </div>
        )}

      </div>

      {/* Pinned, never scrolled away. On a 768-tall tablet the keypad alone
          fills the column, and a till whose "take the money" button is below
          the fold is a till that loses sales at a queue. */}
      <div className="pay-foot">
        <button className="btn-tender" disabled={!ready} onClick={complete}>
          <PrinterIcon />
          {busy ? "Working…" : `Tender & print ${money(total)}`}
        </button>

        <p className="tender-caption">
          {trade ? "Trade pricing · " : ""}
          Enter to complete · drawer opens · invoice prints
        </p>
      </div>
    </aside>
  );
}

function TenderButton({
  label,
  icon,
  active,
  disabled,
  title,
  onClick,
}: {
  label: string;
  icon: React.ReactNode;
  active: boolean;
  disabled?: boolean;
  title?: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className="tender-btn"
      aria-pressed={active}
      disabled={disabled}
      title={title}
      onClick={onClick}
    >
      {icon}
      {label}
    </button>
  );
}
