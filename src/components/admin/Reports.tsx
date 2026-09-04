import { useCallback, useEffect, useState } from "react";
import { errorMessage } from "../../lib/errors";
import { money } from "../../lib/format";
import { printReceipt } from "../../lib/print";
import { buildDayCloseText } from "../../lib/receipt";
import {
  dayClose,
  downloadText,
  exportSales,
  EXPORT_COLUMNS,
  salesByDepartment,
  toCsv,
  vatByMonth,
  type DayClose,
  type DepartmentRow,
  type VatMonth,
} from "../../lib/reports";
import { rangeBounds, type RangeKey } from "../../lib/sales";
import { buildCashUpText } from "../../lib/receipt";
import { Figures } from "./CashUp";
import type { DayCloseSession } from "../../lib/reports";
import { fmtDayMonth, fmtDayMonthTime, fmtTime } from "../../lib/dates";

/**
 * Reports: the numbers, out of the till.
 *
 * Four questions an owner asks that the slips could not answer together:
 * how did the whole shop do today, across every till (Day close); what is
 * selling and at what margin (Departments); what is the VAT return going to
 * say (VAT); and can the accountant have it (Export). Each is one server
 * call and one table, and the day close prints, because the banking bag
 * wants a piece of paper.
 */
type Section = "day" | "departments" | "vat" | "export";

const RANGES: { key: RangeKey; label: string }[] = [
  { key: "today", label: "Today" },
  { key: "yesterday", label: "Yesterday" },
  { key: "week", label: "Last 7 days" },
  { key: "custom", label: "Choose dates" },
];

const TENDER_LABEL: Record<string, string> = {
  cash: "Cash", card: "Card", eft: "EFT", zapper: "Zapper", account: "On account",
};

export default function Reports({ pin }: { pin: string }) {
  const [section, setSection] = useState<Section>("day");
  const [range, setRange] = useState<RangeKey>("today");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [day, setDay] = useState<DayClose | null>(null);
  const [depts, setDepts] = useState<DepartmentRow[] | null>(null);
  const [vat, setVat] = useState<VatMonth[] | null>(null);

  const bounds = rangeBounds(range, from, to);

  const load = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const b = rangeBounds(range, from, to);
      if (section === "day") setDay(await dayClose(pin, b.from, b.to));
      if (section === "departments") setDepts(await salesByDepartment(pin, b.from, b.to));
      if (section === "vat") setVat(await vatByMonth(pin, 12));
    } catch (e) {
      setError(errorMessage(e, "Could not load that report"));
    } finally {
      setBusy(false);
    }
  }, [pin, section, range, from, to]);

  useEffect(() => {
    void load();
  }, [load]);

  async function doExport() {
    setBusy(true);
    setError(null);
    try {
      const rows = await exportSales(pin, bounds.from, bounds.to);
      const stamp = (d: Date) => d.toISOString().slice(0, 10);
      const name = `sales-${stamp(bounds.from)}-to-${stamp(new Date(bounds.to.getTime() - 1))}.csv`;
      downloadText(name, toCsv(rows as unknown as Record<string, unknown>[], EXPORT_COLUMNS));
    } catch (e) {
      setError(errorMessage(e, "Could not export"));
    } finally {
      setBusy(false);
    }
  }

  const chip = (on: boolean) =>
    `px-3 py-1.5 rounded-full text-sm border ${
      on ? "bg-colophon text-paper border-colophon" : "bg-white text-stone-600 border-stone-300"
    }`;

  return (
    <div className="flex-1 overflow-auto p-4">
      <div className="max-w-4xl space-y-4">
        <div className="flex flex-wrap gap-2" role="tablist" aria-label="Report">
          {(
            [
              ["day", "Day close"],
              ["departments", "Departments"],
              ["vat", "VAT"],
              ["export", "Export"],
            ] as const
          ).map(([key, label]) => (
            <button
              key={key}
              role="tab"
              aria-selected={section === key}
              onClick={() => setSection(key)}
              className={chip(section === key)}
            >
              {label}
            </button>
          ))}
        </div>

        {section !== "vat" && (
          <div className="flex flex-wrap items-center gap-2">
            {RANGES.map((r) => (
              <button key={r.key} onClick={() => setRange(r.key)} className={chip(range === r.key)}>
                {r.label}
              </button>
            ))}
            {range === "custom" && (
              <>
                <input type="date" value={from} onChange={(e) => setFrom(e.target.value)}
                  className="rounded-lg border border-stone-300 px-2 py-1 text-sm" aria-label="From date" />
                <span className="text-stone-400">to</span>
                <input type="date" value={to} onChange={(e) => setTo(e.target.value)}
                  className="rounded-lg border border-stone-300 px-2 py-1 text-sm" aria-label="To date" />
              </>
            )}
          </div>
        )}

        {error && (
          <p onClick={() => setError(null)} className="px-3 py-2 bg-amber-100 text-amber-900 text-sm rounded-lg cursor-pointer">
            {error}
          </p>
        )}

        {section === "day" && day && (
          <section aria-label="Day close">
            <DayCloseView day={day} from={bounds.from} to={bounds.to} />
          </section>
        )}
        {section === "departments" && depts && (
          <section aria-label="Departments"><DepartmentsView rows={depts} /></section>
        )}
        {section === "vat" && vat && (
          <section aria-label="VAT"><VatView rows={vat} /></section>
        )}
        {section === "export" && (
          <section aria-label="Export" className="bg-white rounded-xl border border-stone-200 p-5 space-y-3 max-w-xl">
            <h2 className="font-medium">Every line sold, as a spreadsheet</h2>
            <p className="text-sm text-stone-600">
              One row per item on every invoice in the range: number, date, who rang it
              up, the customer, tender, department, quantity, price, VAT, discount and
              the cost at the time. Opens in Excel or Google Sheets.
            </p>
            <button
              className="px-4 py-2 rounded-lg bg-colophon text-paper disabled:opacity-40"
              disabled={busy}
              onClick={() => void doExport()}
            >
              Download CSV
            </button>
          </section>
        )}
        {busy && <p className="text-sm text-stone-500">Loading…</p>}
      </div>
    </div>
  );
}

function Stat({ label, value, tone }: { label: string; value: string; tone?: "good" | "bad" }) {
  return (
    <span>
      <span className="block text-xs uppercase tracking-wide text-stone-400">{label}</span>
      <span className={`text-xl tabular-nums ${tone === "good" ? "text-emerald-700" : tone === "bad" ? "text-amber-700" : ""}`}>
        {value}
      </span>
    </span>
  );
}

function DayCloseView({ day, from, to }: { day: DayClose; from: Date; to: Date }) {
  const t = day.totals;
  // A till's row is a door: the whole cash-up behind it, and its slip.
  const [open, setOpen] = useState<DayCloseSession | null>(null);
  const vTone = (v: number) => (Math.abs(v) < 0.005 ? "good" : "bad");
  const vText = (v: number) => (Math.abs(v) < 0.005 ? "Balanced" : `${v > 0 ? "Over" : "Short"} ${money(Math.abs(v))}`);
  return (
    <div className="space-y-4">
      <div className="bg-white rounded-xl border border-stone-200 p-5 space-y-4">
        <div className="flex flex-wrap gap-x-8 gap-y-3 items-baseline">
          <Stat label="Sales" value={String(t.sales_count)} />
          <Stat label="Taken" value={money(t.sales_total)} />
          {t.refunds_total > 0 && <Stat label="Refunds" value={`-${money(t.refunds_total)}`} />}
          <Stat label="VAT within" value={money(t.vat_total)} />
          {t.discount_total > 0 && <Stat label="Discounts" value={money(t.discount_total)} />}
        </div>
        <div className="flex flex-wrap gap-2 text-sm">
          {Object.entries(t.tenders).map(([m, v]) => (
            <span key={m} className="px-2 py-1 rounded bg-stone-100">
              {TENDER_LABEL[m] ?? m} <b className="tabular-nums">{money(v)}</b>
            </span>
          ))}
          {Object.entries(t.account_payments).map(([m, v]) => (
            <span key={"a" + m} className="px-2 py-1 rounded bg-stone-100">
              Account paid by {(TENDER_LABEL[m] ?? m).toLowerCase()} <b className="tabular-nums">{money(v)}</b>
            </span>
          ))}
        </div>
      </div>

      <div className="bg-white rounded-xl border border-stone-200 p-5 space-y-3">
        <h2 className="font-medium">Across the shop</h2>
        <div className="flex flex-wrap gap-x-8 gap-y-3 items-baseline">
          <Stat label="Cash expected" value={money(t.cash_expected)} />
          <Stat label="Cash counted" value={money(t.cash_counted)} />
          <Stat label="Cash" value={vText(t.cash_variance)} tone={vTone(t.cash_variance)} />
          <Stat label="Card: till" value={money(t.card_expected)} />
          <Stat label="Card: machine" value={money(t.card_counted)} />
          <Stat label="Card" value={vText(t.card_variance)} tone={vTone(t.card_variance)} />
          <Stat label="Banked" value={money(t.banked)} />
          <Stat label="Float kept" value={money(t.float_kept)} />
        </div>
        {t.sessions_open > 0 && (
          <p className="px-3 py-2 bg-amber-100 text-amber-900 text-sm rounded-lg" role="status">
            {t.sessions_open} {t.sessions_open === 1 ? "drawer is" : "drawers are"} still open — the figures above will move until it is closed.
          </p>
        )}
      </div>

      <div className="bg-white rounded-xl border border-stone-200 overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-stone-100 text-stone-600 text-left">
            <tr>
              <th className="p-2 font-medium">Till</th>
              <th className="p-2 font-medium hidden md:table-cell">Opened by</th>
              <th className="p-2 font-medium text-right whitespace-nowrap">Expected</th>
              <th className="p-2 font-medium text-right whitespace-nowrap">Counted</th>
              <th className="p-2 font-medium text-right whitespace-nowrap">Cash</th>
              <th className="p-2 font-medium text-right whitespace-nowrap">Card machine</th>
              <th className="p-2 font-medium text-right pr-4 whitespace-nowrap">Banked</th>
            </tr>
          </thead>
          <tbody>
            {day.sessions.length === 0 && (
              <tr><td className="p-3 text-stone-500" colSpan={7}>No drawer was opened in this range.</td></tr>
            )}
            {day.sessions.map((s) => (
              <tr
                key={s.id}
                className="border-t border-stone-100 even:bg-stone-50/70 hover:bg-amber-50 cursor-pointer"
                onClick={() => setOpen(s)}
              >
                <td className="p-2">
                  <span className="block">{s.register_name ?? "Till"}</span>
                  <span className="block text-xs text-stone-500">
                    {fmtDayMonth(s.opened_at)}
                    <span className="md:hidden"> · {s.opened_by_name}</span>
                  </span>
                  {!s.closed_at && <span className="text-[11px] px-1.5 py-0.5 rounded bg-amber-100 text-amber-800">still open</span>}
                </td>
                <td className="p-2 text-stone-600 hidden md:table-cell whitespace-nowrap">{s.opened_by_name}</td>
                <td className="p-2 text-right tabular-nums whitespace-nowrap">{money(s.expected_cash ?? s.figures.expected_cash)}</td>
                <td className="p-2 text-right tabular-nums whitespace-nowrap">{s.counted_cash == null ? "—" : money(s.counted_cash)}</td>
                <td className={`p-2 text-right tabular-nums whitespace-nowrap ${s.variance == null ? "" : Math.abs(s.variance) < 0.005 ? "text-emerald-700" : "text-amber-700"}`}>
                  {s.variance == null ? "—" : vText(s.variance)}
                </td>
                <td className={`p-2 text-right tabular-nums whitespace-nowrap ${s.card_variance == null ? "" : Math.abs(s.card_variance) < 0.005 ? "text-emerald-700" : "text-amber-700"}`}>
                  {s.card_counted == null ? "—" : `${money(s.card_counted)} · ${vText(s.card_variance ?? 0)}`}
                </td>
                <td className="p-2 text-right tabular-nums pr-4 whitespace-nowrap">{s.banked == null ? "—" : money(s.banked)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <button
        className="px-4 py-2 rounded-lg bg-colophon text-paper"
        onClick={() => printReceipt(buildDayCloseText(day, from, to), "Day close")}
      >
        Print day close
      </button>

      {open && (
        <div
          className="vv-fixed bg-black/50 flex items-center justify-center p-4 z-50"
          role="dialog"
          aria-modal="true"
          aria-label={`Cash-up ${open.register_name ?? "Till"}`}
          onClick={() => setOpen(null)}
        >
          <div className="bg-white rounded-2xl w-full max-w-lg max-h-[90vh] flex flex-col" onClick={(e) => e.stopPropagation()}>
            <div className="p-4 border-b border-stone-200 flex items-start gap-3">
              <div className="flex-1">
                <h2 className="text-lg font-semibold">{open.register_name ?? "Till"}</h2>
                <p className="text-sm text-stone-500">
                  Opened {fmtDayMonthTime(open.opened_at)} by {open.opened_by_name}
                  {open.closed_at
                    ? ` · closed ${fmtTime(open.closed_at)} by ${open.closed_by_name ?? ""}`
                    : " · still open"}
                </p>
              </div>
              <button onClick={() => setOpen(null)} className="text-stone-400 text-2xl leading-none" aria-label="Close cash-up">×</button>
            </div>
            <div className="p-4 overflow-y-auto flex-1 space-y-3">
              <Figures session={open} />
              {open.counted_cash != null && (
                <div className="bg-white rounded-xl border border-stone-200 p-4 text-sm space-y-1">
                  <div className="flex justify-between"><span>Counted</span><span className="tabular-nums">{money(open.counted_cash)}</span></div>
                  <div className="flex justify-between font-medium"><span>{vText(open.variance ?? 0)}</span><span /></div>
                  {open.card_counted != null && (
                    <div className="flex justify-between"><span>Card machine</span><span className="tabular-nums">{money(open.card_counted)} · {vText(open.card_variance ?? 0)}</span></div>
                  )}
                  {open.eft_counted != null && (
                    <div className="flex justify-between"><span>EFTs received</span><span className="tabular-nums">{money(open.eft_counted)} · {vText(open.eft_variance ?? 0)}</span></div>
                  )}
                  {open.banked != null && (
                    <div className="flex justify-between"><span>Banked · float kept</span><span className="tabular-nums">{money(open.banked)} · {money(open.float_kept ?? 0)}</span></div>
                  )}
                  {open.note && <p className="text-stone-600 pt-1">{open.note}</p>}
                </div>
              )}
            </div>
            <div className="p-4 border-t border-stone-200">
              <button
                className="w-full py-2.5 rounded-xl bg-colophon text-paper"
                onClick={() => printReceipt(buildCashUpText(open), "Cash-up")}
              >
                Print this cash-up
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function DepartmentsView({ rows }: { rows: DepartmentRow[] }) {
  const total = rows.reduce((t, r) => t + r.sales, 0);
  return (
    <div className="bg-white rounded-xl border border-stone-200 overflow-x-auto">
      <table className="w-full text-sm">
        <thead className="bg-stone-100 text-stone-600 text-left">
          <tr>
            <th className="p-2 font-medium">Department</th>
            <th className="p-2 font-medium text-right">Lines</th>
            <th className="p-2 font-medium text-right">Sales</th>
            <th className="p-2 font-medium text-right">Share</th>
            <th className="p-2 font-medium text-right">Ex VAT</th>
            <th className="p-2 font-medium text-right">Cost</th>
            <th className="p-2 font-medium text-right pr-4">Margin</th>
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 && (
            <tr><td className="p-3 text-stone-500" colSpan={7}>Nothing sold in that stretch.</td></tr>
          )}
          {rows.map((r) => (
            <tr key={r.department} className="border-t border-stone-100 even:bg-stone-50/70">
              <td className="p-2">{r.department}</td>
              <td className="p-2 text-right tabular-nums whitespace-nowrap">{r.lines}</td>
              <td className="p-2 text-right tabular-nums whitespace-nowrap">{money(r.sales)}</td>
              <td className="p-2 text-right tabular-nums text-stone-500">{total > 0 ? `${((r.sales / total) * 100).toFixed(0)}%` : "—"}</td>
              <td className="p-2 text-right tabular-nums text-stone-500">{money(r.net)}</td>
              <td className="p-2 text-right tabular-nums text-stone-500">
                {r.cost == null ? "—" : money(r.cost)}
                {r.uncosted_lines > 0 && (
                  <span className="block text-[11px] text-amber-700">{r.uncosted_lines} uncosted</span>
                )}
              </td>
              <td className={`p-2 text-right tabular-nums pr-4 ${r.margin_percent != null && r.margin_percent < 15 ? "text-amber-700" : ""}`}>
                {r.margin == null ? "—" : `${money(r.margin)} · ${r.margin_percent}%`}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="px-3 py-2 text-xs text-stone-500 border-t border-stone-100">
        Margin is ex VAT, against the cost each line was actually sold at. A line whose product
        had no cost recorded is counted in sales and flagged, not guessed.
      </p>
    </div>
  );
}

function VatView({ rows }: { rows: VatMonth[] }) {
  const label = (m: string) => {
    const [y, mo] = m.split("-").map(Number);
    return new Date(y, mo - 1, 1).toLocaleDateString("en-ZA", { month: "long", year: "numeric" });
  };
  return (
    <div className="bg-white rounded-xl border border-stone-200 overflow-x-auto">
      <table className="w-full text-sm">
        <thead className="bg-stone-100 text-stone-600 text-left">
          <tr>
            <th className="p-2 font-medium">Month</th>
            <th className="p-2 font-medium text-right">Sales</th>
            <th className="p-2 font-medium text-right">Gross</th>
            <th className="p-2 font-medium text-right">Ex VAT</th>
            <th className="p-2 font-medium text-right">Output VAT</th>
            <th className="p-2 font-medium text-right">Credit notes</th>
            <th className="p-2 font-medium text-right pr-4">VAT due</th>
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 && (
            <tr><td className="p-3 text-stone-500" colSpan={7}>No sales yet.</td></tr>
          )}
          {rows.map((r) => (
            <tr key={r.month} className="border-t border-stone-100 even:bg-stone-50/70">
              <td className="p-2">{label(r.month)}</td>
              <td className="p-2 text-right tabular-nums whitespace-nowrap">{r.sales_count}</td>
              <td className="p-2 text-right tabular-nums whitespace-nowrap">{money(r.gross)}</td>
              <td className="p-2 text-right tabular-nums text-stone-500">{money(r.net)}</td>
              <td className="p-2 text-right tabular-nums whitespace-nowrap">{money(r.vat)}</td>
              <td className="p-2 text-right tabular-nums text-stone-500">{r.refunds > 0 ? `-${money(r.refunds)}` : "—"}</td>
              <td className="p-2 text-right tabular-nums pr-4 font-medium">{money(r.vat_due)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="px-3 py-2 text-xs text-stone-500 border-t border-stone-100">
        Output VAT is the VAT within completed sales; VAT due nets off the VAT on credit notes.
        Input VAT on purchases is not recorded here.
      </p>
    </div>
  );
}
