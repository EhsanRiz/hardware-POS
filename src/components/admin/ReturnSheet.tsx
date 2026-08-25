import { useEffect, useMemo, useState } from "react";
import { saleItems } from "../../lib/api";
import {
  returnSale,
  saleReturns,
  type SaleReturn,
} from "../../lib/adminApi";
import { errorMessage } from "../../lib/errors";
import { money } from "../../lib/format";
import { printReceipt } from "../../lib/print";
import { buildCreditNoteText } from "../../lib/receipt";
import type { SaleRow } from "../../lib/sales";
import type { SaleItem } from "../../lib/types";

/**
 * Return of sold goods, against the invoice the customer brought back.
 *
 * Per line: how many come back — the stepper is capped at what remains
 * un-returned, so nothing can come back twice — and whether each goes back
 * to the shelf or is damaged. The refund method is decided by how the sale
 * was paid, never chosen off a menu: cash-family sales pay cash out of the
 * OPEN till session, account sales credit the account. The server enforces
 * all of it; this sheet's job is to make the rules visible before the
 * refusal, not instead of it.
 *
 * The estimated refund shown per line mirrors the server's arithmetic —
 * what was PAID for the line, discounts included, with the last unit of a
 * line refunding exactly what remains un-refunded — so the number on the
 * button is the number on the credit note.
 */

type LineState = { qty: number; restock: boolean };

export default function ReturnSheet({
  pin,
  sale,
  onClose,
  onDone,
}: {
  pin: string;
  sale: SaleRow;
  onClose: () => void;
  /** Called after a return went through and its credit note printed. */
  onDone: () => Promise<void> | void;
}) {
  const [items, setItems] = useState<SaleItem[] | null>(null);
  const [past, setPast] = useState<SaleReturn[] | null>(null);
  const [state, setState] = useState<Record<string, LineState>>({});
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const [li, rs] = await Promise.all([
          saleItems(sale.id),
          saleReturns(pin, sale.id),
        ]);
        if (cancelled) return;
        setItems(li);
        setPast(rs);
      } catch (e) {
        if (!cancelled) setError(errorMessage(e, "Could not open this sale for a return"));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [pin, sale.id]);

  /** Quantity and money already returned, per sale line. */
  const returned = useMemo(() => {
    const m = new Map<string, { qty: number; total: number }>();
    for (const r of past ?? []) {
      for (const i of r.items) {
        const cur = m.get(i.sale_item_id) ?? { qty: 0, total: 0 };
        cur.qty += i.qty;
        cur.total += i.line_total;
        m.set(i.sale_item_id, cur);
      }
    }
    return m;
  }, [past]);

  function remaining(li: SaleItem): number {
    return li.qty - (returned.get(li.id)?.qty ?? 0);
  }

  /** The server's refund arithmetic, mirrored so the button tells the truth. */
  function lineRefund(li: SaleItem, qty: number): number {
    if (qty <= 0) return 0;
    const prev = returned.get(li.id) ?? { qty: 0, total: 0 };
    if (qty === li.qty - prev.qty) {
      return Math.round((li.line_total - prev.total) * 100) / 100;
    }
    return Math.round((li.line_total * qty) / li.qty * 100) / 100;
  }

  function step(li: SaleItem, delta: number) {
    setState((s) => {
      const cur = s[li.id] ?? { qty: 0, restock: true };
      const next = Math.min(Math.max(cur.qty + delta, 0), remaining(li));
      return { ...s, [li.id]: { ...cur, qty: next } };
    });
  }

  const chosen = (items ?? []).filter((li) => (state[li.id]?.qty ?? 0) > 0);
  const total = chosen.reduce((t, li) => t + lineRefund(li, state[li.id].qty), 0);
  const isAccount = sale.payment_method === "account";
  const cardNote = !isAccount && sale.payment_method && sale.payment_method !== "cash";

  async function confirm() {
    setBusy(true);
    setError(null);
    try {
      const result = await returnSale(
        pin,
        sale.id,
        chosen.map((li) => ({
          sale_item_id: li.id,
          qty: state[li.id].qty,
          restock: state[li.id].restock,
        })),
        reason
      );
      printReceipt(
        buildCreditNoteText({
          doc_number: result.doc_number,
          created_at: new Date().toISOString(),
          sale_doc_number: sale.doc_number,
          sale_payment_method: sale.payment_method,
          reason: reason.trim(),
          refund_method: result.refund_method,
          total: result.total,
          tax_total: result.tax_total,
          by_name: "",
          items: chosen.map((li) => ({
            name: li.name,
            unit_code: li.unit_code,
            qty: state[li.id].qty,
            line_total: lineRefund(li, state[li.id].qty),
            restock: state[li.id].restock,
          })),
        }),
        `Credit Note ${result.doc_number}`
      );
      await onDone();
    } catch (e) {
      setError(errorMessage(e, "The return was refused"));
      setBusy(false);
    }
  }

  function reprint(r: SaleReturn) {
    printReceipt(
      buildCreditNoteText({
        doc_number: r.doc_number,
        created_at: r.created_at,
        sale_doc_number: sale.doc_number,
        sale_payment_method: sale.payment_method,
        reason: r.reason,
        refund_method: r.refund_method,
        total: r.total,
        tax_total: r.tax_total,
        by_name: r.by_name,
        items: r.items.map((i) => ({
          name: i.name,
          unit_code: "",
          qty: i.qty,
          line_total: i.line_total,
          restock: i.restock,
        })),
      }),
      `Credit Note ${r.doc_number}`
    );
  }

  return (
    <div className="vv-fixed bg-black/40 z-50 flex items-end sm:items-center justify-center p-0 sm:p-6">
      <div className="bg-white w-full sm:max-w-2xl sm:rounded-2xl max-h-[92vh] overflow-auto">
        <header className="px-5 py-4 border-b border-stone-200 flex items-baseline gap-3">
          <h3 className="font-semibold">Return goods</h3>
          <span className="text-sm text-stone-500">
            {sale.doc_number ?? "(no invoice number)"} · {money(sale.total)}
          </span>
          <button className="ml-auto text-stone-500" onClick={onClose}>
            Close
          </button>
        </header>

        <div className="p-5 space-y-4">
          {error && (
            <p
              className="px-3 py-2 bg-amber-100 text-amber-900 text-sm rounded-lg cursor-pointer"
              onClick={() => setError(null)}
            >
              {error}
            </p>
          )}

          {!items || !past ? (
            <p className="text-sm text-stone-500">Opening the sale…</p>
          ) : (
            <>
              <ul className="divide-y divide-stone-100">
                {items.map((li) => {
                  const rem = remaining(li);
                  const st = state[li.id] ?? { qty: 0, restock: true };
                  const prev = returned.get(li.id);
                  return (
                    <li key={li.id} className={`py-3 flex items-center gap-3 flex-wrap ${rem <= 0 ? "opacity-50" : ""}`}>
                      <span className="flex-1 min-w-0">
                        <span className="block text-sm font-medium">{li.name}</span>
                        <span className="block text-xs text-stone-500">
                          sold {li.qty} {li.unit_code}
                          {prev && prev.qty > 0 && (
                            <span className="text-amber-700">
                              {" "}· {prev.qty} already returned
                            </span>
                          )}
                          {rem <= 0 && " · nothing left to return"}
                        </span>
                      </span>

                      <span className="flex items-center border border-stone-300 rounded-lg overflow-hidden">
                        <button
                          className="w-9 h-9 text-lg text-stone-600 disabled:opacity-30"
                          aria-label={`Fewer ${li.name}`}
                          disabled={st.qty <= 0 || busy}
                          onClick={() => step(li, -1)}
                        >
                          –
                        </button>
                        <span className="w-10 text-center tabular-nums text-sm" aria-label={`Returning ${st.qty} ${li.name}`}>
                          {st.qty}
                        </span>
                        <button
                          className="w-9 h-9 text-lg text-stone-600 disabled:opacity-30"
                          aria-label={`More ${li.name}`}
                          disabled={st.qty >= rem || busy}
                          onClick={() => step(li, 1)}
                        >
                          +
                        </button>
                      </span>

                      {/* Where it goes decides whether the shelf count moves;
                          shown only once there is a quantity for it to bind. */}
                      <span className={`flex text-xs border border-stone-300 rounded-lg overflow-hidden ${st.qty === 0 ? "invisible" : ""}`}>
                        <button
                          className={`px-2.5 py-2 ${st.restock ? "bg-stone-800 text-white" : "text-stone-500"}`}
                          onClick={() => setState((s) => ({ ...s, [li.id]: { ...st, restock: true } }))}
                        >
                          Shelf
                        </button>
                        <button
                          className={`px-2.5 py-2 ${!st.restock ? "bg-red-700 text-white" : "text-stone-500"}`}
                          onClick={() => setState((s) => ({ ...s, [li.id]: { ...st, restock: false } }))}
                        >
                          Damaged
                        </button>
                      </span>

                      <span className="w-20 text-right text-sm tabular-nums">
                        {st.qty > 0 ? money(lineRefund(li, st.qty)) : "—"}
                      </span>
                    </li>
                  );
                })}
              </ul>

              <label className="block">
                <span className="text-xs text-stone-500">
                  Why is it coming back? (goes on the credit note)
                </span>
                <input
                  className="mt-1 w-full border border-stone-300 rounded-lg px-3 py-2"
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  aria-label="Return reason"
                />
              </label>

              <div className="flex items-baseline gap-3 pt-2 border-t border-stone-200">
                <span className="text-lg font-semibold">Refund {money(total)}</span>
                <span className="ml-auto text-xs text-stone-500 text-right">
                  {isAccount
                    ? "Credited to the customer's account"
                    : "Cash from the drawer — recorded against the open till session"}
                </span>
              </div>

              {cardNote && (
                <p className="text-xs text-amber-800 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
                  This sale was paid by {sale.payment_method}. The till cannot
                  reverse that payment, so the refund is cash out of the drawer
                  — the credit note says so.
                </p>
              )}

              <div className="flex gap-2">
                <button
                  className="flex-1 py-2.5 rounded-xl bg-stone-100 text-stone-700"
                  onClick={onClose}
                  disabled={busy}
                >
                  Cancel
                </button>
                <button
                  className="flex-1 py-2.5 rounded-xl bg-stone-800 text-white disabled:opacity-40"
                  disabled={busy || chosen.length === 0 || !reason.trim()}
                  onClick={() => void confirm()}
                >
                  {busy
                    ? "Refunding…"
                    : `Refund ${money(total)} & print credit note`}
                </button>
              </div>

              {past.length > 0 && (
                <div className="pt-3 border-t border-stone-100">
                  <p className="text-xs uppercase tracking-wide text-stone-400 mb-1">
                    Already returned on this sale
                  </p>
                  {past.map((r) => (
                    <p key={r.id} className="text-sm text-stone-600 flex gap-2 items-baseline">
                      <span>{r.doc_number}</span>
                      <span className="text-stone-400">· {money(r.total)} · {r.by_name}</span>
                      <button
                        className="ml-auto text-xs text-stone-500 underline underline-offset-2"
                        onClick={() => reprint(r)}
                      >
                        Reprint
                      </button>
                    </p>
                  ))}
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
