import { useEffect, useMemo, useRef, useState } from "react";
import { customerHistory, quickCustomer } from "../../lib/api";
import { errorMessage } from "../../lib/errors";
import { money } from "../../lib/money";
import { useOnline } from "../../lib/offline";
import { formatPhone, looksLikePhone, phoneMatches } from "../../lib/phone";
import type { Customer, CustomerVisit } from "../../lib/types";
import { fmtDate } from "../../lib/dates";

/**
 * Who is buying.
 *
 * One box answers three different questions, because at a counter they are the
 * same question asked in different words:
 *
 *   "Put it on Mokoena's account"  → search by name or account code
 *   "It's me again, 082 123 4567"  → search by phone, and record it if new
 *   "I bought this here in March"  → the purchase history behind that number
 *
 * The phone number is the key that makes the last two work. It is the fastest
 * unique thing a person can say across a counter, and unlike a name there is
 * only one spelling of it — once it is normalised, which is `phone.ts`'s job.
 *
 * What a cashier CANNOT do here is grant credit. Recording a buyer produces a
 * retail-priced contact with no limit; turning that into a trade account is a
 * back-office decision, enforced server-side in `pos_quick_customer`.
 */
export default function CustomerPicker({
  customers,
  cashierId,
  onPick,
  onAdded,
  onClose,
  onOpenSale,
}: {
  customers: Customer[];
  /** Whose permission authorises recording a buyer. */
  cashierId: string;
  onPick: (c: Customer | null) => void;
  /** A newly recorded buyer, so the till's cached list stays current. */
  onAdded?: (c: Customer) => void;
  onClose: () => void;
  /** An invoice from a buyer's history, opened by number. */
  onOpenSale?: (docNumber: string) => void;
}) {
  const online = useOnline();
  const [term, setTerm] = useState("");
  const [view, setView] = useState<{ kind: "list" }
    | { kind: "new" }
    | { kind: "history"; customer: Customer }>({ kind: "list" });
  const [newName, setNewName] = useState("");
  const [newPhone, setNewPhone] = useState("");
  const [newAddress, setNewAddress] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const q = term.trim().toLowerCase();
  const phoneish = looksLikePhone(term);

  const shown = useMemo(() => {
    if (!q) return customers;
    return customers.filter(
      (c) =>
        c.name.toLowerCase().includes(q) ||
        (c.code ?? "").toLowerCase().includes(q) ||
        (phoneish && phoneMatches(c.phone, term))
    );
  }, [customers, q, phoneish, term]);

  /*
   * Worth offering to record: nothing on file matches what was typed.
   *
   * This used to require the term to READ as a phone number, which meant
   * somebody who typed a name got "Nothing on file matches" and no way
   * forward — the commonest way a customer introduces themselves, and a dead
   * end. A name is now as good a starting point as a number; the number is
   * then asked for rather than assumed, because it is the key that finds them
   * again when they come back with a warranty claim.
   */
  const canRecord = shown.length === 0 && q !== "";
  /** What the counter typed, read as whichever of the two it looks like. */
  const typedPhone = phoneish ? term : "";
  const typedName = phoneish ? "" : term.trim();
  const phoneReady = looksLikePhone(newPhone);

  function startRecording() {
    setNewPhone(typedPhone);
    setNewName(typedName);
    setNewAddress("");
    setError(null);
    setView({ kind: "new" });
  }

  async function record() {
    setBusy(true);
    setError(null);
    try {
      const c = await quickCustomer(
        cashierId,
        newPhone,
        newName || null,
        null,
        newAddress || null
      );
      onAdded?.(c);
      onPick(c);
    } catch (e) {
      setError(errorMessage(e, "That buyer could not be recorded"));
      setBusy(false);
    }
  }

  if (view.kind === "history") {
    return (
      <PurchaseHistory
        customer={view.customer}
        onBack={() => setView({ kind: "list" })}
        onClose={onClose}
        onOpen={onOpenSale}
      />
    );
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="modal-card"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-label="Choose a customer"
      >
        <h2 className="modal-title">Who's buying?</h2>

        <input
          autoFocus
          value={term}
          onChange={(e) => {
            setTerm(e.target.value);
            setView({ kind: "list" });
            setError(null);
          }}
          placeholder="Name, account code or phone number"
          // A phone keypad on a tablet when the cashier is clearly typing
          // digits, a normal keyboard when they are typing a name.
          inputMode={phoneish ? "tel" : "text"}
          className="modal-input"
        />

        <div className="modal-list">
          <button className="modal-row" onClick={() => onPick(null)}>
            <span className="modal-row-name">Walk-in customer</span>
            <span className="modal-row-meta">Retail price · cash or card</span>
          </button>

          {shown.map((c) => (
            <div key={c.id} className="modal-row-pair">
              <button className="modal-row" onClick={() => onPick(c)}>
                <span className="modal-row-name">{c.name}</span>
                <span className="modal-row-meta">{describe(c)}</span>
              </button>
              <button
                className="modal-row-go"
                onClick={() => setView({ kind: "history", customer: c })}
                disabled={!online}
                title={
                  online
                    ? "What this buyer has bought before"
                    : "Purchase history needs a connection"
                }
                aria-label={`Purchases by ${c.name}`}
              >
                <ReceiptGlyph />
              </button>
            </div>
          ))}

          {canRecord && view.kind === "list" && (
            <button
              className="modal-row"
              onClick={startRecording}
              disabled={!online}
            >
              <span className="modal-row-name">
                Add {formatPhone(term) || term} as a new buyer
              </span>
              <span className="modal-row-meta">
                {online
                  ? "So this purchase can be found again — for a return or a warranty claim"
                  : "Needs a connection · the sale itself still works offline"}
              </span>
            </button>
          )}

          {canRecord && view.kind === "new" && (
            <div className="modal-field">
              <label className="modal-row-meta" htmlFor="buyer-name">
                Their name{phoneish ? ", if they'll give it (optional)" : ""}
              </label>
              <input
                id="buyer-name"
                autoFocus={phoneish}
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                placeholder="e.g. J. Mokoena"
                className="modal-input"
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !busy && phoneReady) void record();
                }}
              />
              {/* Asked for, not assumed. A name is how somebody introduces
                  themselves; a number is what finds them again in March when
                  they come back with a broken grinder and no slip. It is the
                  key the record is kept under, so it is the one thing here
                  that is not optional. */}
              <label className="modal-row-meta" htmlFor="buyer-phone">
                Their phone number
              </label>
              <input
                id="buyer-phone"
                autoFocus={!phoneish}
                value={newPhone}
                onChange={(e) => setNewPhone(e.target.value)}
                placeholder="e.g. 082 123 4567"
                inputMode="tel"
                className="modal-input"
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !busy && phoneReady) void record();
                }}
              />
              <label className="modal-row-meta" htmlFor="buyer-address">
                Delivery address, if there is one (optional)
              </label>
              <input
                id="buyer-address"
                value={newAddress}
                onChange={(e) => setNewAddress(e.target.value)}
                placeholder="e.g. 14 Mabille Rd, Maseru"
                className="modal-input"
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !busy) void record();
                }}
              />
              <p className="modal-row-meta">
                Kept for invoices, returns and warranty claims only. Never
                required to complete a sale — and once it is here, this buyer is
                found again by name or number, so the next slip carries it too.
              </p>
              <div className="modal-actions">
                {/* "Back", not "Cancel": the modal already has a Cancel that
                    closes the whole thing, and two buttons with one word
                    meaning two different retreats is how people tap the wrong
                    one. */}
                <button
                  className="btn-line"
                  onClick={() => setView({ kind: "list" })}
                  disabled={busy}
                >
                  Back
                </button>
                <button
                  className="btn-fill"
                  onClick={() => void record()}
                  disabled={busy || !phoneReady}
                  title={phoneReady ? undefined : "A phone number is how they are found again"}
                >
                  {busy ? "Saving…" : `Save ${newName || formatPhone(newPhone) || "this buyer"}`}
                </button>
              </div>
            </div>
          )}
        </div>

        {error && (
          <p className="modal-row-meta" style={{ color: "var(--color-owing)" }}>
            {error}
          </p>
        )}

        <button className="btn-line" style={{ marginTop: 14 }} onClick={onClose}>
          Cancel
        </button>
      </div>
    </div>
  );
}

/**
 * What this buyer has bought.
 *
 * The reason this screen exists: a customer at the returns counter says they
 * bought a grinder here a few months ago and has no slip. Without this, the
 * answer is a shrug. With it, the invoice number is on screen in seconds.
 */
function PurchaseHistory({
  customer,
  onBack,
  onClose,
  onOpen,
}: {
  customer: Customer;
  onBack: () => void;
  onClose: () => void;
  /** Open one of the invoices — reprint it, or take a return against it. */
  onOpen?: (docNumber: string) => void;
}) {
  const [visits, setVisits] = useState<CustomerVisit[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    customerHistory(customer.id)
      .then((v) => {
        if (alive.current) setVisits(v);
      })
      .catch((e) => {
        if (alive.current) setError(errorMessage(e, "Could not load the purchases"));
      });
    return () => {
      alive.current = false;
    };
  }, [customer.id]);

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="modal-card"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-label={`Purchases by ${customer.name}`}
      >
        <h2 className="modal-title">{customer.name}</h2>
        {customer.phone && (
          <p className="modal-row-meta" style={{ marginTop: -6 }}>
            {formatPhone(customer.phone) || customer.phone}
          </p>
        )}

        <div className="modal-list">
          {visits === null && !error && (
            <p className="modal-row-meta" style={{ padding: "14px 4px" }}>
              Looking…
            </p>
          )}

          {visits?.length === 0 && (
            <p className="modal-row-meta" style={{ padding: "14px 4px" }}>
              Nothing bought under this number yet.
            </p>
          )}

          {/* Each invoice is a door, as it is on the Sales screen: the
              customer at the returns counter with no slip has just been
              found, and the next thing wanted is the slip itself. */}
          {visits?.map((v) => {
            const openable = !!(onOpen && v.doc_number);
            const body = (
              <>
                <span className="modal-row-name">
                  {v.doc_number ?? "—"} · {money(v.total)}
                </span>
                <span className="modal-row-meta">
                  {visitDate(v.created_at)} · {v.item_count}{" "}
                  {v.item_count === 1 ? "item" : "items"}
                  {v.payment_method ? ` · ${v.payment_method}` : ""}
                </span>
                {v.summary && (
                  <span className="modal-row-meta">{v.summary}</span>
                )}
              </>
            );
            return openable ? (
              <button
                key={v.sale_id}
                className="modal-row"
                onClick={() => onOpen!(v.doc_number!)}
                title="Open this invoice"
              >
                {body}
              </button>
            ) : (
              <div key={v.sale_id} className="modal-row" style={{ cursor: "default" }}>
                {body}
              </div>
            );
          })}

          {error && (
            <p className="modal-row-meta" style={{ color: "var(--color-owing)" }}>
              {error}
            </p>
          )}
        </div>

        <div className="modal-actions" style={{ marginTop: 14 }}>
          <button className="btn-line" onClick={onBack}>
            Back
          </button>
          <button className="btn-line" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * The line under a customer's name.
 *
 * A buyer recorded at the counter has no account, and printing "balance R0.00 ·
 * R0.00 available" against their name reads as an account with no credit left —
 * the opposite of the truth. So the money is shown only to those who have an
 * account, and everyone else just gets their number back.
 */
function describe(c: Customer): string {
  const bits: string[] = [];
  if (c.code) bits.push(c.code);
  if (c.phone) bits.push(formatPhone(c.phone) || c.phone);

  const hasAccount = c.credit_limit == null || c.credit_limit > 0 || c.balance !== 0;
  if (hasAccount) {
    bits.push(`balance ${money(c.balance)}`);
    bits.push(c.available != null ? `${money(c.available)} available` : "no limit");
  } else {
    bits.push("cash or card");
  }
  if (c.is_trade) bits.push("trade price");
  return bits.join(" · ");
}

/** "12 Mar 2026" — a date a person reads, not an ISO string. */
function visitDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return fmtDate(d);
}

function ReceiptGlyph() {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M6 3h12v18l-3-2-3 2-3-2-3 2Z" />
      <path d="M9 8h6M9 12h6" />
    </svg>
  );
}
