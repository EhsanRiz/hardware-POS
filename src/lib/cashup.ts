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
  /** Account settlements by method, every method — the card machine's batch
      total includes these, so the slip has to. Cash is also in account_cash. */
  account_payments?: Record<string, number>;
  refunds_count?: number;
  refunds_total?: number;
  /** What the card machine and the bank should show: sales by that tender
      plus account settlements by it. */
  card_expected?: number;
  eft_expected?: number;
  pay_in: number;
  pay_out: number;
  expected_cash: number;
}

/** Whether a drawer is open on this till, and since when. No PIN: it names a
    time and a person, never a figure, so the sign-in screen may ask. */
export interface CashSessionStatus {
  id: string;
  opened_at: string;
  opened_by_name: string;
  hours_open: number;
}

export async function cashSessionStatus(): Promise<CashSessionStatus | null> {
  const { data, error } = await supabase.rpc("pos_cash_session_status", {
    p_register_token: requireToken(),
  });
  if (error) throw error;
  return (data as CashSessionStatus | null) ?? null;
}

/** A drawer opened this long ago belongs to another day. */
export const STALE_SESSION_HOURS = 18;

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
  /** 0048: the card machine and the bank against the till, and the banking. */
  card_counted?: number | null;
  card_expected?: number | null;
  card_variance?: number | null;
  eft_counted?: number | null;
  eft_expected?: number | null;
  eft_variance?: number | null;
  banked?: number | null;
  float_kept?: number | null;
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

export interface CloseInput {
  countedCash: number;
  note: string | null;
  /** The card machine's batch total, if the shop has one. */
  cardCounted?: number | null;
  /** EFTs received, from the bank. */
  eftCounted?: number | null;
  /** Cash going to the bank; the rest stays as tomorrow's float. */
  banked?: number | null;
}

export async function closeSession(pin: string, input: CloseInput): Promise<CashSession> {
  const { data, error } = await supabase.rpc("pos_cash_session_close", {
    p_register_token: requireToken(),
    p_pin: pin,
    p_counted_cash: input.countedCash,
    p_note: input.note,
    p_card_counted: input.cardCounted ?? null,
    p_eft_counted: input.eftCounted ?? null,
    p_banked: input.banked ?? null,
  });
  if (error) throw error;
  return data as CashSession;
}

/** The float kept at the last close on this till, or null if it never said. */
export async function suggestedFloat(pin: string): Promise<number | null> {
  const { data, error } = await supabase.rpc("pos_cash_session_suggested_float", {
    p_register_token: requireToken(),
    p_pin: pin,
  });
  if (error) throw error;
  return data == null ? null : Number(data);
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
