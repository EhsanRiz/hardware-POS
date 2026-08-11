import { useState } from "react";
import { money } from "../../lib/money";
import type { Customer } from "../../lib/types";

/**
 * Putting a sale on a contractor's account.
 *
 * The available credit is shown on every row, before the choice is made, because
 * an over-limit sale is refused server-side and finding that out after the
 * bakkie is loaded helps nobody.
 */
export default function CustomerPicker({
  customers,
  onPick,
  onClose,
}: {
  customers: Customer[];
  onPick: (c: Customer | null) => void;
  onClose: () => void;
}) {
  const [term, setTerm] = useState("");
  const q = term.trim().toLowerCase();
  const shown = customers.filter(
    (c) =>
      c.name.toLowerCase().includes(q) ||
      (c.code ?? "").toLowerCase().includes(q)
  );

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="modal-card"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-label="Choose a customer"
      >
        <h2 className="modal-title">Charge to an account</h2>

        <input
          autoFocus
          value={term}
          onChange={(e) => setTerm(e.target.value)}
          placeholder="Search accounts…"
          className="modal-input"
        />

        <div className="modal-list">
          <button className="modal-row" onClick={() => onPick(null)}>
            <span className="modal-row-name">Walk-in customer</span>
            <span className="modal-row-meta">Retail price · cash or card</span>
          </button>

          {shown.map((c) => (
            <button key={c.id} className="modal-row" onClick={() => onPick(c)}>
              <span className="modal-row-name">{c.name}</span>
              <span className="modal-row-meta">
                {c.code ? `${c.code} · ` : ""}
                balance {money(c.balance)}
                {c.available != null
                  ? ` · ${money(c.available)} available`
                  : " · no limit"}
                {c.is_trade ? " · trade price" : ""}
              </span>
            </button>
          ))}

          {shown.length === 0 && q !== "" && (
            <p className="modal-row-meta" style={{ padding: "14px 4px" }}>
              No account matches “{term}”.
            </p>
          )}
        </div>

        <button className="btn-line" style={{ marginTop: 14 }} onClick={onClose}>
          Cancel
        </button>
      </div>
    </div>
  );
}
