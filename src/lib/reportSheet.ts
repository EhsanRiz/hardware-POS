/**
 * A report, as a sheet of A4.
 *
 * The day close printed as a 48-column till slip and everything else printed
 * as nothing at all — so "can I have that for the file" or "the bank wants to
 * see it" meant a screenshot. These come out on the SAME letterhead the shop's
 * quotations and invoices use, because a page that leaves the building should
 * look like it came from the same place as the rest of the shop's paper.
 *
 * The mapping lives here, apart from the screen, for two reasons. It is pure —
 * data in, strings out — so what goes on the paper can be checked without a
 * browser. And it is ONE place: every report's paper version is decided in
 * this file rather than scattered through a dozen table components.
 *
 * The figures come from the same server rows the screen renders. There is no
 * second sum anywhere in here; a column is a column of the row it was handed.
 */
import { MONTHS } from "./dates";
import { money } from "./money";
import type {
  CashierRow, DayClose, DebtorsAgeing, DeliveriesReport, DepartmentRow,
  ItemRow, MoneyBackRow, Shrinkage, StockValue, SupplierSpendRow, VatMonth,
} from "./reports";

export interface ReportColumn {
  label: string;
  /** Right-aligned and tabular: a column of money or a count. */
  num?: boolean;
}

export interface ReportSheetData {
  title: string;
  /** "Today", "1 Sep – 7 Sep 2026", or "As it stands now". */
  period: string;
  columns: ReportColumn[];
  rows: string[][];
  /** The emphasised last line, when the report has one. */
  total?: string[];
  /** Said under the table when the figures need a caveat. */
  note?: string;
}

/**
 * The window a report covers, as a person would say it.
 *
 * "13 Sep – 13 Sep" is how a date range prints when nobody looked at it: a
 * single day said twice, and no year at all on a page that will be found in a
 * drawer next March. One day is one date; a range inside one month keeps the
 * month once; anything else spells both ends out.
 *
 * `to` is the EXCLUSIVE end the query used, so the last day of the range is
 * the moment before it — the same arithmetic the rest of the app does.
 */
export function reportPeriod(from: Date, to: Date): string {
  const last = new Date(to.getTime() - 1);
  const d = (x: Date) => x.getDate();
  const mon = (x: Date) => MONTHS[x.getMonth()];
  const yr = (x: Date) => x.getFullYear();

  if (from.toDateString() === last.toDateString()) {
    return `${d(from)} ${mon(from)} ${yr(from)}`;
  }
  if (yr(from) === yr(last) && mon(from) === mon(last)) {
    return `${d(from)} – ${d(last)} ${mon(last)} ${yr(last)}`;
  }
  if (yr(from) === yr(last)) {
    return `${d(from)} ${mon(from)} – ${d(last)} ${mon(last)} ${yr(last)}`;
  }
  return `${d(from)} ${mon(from)} ${yr(from)} – ${d(last)} ${mon(last)} ${yr(last)}`;
}

const R = (n: number | null | undefined): string =>
  n == null ? "—" : money(n);

const N = (n: number | null | undefined, dp = 0): string =>
  n == null ? "—" : n.toFixed(dp);

/** A percentage as a shop reads one, or a dash when it cannot be worked out. */
const PC = (n: number | null | undefined): string =>
  n == null ? "—" : `${n.toFixed(1)}%`;

/**
 * How many lines could not be costed, said out loud.
 *
 * A margin worked out over lines whose cost is unknown is not a margin, and a
 * printed page is exactly where that silently becomes a fact somebody quotes
 * back at you. Every report that shows a margin carries this note.
 */
function uncostedNote(lines: number): string | undefined {
  if (!lines) return undefined;
  return lines === 1
    ? "One line had no cost recorded, so the margin is worked out without it."
    : `${lines} lines had no cost recorded, so the margin is worked out without them.`;
}

export function dayCloseSheet(d: DayClose, period: string): ReportSheetData {
  const t = d.totals;
  const rows: string[][] = [
    ["Sales", String(t.sales_count), R(t.sales_total)],
    ["VAT within", "", R(t.vat_total)],
    ["Discounts given", "", R(t.discount_total)],
    ["Refunds", String(t.refunds_count), R(t.refunds_total)],
  ];
  // Every way the shop was paid, in the order the drawer sees them.
  for (const [method, amount] of Object.entries(t.tenders)) {
    rows.push([`Taken — ${TENDER[method] ?? method}`, "", R(amount)]);
  }
  for (const [method, amount] of Object.entries(t.account_payments)) {
    rows.push([`Account payment — ${TENDER[method] ?? method}`, "", R(amount)]);
  }
  if (t.card_expected) rows.push(["Card expected at the bank", "", R(t.card_expected)]);
  if (t.eft_expected) rows.push(["EFT expected at the bank", "", R(t.eft_expected)]);

  return {
    title: "Day close",
    period,
    columns: [{ label: "" }, { label: "Count", num: true }, { label: "Amount", num: true }],
    rows,
    total: ["Sales less refunds", "", R(t.sales_total - t.refunds_total)],
  };
}

const TENDER: Record<string, string> = {
  cash: "Cash", card: "Card", eft: "EFT", zapper: "Zapper", account: "On account",
};

export function departmentsSheet(rows: DepartmentRow[], period: string): ReportSheetData {
  const uncosted = rows.reduce((n, r) => n + r.uncosted_lines, 0);
  return {
    title: "Sales by department",
    period,
    columns: [
      { label: "Department" },
      { label: "Lines", num: true },
      { label: "Sold", num: true },
      { label: "Sales", num: true },
      { label: "VAT", num: true },
      { label: "Margin", num: true },
      { label: "Margin %", num: true },
    ],
    rows: rows.map((r) => [
      r.department, String(r.lines), N(r.qty, 2), R(r.sales), R(r.vat),
      R(r.margin), PC(r.margin_percent),
    ]),
    total: [
      "Total",
      String(rows.reduce((n, r) => n + r.lines, 0)),
      "",
      R(rows.reduce((n, r) => n + r.sales, 0)),
      R(rows.reduce((n, r) => n + r.vat, 0)),
      "",
      "",
    ],
    note: uncostedNote(uncosted),
  };
}

export function itemsSheet(rows: ItemRow[], period: string): ReportSheetData {
  const uncosted = rows.reduce((n, r) => n + r.uncosted_lines, 0);
  return {
    title: "Sales by item",
    period,
    columns: [
      { label: "Code" }, { label: "Item" }, { label: "Department" },
      { label: "Sold", num: true }, { label: "Sales", num: true },
      { label: "Margin", num: true }, { label: "On hand", num: true },
    ],
    rows: rows.map((r) => [
      r.sku ?? "—", r.item, r.department, `${N(r.qty, 2)} ${r.unit}`,
      R(r.sales), R(r.margin), r.on_hand == null ? "not tracked" : N(r.on_hand, 2),
    ]),
    total: ["", "Total", "", "", R(rows.reduce((n, r) => n + r.sales, 0)), "", ""],
    note: uncostedNote(uncosted),
  };
}

export function peopleSheet(rows: CashierRow[], period: string): ReportSheetData {
  return {
    title: "Sales by person",
    period,
    columns: [
      { label: "Who" }, { label: "Sales", num: true }, { label: "Taken", num: true },
      { label: "Average", num: true }, { label: "Discount", num: true },
      { label: "Refunds", num: true },
    ],
    rows: rows.map((r) => [
      r.cashier, String(r.sales_count), R(r.sales), R(r.average), R(r.discount),
      `${r.refunds_count} · ${money(r.refunds)}`,
    ]),
    total: [
      "Total",
      String(rows.reduce((n, r) => n + r.sales_count, 0)),
      R(rows.reduce((n, r) => n + r.sales, 0)),
      "", R(rows.reduce((n, r) => n + r.discount, 0)),
      R(rows.reduce((n, r) => n + r.refunds, 0)),
    ],
  };
}

export function refundsSheet(rows: MoneyBackRow[], period: string): ReportSheetData {
  return {
    title: "Money back",
    period,
    columns: [
      { label: "When" }, { label: "What" }, { label: "Against" },
      { label: "Who" }, { label: "Why" }, { label: "Amount", num: true },
    ],
    rows: rows.map((r) => [
      r.at, r.kind === "return" ? "Return" : "Cancelled", r.against ?? r.doc_number ?? "—",
      r.who ?? "—", r.reason ?? "—", R(r.amount),
    ]),
    total: ["", "", "", "", "Total", R(rows.reduce((n, r) => n + r.amount, 0))],
  };
}

export function suppliersSheet(rows: SupplierSpendRow[], period: string): ReportSheetData {
  return {
    title: "Spend by supplier",
    period,
    columns: [
      { label: "Supplier" }, { label: "Documents", num: true },
      { label: "Received", num: true }, { label: "Invoiced", num: true },
      { label: "Quoted", num: true }, { label: "Last document" },
    ],
    rows: rows.map((r) => [
      r.supplier, String(r.documents), String(r.received), R(r.total), R(r.quoted),
      r.last_document ?? "—",
    ]),
    total: [
      "Total", String(rows.reduce((n, r) => n + r.documents, 0)), "",
      R(rows.reduce((n, r) => n + (r.total ?? 0), 0)), "", "",
    ],
  };
}

export function vatSheet(rows: VatMonth[]): ReportSheetData {
  return {
    title: "VAT",
    // A VAT report is not a window somebody chose: it is every month the till
    // has taken money in.
    period: "By month",
    columns: [
      { label: "Month" }, { label: "Sales", num: true }, { label: "Gross", num: true },
      { label: "VAT", num: true }, { label: "Refunds", num: true },
      { label: "VAT on refunds", num: true }, { label: "VAT due", num: true },
    ],
    rows: rows.map((r) => [
      r.month, String(r.sales_count), R(r.gross), R(r.vat), R(r.refunds),
      R(r.refunds_vat), R(r.vat_due),
    ]),
    total: [
      "Total", "", R(rows.reduce((n, r) => n + r.gross, 0)),
      R(rows.reduce((n, r) => n + r.vat, 0)), "", "",
      R(rows.reduce((n, r) => n + r.vat_due, 0)),
    ],
    note:
      "Worked out from the till's own sales. It is not a return, and it does " +
      "not know about anything the shop bought.",
  };
}

export function stockSheet(v: StockValue): ReportSheetData {
  const uncosted = v.departments.reduce((n, d) => n + d.uncosted_lines, 0);
  return {
    title: "Stock on hand",
    period: "As it stands now",
    columns: [
      { label: "Department" }, { label: "Lines", num: true },
      { label: "Units", num: true }, { label: "At cost", num: true },
      { label: "At retail", num: true },
    ],
    rows: v.departments.map((d) => [
      d.department, String(d.lines), N(d.units, 2), R(d.at_cost), R(d.at_retail),
    ]),
    total: [
      "Total", String(v.totals.lines), N(v.totals.units, 2),
      R(v.totals.at_cost), R(v.totals.at_retail),
    ],
    note: uncosted
      ? `${uncosted} lines have no cost recorded, so the value at cost is short by whatever they are worth.`
      : undefined,
  };
}

export function lossesSheet(s: Shrinkage, period: string): ReportSheetData {
  return {
    title: "Losses",
    period,
    columns: [
      { label: "Item" }, { label: "Code" }, { label: "Department" },
      { label: "Why" }, { label: "Quantity", num: true }, { label: "At cost", num: true },
    ],
    rows: s.rows.map((r) => [
      r.item, r.sku ?? "—", r.department,
      r.reason === "stocktake" ? "Stock take" : "Adjustment",
      N(r.qty, 2), r.estimated ? `${money(r.at_cost)} *` : R(r.at_cost),
    ]),
    total: ["", "", "", "", "Total", R(s.totals.at_cost)],
    note: s.rows.some((r) => r.estimated)
      ? "* Costed at today's price, because no cost was recorded when it went."
      : undefined,
  };
}

export function debtorsSheet(d: DebtorsAgeing): ReportSheetData {
  return {
    title: "Who owes the shop",
    period: "As it stands now",
    columns: [
      { label: "Customer" }, { label: "Account" }, { label: "Current", num: true },
      { label: "30 days", num: true }, { label: "60 days", num: true },
      { label: "90 days +", num: true }, { label: "Total", num: true },
    ],
    rows: d.rows.map((r) => [
      r.customer, r.code ?? "—", R(r.current_due), R(r.days30), R(r.days60),
      R(r.days90), R(r.total_due),
    ]),
    total: [
      `${d.totals.accounts} accounts`, "", R(d.totals.current), R(d.totals.days30),
      R(d.totals.days60), R(d.totals.days90), R(d.totals.total),
    ],
  };
}

export function deliveriesSheet(r: DeliveriesReport, period: string): ReportSheetData {
  const t = r.totals;
  return {
    title: "Deliveries",
    period,
    columns: [{ label: "" }, { label: "Amount", num: true }],
    rows: [
      ["Booked", String(t.count)],
      ["Delivered", String(t.delivered)],
      ["Still to go out", String(t.outstanding)],
      ["Late", String(t.late)],
      ["Carriage charged", R(t.carriage)],
      ["Carriage not charged", R(t.carriage_free)],
      ["Carriage cost", R(t.carriage_cost)],
    ],
    total: ["Carriage margin", R(t.carriage_margin)],
    note: r.outstanding.length
      ? `${r.outstanding.length} ${r.outstanding.length === 1 ? "delivery is" : "deliveries are"} still to go out.`
      : undefined,
  };
}
