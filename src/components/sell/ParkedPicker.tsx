import { money } from "../../lib/money";
import { fmtTime } from "../../lib/dates";
import type { CartLine, Customer } from "../../lib/types";

/** A sale set aside to serve the next customer while this one fetches a card. */
export interface ParkedSale {
  id: string;
  at: string;
  lines: CartLine[];
  customer: Customer | null;
  discount: number;
  discountReason: string | null;
}

/** What a parked sale would come to, priced as it was parked. */
export function parkedTotal(p: ParkedSale): number {
  const trade = !!p.customer?.is_trade;
  const gross = p.lines.reduce((sum, l) => {
    const unit = trade && l.product.price_trade != null ? l.product.price_trade : l.product.price_retail;
    return sum + unit * l.qty - (l.discount ?? 0);
  }, 0);
  return Math.max(0, Math.round((gross - p.discount) * 100) / 100);
}

/**
 * Which parked sale.
 *
 * One parked sale resumes at a tap. Two or more used to resume the LAST one
 * parked, silently, and the cashier had to park it again to reach the one
 * they meant. Now each is a row: when it was parked, whose it is, what is
 * in it and what it comes to, so the right basket comes back first time.
 */
export default function ParkedPicker({
  parked,
  onPick,
  onClose,
}: {
  parked: ParkedSale[];
  onPick: (p: ParkedSale) => void;
  onClose: () => void;
}) {
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="modal-card"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-label="Which parked sale?"
      >
        <h2 className="modal-title">Which parked sale?</h2>
        <div className="modal-list">
          {parked.map((p) => {
            const units = p.lines.reduce((n, l) => n + l.qty, 0);
            const names = p.lines.map((l) => l.product.name).join(", ");
            return (
              <button
                key={p.id}
                className="modal-row"
                onClick={() => onPick(p)}
                aria-label={`Resume the sale parked at ${fmtTime(p.at)}`}
              >
                <span className="modal-row-name">
                  {fmtTime(p.at)} · {p.customer?.name ?? "Walk-in customer"} · {money(parkedTotal(p))}
                </span>
                <span className="modal-row-meta">
                  {p.lines.length} {p.lines.length === 1 ? "line" : "lines"} · {units}{" "}
                  {units === 1 ? "unit" : "units"} · {names}
                </span>
              </button>
            );
          })}
        </div>
        <button className="btn-line" style={{ marginTop: 14 }} onClick={onClose}>
          Cancel
        </button>
      </div>
    </div>
  );
}
