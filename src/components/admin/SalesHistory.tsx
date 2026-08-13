import { useCallback, useEffect, useState } from "react";
import { approveSale, saleItems, salePayments } from "../../lib/api";
import { errorMessage } from "../../lib/errors";
import { money } from "../../lib/format";
import { printReceipt } from "../../lib/print";
import { buildReceiptText } from "../../lib/receipt";
import {
  rangeBounds,
  salesHistory,
  type RangeKey,
  type SaleRow,
  type SalesHistory as History,
} from "../../lib/sales";
import type { Sale } from "../../lib/types";
import ManagerPinModal from "../ManagerPinModal";

const RANGES: { key: RangeKey; label: string }[] = [
  { key: "today", label: "Today" },
  { key: "yesterday", label: "Yesterday" },
  { key: "week", label: "Last 7 days" },
  { key: "custom", label: "Choose dates" },
];

const TENDER_LABEL: Record<string, string> = {
  cash: "Cash",
  card: "Card",
  eft: "EFT",
  zapper: "Zapper",
  account: "On account",
  mixed: "Mixed",
};

/**
 * What was sold, and when.
 *
 * The shop could ring sales up and never see one again. That is worse than a
 * missing feature: a cashier who cannot find the sale they just took has no way
 * to tell "it went through" from "it was lost", and will ring it up a second
 * time to be safe.
 *
 * So the four questions a counter actually asks are four buttons — today,
 * yesterday, the last seven days, and any two dates — and each row reprints,
 * because "can I have another copy of that slip" is the reason most people go
 * looking for an old sale in the first place.
 */
export default function SalesHistory({ pin }: { pin: string }) {
  const [range, setRange] = useState<RangeKey>("today");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [data, setData] = useState<History | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [printing, setPrinting] = useState<string | null>(null);
  // The sale a manager is being asked to release, if any.
  const [releasing, setReleasing] = useState<SaleRow | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const b = rangeBounds(range, from, to);
      setData(await salesHistory(pin, b.from, b.to));
      setError(null);
    } catch (e) {
      setError(errorMessage(e, "Could not load the sales"));
    } finally {
      setLoading(false);
    }
  }, [pin, range, from, to]);

  useEffect(() => {
    // A half-typed custom range would query nonsense on every keystroke.
    if (range === "custom" && !(from && to)) {
      setLoading(false);
      return;
    }
    void load();
  }, [load, range, from, to]);

  async function reprint(s: SaleRow) {
    setPrinting(s.id);
    setError(null);
    try {
      const [items, payments] = await Promise.all([
        saleItems(s.id),
        salePayments(s.id),
      ]);
      // The stored sale is what prints. Rebuilding the figures here would let a
      // later price change rewrite an old invoice, which is the one thing a tax
      // invoice must never do.
      printReceipt(
        buildReceiptText(
          s as unknown as Sale,
          // Including what came off each line. These were being dropped here,
          // so a slip printed a second time showed full price on a line that
          // had been marked down and a total that did not follow from it.
          items.map((i) => ({
            name: i.name,
            unit_code: i.unit_code,
            qty: i.qty,
            unit_price: i.unit_price,
            line_total: i.line_total,
            discount_amount: i.discount_amount,
            discount_percent: i.discount_percent,
            discount_reason: i.discount_reason,
          })),
          s.customer_name ? { name: s.customer_name, balance: 0 } : null,
          payments
        ),
        `Tax Invoice ${s.doc_number ?? ""}`.trim()
      );
    } catch (e) {
      setError(errorMessage(e, "Could not reprint that slip"));
    } finally {
      setPrinting(null);
    }
  }

  const t = data?.totals;

  return (
    <div className="flex-1 overflow-auto p-4">
      <div className="max-w-4xl space-y-4">
        <div className="flex flex-wrap items-center gap-2">
          {RANGES.map((r) => (
            <button
              key={r.key}
              onClick={() => setRange(r.key)}
              className={`px-3 py-1.5 rounded-full text-sm border ${
                range === r.key
                  ? "bg-stone-800 text-white border-stone-800"
                  : "bg-white text-stone-600 border-stone-300"
              }`}
            >
              {r.label}
            </button>
          ))}

          {range === "custom" && (
            <span className="flex items-center gap-2 text-sm">
              <input
                type="date"
                className="border border-stone-300 rounded-lg px-2 py-1"
                value={from}
                max={to || undefined}
                onChange={(e) => setFrom(e.target.value)}
                aria-label="From date"
              />
              <span className="text-stone-500">to</span>
              <input
                type="date"
                className="border border-stone-300 rounded-lg px-2 py-1"
                value={to}
                min={from || undefined}
                onChange={(e) => setTo(e.target.value)}
                aria-label="To date"
              />
            </span>
          )}
        </div>

        {error && (
          <p
            onClick={() => setError(null)}
            className="px-3 py-2 bg-amber-100 text-amber-900 text-sm rounded-lg cursor-pointer"
          >
            {error}
          </p>
        )}

        {t && (
          <div className="bg-white rounded-xl border border-stone-200 p-5">
            <div className="flex flex-wrap gap-x-8 gap-y-2 items-baseline">
              <span>
                <span className="block text-xs uppercase tracking-wide text-stone-400">
                  Sales
                </span>
                <span className="text-2xl tabular-nums">{t.count}</span>
              </span>
              <span>
                <span className="block text-xs uppercase tracking-wide text-stone-400">
                  Taken
                </span>
                <span className="text-2xl tabular-nums">{money(t.gross)}</span>
              </span>
              <span>
                <span className="block text-xs uppercase tracking-wide text-stone-400">
                  VAT within
                </span>
                <span className="text-lg tabular-nums text-stone-600">{money(t.vat)}</span>
              </span>
              {t.discount > 0 && (
                <span>
                  <span className="block text-xs uppercase tracking-wide text-stone-400">
                    Discounts
                  </span>
                  <span className="text-lg tabular-nums text-stone-600">
                    {money(t.discount)}
                  </span>
                </span>
              )}
              {t.voided > 0 && (
                <span>
                  <span className="block text-xs uppercase tracking-wide text-stone-400">
                    Voided
                  </span>
                  <span className="text-lg tabular-nums text-stone-600">{t.voided}</span>
                </span>
              )}
            </div>

            {Object.keys(t.tenders).length > 0 && (
              <div className="mt-3 pt-3 border-t border-stone-100 flex flex-wrap gap-x-6 gap-y-1 text-sm text-stone-600">
                {Object.entries(t.tenders).map(([m, v]) => (
                  <span key={m}>
                    {TENDER_LABEL[m] ?? m} {money(v)}
                  </span>
                ))}
              </div>
            )}
          </div>
        )}

        {loading ? (
          <p className="text-stone-500 text-sm">Loading…</p>
        ) : range === "custom" && !(from && to) ? (
          <p className="text-stone-500 text-sm">Pick both dates.</p>
        ) : !data?.rows.length ? (
          <p className="text-stone-500 text-sm">
            Nothing sold in that stretch.
          </p>
        ) : (
          <ul className="divide-y divide-stone-200 bg-white rounded-xl border border-stone-200">
            {data.rows.map((s) => (
              <li key={s.id} className="px-4 py-3 flex items-center gap-3 flex-wrap">
                <span className="flex-1 min-w-0">
                  <span className="block">
                    <span className={s.status === "voided" ? "line-through text-stone-400" : ""}>
                      {s.doc_number ?? "(no invoice number)"}
                    </span>
                    {s.status === "voided" && (
                      <span className="ml-2 text-xs text-amber-700">voided</span>
                    )}
                    {s.status === "pending_approval" && (
                      <span className="ml-2 text-xs text-amber-700">awaiting approval</span>
                    )}
                    {/* Who let it through, and whether they were in the room.
                        A code is the manager's decision either way, but it was
                        made down a phone line by somebody who could not see the
                        counter — which is exactly what an owner reading the day
                        back wants to be able to pick out. */}
                    {s.approved_by_name && (
                      <span className="ml-2 text-xs text-stone-500">
                        {s.approved_by_code ? "by code" : "approved"} ·{" "}
                        {s.approved_by_name}
                      </span>
                    )}
                  </span>
                  <span className="block text-sm text-stone-500">
                    {new Date(s.created_at).toLocaleString("en-ZA", {
                      day: "2-digit",
                      month: "short",
                      hour: "2-digit",
                      minute: "2-digit",
                    })}
                    {" · "}
                    {s.cashier_name}
                    {s.customer_name ? ` · ${s.customer_name}` : ""}
                    {" · "}
                    {s.item_count} {s.item_count === 1 ? "line" : "lines"}
                  </span>
                </span>

                <span className="text-sm text-stone-600">
                  {TENDER_LABEL[s.payment_method ?? ""] ?? s.payment_method ?? ""}
                </span>
                <span className="tabular-nums w-24 text-right">{money(s.total)}</span>

                {/* A sale parked for approval had nowhere to go. The RPC to
                    release one has existed since 0004 and nothing ever called
                    it, so "awaiting approval" was a label with no exit — the
                    sale sat there with no invoice number and its stock never
                    came off the shelf. */}
                {s.status === "pending_approval" && (
                  <button
                    className="text-sm text-emerald-700 underline underline-offset-2"
                    onClick={() => setReleasing(s)}
                  >
                    Release
                  </button>
                )}

                <button
                  className="text-sm text-stone-600 underline underline-offset-2 disabled:opacity-40"
                  disabled={printing === s.id}
                  onClick={() => void reprint(s)}
                >
                  {printing === s.id ? "Printing…" : "Reprint"}
                </button>
              </li>
            ))}
          </ul>
        )}

        {releasing && (
          <ManagerPinModal
            title="Release this sale"
            subtitle={`${money(releasing.total)} rung up by ${releasing.cashier_name}`}
            onApprove={async (pin) => {
              // Checked on the server against approve_discount, so the PIN of
              // whoever is standing here decides — not whoever opened Manage.
              await approveSale(releasing.id, pin);
              setReleasing(null);
              await load();
            }}
            onCancel={() => setReleasing(null)}
          />
        )}

        {data && data.rows.length >= 200 && (
          <p className="text-sm text-stone-500">
            Showing the most recent 200. The totals above cover the whole
            stretch, not just these rows.
          </p>
        )}
      </div>
    </div>
  );
}
