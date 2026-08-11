// Back-office calls. Every one of these is PIN-gated and permission-checked in
// the database, so the manager's PIN is passed per call rather than held in a
// session — it is typed once when the Manage area is opened and kept in memory
// only, never written to the device.
//
// The register token travels with every call too. It is not a second secret so
// much as an address: it tells the server WHICH shop's staff list to check the
// PIN against, because a PIN alone identifies nobody in a multi-tenant system.
import { requireToken } from "./api";
import { supabase } from "./supabase";
import type { AdminProduct, Category, StockMovement, UnitOfMeasure } from "./types";

export async function adminListProducts(pin: string): Promise<AdminProduct[]> {
  const { data, error } = await supabase.rpc("pos_admin_list_products", {
    p_register_token: requireToken(),
    p_pin: pin,
  });
  if (error) throw error;
  return data as AdminProduct[];
}

export interface ProductInput {
  id?: string | null;
  sku: string;
  barcode: string | null;
  name: string;
  description: string | null;
  category_id: string | null;
  unit_code: string;
  price_retail: number;
  price_trade: number | null;
  cost: number | null;
  tax_code: string;
  stock_qty: number | null;
  reorder_level: number | null;
  active: boolean;
  /** Shelf or bin location — where in the shop the thing physically is. */
  bin?: string | null;
}

export async function adminSaveProduct(
  pin: string,
  p: ProductInput
): Promise<void> {
  const { error } = await supabase.rpc("pos_admin_save_product", {
    p_register_token: requireToken(),
    p_pin: pin,
    p_id: p.id ?? null,
    p_sku: p.sku,
    p_barcode: p.barcode,
    p_name: p.name,
    p_description: p.description,
    p_category_id: p.category_id,
    p_unit_code: p.unit_code,
    p_price_retail: p.price_retail,
    p_price_trade: p.price_trade,
    p_cost: p.cost,
    p_tax_code: p.tax_code,
    p_stock_qty: p.stock_qty,
    p_reorder_level: p.reorder_level,
    p_active: p.active,
    p_bin: p.bin ?? null,
  });
  if (error) throw error;
}

/** Returns "deactivated" for a product with sale history, "deleted" otherwise. */
export async function adminDeleteProduct(
  pin: string,
  id: string
): Promise<string> {
  const { data, error } = await supabase.rpc("pos_admin_delete_product", {
    p_register_token: requireToken(),
    p_pin: pin,
    p_id: id,
  });
  if (error) throw error;
  return data as string;
}

/** Set stock to a counted figure; the difference is written to the ledger. */
export async function adminAdjustStock(
  pin: string,
  productId: string,
  newQty: number,
  note: string | null
): Promise<void> {
  const { error } = await supabase.rpc("pos_admin_adjust_stock", {
    p_register_token: requireToken(),
    p_pin: pin,
    p_product_id: productId,
    p_new_qty: newQty,
    p_note: note,
  });
  if (error) throw error;
}

export async function adminStockHistory(
  pin: string,
  productId: string
): Promise<StockMovement[]> {
  const { data, error } = await supabase.rpc("pos_admin_stock_history", {
    p_register_token: requireToken(),
    p_pin: pin,
    p_product_id: productId,
  });
  if (error) throw error;
  return data as StockMovement[];
}

export async function adminSaveCategory(
  pin: string,
  c: { id?: string | null; name: string; sort_order: number; active: boolean }
): Promise<void> {
  const { error } = await supabase.rpc("pos_admin_save_category", {
    p_register_token: requireToken(),
    p_pin: pin,
    p_id: c.id ?? null,
    p_name: c.name,
    p_sort_order: c.sort_order,
    p_active: c.active,
  });
  if (error) throw error;
}

export async function adminDeleteCategory(
  pin: string,
  id: string,
  reassignTo: string | null
): Promise<void> {
  const { error } = await supabase.rpc("pos_admin_delete_category", {
    p_register_token: requireToken(),
    p_pin: pin,
    p_id: id,
    p_reassign_to: reassignTo,
  });
  if (error) throw error;
}

export interface ImportRow {
  sku: string;
  name?: string;
  barcode?: string;
  category?: string;
  unit?: string;
  price?: number;
  trade?: number;
  cost?: number;
  stock?: number;
  reorder?: number;
}

export interface ImportResult {
  row_no: number;
  sku: string;
  outcome: "created" | "updated" | "rejected";
  detail: string | null;
}

export async function adminImportProducts(
  pin: string,
  rows: ImportRow[]
): Promise<ImportResult[]> {
  const { data, error } = await supabase.rpc("pos_admin_import_products", {
    p_register_token: requireToken(),
    p_pin: pin,
    p_rows: rows,
  });
  if (error) throw error;
  return data as ImportResult[];
}

export async function adminSaveSettings(
  pin: string,
  settings: Record<string, string>
): Promise<void> {
  const { error } = await supabase.rpc("pos_admin_save_settings", {
    p_register_token: requireToken(),
    p_pin: pin,
    p_settings: settings,
  });
  if (error) throw error;
}

/** Staff roster for this shop. Names, phones, roles — never PINs. */
export interface StaffUser {
  id: string;
  name: string;
  phone: string;
  role: "admin" | "manager" | "employee";
  status: "invited" | "active" | "disabled";
  active: boolean;
  permissions: string[];
}

export async function adminListUsers(pin: string): Promise<StaffUser[]> {
  const { data, error } = await supabase.rpc("pos_admin_list_users", {
    p_register_token: requireToken(),
    p_pin: pin,
  });
  if (error) throw error;
  return data as StaffUser[];
}

/**
 * Invite a colleague by phone number. The row is created 'invited' with no
 * PIN; they prove possession of the phone via OTP and choose their own PIN at
 * the enrolment page. Nobody ever learns anyone else's PIN.
 */
export async function adminInviteUser(
  pin: string,
  name: string,
  phone: string,
  role: "admin" | "manager" | "employee" = "employee",
  permissions: string[] = []
): Promise<StaffUser> {
  const { data, error } = await supabase.rpc("pos_admin_invite_user", {
    p_register_token: requireToken(),
    p_pin: pin,
    p_name: name,
    p_phone: phone,
    p_role: role,
    p_permissions: permissions,
  });
  if (error) throw error;
  const rows = data as StaffUser[];
  if (!rows?.[0]) throw new Error("Invite failed");
  return rows[0];
}

// Units are global reference data (kg, ea, m) with nothing tenant-specific in
// them, so they remain a plain anon-readable table — the one survivor of the
// old "just read the table" era.
export async function fetchUnits(): Promise<UnitOfMeasure[]> {
  const { data, error } = await supabase
    .from("units_of_measure")
    .select("code, name, allows_fraction, sort_order")
    .order("sort_order");
  if (error) throw error;
  return data as UnitOfMeasure[];
}

export async function fetchAllCategories(): Promise<Category[]> {
  const { data, error } = await supabase.rpc("pos_categories", {
    p_register_token: requireToken(),
  });
  if (error) throw error;
  return data as Category[];
}
