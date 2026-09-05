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

// --- 0063: the rest of the questions -----------------------------------------

export interface DeliveryReportTotals {
  count: number;
  delivered: number;
  outstanding: number;
  late: number;
  carriage: number;
  carriage_free: number;
  carriage_net: number;
  carriage_cost: number;
  carriage_margin: number;
}

export interface OutstandingDelivery {
  id: string;
  doc_number: string;
  customer_name: string;
  address: string;
  deliver_on: string;
  deliver_at: string | null;
  charge: number;
  sale_number: string | null;
  cashier_name: string | null;
  days_late: number;
}

export interface DeliveriesReport {
  totals: DeliveryReportTotals;
  outstanding: OutstandingDelivery[];
}

export async function deliveriesReport(
  pin: string, from: Date, to: Date
): Promise<DeliveriesReport> {
  const { data, error } = await supabase.rpc("pos_deliveries_report", {
    p_register_token: requireToken(), p_pin: pin,
    p_from: from.toISOString(), p_to: to.toISOString(),
  });
  if (error) throw error;
  return data as DeliveriesReport;
}

export interface CashierRow {
  cashier: string;
  sales_count: number;
  sales: number;
  net: number;
  average: number;
  discount: number;
  refunds_count: number;
  refunds: number;
}

export async function salesByCashier(
  pin: string, from: Date, to: Date
): Promise<CashierRow[]> {
  const { data, error } = await supabase.rpc("pos_sales_by_cashier", {
    p_register_token: requireToken(), p_pin: pin,
    p_from: from.toISOString(), p_to: to.toISOString(),
  });
  if (error) throw error;
  return (data as CashierRow[]) ?? [];
}

export interface MoneyBackRow {
  kind: "return" | "cancelled";
  at: string;
  amount: number;
  doc_number: string | null;
  against: string | null;
  who: string | null;
  reason: string | null;
  refund_method: string | null;
}

export async function moneyBack(
  pin: string, from: Date, to: Date
): Promise<MoneyBackRow[]> {
  const { data, error } = await supabase.rpc("pos_money_back", {
    p_register_token: requireToken(), p_pin: pin,
    p_from: from.toISOString(), p_to: to.toISOString(),
  });
  if (error) throw error;
  return (data as MoneyBackRow[]) ?? [];
}

export interface ItemRow {
  sku: string | null;
  item: string;
  department: string;
  qty: number;
  unit: string;
  lines: number;
  sales: number;
  net: number;
  cost: number | null;
  uncosted_lines: number;
  margin: number | null;
  on_hand: number | null;
}

export async function itemMovement(
  pin: string, from: Date, to: Date, limit = 200
): Promise<ItemRow[]> {
  const { data, error } = await supabase.rpc("pos_item_movement", {
    p_register_token: requireToken(), p_pin: pin,
    p_from: from.toISOString(), p_to: to.toISOString(), p_limit: limit,
  });
  if (error) throw error;
  return (data as ItemRow[]) ?? [];
}

export interface StockValueDept {
  department: string;
  lines: number;
  units: number;
  at_cost: number | null;
  at_retail: number;
  uncosted_lines: number;
  negative_lines: number;
}

export interface StockValue {
  departments: StockValueDept[];
  totals: {
    at_cost: number; at_retail: number; units: number; lines: number;
    uncosted_lines: number; negative_lines: number;
  };
}

export async function stockValue(pin: string): Promise<StockValue> {
  const { data, error } = await supabase.rpc("pos_stock_value", {
    p_register_token: requireToken(), p_pin: pin,
  });
  if (error) throw error;
  return data as StockValue;
}

export interface MarginRow {
  sku: string;
  item: string;
  department: string;
  cost: number;
  retail: number;
  on_hand: number | null;
  net_retail: number;
  margin: number;
  margin_percent: number | null;
  below_cost: boolean;
}

export async function marginSlipped(pin: string, below = 15): Promise<MarginRow[]> {
  const { data, error } = await supabase.rpc("pos_margin_slipped", {
    p_register_token: requireToken(), p_pin: pin, p_below: below,
  });
  if (error) throw error;
  return (data as MarginRow[]) ?? [];
}

export interface DebtorRow {
  customer_id: string;
  customer: string;
  code: string | null;
  phone: string | null;
  current_due: number;
  days30: number;
  days60: number;
  days90: number;
  total_due: number;
  oldest_unpaid: string | null;
  credit_limit: number | null;
}

export interface DebtorsAgeing {
  rows: DebtorRow[];
  totals: {
    current: number; days30: number; days60: number; days90: number;
    total: number; accounts: number;
  };
}

export async function debtorsAgeing(pin: string): Promise<DebtorsAgeing> {
  const { data, error } = await supabase.rpc("pos_debtors_ageing", {
    p_register_token: requireToken(), p_pin: pin,
  });
  if (error) throw error;
  return data as DebtorsAgeing;
}

export interface SupplierSpendRow {
  supplier: string;
  documents: number;
  received: number;
  total: number | null;
  quoted: number | null;
  last_document: string | null;
}

export async function purchasesBySupplier(
  pin: string, from: Date, to: Date
): Promise<SupplierSpendRow[]> {
  const { data, error } = await supabase.rpc("pos_purchases_by_supplier", {
    p_register_token: requireToken(), p_pin: pin,
    p_from: from.toISOString(), p_to: to.toISOString(),
  });
  if (error) throw error;
  return (data as SupplierSpendRow[]) ?? [];
}

export interface ShrinkageRow {
  department: string;
  item: string;
  sku: string | null;
  /** 'stocktake' — a count found it missing. 'adjustment' — written off. */
  reason: "stocktake" | "adjustment";
  qty: number;
  at_cost: number;
  /** True where this is today's cost, not the cost on the day it was lost. */
  estimated: boolean;
}

export interface Shrinkage {
  rows: ShrinkageRow[];
  totals: {
    at_cost: number;
    counted_short: number;
    written_off: number;
    lines: number;
    any_estimated: boolean;
  };
  from: string;
  to: string;
}

/**
 * What walked out of the door without being sold, over a window.
 *
 * Dates rather than timestamps: a loss is discovered on a day, not at a
 * moment, and a stock take that ran over lunch belongs to that day whole.
 */
export async function shrinkage(
  pin: string, from: Date, to: Date
): Promise<Shrinkage> {
  const day = (d: Date) =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  const { data, error } = await supabase.rpc("pos_shrinkage", {
    p_register_token: requireToken(), p_pin: pin,
    p_from: day(from), p_to: day(to),
  });
  if (error) throw error;
  return data as Shrinkage;
}
