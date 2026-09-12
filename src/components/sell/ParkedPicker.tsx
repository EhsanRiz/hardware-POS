import { useState } from "react";
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
 * One row of the list, whichever list it came from: the shop's (0086, seen
 * from every till) or this device's own (the line down, or a basket
 * recovered after a refresh).
 */
export interface ParkedEntry {
  id: string;
  at: string;
  /** Which till it sits on and who parked it; null means this till only. */
  where: string | null;
  who: string | null;
  customerName: string | null;
  total: number;
  lineCount: number;
  units: number;
  names: string;
}

/** A device-only parked sale as a row. */
export function localEntry(p: ParkedSale): ParkedEntry {
  return {
    id: p.id, at: p.at, where: null, who: null,
    customerName: p.customer?.name ?? null,
    total: parkedTotal(p),
    lineCount: p.lines.length,
    units: p.lines.reduce((n, l) => n + l.qty, 0),
    names: p.lines.map((l) => l.product.name).join(", "),
  };
}

/**
 * Which parked sale.
 *
 * One parked sale resumes at a tap. Two or more used to resume the LAST one
 * parked, silently, and the cashier had to park it again to reach the one
 * they meant. Now each is a row: when it was parked, where and by whom,
 * whose it is, what is in it and what it comes to, so the right basket
 * comes back first time — on whichever till the customer walked up to.
 */
export default function ParkedPicker({
  parked,
  onPick,
  onDelete,
  onClose,
}: {
  parked: ParkedEntry[];
  onPick: (id: string) => void;
  /** A parked sale nobody is coming back for. */
  onDelete: (id: string) => void;
  onClose: () => void;
}) {
  // The row whose delete is being confirmed, so a stray tap deletes nothing.
  const [confirming, setConfirming] = useState<string | null>(null);
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
            const units = p.units;
            const names = p.names;
            if (confirming === p.id) {
              return (
                <div key={p.id} className="modal-row-pair" role="group" aria-label={`Delete the sale parked at ${fmtTime(p.at)}?`}>
                  <div className="modal-row" style={{ cursor: "default" }}>
                    <span className="modal-row-name">Delete the {fmtTime(p.at)} sale?</span>
                    <span className="modal-row-meta">{names}</span>
                  </div>
                  <div className="modal-actions" style={{ alignItems: "center", padding: "0 4px" }}>
                    <button className="btn-cancel" onClick={() => setConfirming(null)}>Keep it</button>
                    <button className="btn-fill" onClick={() => { setConfirming(null); onDelete(p.id); }}>
                      Delete it
                    </button>
                  </div>
                </div>
              );
            }
            return (
              <div key={p.id} className="modal-row-pair">
                <button
                  className="modal-row"
                  onClick={() => onPick(p.id)}
                  aria-label={`Resume the sale parked at ${fmtTime(p.at)}`}
                >
                  <span className="modal-row-name">
                    {fmtTime(p.at)} · {p.customerName ?? "Walk-in customer"} · {money(p.total)}
                  </span>
                  <span className="modal-row-meta">
                    {p.where ? `${p.where} · ${p.who ?? "—"}` : "this till only"} · {p.lineCount}{" "}
                    {p.lineCount === 1 ? "line" : "lines"} · {units} {units === 1 ? "unit" : "units"} · {names}
                  </span>
                </button>
                <button
                  className="modal-row-go"
                  onClick={() => setConfirming(p.id)}
                  title="Nobody is coming back for this one"
                  aria-label={`Delete the sale parked at ${fmtTime(p.at)}`}
                >
                  ✕
                </button>
              </div>
            );
          })}
        </div>
        <button className="btn-cancel" style={{ marginTop: 14 }} onClick={onClose}>
          Cancel
        </button>
      </div>
    </div>
  );
}
