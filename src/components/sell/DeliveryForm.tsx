import { useState } from "react";
import { fmtDate } from "../../lib/dates";

/**
 * Where the load is going, asked at the counter.
 *
 * Opened from the Sell screen before the sale is tendered, because the charge
 * has to be in the cart before the money is taken — it is a line on the
 * invoice, banked and taxed like everything else, not a note on a scrap of
 * paper. The address is asked for once, here, and never typed again.
 */
export interface DeliveryDetails {
  customerName: string;
  address: string;
  deliverOn: string;
  deliverAt: string;
  charge: number;
  note: string;
}

/** Today, as the date input wants it. */
export function today(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
    d.getDate()
  ).padStart(2, "0")}`;
}

export default function DeliveryForm({
  initial,
  suggestedName,
  onCancel,
  onConfirm,
}: {
  initial?: DeliveryDetails | null;
  /** The customer already on the sale, if there is one. */
  suggestedName?: string | null;
  onCancel: () => void;
  onConfirm: (d: DeliveryDetails) => void;
}) {
  const [customerName, setName] = useState(initial?.customerName ?? suggestedName ?? "");
  const [address, setAddress] = useState(initial?.address ?? "");
  const [deliverOn, setOn] = useState(initial?.deliverOn ?? today());
  const [deliverAt, setAt] = useState(initial?.deliverAt ?? "");
  const [charge, setCharge] = useState(initial ? String(initial.charge) : "");
  const [note, setNote] = useState(initial?.note ?? "");

  const amount = Number(charge.replace(",", "."));
  const ready =
    customerName.trim() !== "" && address.trim() !== "" && deliverOn !== "" &&
    (charge.trim() === "" || (Number.isFinite(amount) && amount >= 0));

  return (
    <div className="modal-backdrop" onClick={onCancel}>
      <div
        className="modal-card"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label="Deliver this sale"
      >
        <h2 className="modal-title">Deliver this sale</h2>
        <p className="acc-note">
          The charge goes on the invoice as its own line. A delivery note is
          written when the sale goes through.
        </p>

        <label className="block" style={{ marginTop: 12 }}>
          <span className="text-sm text-stone-600">Deliver to</span>
          <input
            className="modal-input"
            value={customerName}
            onChange={(e) => setName(e.target.value)}
            placeholder="Name or company"
            autoFocus
          />
        </label>

        <label className="block" style={{ marginTop: 12 }}>
          <span className="text-sm text-stone-600">Address</span>
          <textarea
            className="modal-input"
            value={address}
            onChange={(e) => setAddress(e.target.value)}
            rows={3}
            placeholder="Street, suburb, town"
          />
        </label>

        <div className="modal-grid">
          <label className="block">
            <span className="text-sm text-stone-600">Date</span>
            <input
              className="modal-input"
              type="date"
              value={deliverOn}
              onChange={(e) => setOn(e.target.value)}
            />
          </label>
          <label className="block">
            <span className="text-sm text-stone-600">Time</span>
            {/* Free text, because "after 14:00" and "Tue morning" are what a
                shop actually promises and neither fits a clock. */}
            <input
              className="modal-input"
              value={deliverAt}
              onChange={(e) => setAt(e.target.value)}
              placeholder="after 14:00"
            />
          </label>
        </div>

        <div className="modal-grid">
          <label className="block">
            <span className="text-sm text-stone-600">Delivery charge</span>
            <input
              className="modal-input"
              inputMode="decimal"
              value={charge}
              onChange={(e) => setCharge(e.target.value)}
              placeholder="0.00"
            />
          </label>
          <label className="block">
            <span className="text-sm text-stone-600">Note</span>
            <input
              className="modal-input"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="Gate code, who to ask for"
            />
          </label>
        </div>

        <p className="acc-note">
          {deliverOn ? `Going out ${fmtDate(deliverOn)}` : "Pick a date"}
          {deliverAt ? `, ${deliverAt}` : ""}
        </p>

        <div className="modal-actions">
          <button className="btn-line" onClick={onCancel}>
            Cancel
          </button>
          <button
            className="btn-fill"
            disabled={!ready}
            onClick={() =>
              onConfirm({
                customerName: customerName.trim(),
                address: address.trim(),
                deliverOn,
                deliverAt: deliverAt.trim(),
                charge: charge.trim() === "" ? 0 : Math.round(amount * 100) / 100,
                note: note.trim(),
              })
            }
          >
            Add to the sale
          </button>
        </div>
      </div>
    </div>
  );
}
