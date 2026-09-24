// A count job (migration 0114): a shop's stock counted by people who are not
// on its staff.
//
// Two sets of calls. The COUNTER's carry the token a phone got by joining with
// the job's code, and nothing else — no register, no PIN, no shop. The SHOP's
// are the back office's usual register token and manager PIN, checked in the
// database on every call like the rest of adminApi.
import { requireToken } from "./api";
import { API_BASE, supabase } from "./supabase";

// --- the counter's side ------------------------------------------------------

export interface CountJoin {
  token: string;
  counter_id: string;
  counter_name: string;
  job_id: string;
  doc_number: string;
  note: string | null;
  shop_name: string;
}

export async function joinCount(code: string, name: string): Promise<CountJoin> {
  const { data, error } = await supabase.rpc("pos_count_join", {
    p_code: code,
    p_name: name,
  });
  if (error) throw error;
  const row = (data as CountJoin[] | null)?.[0];
  if (!row) throw new Error("That code is not open for counting");
  return row;
}

/** Something the shop already sells, as a counter sees it: no money in it. */
export interface CountProduct {
  id: string;
  name: string;
  sku: string;
  barcode: string | null;
  unit_code: string;
}

/** Something this count met that the catalogue did not know. */
export interface CountNewItem {
  id: string;
  name: string;
  barcode: string | null;
  unit_code: string;
}

export interface CountUnit {
  code: string;
  name: string;
  allows_fraction: boolean;
}

export interface CountState {
  job: { id: string; doc_number: string; note: string | null; shop_name: string };
  counter: { id: string; name: string };
  products: CountProduct[];
  new_items: CountNewItem[];
  units: CountUnit[];
}

export async function countState(token: string): Promise<CountState> {
  const { data, error } = await supabase.rpc("pos_count_state", { p_token: token });
  if (error) throw error;
  return data as CountState;
}

export interface CaptureInput {
  client_ref: string;
  product_id: string | null;
  new_item_id: string | null;
  barcode: string | null;
  name: string | null;
  unit_code: string | null;
  qty: number;
  location: string | null;
  captured_at: string;
}

export interface CaptureResult {
  id: string;
  product_id: string | null;
  new_item_id: string | null;
  name?: string;
  repeat: boolean;
}

export async function sendCapture(token: string, c: CaptureInput): Promise<CaptureResult> {
  const { data, error } = await supabase.rpc("pos_count_capture", {
    p_token: token,
    p_client_ref: c.client_ref,
    p_product_id: c.product_id,
    p_new_item_id: c.new_item_id,
    p_barcode: c.barcode,
    p_name: c.name,
    p_unit_code: c.unit_code,
    p_qty: c.qty,
    p_location: c.location,
    p_captured_at: c.captured_at,
  });
  if (error) throw error;
  return data as CaptureResult;
}

export async function voidCapture(token: string, clientRef: string): Promise<boolean> {
  const { data, error } = await supabase.rpc("pos_count_void", {
    p_token: token,
    p_client_ref: clientRef,
  });
  if (error) throw error;
  return data as boolean;
}

/**
 * "I'm done" (0115). The count cannot be posted while anybody on it has not
 * said this, so a counter is never shut out half-way down a shelf.
 */
export async function finishCount(token: string): Promise<void> {
  const { error } = await supabase.rpc("pos_count_finish", { p_token: token });
  if (error) throw error;
}

/** "Not done after all" — until the count is posted. */
export async function resumeCount(token: string): Promise<void> {
  const { error } = await supabase.rpc("pos_count_resume", { p_token: token });
  if (error) throw error;
}

/**
 * A photo on one of this phone's captures, through the same function that
 * stores product photos (the bucket is not writable with the anon key). Sent
 * again whenever the phone is unsure: the photo's own ref makes the second
 * send a no-op on the server.
 */
export async function uploadCountPhoto(
  token: string,
  captureRef: string,
  photoRef: string,
  dataUrl: string
): Promise<string> {
  const res = await fetch(`${API_BASE}/functions/v1/product-image`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      apikey: import.meta.env.VITE_SUPABASE_ANON_KEY,
      Authorization: `Bearer ${import.meta.env.VITE_SUPABASE_ANON_KEY}`,
    },
    body: JSON.stringify({
      count_token: token,
      capture_ref: captureRef,
      photo_ref: photoRef,
      image: dataUrl,
    }),
  });
  let body: { ok?: boolean; path?: string; message?: string } = {};
  try {
    body = await res.json();
  } catch {
    /* a proxy or a dropped line can answer with something that is not JSON */
  }
  if (!res.ok || !body.ok) {
    throw new Error(body.message ?? "The photo could not be sent.");
  }
  return body.path!;
}

// --- the shop's side ---------------------------------------------------------

export interface CountJob {
  id: string;
  doc_number: string;
  note: string | null;
  status: "open" | "posted" | "abandoned";
  /** Only while the job is open. */
  join_code: string | null;
  joining_open: boolean;
  opened_at: string;
  opened_by_name: string | null;
  posted_at: string | null;
  posted_by_name: string | null;
  counters: number;
  captures: number;
  products_counted: number;
  new_items: number;
  new_pending: number;
}

export async function countJobs(pin: string): Promise<CountJob[]> {
  const { data, error } = await supabase.rpc("pos_count_jobs", {
    p_register_token: requireToken(),
    p_pin: pin,
  });
  if (error) throw error;
  return (data ?? []) as CountJob[];
}

export async function openCountJob(pin: string, note: string | null): Promise<void> {
  const { error } = await supabase.rpc("pos_count_job_open", {
    p_register_token: requireToken(),
    p_pin: pin,
    p_note: note,
  });
  if (error) throw error;
}

export async function setCountJoining(pin: string, jobId: string, open: boolean): Promise<void> {
  const { error } = await supabase.rpc("pos_count_job_joining", {
    p_register_token: requireToken(),
    p_pin: pin,
    p_job_id: jobId,
    p_open: open,
  });
  if (error) throw error;
}

export interface CountCounter {
  id: string;
  name: string;
  active: boolean;
  joined_at: string;
  last_seen_at: string | null;
  captures: number;
  /** When they said "I'm done" — null while still counting (0115). */
  finished_at: string | null;
}

export async function countJobCounters(pin: string, jobId: string): Promise<CountCounter[]> {
  const { data, error } = await supabase.rpc("pos_count_job_counters", {
    p_register_token: requireToken(),
    p_pin: pin,
    p_job_id: jobId,
  });
  if (error) throw error;
  return (data ?? []) as CountCounter[];
}

export async function removeCountCounter(pin: string, counterId: string): Promise<void> {
  const { error } = await supabase.rpc("pos_count_job_remove_counter", {
    p_register_token: requireToken(),
    p_pin: pin,
    p_counter_id: counterId,
  });
  if (error) throw error;
}

/** An item the shop already has, and what posting will make its stock. */
export interface CountedLine {
  product_id: string;
  sku: string;
  name: string;
  unit_code: string;
  counted: number;
  captures: number;
  counters: string | null;
  locations: string | null;
  first_counted_at: string;
  on_hand: number | null;
  since: number;
  becomes: number;
}

export async function countJobCounted(pin: string, jobId: string): Promise<CountedLine[]> {
  const { data, error } = await supabase.rpc("pos_count_job_counted", {
    p_register_token: requireToken(),
    p_pin: pin,
    p_job_id: jobId,
  });
  if (error) throw error;
  return (data ?? []) as CountedLine[];
}

export type NewItemDecision = "pending" | "add" | "skip" | "merge";

export interface CountNewItemRow {
  id: string;
  barcode: string | null;
  name: string;
  unit_code: string;
  counted: number;
  captures: number;
  counters: string | null;
  locations: string | null;
  decision: NewItemDecision;
  merge_into: string | null;
  merge_product: string | null;
  merge_product_name: string | null;
  category_id: string | null;
  price_retail: number | null;
  price_trade: number | null;
  cost: number | null;
  product_id: string | null;
  /** Storage paths of the photos counters took of it (0115). */
  photos: string[];
}

export async function countJobNewItems(pin: string, jobId: string): Promise<CountNewItemRow[]> {
  const { data, error } = await supabase.rpc("pos_count_job_new_items", {
    p_register_token: requireToken(),
    p_pin: pin,
    p_job_id: jobId,
  });
  if (error) throw error;
  return (data ?? []) as CountNewItemRow[];
}

export interface NewItemReview {
  decision: NewItemDecision;
  name: string;
  /** "" clears a misread barcode; null keeps what was scanned. */
  barcode: string | null;
  unit_code: string;
  category_id: string | null;
  price_retail: number | null;
  price_trade: number | null;
  cost: number | null;
  merge_into: string | null;
  merge_product: string | null;
}

export async function reviewNewItem(pin: string, itemId: string, r: NewItemReview): Promise<void> {
  const { error } = await supabase.rpc("pos_count_new_item_review", {
    p_register_token: requireToken(),
    p_pin: pin,
    p_item_id: itemId,
    p_decision: r.decision,
    p_name: r.name,
    p_barcode: r.barcode,
    p_unit_code: r.unit_code,
    p_category_id: r.category_id,
    p_price_retail: r.price_retail,
    p_price_trade: r.price_trade,
    p_cost: r.cost,
    p_merge_into: r.merge_into,
    p_merge_product: r.merge_product,
  });
  if (error) throw error;
}

export interface CountPostResult {
  products_counted: number;
  products_created: number;
  created_hidden: number;
  lines_moved: number;
  units_up: number;
  units_down: number;
  /** Photos handed to products that had none (0115). */
  photos: number;
}

export async function postCountJob(pin: string, jobId: string): Promise<CountPostResult> {
  const { data, error } = await supabase.rpc("pos_count_job_post", {
    p_register_token: requireToken(),
    p_pin: pin,
    p_job_id: jobId,
  });
  if (error) throw error;
  return data as CountPostResult;
}

export async function abandonCountJob(pin: string, jobId: string): Promise<void> {
  const { error } = await supabase.rpc("pos_count_job_abandon", {
    p_register_token: requireToken(),
    p_pin: pin,
    p_job_id: jobId,
  });
  if (error) throw error;
}
