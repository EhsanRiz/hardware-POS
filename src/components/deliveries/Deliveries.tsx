import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  deliveryItems,
  listDeliveries,
  markDelivered,
  type DeliveryLine,
  type DeliveryRow,
  DELIVERIES_CACHE_KEY,
} from "../../lib/api";
import { errorMessage } from "../../lib/errors";
import { fmtDate, fmtDateTime } from "../../lib/dates";
import { cacheGet, cacheSet } from "../../lib/localCache";
import { money } from "../../lib/money";
import { isNetworkError, useOnline } from "../../lib/offline";
import {
  actionCount, enqueueAction, onQueueChange, pendingDeliveryIds, queuedDeliveries,
} from "../../lib/queue";
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
const LIST_KEY = DELIVERIES_CACHE_KEY;

export default function Deliveries({ user }: { user: User }) {
  const online = useOnline();
  // The last list the line gave, so the driver's phone still shows this
  // morning's load at a site with no signal — where the page gets signed.
  const [rows, setRows] = useState<DeliveryRow[] | null>(() =>
    cacheGet<DeliveryRow[] | null>(LIST_KEY, null)
  );
  const [error, setError] = useState<string | null>(null);
  const [term, setTerm] = useState("");
  const [busy, setBusy] = useState(false);
  // Marked off on this device and not yet told to the server. Read from the
  // queue itself, so a reload shows the same "will sync" the tap did.
  const [pending, setPending] = useState<Set<string>>(pendingDeliveryIds);
  // Arranged on this device with the line down, not yet filed: on the list
  // as rows of their own, so the driver sees the load before it syncs.
  const [queued, setQueued] = useState(queuedDeliveries);

  const [viewing, setViewing] = useState<DeliveryRow | null>(null);
  const [viewLines, setViewLines] = useState<DeliveryLine[] | null>(null);
  const [sheet, setSheet] = useState<Sheet | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const fresh = await listDeliveries();
      setRows(fresh);
      cacheSet(LIST_KEY, fresh);
    } catch (e) {
      // With the line down the cached list stands; only a real refusal is an error.
      if (!isNetworkError(e)) setError(errorMessage(e, "Could not load the deliveries"));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // When the queue drains (the line came back and sync sent the mark-offs),
  // the server's list is the truth again.
  const actionsBefore = useRef(actionCount());
  useEffect(
    () =>
      onQueueChange(() => {
        setPending(pendingDeliveryIds());
        setQueued(queuedDeliveries());
        const now = actionCount();
        if (actionsBefore.current > 0 && now === 0) void load();
        actionsBefore.current = now;
      }),
    [load]
  );

  /** A queued delivery, shaped as a row; its id says it is not the server's. */
  const queuedRows: DeliveryRow[] = queued.map((a) => ({
    id: a.id, doc_number: a.docNumber ?? "DEL-—", sale_id: a.saleId ?? "",
    sale_number: a.saleNumber, customer_name: a.customerName, address: a.address,
    deliver_on: a.deliverOn, deliver_at: a.deliverAt, charge: a.charge, note: a.note,
    status: "pending", created_at: a.at, cashier_name: user.name,
    delivered_at: null, delivered_by_name: null, item_count: 0,
  }));
  const isQueued = (d: DeliveryRow) => d.id.startsWith("cd-");

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
    const all = [...queuedRows, ...(rows ?? [])];
    if (!q) return all;
    return all.filter(
      (d) =>
        (d.doc_number ?? "").toLowerCase().includes(q) ||
        d.customer_name.toLowerCase().includes(q) ||
        d.address.toLowerCase().includes(q) ||
        (d.sale_number ?? "").toLowerCase().includes(q)
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, term, queued]);

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

  // Marked off on the phone: sent now if the line is up, queued if it is
  // not — or if it drops mid-tap, which at a site is the usual way. The row
  // shows delivered either way, with "will sync" until the server has it.
  function markOffLocally(d: DeliveryRow) {
    const at = new Date().toISOString();
    enqueueAction({ id: `md-${d.id}`, kind: "mark_delivered", deliveryId: d.id, userId: user.id, at });
    const local: DeliveryRow = {
      ...d, status: "delivered", delivered_at: at, delivered_by_name: user.name,
    };
    setRows((prev) => {
      const next = (prev ?? []).map((r) => (r.id === d.id ? local : r));
      cacheSet(LIST_KEY, next);
      return next;
    });
  }

  async function markOff(d: DeliveryRow) {
    setBusy(true);
    setError(null);
    try {
      if (!online) {
        markOffLocally(d);
      } else {
        await markDelivered(user.id, d.id);
        await load();
      }
      setViewing(null);
    } catch (e) {
      if (isNetworkError(e)) {
        markOffLocally(d);
        setViewing(null);
      } else {
        setError(errorMessage(e, "Could not mark that delivered"));
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="acc">
      <div className="acc-bar">
        <input
          className="modal-input acc-search"
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
          {rows === null && queuedRows.length === 0 && (
            <tr><td colSpan={5} className="acc-empty">Looking…</td></tr>
          )}
          {(rows !== null || queuedRows.length > 0) && shown.length === 0 && (
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
              // A queued one has no note on the server to open yet.
              onClick={() => !isQueued(d) && setViewing(d)}
            >
              <td>
                <span className="acc-name">{d.doc_number}</span>
                <span className="acc-sub">
                  {d.item_count} {d.item_count === 1 ? "line" : "lines"}
                  {d.charge > 0 ? ` · ${money(d.charge)} carriage` : ""}
                  {d.cashier_name ? ` · by ${d.cashier_name}` : ""}
                </span>
              </td>
              <td data-label="To">
                <span className="acc-name">{d.customer_name}</span>
                <span className="acc-sub">{d.address}</span>
              </td>
              <td data-label="When">
                {fmtDate(d.deliver_on)}
                {d.deliver_at ? <span className="acc-sub">{d.deliver_at}</span> : null}
              </td>
              <td data-label="Invoice">{d.sale_number ?? ""}</td>
              <td className="num">
                {d.status === "delivered" ? (
                  <span className="acc-sub">
                    Delivered{d.delivered_by_name ? ` · ${d.delivered_by_name}` : ""}
                    {pending.has(d.id) ? " · will sync" : ""}
                    {d.delivered_at ? <br /> : null}
                    {d.delivered_at ? fmtDateTime(d.delivered_at) : ""}
                  </span>
                ) : isQueued(d) ? (
                  <span className="acc-sub">Arranged · will sync</span>
                ) : (
                  <button
                    className="btn-line"
                    disabled={busy}
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
                  disabled={busy}
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
