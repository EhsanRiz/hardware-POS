import { useCallback, useEffect, useMemo, useState } from "react";
import { endOfDay, type EndOfDayReport, type EodCashier } from "../lib/api";
import type { User } from "../lib/types";
import { money } from "../lib/format";
import { buildEndOfDaySlip } from "../lib/receipt";
import { printReceipt } from "../lib/print";

type DayKey = "today" | "yesterday";

function rangeFor(key: DayKey): { from: Date; to: Date; label: string } {
  const from = new Date();
  from.setHours(0, 0, 0, 0);
  if (key === "yesterday") from.setDate(from.getDate() - 1);
  const to = new Date(from);
  to.setDate(to.getDate() + 1);
  return { from, to, label: from.toLocaleDateString() };
}

function Row({
  label,
  value,
  strong,
}: {
  label: string;
  value: string;
  strong?: boolean;
}) {
  return (
    <div
      className={`flex justify-between ${
        strong ? "text-lg font-bold text-stone-900" : "text-stone-600"
      }`}
    >
      <span>{label}</span>
      <span>{value}</span>
    </div>
  );
}

export default function EndOfDay({
  managerPin,
  actor,
}: {
  managerPin: string;
  actor: User;
}) {
  const [day, setDay] = useState<DayKey>("today");
  const [data, setData] = useState<EndOfDayReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const { from, to, label } = useMemo(() => rangeFor(day), [day]);

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    endOfDay(managerPin, from, to)
      .then(setData)
      .catch((e) => setError(e instanceof Error ? e.message : "Failed to load"))
      .finally(() => setLoading(false));
  }, [managerPin, from, to]);
  useEffect(load, [load]);

  const printStaff = (c: EodCashier) => {
    printReceipt(
      buildEndOfDaySlip({
        dateLabel: label,
        cashier: c.name,
        salesCount: c.sales,
        cash: c.cash,
        card: c.card,
        other: c.other,
        tips: c.tips,
        discount: c.discount,
        total: c.net,
        printedBy: actor.name,
        accountRepaidCash: c.repaid_cash,
        accountRepaidCard: c.repaid_card,
      }),
      "End of Day"
    );
  };

  const printAll = () => {
    if (!data) return;
    printReceipt(
      buildEndOfDaySlip({
        dateLabel: label,
        cashier: null,
        salesCount: data.sales_count,
        cash: data.cash,
        card: data.card,
        other: data.other,
        tips: data.tips,
        discount: data.discount,
        total: data.net,
        printedBy: actor.name,
        accountRepaidCash: data.account_repaid_cash,
        accountRepaidCard: data.account_repaid_card,
        accountOwed: data.account,
      }),
      "End of Day"
    );
  };

  return (
    <div className="p-4">
      <div className="max-w-2xl mx-auto space-y-4">
        <div className="flex gap-2">
          {(["today", "yesterday"] as DayKey[]).map((k) => (
            <button
              key={k}
              onClick={() => setDay(k)}
              className={`h-10 px-4 rounded-full font-medium transition-colors capitalize ${
                day === k
                  ? "bg-brand text-white"
                  : "bg-white border border-stone-200 text-stone-600"
              }`}
            >
              {k}
            </button>
          ))}
        </div>

        {loading && <p className="text-stone-400">Loading…</p>}
        {error && <p className="text-red-600">{error}</p>}

        {data && !loading && (
          <div className="animate-fade-in space-y-4">
            {/* Whole-day summary */}
            <div className="bg-white border border-stone-200 rounded-xl p-5">
              <div className="flex items-center justify-between mb-3">
                <h3 className="font-semibold text-stone-800">{label} · all staff</h3>
                <button
                  onClick={printAll}
                  className="h-9 px-4 rounded-lg bg-brand text-white text-sm font-semibold active:bg-brand-dark transition-transform active:scale-95"
                >
                  🖨 Print
                </button>
              </div>
              <div className="space-y-1.5">
                <Row label="No. of sales" value={String(data.sales_count)} />
                <Row label="Cash" value={money(data.cash)} />
                <Row label="Card" value={money(data.card)} />
                {data.other > 0 && (
                  <Row label="Unspecified" value={money(data.other)} />
                )}
                {(data.account_repaid_cash > 0 || data.account_repaid_card > 0) && (
                  <p className="text-xs text-taupe-light">
                    incl. account repaid
                    {data.account_repaid_cash > 0 &&
                      ` · cash ${money(data.account_repaid_cash)}`}
                    {data.account_repaid_card > 0 &&
                      ` · card ${money(data.account_repaid_card)}`}
                  </p>
                )}
                <Row label="Tips" value={money(data.tips)} />
                <Row label="Discounts" value={`-${money(data.discount)}`} />
                <div className="border-t border-stone-100 my-2" />
                <Row label="Total collected" value={money(data.net)} strong />
                {data.account > 0 && (
                  <>
                    <div className="border-t border-stone-100 my-2" />
                    <p className="text-xs font-semibold text-taupe-light uppercase pt-1">
                      On account — not collected
                    </p>
                    <Row label="Charged to accounts" value={money(data.account)} />
                  </>
                )}
              </div>
            </div>

            {/* Per-staff breakdown */}
            <div>
              <h3 className="font-semibold text-stone-700 mb-2">By staff</h3>
              {data.by_cashier.length === 0 && (
                <p className="bg-white border border-stone-200 rounded-xl p-4 text-stone-400">
                  No sales for this day.
                </p>
              )}
              <div className="space-y-3">
                {data.by_cashier.map((c) => (
                  <div
                    key={c.name}
                    className="bg-white border border-stone-200 rounded-xl p-4"
                  >
                    <div className="flex items-center justify-between mb-2">
                      <span className="font-semibold text-stone-800">
                        {c.name}
                        <span className="text-taupe font-normal text-sm">
                          {" "}
                          · {c.sales} sales
                        </span>
                      </span>
                      <button
                        onClick={() => printStaff(c)}
                        className="h-9 px-4 rounded-lg bg-brand-light text-brand-dark text-sm font-semibold active:bg-brand/20 transition-transform active:scale-95"
                      >
                        🖨 Print
                      </button>
                    </div>
                    <div className="grid grid-cols-2 gap-x-6 gap-y-1">
                      <Row label="Cash" value={money(c.cash)} />
                      <Row label="Card" value={money(c.card)} />
                      <Row label="Tips" value={money(c.tips)} />
                      <Row label="Discounts" value={`-${money(c.discount)}`} />
                    </div>
                    {(c.repaid_cash > 0 || c.repaid_card > 0) && (
                      <p className="text-xs text-taupe-light mt-1">
                        incl. account repaid
                        {c.repaid_cash > 0 && ` · cash ${money(c.repaid_cash)}`}
                        {c.repaid_card > 0 && ` · card ${money(c.repaid_card)}`}
                      </p>
                    )}
                    <div className="border-t border-stone-100 my-2" />
                    <Row label="Total collected" value={money(c.net)} strong />
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
