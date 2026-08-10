import { useCallback, useEffect, useMemo, useState } from "react";
import { salesSummary, type SalesSummary } from "../lib/api";
import type { Sale, User } from "../lib/types";
import { money } from "../lib/format";
import { buildSalesReportSlip } from "../lib/receipt";
import { printReceipt } from "../lib/print";
import SalesList, { type SalesFilter } from "./SalesList";
import SaleDetail from "./SaleDetail";
import ItemHistory from "./ItemHistory";
import InvoicesReport from "./InvoicesReport";

type PeriodKey = "today" | "week" | "month" | "custom";

function isoDate(d: Date): string {
  const local = new Date(d.getTime() - d.getTimezoneOffset() * 60000);
  return local.toISOString().slice(0, 10);
}

const LABELS: Record<PeriodKey, string> = {
  today: "Today",
  week: "Last 7 days",
  month: "This month",
  custom: "Custom",
};

function Stat({
  label,
  value,
  onClick,
}: {
  label: string;
  value: string;
  onClick?: () => void;
}) {
  return (
    <button
      onClick={onClick}
      disabled={!onClick}
      className="text-left bg-white border border-stone-200 rounded-xl p-4 transition-all enabled:hover:border-brand/40 enabled:hover:shadow-md enabled:active:scale-[0.98] disabled:cursor-default"
    >
      <p className="text-taupe text-sm">{label}</p>
      <p className="text-2xl font-bold text-stone-800 mt-1">{value}</p>
    </button>
  );
}

export default function SalesReport({
  managerPin,
  actor,
}: {
  managerPin: string;
  actor: User;
}) {
  const [view, setView] = useState<"summary" | "invoices" | "item">("summary");
  const [period, setPeriod] = useState<PeriodKey>("today");
  const [data, setData] = useState<SalesSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  const [drill, setDrill] = useState<SalesFilter | null>(null);
  const [openSale, setOpenSale] = useState<Sale | null>(null);

  // Custom range date inputs (used when period === "custom").
  const todayIso = isoDate(new Date());
  const [customFrom, setCustomFrom] = useState(
    isoDate(new Date(new Date().getFullYear(), new Date().getMonth(), 1))
  );
  const [customTo, setCustomTo] = useState(todayIso);

  const { from, to, label } = useMemo(() => {
    const now = new Date();
    if (period === "custom") {
      const f = new Date(`${customFrom}T00:00:00`);
      const t = new Date(`${customTo}T00:00:00`);
      t.setDate(t.getDate() + 1);
      return {
        from: f,
        to: t,
        label: customFrom === customTo ? customFrom : `${customFrom} to ${customTo}`,
      };
    }
    const to = new Date(now.getTime() + 1000);
    const f = new Date(now);
    if (period === "today") f.setHours(0, 0, 0, 0);
    else if (period === "week") {
      f.setDate(f.getDate() - 6);
      f.setHours(0, 0, 0, 0);
    } else {
      f.setDate(1);
      f.setHours(0, 0, 0, 0);
    }
    return { from: f, to, label: LABELS[period] };
  }, [period, customFrom, customTo]);

  useEffect(() => {
    setLoading(true);
    setError(null);
    salesSummary(managerPin, from, to)
      .then(setData)
      .catch((e) => setError(e instanceof Error ? e.message : "Failed to load"))
      .finally(() => setLoading(false));
  }, [managerPin, from, to, reloadKey]);

  // After a void, refresh totals; the drill list remounts via its own key.
  const afterVoid = useCallback(() => setReloadKey((k) => k + 1), []);

  const periodLabel = label;

  const printSummary = () => {
    if (!data) return;
    printReceipt(
      buildSalesReportSlip({
        rangeLabel: label,
        salesCount: data.sales_count,
        collected: data.net,
        cash: data.cash,
        card: data.card,
        accountOwed: data.account_owed,
        tips: data.tips,
        discount: data.discount,
        printedBy: actor.name,
        topItems: data.top_items,
      }),
      "Sales report"
    );
  };

  return (
    <div className="p-4">
      <div className="max-w-3xl mx-auto">
        {/* Summary vs invoices vs per-item history */}
        <div className="flex gap-2 mb-4 border-b border-stone-200">
          {(
            [
              ["summary", "Summary"],
              ["invoices", "Invoices"],
              ["item", "Item history"],
            ] as const
          ).map(([k, tab]) => (
            <button
              key={k}
              onClick={() => setView(k)}
              className={`h-10 px-4 -mb-px font-medium border-b-2 transition-colors ${
                view === k
                  ? "border-brand text-brand-dark"
                  : "border-transparent text-stone-500"
              }`}
            >
              {tab}
            </button>
          ))}
        </div>

        {view === "item" && <ItemHistory managerPin={managerPin} />}

        {view === "invoices" && (
          <InvoicesReport
            managerPin={managerPin}
            actor={actor}
            onOpen={setOpenSale}
          />
        )}

        {view === "summary" && (
        <>
        <div className="flex flex-wrap gap-2 mb-3">
          {(Object.keys(LABELS) as PeriodKey[]).map((k) => (
            <button
              key={k}
              onClick={() => {
                setPeriod(k);
                setDrill(null);
              }}
              className={`h-10 px-4 rounded-full font-medium transition-colors ${
                period === k
                  ? "bg-brand text-white"
                  : "bg-white border border-stone-200 text-stone-600"
              }`}
            >
              {LABELS[k]}
            </button>
          ))}
        </div>

        {period === "custom" && (
          <div className="grid grid-cols-2 gap-3 mb-4 bg-white border border-stone-200 rounded-xl p-3">
            <div>
              <label className="block text-xs font-medium text-stone-600 mb-1">From</label>
              <input
                type="date"
                value={customFrom}
                max={customTo}
                onChange={(e) => {
                  setCustomFrom(e.target.value);
                  setDrill(null);
                }}
                className="w-full h-10 px-3 rounded-lg border border-stone-300 focus:border-brand outline-none"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-stone-600 mb-1">To</label>
              <input
                type="date"
                value={customTo}
                min={customFrom}
                onChange={(e) => {
                  setCustomTo(e.target.value);
                  setDrill(null);
                }}
                className="w-full h-10 px-3 rounded-lg border border-stone-300 focus:border-brand outline-none"
              />
            </div>
          </div>
        )}

        {loading && <p className="text-stone-400">Loading…</p>}
        {error && <p className="text-red-600">{error}</p>}

        {/* Drill-down list */}
        {drill && !loading && (
          <SalesList
            key={reloadKey}
            managerPin={managerPin}
            from={from}
            to={to}
            filter={drill}
            onBack={() => setDrill(null)}
            onOpen={setOpenSale}
          />
        )}

        {/* Summary */}
        {data && !loading && !drill && (
          <div className="animate-fade-in space-y-4">
            <div className="flex items-center justify-between">
              <h3 className="font-semibold text-stone-700">{periodLabel}</h3>
              <button
                onClick={printSummary}
                className="h-10 px-4 rounded-lg bg-brand text-white text-sm font-semibold active:bg-brand-dark transition-transform active:scale-95"
              >
                🖨 Print report
              </button>
            </div>
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
              <Stat
                label="Money collected"
                value={money(data.net)}
                onClick={() =>
                  setDrill({ title: `${periodLabel} · all sales` })
                }
              />
              <Stat label="Cash" value={money(data.cash)} />
              <Stat label="Card" value={money(data.card)} />
              <Stat label="Account repaid" value={money(data.account_repaid)} />
              <Stat label="On account (owed)" value={money(data.account_owed)} />
              <Stat label="Tips" value={money(data.tips)} />
              <Stat
                label="Discounts"
                value={money(data.discount)}
                onClick={() =>
                  setDrill({
                    title: `${periodLabel} · discounted sales`,
                    onlyDiscounted: true,
                  })
                }
              />
              <Stat
                label="No. Of sales"
                value={String(data.sales_count)}
                onClick={() =>
                  setDrill({ title: `${periodLabel} · all sales` })
                }
              />
            </div>
            <p className="text-xs text-taupe -mt-1">
              Cash &amp; Card include account repayments collected by that method
              (“Account repaid” shows that portion). On-account charges are shown
              separately as owed and only count once paid.
            </p>

            <div>
              <h3 className="font-semibold text-stone-700 mb-2">Top sellers</h3>
              <div className="bg-white border border-stone-200 rounded-xl divide-y divide-stone-100">
                {data.top_items.length === 0 && (
                  <p className="p-4 text-stone-400">No sales in this period.</p>
                )}
                {data.top_items.map((it, i) => (
                  <button
                    key={it.name}
                    onClick={() =>
                      setDrill({
                        title: `${periodLabel} · ${it.name}`,
                        itemName: it.name,
                      })
                    }
                    className="w-full flex items-center gap-3 p-3 text-left active:bg-stone-50"
                  >
                    <span className="w-6 text-center font-bold text-taupe-light">
                      {i + 1}
                    </span>
                    <span className="flex-1 font-medium text-stone-800">
                      {it.name}
                    </span>
                    <span className="text-taupe">{it.qty} sold</span>
                    <span className="w-20 text-right font-semibold text-brand">
                      {money(it.revenue)}
                    </span>
                    <span className="text-taupe-light">›</span>
                  </button>
                ))}
              </div>
            </div>

            {data.by_cashier.length > 0 && (
              <div>
                <h3 className="font-semibold text-stone-700 mb-2">By cashier</h3>
                <div className="bg-white border border-stone-200 rounded-xl divide-y divide-stone-100">
                  {data.by_cashier.map((c) => (
                    <button
                      key={c.name}
                      onClick={() =>
                        setDrill({
                          title: `${periodLabel} · ${c.name}`,
                          cashier: c.name,
                        })
                      }
                      className="w-full flex items-center gap-3 p-3 text-left active:bg-stone-50"
                    >
                      <span className="flex-1 font-medium text-stone-800">
                        {c.name}
                      </span>
                      <span className="text-taupe">{c.sales} sales</span>
                      <span className="w-20 text-right font-semibold text-brand">
                        {money(c.net)}
                      </span>
                      <span className="text-taupe-light">›</span>
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
        </>
        )}
      </div>

      {openSale && (
        <SaleDetail
          managerPin={managerPin}
          actor={actor}
          sale={openSale}
          onClose={() => setOpenSale(null)}
          onVoided={afterVoid}
        />
      )}
    </div>
  );
}
