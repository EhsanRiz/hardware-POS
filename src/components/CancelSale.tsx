import { useState } from "react";
import { voidSale } from "../lib/api";
import { errorMessage } from "../lib/errors";
import { money } from "../lib/money";
import PinPad from "./PinPad";

/** What the cancel needs to know about the sale. */
export interface CancellableSale {
  id: string;
  doc_number: string | null;
  total: number;
  payment_method: string | null;
}

/**
 * "Actually, no." — the customer changes their mind with the cash in the
 * drawer and the slip half printed.
 *
 * The invoice already has a number, so it is voided rather than erased: stock
 * goes back, the money goes back across the counter, and the day close counts
 * it as voided. That takes a manager. When the manager is not in the building,
 * a one-time code read over the phone does — the same code that approves a
 * discount, with the same cap — and the void is recorded against the manager
 * who issued it.
 *
 * A reason is required. "Customer changed mind" takes four seconds and is the
 * difference between a cancelled sale and a mystery at the cash-up.
 */
export default function CancelSale({
  sale,
  cashierId,
  pin,
  onDone,
  onClose,
}: {
  sale: CancellableSale;
  /** Whoever is signed in at the till, recorded when a code is spent. */
  cashierId: string | null;
  /** A manager's PIN already in hand (Manage), or null to ask for one. */
  pin: string | null;
  onDone: () => Promise<void> | void;
  onClose: () => void;
}) {
  const [reason, setReason] = useState("");
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ready = reason.trim().length > 0;
  const card = sale.payment_method && sale.payment_method !== "cash" && sale.payment_method !== "account";

  async function cancelWith(secret: string) {
    setBusy(true);
    setError(null);
    try {
      await voidSale(sale.id, secret, reason.trim(), cashierId);
      await onDone();
    } catch (e) {
      setError(errorMessage(e, "The sale could not be cancelled"));
      setBusy(false);
    }
  }

  return (
    <div className="modal-backdrop" onClick={busy ? undefined : onClose}>
      <div
        className="modal-card"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-label="Cancel this sale"
      >
        <h2 className="modal-title">Cancel {sale.doc_number ?? "this sale"}?</h2>
        <p className="acc-note">
          The invoice is voided, stock goes back on the shelf, and{" "}
          {money(sale.total)} is handed back to the customer.
          {card && " A card or EFT payment must be reversed on the machine as well — this does not do that."}
        </p>

        {!asking ? (
          <>
            <label className="block" style={{ marginTop: 12 }}>
              <span className="text-sm text-stone-600">Why</span>
              <input
                className="modal-input"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder="Customer changed their mind"
                aria-label="Reason for cancelling"
                autoFocus
                maxLength={200}
              />
            </label>
            {error && <p className="acc-note is-bad" role="alert">{error}</p>}
            <div className="modal-actions">
              <button type="button" className="btn-line" onClick={onClose} disabled={busy}>
                Keep the sale
              </button>
              <button
                type="button"
                className="btn-fill"
                disabled={!ready || busy}
                onClick={() => (pin ? void cancelWith(pin) : setAsking(true))}
              >
                {busy ? "Cancelling…" : pin ? "Cancel the sale" : "Continue"}
              </button>
            </div>
          </>
        ) : (
          <>
            {/* The PIN and a phoned code go in the same pad. The cashier was
                read six digits; which kind they are is the server's to tell. */}
            <p className="acc-note" style={{ marginTop: 8 }}>
              A manager's PIN — or, with the manager on the phone, the one-time
              code they issue from Manage → Approvals.
            </p>
            <PinPad onSubmit={(digits) => void cancelWith(digits)} busy={busy} />
            {error && <p className="acc-note is-bad" role="alert">{error}</p>}
            <div className="modal-actions">
              <button type="button" className="btn-line" onClick={() => setAsking(false)} disabled={busy}>
                Back
              </button>
              <button type="button" className="btn-line" onClick={onClose} disabled={busy}>
                Keep the sale
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
