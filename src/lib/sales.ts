// Looking back at what was sold.
//
// The shop could ring sales up and never see one again — which reads as "the
// sale was lost" however healthy the database is. These are the four questions
// a counter actually asks, and they are all one query with different ends.
import { requireToken } from "./api";
import { supabase } from "./supabase";

export interface SaleRow {
  id: string;
  doc_number: string | null;
  created_at: string;
  cashier_name: string;
  customer_name: string | null;
  customer_phone: string | null;
  customer_address: string | null;
  trade_pricing: boolean;
  subtotal: number;
  total: number;
  tax_amount: number;
  discount_amount: number;
  discount_reason: string | null;
  paid_cash: number | null;
  paid_card: number | null;
  status: "completed" | "pending_approval" | "voided";
  payment_method: string | null;
  amount_tendered: number | null;
  change_due: number | null;
  rounding: number;
  po_number: string | null;
  customer_vat_number: string | null;
  item_count: number;
}

export interface SalesTotals {
  count: number;
  gross: number;
  vat: number;
  discount: number;
  voided: number;
  /** Takings by tender across the whole window, not just the rows shown. */
  tenders: Record<string, number>;
}

export interface SalesHistory {
  rows: SaleRow[];
  totals: SalesTotals;
}

/** The named ranges, plus the custom one. */
export type RangeKey = "today" | "yesterday" | "week" | "custom";

/**
 * Turn a range into two instants.
 *
 * Days are the shop's days, in the device's own timezone — a South African
 * counter closing at six means today ends at midnight where it stands, not at
 * midnight UTC. The end is exclusive so a sale rung up at 23:59:59.7 belongs to
 * the day it was rung up on rather than falling in a gap between two windows.
 */
export function rangeBounds(
  key: RangeKey,
  from?: string,
  to?: string
): { from: Date; to: Date } {
  const midnight = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const today = midnight(new Date());
  const plusDays = (d: Date, n: number) =>
    new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);

  switch (key) {
    case "today":
      return { from: today, to: plusDays(today, 1) };
    case "yesterday":
      return { from: plusDays(today, -1), to: today };
    case "week":
      // Seven days INCLUDING today, which is what "the last 7 days" means to
      // somebody who has been working all week.
      return { from: plusDays(today, -6), to: plusDays(today, 1) };
    case "custom": {
      const a = from ? new Date(from + "T00:00:00") : today;
      const b = to ? new Date(to + "T00:00:00") : a;
      // Both dates are inclusive to the person choosing them: picking the 1st
      // and the 1st means that whole day, not an empty instant.
      return { from: midnight(a), to: plusDays(midnight(b), 1) };
    }
  }
}

export async function salesHistory(
  pin: string,
  from: Date,
  to: Date
): Promise<SalesHistory> {
  const { data, error } = await supabase.rpc("pos_sales_history", {
    p_register_token: requireToken(),
    p_pin: pin,
    p_from: from.toISOString(),
    p_to: to.toISOString(),
    p_limit: 200,
  });
  if (error) throw error;
  return data as SalesHistory;
}
