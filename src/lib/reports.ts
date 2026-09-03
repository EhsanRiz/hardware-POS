// Reports: the numbers, out of the till. Everything here is read-only and
// re-checks view_reports server-side. Windows are decided on the device, so
// "today" is the shop's today (see rangeBounds in sales.ts).
import { requireToken } from "./api";
import { supabase } from "./supabase";
import type { CashFigures, CashSession } from "./cashup";

export interface DayCloseSession extends CashSession {
  register_name: string | null;
}

export interface DayCloseTotals {
  sales_count: number;
  sales_total: number;
  vat_total: number;
  discount_total: number;
  refunds_count: number;
  refunds_total: number;
  tenders: Record<string, number>;
  account_payments: Record<string, number>;
  card_expected: number;
  eft_expected: number;
  sessions_open: number;
  floats: number;
  cash_expected: number;
  cash_counted: number;
  cash_variance: number;
  card_counted: number;
  card_variance: number;
  eft_counted: number;
  eft_variance: number;
  banked: number;
  float_kept: number;
}

export interface DayClose {
  sessions: DayCloseSession[];
  totals: DayCloseTotals;
}

export async function dayClose(pin: string, from: Date, to: Date): Promise<DayClose> {
  const { data, error } = await supabase.rpc("pos_day_close", {
    p_register_token: requireToken(),
    p_pin: pin,
    p_from: from.toISOString(),
    p_to: to.toISOString(),
  });
  if (error) throw error;
  return data as DayClose;
}

export interface DepartmentRow {
  department: string;
  lines: number;
  qty: number;
  sales: number;
  vat: number;
  net: number;
  cost: number | null;
  uncosted_lines: number;
  margin: number | null;
  margin_percent: number | null;
}

export async function salesByDepartment(pin: string, from: Date, to: Date): Promise<DepartmentRow[]> {
  const { data, error } = await supabase.rpc("pos_sales_by_department", {
    p_register_token: requireToken(),
    p_pin: pin,
    p_from: from.toISOString(),
    p_to: to.toISOString(),
  });
  if (error) throw error;
  return (data as DepartmentRow[]) ?? [];
}

export interface VatMonth {
  month: string;
  sales_count: number;
  gross: number;
  vat: number;
  net: number;
  refunds: number;
  refunds_vat: number;
  vat_due: number;
}

export async function vatByMonth(pin: string, months = 12): Promise<VatMonth[]> {
  const { data, error } = await supabase.rpc("pos_vat_by_month", {
    p_register_token: requireToken(),
    p_pin: pin,
    p_months: months,
    p_tz: Intl.DateTimeFormat().resolvedOptions().timeZone || "Africa/Johannesburg",
  });
  if (error) throw error;
  return (data as VatMonth[]) ?? [];
}

export interface ExportRow {
  doc_number: string | null;
  created_at: string;
  status: string;
  cashier: string;
  customer: string | null;
  payment_method: string | null;
  sku: string | null;
  item: string;
  department: string | null;
  qty: number;
  unit: string;
  unit_price: number;
  line_total: number;
  vat: number;
  discount: number;
  cost_at_sale: number | null;
}

export async function exportSales(pin: string, from: Date, to: Date): Promise<ExportRow[]> {
  const { data, error } = await supabase.rpc("pos_export_sales", {
    p_register_token: requireToken(),
    p_pin: pin,
    p_from: from.toISOString(),
    p_to: to.toISOString(),
  });
  if (error) throw error;
  return (data as ExportRow[]) ?? [];
}

/** RFC 4180 enough for Excel: quoted fields, doubled quotes, CRLF lines. */
export function toCsv(rows: Record<string, unknown>[], columns: string[]): string {
  const cell = (v: unknown) => {
    if (v == null) return "";
    const s = typeof v === "number" ? String(v) : String(v);
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [columns.join(",")];
  for (const r of rows) lines.push(columns.map((c) => cell(r[c])).join(","));
  return lines.join("\r\n") + "\r\n";
}

/** Hand the browser a file. A BOM so Excel reads the rands as text, not maths. */
export function downloadText(filename: string, text: string, type = "text/csv"): void {
  const blob = new Blob(["\ufeff" + text], { type: `${type};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export const EXPORT_COLUMNS: (keyof ExportRow)[] = [
  "doc_number", "created_at", "status", "cashier", "customer", "payment_method",
  "sku", "item", "department", "qty", "unit", "unit_price", "line_total", "vat",
  "discount", "cost_at_sale",
];

/** Re-exported so the reports screen has one import for figures too. */
export type { CashFigures };
