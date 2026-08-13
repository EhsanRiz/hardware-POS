// Cashing up: opening the drawer, what moved in and out of it, and the count
// at the end of the day.
//
// Everything here re-checks cash_management server-side. The figures are the
// server's, never the device's: a variance computed on the tablet that took the
// money is not evidence of anything.
import { requireToken } from "./api";
import { supabase } from "./supabase";

/** What a session's window adds up to. */
export interface CashFigures {
  sales_count: number;
  sales_total: number;
  vat_total: number;
  discount_total: number;
  /** Takings by tender: { cash: 1200, card: 450, … }. */
  tenders: Record<string, number>;
  cash_sales: number;
  /** Account settlements paid in cash over the counter — drawer money too. */
  account_cash: number;
  pay_in: number;
  pay_out: number;
  expected_cash: number;
}

export interface CashMovement {
  id: string;
  kind: "pay_in" | "pay_out";
  amount: number;
  reason: string;
  by_name: string | null;
  created_at: string;
}

export interface CashSession {
  id: string;
  opened_by_name: string;
  opened_at: string;
  opening_float: number;
  closed_by_name: string | null;
  closed_at: string | null;
  counted_cash: number | null;
  expected_cash: number | null;
  variance: number | null;
  note: string | null;
  figures: CashFigures;
  movements?: CashMovement[];
}

export async function openSession(pin: string, float: number): Promise<void> {
  const { error } = await supabase.rpc("pos_cash_session_open", {
    p_register_token: requireToken(),
    p_pin: pin,
    p_opening_float: float,
  });
  if (error) throw error;
}

/** The open session on this till, or null if the drawer has not been opened. */
export async function currentSession(pin: string): Promise<CashSession | null> {
  const { data, error } = await supabase.rpc("pos_cash_session_current", {
    p_register_token: requireToken(),
    p_pin: pin,
  });
  if (error) throw error;
  return (data as CashSession | null) ?? null;
}

export async function addMovement(
  pin: string,
  kind: "pay_in" | "pay_out",
  amount: number,
  reason: string
): Promise<void> {
  const { error } = await supabase.rpc("pos_cash_movement", {
    p_register_token: requireToken(),
    p_pin: pin,
    p_kind: kind,
    p_amount: amount,
    p_reason: reason,
  });
  if (error) throw error;
}

export async function closeSession(
  pin: string,
  countedCash: number,
  note: string | null
): Promise<CashSession> {
  const { data, error } = await supabase.rpc("pos_cash_session_close", {
    p_register_token: requireToken(),
    p_pin: pin,
    p_counted_cash: countedCash,
    p_note: note,
  });
  if (error) throw error;
  return data as CashSession;
}

/** Closed sessions, newest first, so yesterday's can be reprinted. */
export async function pastSessions(pin: string): Promise<CashSession[]> {
  const { data, error } = await supabase.rpc("pos_cash_sessions", {
    p_register_token: requireToken(),
    p_pin: pin,
    p_limit: 30,
  });
  if (error) throw error;
  return (data as CashSession[]) ?? [];
}
