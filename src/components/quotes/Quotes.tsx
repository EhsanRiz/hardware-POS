import { useCallback, useEffect, useMemo, useState } from "react";
import {
  closeQuote,
  listQuotes,
  quoteItems,
  type QuoteLine,
  type QuoteSummary,
} from "../../lib/api";
import { errorMessage } from "../../lib/errors";
import { money } from "../../lib/money";
import { useOnline } from "../../lib/offline";
import type { User } from "../../lib/types";

/**
 * Quotes — the sales that have not happened yet.
 *
 * The list answers the counter question ("Mr Mokoena is here about quote
 * QUO-000031") and the Friday question ("what did we quote this week that
 * never came back?"). Recalling a quote loads it back onto the till exactly
 * as it was priced — and if today's price has drifted from the promise, the
 * drift is shown BEFORE the sale is rung, because honouring a two-day-old
 * quote is the shop's decision to make and it can only make it seeing the
 * difference.
 */
export default function Quotes({
  user,
  onRecall,
}: {
  user: User;
  /** Load a quote's lines onto the Sell screen. */
  onRecall: (quote: QuoteSummary, lines: QuoteLine[]) => void;
}) {
  const online = useOnline();
  const [quotes, setQuotes] = useState<QuoteSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [term, setTerm] = useState("");
  const [busy, setBusy] = useState(false);
  const [cancelling, setCancelling] = useState<QuoteSummary | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      setQuotes(await listQuotes());
    } catch (e) {
      setError(errorMessage(e, "Could not load the quotes"));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const shown = useMemo(() => {
    const q = term.trim().toLowerCase();
    if (!q || !quotes) return quotes ?? [];
    return quotes.filter(
      (x) =>
        (x.doc_number ?? "").toLowerCase().includes(q) ||
        (x.customer_name ?? "").toLowerCase().includes(q) ||
        (x.note ?? "").toLowerCase().includes(q)
    );
  }, [quotes, term]);

  async function recall(q: QuoteSummary) {
    setBusy(true);
    setError(null);
    try {
      onRecall(q, await quoteItems(q.id));
    } catch (e) {
      setError(errorMessage(e, "Could not open that quote"));
      setBusy(false);
    }
  }

  async function cancel(q: QuoteSummary) {
    setBusy(true);
    setError(null);
    try {
      await closeQuote(user.id, q.id, "cancelled");
      setCancelling(null);
      await load();
    } catch (e) {
      setError(errorMessage(e, "Could not cancel that quote"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="acc">
      <div className="acc-tools">
        <input
          value={term}
          onChange={(e) => setTerm(e.target.value)}
          placeholder="Find a quote by number, customer or note…"
          className="modal-input"
          style={{ marginBottom: 0, maxWidth: 420 }}
        />
        <button className="btn-line" onClick={() => void load()} disabled={!online}>
          Refresh
        </button>
      </div>

      {!online && (
        <p className="acc-note">
          Quotes need a connection — to give one at the counter, print from the
          Sell screen.
        </p>
      )}
      {error && <p className="acc-note is-bad">{error}</p>}

      <div className="acc-scroll">
        <table className="acc-table">
          <thead>
            <tr>
              <th>Quote</th>
              <th>For</th>
              <th className="num">Total</th>
              <th>Valid until</th>
              <th className="num" />
            </tr>
          </thead>
          <tbody>
            {quotes === null && (
              <tr><td colSpan={5} className="acc-empty">Looking…</td></tr>
            )}
            {quotes !== null && shown.length === 0 && (
              <tr>
                <td colSpan={5} className="acc-empty">
                  {term
                    ? `No open quote matches “${term}”.`
                    : "No open quotes. Build a sale on the Sell screen and choose Save as quote."}
                </td>
              </tr>
            )}
            {shown.map((q) => (
              <tr key={q.id}>
                <td>
                  <span className="acc-name">{q.doc_number}</span>
                  <span className="acc-sub">
                    {quoteDate(q.created_at)} · {q.item_count}{" "}
                    {q.item_count === 1 ? "line" : "lines"} · by {q.cashier_name}
                  </span>
                </td>
                <td>
                  <span className="acc-name">{q.customer_name ?? "Walk-in"}</span>
                  {q.note && <span className="acc-sub">{q.note}</span>}
                </td>
                <td className="num">{money(q.total)}</td>
                <td className={q.expired ? "is-bad" : "quiet"}>
                  {quoteDate(q.valid_until)}
                  {q.expired ? " · expired" : ""}
                </td>
                <td className="num">
                  <span className="quote-actions">
                    <button
                      className="btn-line"
                      onClick={() => void recall(q)}
                      disabled={busy || !online}
                    >
                      Open on the till
                    </button>
                    <button
                      className="btn-line quiet"
                      onClick={() => setCancelling(q)}
                      disabled={busy || !online}
                    >
                      Cancel
                    </button>
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {cancelling && (
        <div className="modal-backdrop" onClick={() => setCancelling(null)}>
          <div
            className="modal-card"
            onClick={(e) => e.stopPropagation()}
            role="dialog"
            aria-label="Cancel this quote"
          >
            <h2 className="modal-title">Cancel {cancelling.doc_number}?</h2>
            <p className="acc-note">
              {cancelling.customer_name ?? "Walk-in"} · {money(cancelling.total)}.
              The quote stays on record as cancelled; nothing is deleted.
            </p>
            <div className="modal-actions" style={{ marginTop: 16 }}>
              <button className="btn-line" onClick={() => setCancelling(null)}>
                Keep it open
              </button>
              <button
                className="btn-fill"
                onClick={() => void cancel(cancelling)}
                disabled={busy}
              >
                {busy ? "Cancelling…" : "Cancel the quote"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/** Lines the till cannot ring, and price drift, summarised for a banner. */
export function recallWarnings(lines: QuoteLine[]): string | null {
  const gone = lines.filter((l) => !l.still_sold);
  const drifted = lines.filter(
    (l) => l.still_sold && l.price_now != null && l.price_now !== l.unit_price
  );
  const parts: string[] = [];
  if (gone.length) {
    parts.push(
      `${gone.length} line${gone.length === 1 ? " is" : "s are"} no longer sold and ${
        gone.length === 1 ? "was" : "were"
      } left off`
    );
  }
  if (drifted.length) {
    parts.push(
      `prices have changed since the quote (${drifted
        .slice(0, 3)
        .map((l) => `${l.name}: ${money(l.unit_price)} → ${money(l.price_now!)}`)
        .join(", ")}${drifted.length > 3 ? ", …" : ""})`
    );
  }
  return parts.length ? parts.join("; ") + "." : null;
}

/** How many of a quote's lines can actually be rung today. */
export function sellableLines(lines: QuoteLine[]): QuoteLine[] {
  return lines.filter((l) => l.still_sold && l.product_id);
}

function quoteDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleDateString("en-ZA", {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}
