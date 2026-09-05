import { useCallback, useEffect, useState } from "react";
import { errorMessage } from "../../lib/errors";
import { money } from "../../lib/format";
import { printReceipt } from "../../lib/print";
import { buildDayCloseText } from "../../lib/receipt";
import {
  dayClose,
  debtorsAgeing,
  shrinkage,
  deliveriesReport,
  itemMovement,
  marginSlipped,
  moneyBack,
  purchasesBySupplier,
  salesByCashier,
  stockValue,
  downloadText,
  exportSales,
  EXPORT_COLUMNS,
  salesByDepartment,
  toCsv,
  vatByMonth,
  type Shrinkage,
  type CashierRow,
  type DayClose,
  type DebtorsAgeing,
  type DeliveriesReport,
  type DepartmentRow,
  type ItemRow,
  type MarginRow,
  type MoneyBackRow,
  type StockValue,
  type SupplierSpendRow,
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
type Section =
  | "day" | "departments" | "items" | "people" | "refunds" | "deliveries"
  | "stock" | "losses" | "debtors" | "suppliers" | "vat" | "export";

/**
 * The tabs, in the order an owner works through them: how did today go, what
 * sold, who sold it, what came back, what is still to go out, what is on the
 * shelves, who owes us, who we owe, what the VAT return says, and give the
 * accountant the lot.
 */
const TABS: [Section, string][] = [
  ["day", "Day close"],
  ["departments", "Departments"],
  ["items", "Items"],
  ["people", "People"],
  ["refunds", "Refunds"],
  ["deliveries", "Deliveries"],
  ["stock", "Stock"],
  ["losses", "Losses"],
  ["debtors", "Debtors"],
  ["suppliers", "Suppliers"],
  ["vat", "VAT"],
  ["export", "Export"],
];

/** Reports that describe how things stand now, not what happened in a window. */
const NO_RANGE: Section[] = ["vat", "stock", "debtors"];

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
  const [items, setItems] = useState<ItemRow[] | null>(null);
  const [people, setPeople] = useState<CashierRow[] | null>(null);
  const [back, setBack] = useState<MoneyBackRow[] | null>(null);
  const [deliv, setDeliv] = useState<DeliveriesReport | null>(null);
  const [stock, setStock] = useState<StockValue | null>(null);
  const [slipped, setSlipped] = useState<MarginRow[] | null>(null);
  const [losses, setLosses] = useState<Shrinkage | null>(null);
  const [debtors, setDebtors] = useState<DebtorsAgeing | null>(null);
  const [suppliers, setSuppliers] = useState<SupplierSpendRow[] | null>(null);

  const bounds = rangeBounds(range, from, to);

  const load = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const b = rangeBounds(range, from, to);
      if (section === "day") setDay(await dayClose(pin, b.from, b.to));
      if (section === "departments") setDepts(await salesByDepartment(pin, b.from, b.to));
      if (section === "vat") setVat(await vatByMonth(pin, 12));
      if (section === "items") setItems(await itemMovement(pin, b.from, b.to));
      if (section === "people") setPeople(await salesByCashier(pin, b.from, b.to));
      if (section === "refunds") setBack(await moneyBack(pin, b.from, b.to));
      if (section === "deliveries") setDeliv(await deliveriesReport(pin, b.from, b.to));
      if (section === "stock") {
        // Two questions about the same shelves: what is on them, and whether
        // what is on them is still priced to make money.
        setStock(await stockValue(pin));
        setSlipped(await marginSlipped(pin, 15));
      }
      if (section === "losses") setLosses(await shrinkage(pin, b.from, b.to));
      if (section === "debtors") setDebtors(await debtorsAgeing(pin));
      if (section === "suppliers") setSuppliers(await purchasesBySupplier(pin, b.from, b.to));
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
          {TABS.map(([key, label]) => (
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

        {!NO_RANGE.includes(section) && (
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
        {section === "items" && items && (
          <section aria-label="Items"><ItemsView rows={items} /></section>
        )}
        {section === "people" && people && (
          <section aria-label="People"><PeopleView rows={people} /></section>
        )}
        {section === "refunds" && back && (
          <section aria-label="Refunds"><MoneyBackView rows={back} /></section>
        )}
        {section === "deliveries" && deliv && (
          <section aria-label="Deliveries"><DeliveriesView report={deliv} /></section>
        )}
        {section === "stock" && stock && (
          <section aria-label="Stock">
            <StockView value={stock} slipped={slipped ?? []} />
          </section>
        )}
        {section === "losses" && losses && (
          <section aria-label="Losses"><LossesView report={losses} /></section>
        )}
        {section === "debtors" && debtors && (
          <section aria-label="Debtors"><DebtorsView report={debtors} /></section>
        )}
        {section === "suppliers" && suppliers && (
          <section aria-label="Suppliers"><SuppliersView rows={suppliers} /></section>
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

/* -------------------------------------------------------------------------
 * The reports added in 0063. Each is one table and one question.
 * ------------------------------------------------------------------------- */

/** A card with a heading and a table inside it, which every view below wants. */
function Card({ title, note, children }: {
  title: string; note?: string; children: React.ReactNode;
}) {
  return (
    <div className="bg-white rounded-xl border border-stone-200 overflow-hidden">
      <div className="px-5 pt-4 pb-2">
        <h2 className="font-medium">{title}</h2>
        {note && <p className="text-sm text-stone-600 mt-1">{note}</p>}
      </div>
      <div className="overflow-x-auto">{children}</div>
    </div>
  );
}

const TH = "p-2 font-medium";
const THN = "p-2 font-medium text-right whitespace-nowrap";
const TD = "p-2";
const TDN = "p-2 text-right tabular-nums whitespace-nowrap";
const ROW = "border-t border-stone-100 even:bg-stone-50/70";

function Empty({ span, children }: { span: number; children: React.ReactNode }) {
  return <tr><td className="p-3 text-stone-500" colSpan={span}>{children}</td></tr>;
}

function ItemsView({ rows }: { rows: ItemRow[] }) {
  return (
    <Card
      title="Every line that moved"
      note="Biggest seller first. Departments answers “which part of the shop”; this answers “which thing”."
    >
      <table className="w-full text-sm">
        <thead className="bg-stone-100 text-stone-600 text-left">
          <tr>
            <th className={TH}>Item</th>
            <th className={TH + " hidden md:table-cell"}>Department</th>
            <th className={THN}>Sold</th>
            <th className={THN}>Takings</th>
            <th className={THN}>Margin</th>
            <th className={THN + " pr-4"}>On hand</th>
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 && <Empty span={6}>Nothing sold in this range.</Empty>}
          {rows.map((r, i) => (
            <tr key={i} className={ROW}>
              <td className={TD}>
                <span className="block">{r.item}</span>
                <span className="block text-xs text-stone-500">{r.sku ?? "—"}</span>
              </td>
              <td className={TD + " hidden md:table-cell text-stone-600"}>{r.department}</td>
              <td className={TDN}>{r.qty} {r.unit}</td>
              <td className={TDN}>{money(r.sales)}</td>
              <td className={TDN}>
                {r.margin == null ? "—" : money(r.margin)}
                {r.uncosted_lines > 0 && (
                  <span className="block text-[11px] text-amber-700">{r.uncosted_lines} uncosted</span>
                )}
              </td>
              <td className={TDN + " pr-4 text-stone-500"}>
                {r.on_hand == null ? "—" : r.on_hand}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </Card>
  );
}

function PeopleView({ rows }: { rows: CashierRow[] }) {
  return (
    <Card
      title="Who served the shop"
      note="The day close balances a drawer; this follows the person. Two people work one till, and one person works three."
    >
      <table className="w-full text-sm">
        <thead className="bg-stone-100 text-stone-600 text-left">
          <tr>
            <th className={TH}>Who</th>
            <th className={THN}>Sales</th>
            <th className={THN}>Taken</th>
            <th className={THN}>Average</th>
            <th className={THN}>Given away</th>
            <th className={THN + " pr-4"}>Refunded</th>
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 && <Empty span={6}>Nobody rang anything up in this range.</Empty>}
          {rows.map((r, i) => (
            <tr key={i} className={ROW}>
              <td className={TD}>{r.cashier}</td>
              <td className={TDN}>{r.sales_count}</td>
              <td className={TDN}>{money(r.sales)}</td>
              <td className={TDN + " text-stone-500"}>{money(r.average)}</td>
              <td className={`${TDN} ${r.discount > 0 ? "text-amber-700" : "text-stone-500"}`}>
                {r.discount > 0 ? money(r.discount) : "—"}
              </td>
              <td className={TDN + " pr-4 text-stone-500"}>
                {r.refunds_count === 0 ? "—" : `${money(r.refunds)} · ${r.refunds_count}`}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </Card>
  );
}

function MoneyBackView({ rows }: { rows: MoneyBackRow[] }) {
  const total = rows.reduce((t, r) => t + r.amount, 0);
  return (
    <Card
      title="Money back across the counter"
      note={`${rows.length === 0 ? "Nothing" : money(total)} in ${rows.length} ${rows.length === 1 ? "event" : "events"}. Goods returned and sales cancelled outright are both here — they are different events with different reasons.`}
    >
      <table className="w-full text-sm">
        <thead className="bg-stone-100 text-stone-600 text-left">
          <tr>
            <th className={TH}>When</th>
            <th className={TH}>What</th>
            <th className={TH}>Why</th>
            <th className={TH + " hidden md:table-cell"}>Who</th>
            <th className={THN + " pr-4"}>Amount</th>
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 && <Empty span={5}>Nothing came back in this range.</Empty>}
          {rows.map((r, i) => (
            <tr key={i} className={ROW}>
              <td className={TD + " whitespace-nowrap text-stone-600"}>{fmtDayMonthTime(r.at)}</td>
              <td className={TD}>
                <span className={`text-[11px] px-1.5 py-0.5 rounded ${
                  r.kind === "cancelled" ? "bg-rose-100 text-rose-800" : "bg-stone-100 text-stone-700"
                }`}>
                  {r.kind === "cancelled" ? "Cancelled" : "Returned"}
                </span>
                <span className="block text-xs text-stone-500">
                  {r.doc_number ?? "—"}{r.against ? ` · against ${r.against}` : ""}
                </span>
              </td>
              <td className={TD + " text-stone-600"}>{r.reason ?? "—"}</td>
              <td className={TD + " hidden md:table-cell text-stone-600"}>{r.who ?? "—"}</td>
              <td className={TDN + " pr-4"}>{money(r.amount)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </Card>
  );
}

function DeliveriesView({ report }: { report: DeliveriesReport }) {
  const t = report.totals;
  return (
    <div className="space-y-4">
      <div className="bg-white rounded-xl border border-stone-200 p-5 space-y-3">
        <div className="flex flex-wrap gap-x-8 gap-y-3 items-baseline">
          <Stat label="Arranged" value={String(t.count)} />
          <Stat label="Signed for" value={String(t.delivered)} />
          <Stat label="Still to go" value={String(t.outstanding)} />
          <Stat
            label="Late"
            value={String(t.late)}
            tone={t.late > 0 ? "bad" : "good"}
          />
          <Stat label="Carriage charged" value={money(t.carriage)} />
          <Stat label="Carriage earned" value={money(t.carriage_net)} />
          <Stat label="Cost of the trips" value={money(t.carriage_cost)} />
          <Stat
            label="Worth"
            value={money(t.carriage_margin)}
            tone={t.carriage_margin < 0 ? "bad" : "good"}
          />
        </div>
        <p className="text-xs text-stone-500">
          Charged is what was agreed on the notes in this range; earned is what
          the invoices actually took for it, less VAT. “Late” counts every note
          still outstanding past its day, whenever it was written — a load
          promised three weeks ago is exactly the one nobody is looking at.
          {t.carriage_free > 0 && ` ${t.carriage_free} went out free of charge.`}
        </p>
        {t.carriage_cost === 0 && t.count > 0 && (
          <p className="px-3 py-2 bg-amber-100 text-amber-900 text-sm rounded-lg" role="status">
            No cost is recorded against a delivery, so “worth” above is the
            whole charge and every trip reports as pure profit. Set what one
            costs under Manage → Shop.
          </p>
        )}
      </div>

      <Card
        title="Still to go out"
        note="Oldest promise first: the order a bakkie loads in."
      >
        <table className="w-full text-sm">
          <thead className="bg-stone-100 text-stone-600 text-left">
            <tr>
              <th className={TH}>Note</th>
              <th className={TH}>To</th>
              <th className={TH}>Promised</th>
              <th className={TH + " hidden md:table-cell"}>Invoice</th>
              <th className={THN + " pr-4"}>Carriage</th>
            </tr>
          </thead>
          <tbody>
            {report.outstanding.length === 0 && (
              <Empty span={5}>Nothing outstanding. Everything promised has been signed for.</Empty>
            )}
            {report.outstanding.map((d) => (
              <tr key={d.id} className={ROW}>
                <td className={TD}>{d.doc_number}</td>
                <td className={TD}>
                  <span className="block">{d.customer_name}</span>
                  <span className="block text-xs text-stone-500">{d.address}</span>
                </td>
                <td className={TD + " whitespace-nowrap"}>
                  {fmtDayMonth(d.deliver_on)}
                  {d.deliver_at ? <span className="block text-xs text-stone-500">{d.deliver_at}</span> : null}
                  {d.days_late > 0 && (
                    <span className="block text-xs text-amber-700">
                      {d.days_late} {d.days_late === 1 ? "day" : "days"} late
                    </span>
                  )}
                </td>
                <td className={TD + " hidden md:table-cell text-stone-600"}>{d.sale_number ?? "—"}</td>
                <td className={TDN + " pr-4"}>{d.charge > 0 ? money(d.charge) : "free"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
    </div>
  );
}

function StockView({ value, slipped }: { value: StockValue; slipped: MarginRow[] }) {
  const t = value.totals;
  return (
    <div className="space-y-4">
      <div className="bg-white rounded-xl border border-stone-200 p-5 space-y-3">
        <div className="flex flex-wrap gap-x-8 gap-y-3 items-baseline">
          <Stat label="At cost" value={money(t.at_cost)} />
          <Stat label="At retail" value={money(t.at_retail)} />
          <Stat label="Lines" value={String(t.lines)} />
          <Stat label="Units" value={String(t.units)} />
        </div>
        <p className="text-xs text-stone-500">
          At cost is the figure that goes in the books; at retail is what it
          would ring up as, and the gap is profit still sitting on a shelf.
        </p>
        {(t.uncosted_lines > 0 || t.negative_lines > 0) && (
          <p className="px-3 py-2 bg-amber-100 text-amber-900 text-sm rounded-lg" role="status">
            {t.uncosted_lines > 0 && `${t.uncosted_lines} lines have no cost recorded, so they count as nothing here. `}
            {t.negative_lines > 0 && `${t.negative_lines} lines are below zero on hand — that is a counting problem, and it makes every figure above a guess.`}
          </p>
        )}
      </div>

      <Card title="What is on the shelves">
        <table className="w-full text-sm">
          <thead className="bg-stone-100 text-stone-600 text-left">
            <tr>
              <th className={TH}>Department</th>
              <th className={THN}>Lines</th>
              <th className={THN}>Units</th>
              <th className={THN}>At cost</th>
              <th className={THN + " pr-4"}>At retail</th>
            </tr>
          </thead>
          <tbody>
            {value.departments.length === 0 && <Empty span={5}>No stock is tracked yet.</Empty>}
            {value.departments.map((d, i) => (
              <tr key={i} className={ROW}>
                <td className={TD}>{d.department}</td>
                <td className={TDN + " text-stone-500"}>{d.lines}</td>
                <td className={TDN + " text-stone-500"}>{d.units}</td>
                <td className={TDN}>
                  {d.at_cost == null ? "—" : money(d.at_cost)}
                  {d.uncosted_lines > 0 && (
                    <span className="block text-[11px] text-amber-700">{d.uncosted_lines} uncosted</span>
                  )}
                </td>
                <td className={TDN + " pr-4"}>{money(d.at_retail)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>

      <Card
        title="Where the margin went"
        note="Cost is a fact the shop records when goods arrive; retail is a decision it makes on purpose. Nothing moves retail automatically, so a supplier’s price rise eats a line quietly. Retail here is shown less VAT — comparing a VAT-inclusive price against an ex-VAT cost makes every margin look 15 points better than it is."
      >
        <table className="w-full text-sm">
          <thead className="bg-stone-100 text-stone-600 text-left">
            <tr>
              <th className={TH}>Item</th>
              <th className={TH + " hidden md:table-cell"}>Department</th>
              <th className={THN}>Cost</th>
              <th className={THN}>Retail less VAT</th>
              <th className={THN + " pr-4"}>Margin</th>
            </tr>
          </thead>
          <tbody>
            {slipped.length === 0 && (
              <Empty span={5}>Nothing under 15%. Every priced line is still earning.</Empty>
            )}
            {slipped.map((r, i) => (
              <tr key={i} className={`${ROW} ${r.below_cost ? "bg-rose-50" : ""}`}>
                <td className={TD}>
                  <span className="block">{r.item}</span>
                  <span className="block text-xs text-stone-500">{r.sku}</span>
                </td>
                <td className={TD + " hidden md:table-cell text-stone-600"}>{r.department}</td>
                <td className={TDN}>{money(r.cost)}</td>
                <td className={TDN}>{money(r.net_retail)}</td>
                <td className={`${TDN} pr-4 ${r.below_cost ? "text-rose-700" : "text-amber-700"}`}>
                  {money(r.margin)}
                  <span className="block text-[11px]">
                    {r.below_cost ? "below cost" : `${r.margin_percent}%`}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
    </div>
  );
}

function DebtorsView({ report }: { report: DebtorsAgeing }) {
  const t = report.totals;
  return (
    <div className="space-y-4">
      <div className="bg-white rounded-xl border border-stone-200 p-5 space-y-3">
        <div className="flex flex-wrap gap-x-8 gap-y-3 items-baseline">
          <Stat label="Owed" value={money(t.total)} />
          <Stat label="Accounts" value={String(t.accounts)} />
          <Stat label="Current" value={money(t.current)} />
          <Stat label="30 days" value={money(t.days30)} />
          <Stat label="60 days" value={money(t.days60)} />
          <Stat label="90+ days" value={money(t.days90)} tone={t.days90 > 0 ? "bad" : undefined} />
        </div>
        <p className="text-xs text-stone-500">
          Payments are consumed against the oldest charge first, so what is left
          in the 90-day column is money that has been owed since then.
        </p>
      </div>

      <Card title="Who owes the shop" note="Biggest first. Ring the 90-day column.">
        <table className="w-full text-sm">
          <thead className="bg-stone-100 text-stone-600 text-left">
            <tr>
              <th className={TH}>Customer</th>
              <th className={THN}>Current</th>
              <th className={THN}>30</th>
              <th className={THN}>60</th>
              <th className={THN}>90+</th>
              <th className={THN + " pr-4"}>Owed</th>
            </tr>
          </thead>
          <tbody>
            {report.rows.length === 0 && <Empty span={6}>Nobody owes the shop anything.</Empty>}
            {report.rows.map((r) => (
              <tr key={r.customer_id} className={ROW}>
                <td className={TD}>
                  <span className="block">{r.customer}</span>
                  <span className="block text-xs text-stone-500">
                    {[r.code, r.phone].filter(Boolean).join(" · ") || "—"}
                  </span>
                </td>
                <td className={TDN + " text-stone-500"}>{money(r.current_due)}</td>
                <td className={TDN + " text-stone-500"}>{money(r.days30)}</td>
                <td className={TDN + " text-stone-500"}>{money(r.days60)}</td>
                <td className={`${TDN} ${r.days90 > 0 ? "text-amber-700" : "text-stone-500"}`}>
                  {money(r.days90)}
                </td>
                <td className={TDN + " pr-4"}>{money(r.total_due)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
    </div>
  );
}

function SuppliersView({ rows }: { rows: SupplierSpendRow[] }) {
  const total = rows.reduce((t, r) => t + (r.total ?? 0), 0);
  return (
    <Card
      title="What the shop bought"
      note={`${money(total)} on invoices and delivery notes in this range. A quotation is not a purchase and is counted separately.`}
    >
      <table className="w-full text-sm">
        <thead className="bg-stone-100 text-stone-600 text-left">
          <tr>
            <th className={TH}>Supplier</th>
            <th className={THN}>Documents</th>
            <th className={THN}>Booked in</th>
            <th className={THN}>Quoted</th>
            <th className={THN + " pr-4"}>Spent</th>
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 && (
            <Empty span={5}>
              No supplier paperwork in this range. Scan an invoice under Manage → Suppliers.
            </Empty>
          )}
          {rows.map((r, i) => (
            <tr key={i} className={ROW}>
              <td className={TD}>
                <span className="block">{r.supplier}</span>
                {r.last_document && (
                  <span className="block text-xs text-stone-500">last {fmtDayMonth(r.last_document)}</span>
                )}
              </td>
              <td className={TDN + " text-stone-500"}>{r.documents}</td>
              <td className={TDN + " text-stone-500"}>{r.received}</td>
              <td className={TDN + " text-stone-500"}>{r.quoted == null ? "—" : money(r.quoted)}</td>
              <td className={TDN + " pr-4"}>{r.total == null ? "—" : money(r.total)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </Card>
  );
}

/**
 * What walked out of the door without being sold.
 *
 * Stock leaving because somebody paid for it is business. Stock leaving any
 * other way is not, and until now the till recorded it faithfully and never
 * added it up. Counted short and written off are kept apart on purpose: they
 * have different cures.
 */
function LossesView({ report }: { report: Shrinkage }) {
  const t = report.totals;
  return (
    <div className="space-y-4">
      <div
        className="bg-white rounded-xl border border-stone-200 p-5 space-y-3"
        role="group"
        aria-label="Losses at a glance"
      >
        <div className="flex flex-wrap gap-x-8 gap-y-3 items-baseline">
          <Stat label="Lost, at cost" value={money(t.at_cost)} />
          <Stat label="Counted short" value={money(t.counted_short)} />
          <Stat label="Written off" value={money(t.written_off)} />
          <Stat label="Lines" value={String(t.lines)} />
        </div>
        <p className="text-xs text-stone-500">
          Everything that left the shelves without a sale. Counted short is
          what a stock take could not find; written off is what somebody
          adjusted by hand — breakages, damage, a bag that split.
        </p>
        {t.any_estimated && (
          <p className="px-3 py-2 bg-amber-100 text-amber-900 text-sm rounded-lg" role="status">
            Some of these movements were recorded before the shop kept a cost
            against them, so they are valued at today&rsquo;s cost and marked
            as estimates below.
          </p>
        )}
      </div>

      <Card title="What went missing">
        <table className="w-full text-sm">
          <thead className="bg-stone-100 text-stone-600 text-left">
            <tr>
              <th className={TH}>Item</th>
              <th className={TH}>Department</th>
              <th className={TH}>How</th>
              <th className={THN}>Units</th>
              <th className={THN}>At cost</th>
            </tr>
          </thead>
          <tbody>
            {report.rows.length === 0 && (
              <tr><td colSpan={5} className="px-3 py-6 text-center text-stone-500">
                Nothing has left the shelves except by being sold.
              </td></tr>
            )}
            {report.rows.map((r, i) => (
              <tr key={i} className="border-t border-stone-100">
                <td className={TD}>
                  <div className="font-medium">{r.item}</div>
                  <div className="text-xs text-stone-500">{r.sku ?? "—"}</div>
                </td>
                <td className={TD}>{r.department}</td>
                <td className={TD}>
                  {r.reason === "stocktake" ? "Counted short" : "Written off"}
                </td>
                <td className={TDN}>{r.qty}</td>
                <td className={TDN}>
                  {money(r.at_cost)}
                  {r.estimated && (
                    <div className="text-xs text-stone-500">estimated</div>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
    </div>
  );
}
