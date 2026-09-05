import { useCallback, useEffect, useMemo, useState } from "react";
import {
  deliveryItems,
  listDeliveries,
  markDelivered,
  type DeliveryLine,
  type DeliveryRow,
} from "../../lib/api";
import { errorMessage } from "../../lib/errors";
import { fmtDate, fmtDateTime } from "../../lib/dates";
import { money } from "../../lib/money";
import { useOnline } from "../../lib/offline";
import DocumentSheet from "../DocumentSheet";
import type { Sheet } from "../../lib/sheet";
import type { User } from "../../lib/types";

/**
 * What is going out, and what has gone.
 *
 * Open to everyone with no permission on it, deliberately. The person who
 * needs to know what is on the bakkie this morning is whoever is loading it,
 * and a tab they cannot open is a phone call to somebody who can.
 *
 * Outstanding first, oldest promise at the top: that is the order a driver
 * loads in, and it is the order the server returns.
 */
export default function Deliveries({ user }: { user: User }) {
  const online = useOnline();
  const [rows, setRows] = useState<DeliveryRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [term, setTerm] = useState("");
  const [busy, setBusy] = useState(false);

  const [viewing, setViewing] = useState<DeliveryRow | null>(null);
  const [viewLines, setViewLines] = useState<DeliveryLine[] | null>(null);
  const [sheet, setSheet] = useState<Sheet | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      setRows(await listDeliveries());
    } catch (e) {
      setError(errorMessage(e, "Could not load the deliveries"));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!viewing) return;
    let cancelled = false;
    setViewLines(null);
    deliveryItems(viewing.id)
      .then((l) => !cancelled && setViewLines(l))
      .catch((e) => !cancelled && setError(errorMessage(e, "Could not open that note")));
    return () => {
      cancelled = true;
    };
  }, [viewing]);

  const shown = useMemo(() => {
    const q = term.trim().toLowerCase();
    if (!rows) return [];
    if (!q) return rows;
    return rows.filter(
      (d) =>
        (d.doc_number ?? "").toLowerCase().includes(q) ||
        d.customer_name.toLowerCase().includes(q) ||
        d.address.toLowerCase().includes(q) ||
        (d.sale_number ?? "").toLowerCase().includes(q)
    );
  }, [rows, term]);

  const outstanding = shown.filter((d) => d.status === "pending").length;

  /** The note as the A4 document: goods and quantities, and nothing about money. */
  function asSheet(d: DeliveryRow, lines: DeliveryLine[]): Sheet {
    return {
      kind: "delivery",
      number: d.doc_number,
      date: fmtDate(d.created_at),
      customer: { name: d.customer_name },
      deliverTo: d.address,
      deliverOn: fmtDate(d.deliver_on),
      deliverAt: d.deliver_at,
      invoiceNumber: d.sale_number,
      servedBy: d.cashier_name,
      note: d.note,
      lines: lines.map((l) => ({
        code: l.sku,
        description: l.name,
        qty: l.qty,
        unit: l.unit_code,
        // A delivery note prints no money. These are carried because a Sheet
        // has them; SHEET_PRICED is what decides they are never shown.
        unitPrice: 0,
        lineTotal: 0,
      })),
      subtotal: 0,
      discount: 0,
      vat: 0,
      total: 0,
    };
  }

  async function markOff(d: DeliveryRow) {
    setBusy(true);
    setError(null);
    try {
      await markDelivered(user.id, d.id);
      setViewing(null);
      await load();
    } catch (e) {
      setError(errorMessage(e, "Could not mark that delivered"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="acc">
      <div className="acc-bar">
        <input
          className="acc-search"
          value={term}
          onChange={(e) => setTerm(e.target.value)}
          placeholder="Find a delivery by number, name, address or invoice"
          aria-label="Find a delivery"
        />
        <span className="acc-count">
          {outstanding} still to go
        </span>
      </div>

      {error && <p className="acc-error">{error}</p>}

      <table className="acc-table">
        <thead>
          <tr>
            <th>Note</th>
            <th>To</th>
            <th>When</th>
            <th>Invoice</th>
            <th className="num" />
          </tr>
        </thead>
        <tbody>
          {rows === null && (
            <tr><td colSpan={5} className="acc-empty">Looking…</td></tr>
          )}
          {rows !== null && shown.length === 0 && (
            <tr>
              <td colSpan={5} className="acc-empty">
                {term
                  ? `No delivery matches “${term}”.`
                  : "Nothing to deliver. Choose Deliver on the Sell screen before taking the money."}
              </td>
            </tr>
          )}
          {shown.map((d) => (
            <tr
              key={d.id}
              className={`acc-row${d.status === "delivered" ? " is-quiet" : ""}`}
              onClick={() => setViewing(d)}
            >
              <td>
                <span className="acc-name">{d.doc_number}</span>
                <span className="acc-sub">
                  {d.item_count} {d.item_count === 1 ? "line" : "lines"}
                  {d.charge > 0 ? ` · ${money(d.charge)} carriage` : ""}
                  {d.cashier_name ? ` · by ${d.cashier_name}` : ""}
                </span>
              </td>
              <td>
                <span className="acc-name">{d.customer_name}</span>
                <span className="acc-sub">{d.address}</span>
              </td>
              <td>
                {fmtDate(d.deliver_on)}
                {d.deliver_at ? <span className="acc-sub">{d.deliver_at}</span> : null}
              </td>
              <td>{d.sale_number ?? ""}</td>
              <td className="num">
                {d.status === "delivered" ? (
                  <span className="acc-sub">
                    Delivered{d.delivered_by_name ? ` · ${d.delivered_by_name}` : ""}
                    {d.delivered_at ? <br /> : null}
                    {d.delivered_at ? fmtDateTime(d.delivered_at) : ""}
                  </span>
                ) : (
                  <button
                    className="btn-line"
                    disabled={busy || !online}
                    onClick={(e) => {
                      e.stopPropagation();
                      void markOff(d);
                    }}
                  >
                    Delivered
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {viewing && (
        <div className="modal-backdrop" onClick={() => setViewing(null)}>
          <div
            className="modal-card"
            onClick={(e) => e.stopPropagation()}
            role="dialog"
            aria-modal="true"
            aria-label={`Delivery ${viewing.doc_number}`}
          >
            <h2 className="modal-title">{viewing.doc_number}</h2>
            <p className="acc-note">
              {viewing.customer_name} · {viewing.address}
              <br />
              {fmtDate(viewing.deliver_on)}
              {viewing.deliver_at ? `, ${viewing.deliver_at}` : ""}
              {viewing.sale_number ? ` · ${viewing.sale_number}` : ""}
            </p>
            {viewing.note && <p className="acc-note">{viewing.note}</p>}

            <div className="modal-scroll">
              {!viewLines ? (
                <p className="acc-note">Looking…</p>
              ) : (
                <ul className="modal-list">
                  {viewLines.map((l, n) => (
                    <li key={n} className="modal-row">
                      <span>{l.name}</span>
                      <span className="tabular-nums">
                        {l.qty} {l.unit_code}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            <div className="modal-actions">
              <button
                className="btn-line"
                disabled={!viewLines}
                onClick={() => viewLines && setSheet(asSheet(viewing, viewLines))}
              >
                Delivery note
              </button>
              {viewing.status === "pending" && (
                <button
                  className="btn-fill"
                  disabled={busy || !online}
                  onClick={() => void markOff(viewing)}
                >
                  Mark delivered
                </button>
              )}
              <button className="btn-line" onClick={() => setViewing(null)}>
                Close
              </button>
            </div>
          </div>
        </div>
      )}

      {sheet && <DocumentSheet sheet={sheet} onClose={() => setSheet(null)} />}
    </div>
  );
}
