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
import { printReceipt } from "../../lib/print";
import { buildQuoteText, stripMarkup } from "../../lib/receipt";
import { shopSettings } from "../../lib/settings";
import type { User } from "../../lib/types";
import { fmtDate } from "../../lib/dates";

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

  // A row is a door: the quote's lines, without loading it onto the till.
  const [viewing, setViewing] = useState<QuoteSummary | null>(null);
  const [viewLines, setViewLines] = useState<QuoteLine[] | null>(null);
  useEffect(() => {
    if (!viewing) return;
    let cancelled = false;
    setViewLines(null);
    quoteItems(viewing.id)
      .then((l) => !cancelled && setViewLines(l))
      .catch((e) => !cancelled && setError(errorMessage(e, "Could not open that quote")));
    return () => {
      cancelled = true;
    };
  }, [viewing]);

  /** The saved quote, laid out exactly as it was when first printed. */
  function quoteText(q: QuoteSummary, lines: QuoteLine[]): string {
    return buildQuoteText(
      lines.map((l) => ({
        name: l.name,
        unit_code: l.unit_code,
        qty: l.qty,
        unit: l.unit_price,
      })),
      {
        subtotal: q.total,
        discount: 0,
        total: q.total,
        trade: false,
        docNumber: q.doc_number,
        validUntil: q.valid_until,
        customerName: q.customer_name,
        createdAt: q.created_at,
      }
    );
  }

  /**
   * One tap to email it. The device's own mail app opens with the quote in
   * the body and the shop's address to reply to — no mail server to run, no
   * address book to keep, and it works from the phone in the yard as well as
   * the desk.
   */
  function mailtoHref(q: QuoteSummary, lines: QuoteLine[]): string {
    const s = shopSettings();
    const subject = `Quote ${q.doc_number ?? ""} from ${s.shop_name}`.trim();
    const body =
      stripMarkup(quoteText(q, lines)) +
      (s.email ? `\n\nReplies: ${s.email}` : "");
    return `mailto:?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
  }

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
              <tr key={q.id} className="acc-row" onClick={() => setViewing(q)}>
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
                      onClick={(e) => { e.stopPropagation(); void recall(q); }}
                      disabled={busy || !online}
                    >
                      Open on the till
                    </button>
                    <button
                      className="btn-line quiet"
                      onClick={(e) => { e.stopPropagation(); setCancelling(q); }}
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

      {viewing && (
        <div
          className="vv-fixed bg-black/50 flex items-center justify-center p-4 z-50"
          role="dialog"
          aria-modal="true"
          aria-label={`Quote ${viewing.doc_number ?? ""}`.trim()}
          onClick={() => setViewing(null)}
        >
          <div
            className="bg-white rounded-2xl w-full max-w-lg max-h-[90vh] flex flex-col"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="p-4 border-b border-stone-200 flex items-start gap-3">
              <div className="flex-1 min-w-0">
                <h2 className="text-lg font-semibold">{viewing.doc_number}</h2>
                <p className="text-sm text-stone-500">
                  {quoteDate(viewing.created_at)} · {viewing.customer_name ?? "Walk-in"} · by {viewing.cashier_name}
                  {" · "}
                  <span className={viewing.expired ? "is-bad" : ""}>
                    valid until {quoteDate(viewing.valid_until)}{viewing.expired ? " (expired)" : ""}
                  </span>
                </p>
                {viewing.note && <p className="text-sm text-stone-600 mt-1">{viewing.note}</p>}
              </div>
              <button
                onClick={() => setViewing(null)}
                className="text-stone-400 text-2xl leading-none"
                aria-label="Close quote"
              >
                ×
              </button>
            </div>
            <div className="p-4 overflow-y-auto flex-1">
              {!viewLines ? (
                <p className="text-sm text-stone-500">Loading…</p>
              ) : (
                <ul className="divide-y divide-stone-100">
                  {viewLines.map((l, n) => (
                    <li key={n} className="py-2 px-1 flex items-baseline gap-3 text-sm even:bg-stone-50/70">
                      <span className="flex-1 min-w-0">
                        <span className="block">{l.name}</span>
                        <span className="block text-xs text-stone-500">
                          {l.qty} {l.unit_code} × {money(l.unit_price)}
                          {!l.still_sold && <span className="is-bad"> · no longer sold</span>}
                        </span>
                      </span>
                      <span className="tabular-nums whitespace-nowrap">{money(l.line_total)}</span>
                    </li>
                  ))}
                </ul>
              )}
              <div className="flex justify-between items-baseline border-t-2 border-stone-800 pt-2 mt-2">
                <span className="text-sm text-stone-600">Quoted</span>
                <span className="text-lg tabular-nums">{money(viewing.total)}</span>
              </div>
            </div>
            <div className="p-4 border-t border-stone-200 flex gap-2 flex-wrap">
              <button
                className="px-4 py-2.5 rounded-xl border border-stone-300 disabled:opacity-40"
                disabled={!viewLines}
                onClick={() => viewLines && printReceipt(quoteText(viewing, viewLines), "Quote")}
              >
                Print
              </button>
              <a
                className={`px-4 py-2.5 rounded-xl border border-stone-300 ${viewLines ? "" : "opacity-40 pointer-events-none"}`}
                href={viewLines ? mailtoHref(viewing, viewLines) : undefined}
                aria-disabled={!viewLines}
              >
                Email
              </a>
              <button
                className="flex-1 py-2.5 rounded-xl bg-colophon text-paper disabled:opacity-40"
                disabled={busy || !online}
                onClick={() => {
                  const q = viewing;
                  setViewing(null);
                  void recall(q);
                }}
              >
                Open on the till
              </button>
            </div>
          </div>
        </div>
      )}

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
  return fmtDate(d);
}
