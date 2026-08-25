// Back-office calls. Every one of these is PIN-gated and permission-checked in
// the database, so the manager's PIN is passed per call rather than held in a
// session — it is typed once when the Manage area is opened and kept in memory
// only, never written to the device.
//
// The register token travels with every call too. It is not a second secret so
// much as an address: it tells the server WHICH shop's staff list to check the
// PIN against, because a PIN alone identifies nobody in a multi-tenant system.
import { requireToken } from "./api";
import { API_BASE, supabase } from "./supabase";
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
  /**
   * The shop's ceiling on discounting this line, overriding whatever anybody
   * at the till is allowed to give. Null clears it — unlike the picture in
   * 0027, an empty box here means "no cap", because a cap you cannot remove
   * by clearing the box would be a trap.
   */
  max_discount_percent?: number | null;
  max_discount_amount?: number | null;
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
    p_max_discount_percent: p.max_discount_percent ?? null,
    p_max_discount_amount: p.max_discount_amount ?? null,
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

/**
 * Book in a delivery: many lines, one supplier reference, all or nothing.
 *
 * One movement per line, each stamped 'receipt' with the reference, so the
 * ledger can answer "where did these 200 bags come from" months later.
 */
export async function receiveStock(
  pin: string,
  lines: { product_id: string; qty: number }[],
  reference: string | null,
  note: string | null
): Promise<{ product_id: string; name: string; received: number; stock_qty: number }[]> {
  const { data, error } = await supabase.rpc("pos_receive_stock", {
    p_register_token: requireToken(),
    p_pin: pin,
    p_lines: lines,
    p_reference: reference,
    p_note: note,
  });
  if (error) throw error;
  return data as { product_id: string; name: string; received: number; stock_qty: number }[];
}

export interface StockMovementRow {
  at: string;
  product_id: string;
  product_name: string;
  qty_delta: number;
  qty_after: number;
  reason: string;
  by_name: string | null;
  note: string | null;
}

/** Everything that moved, shop-wide, newest first. */
export async function stockMovements(
  pin: string,
  limit = 100
): Promise<StockMovementRow[]> {
  const { data, error } = await supabase.rpc("pos_stock_movements", {
    p_register_token: requireToken(),
    p_pin: pin,
    p_limit: limit,
  });
  if (error) throw error;
  return data as StockMovementRow[];
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
  // A boolean travels as a real jsonb boolean rather than the string "false",
  // which `->> ... ::boolean` on the server reads correctly either way but
  // which would read as truthy to anything that ever checks it in JavaScript.
  settings: Record<string, string | boolean>
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
  /**
   * How far this person may discount without fetching a manager. Null means
   * none. See supabase/migrations/0037_discount_limits.sql — a limit only
   * decides whether approval is needed, it never refuses.
   */
  discount_limit_percent: number | null;
  discount_limit_amount: number | null;
  /**
   * Why the most recent enrolment code for this phone did not go out, in words
   * a manager can act on — or null when it went (or nothing was ever asked
   * for). See 0043: the OTP sender records its outcome instead of swallowing
   * it, so "they never asked for a code" and "they asked and the SMS service
   * failed them" stop looking identical from the staff screen.
   */
  last_code_error: string | null;
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

/**
 * Change a staff member. Every field is optional — send only what changed, and
 * the server leaves the rest alone.
 *
 * It also refuses the changes that would lock the shop out of itself: your own
 * role, your own access, and the last admin standing. Those checks live in the
 * database because this screen is not the only way in.
 */
export async function adminUpdateUser(
  pin: string,
  id: string,
  patch: {
    name?: string;
    role?: "admin" | "manager" | "employee";
    permissions?: string[];
    active?: boolean;
    /**
     * Zero clears a limit; undefined leaves it alone. There is no such thing
     * as a zero limit — it would mean the same as having none — so zero is
     * free to be the "take it away" signal, and the server reads it that way.
     */
    discount_limit_percent?: number | null;
    discount_limit_amount?: number | null;
  }
): Promise<StaffUser> {
  const { data, error } = await supabase.rpc("pos_admin_update_user", {
    p_register_token: requireToken(),
    p_pin: pin,
    p_user_id: id,
    p_name: patch.name ?? null,
    p_role: patch.role ?? null,
    p_permissions: patch.permissions ?? null,
    p_active: patch.active ?? null,
    p_discount_limit_percent: patch.discount_limit_percent ?? null,
    p_discount_limit_amount: patch.discount_limit_amount ?? null,
  });
  if (error) throw error;
  const rows = data as StaffUser[];
  if (!rows?.[0]) throw new Error("Save failed");
  return rows[0];
}

/**
 * Remove a staff member. Anybody who has rung up a sale is disabled rather
 * than deleted — their name is on invoices that still have to make sense — so
 * the outcome says which of the two actually happened.
 */
export async function adminDeleteUser(
  pin: string,
  id: string
): Promise<"deleted" | "disabled"> {
  const { data, error } = await supabase.rpc("pos_admin_delete_user", {
    p_register_token: requireToken(),
    p_pin: pin,
    p_user_id: id,
  });
  if (error) throw error;
  return data as "deleted" | "disabled";
}

/** The shop's own details, as the back office edits them. */
export interface ShopDetails {
  shop_name: string;
  address_line1: string;
  address_line2: string;
  phone: string;
  vat_number: string;
  currency: string;
  registration_number: string;
  email: string;
  /** Where an EFT or account customer actually sends the money. */
  bank_name: string;
  bank_account_name: string;
  bank_account_number: string;
  bank_branch_code: string;
  /**
   * Whether a printed quote prices each line, or gives the scope and one total.
   * The only non-text setting here, which is why the form and the RPC both
   * handle it apart from the rest.
   */
  quote_show_line_prices: boolean;
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

// --- Product photographs ----------------------------------------------------

export interface ProductImage {
  id: string;
  /** A storage path; run it through imageSrc() to display it. */
  url: string;
  sort_order: number;
}

/** Every photograph on a product, primary first. */
/** What the Shelf screen knows about an item: enough to say "this one", and
 * deliberately no more — no cost, no margin, no supplier. */
export interface ShelfItem {
  id: string;
  name: string;
  barcode: string;
  unit_code: string;
  price_retail: number;
  active: boolean;
  has_photo: boolean;
}

/** The barcode either names an item in this shop's catalogue, or it doesn't. */
export async function shelfLookup(pin: string, barcode: string): Promise<ShelfItem | null> {
  const { data, error } = await supabase.rpc("pos_shelf_lookup", {
    p_register_token: requireToken(),
    p_pin: pin,
    p_barcode: barcode,
  });
  if (error) throw error;
  return (data as ShelfItem[])[0] ?? null;
}

/**
 * Record an item the catalogue has never heard of. It lands HIDDEN — the
 * server enforces that, not this comment — and the price travels along as a
 * proposal for whoever reviews it in Catalogue.
 */
export async function shelfAddItem(
  pin: string,
  barcode: string,
  name: string,
  priceRetail: number
): Promise<ShelfItem> {
  const { data, error } = await supabase.rpc("pos_shelf_add_item", {
    p_register_token: requireToken(),
    p_pin: pin,
    p_barcode: barcode,
    p_name: name,
    p_price_retail: priceRetail,
  });
  if (error) throw error;
  const rows = data as ShelfItem[];
  if (!rows?.[0]) throw new Error("The item could not be saved");
  return rows[0];
}

/**
 * Fix a retail price from the shelf. Requires catalogue rights — the server
 * refuses the shelf grant alone, which is the property that makes the shelf
 * phone safe to hand to anybody.
 */
export async function shelfSetPrice(
  pin: string,
  productId: string,
  priceRetail: number
): Promise<number> {
  const { data, error } = await supabase.rpc("pos_shelf_set_price", {
    p_register_token: requireToken(),
    p_pin: pin,
    p_product_id: productId,
    p_price_retail: priceRetail,
  });
  if (error) throw error;
  return data as number;
}

/** A credit note as the sales screen shows and reprints it. */
export interface SaleReturn {
  id: string;
  doc_number: string;
  reason: string;
  refund_method: "cash" | "account";
  total: number;
  tax_total: number;
  by_name: string;
  created_at: string;
  items: {
    sale_item_id: string;
    name: string;
    qty: number;
    line_total: number;
    restock: boolean;
  }[];
}

/** Every credit note already written against a sale, lines grouped under it. */
export async function saleReturns(pin: string, saleId: string): Promise<SaleReturn[]> {
  const { data, error } = await supabase.rpc("pos_sale_returns", {
    p_register_token: requireToken(),
    p_pin: pin,
    p_sale_id: saleId,
  });
  if (error) throw error;
  const grouped = new Map<string, SaleReturn>();
  for (const row of data as (Omit<SaleReturn, "items"> & {
    sale_item_id: string;
    item_name: string;
    item_qty: number;
    item_line_total: number;
    item_restock: boolean;
  })[]) {
    let r = grouped.get(row.id);
    if (!r) {
      r = {
        id: row.id,
        doc_number: row.doc_number,
        reason: row.reason,
        refund_method: row.refund_method,
        total: row.total,
        tax_total: row.tax_total,
        by_name: row.by_name,
        created_at: row.created_at,
        items: [],
      };
      grouped.set(row.id, r);
    }
    r.items.push({
      sale_item_id: row.sale_item_id,
      name: row.item_name,
      qty: row.item_qty,
      line_total: row.item_line_total,
      restock: row.item_restock,
    });
  }
  return Array.from(grouped.values());
}

/**
 * Take goods back against a sale. The server decides the refund method from
 * how the sale was paid, refuses over-returns, and writes the credit note —
 * this call returns its number and totals so the slip can print.
 */
export async function returnSale(
  pin: string,
  saleId: string,
  items: { sale_item_id: string; qty: number; restock: boolean }[],
  reason: string
): Promise<{ return_id: string; doc_number: string; refund_method: string; total: number; tax_total: number }> {
  const { data, error } = await supabase.rpc("pos_return_sale", {
    p_register_token: requireToken(),
    p_pin: pin,
    p_sale_id: saleId,
    p_items: items,
    p_reason: reason,
  });
  if (error) throw error;
  const rows = data as { return_id: string; doc_number: string; refund_method: string; total: number; tax_total: number }[];
  if (!rows?.[0]) throw new Error("The return was not recorded");
  return rows[0];
}

export async function listProductImages(productId: string): Promise<ProductImage[]> {
  const { data, error } = await supabase.rpc("pos_product_images", {
    p_register_token: requireToken(),
    p_product_id: productId,
  });
  if (error) throw error;
  return data as ProductImage[];
}

/**
 * Upload a photograph.
 *
 * Goes to an edge function rather than straight to storage: the browser holds
 * only the anon key, and a bucket writable with the anon key is a bucket anyone
 * can fill. The function checks the till's token and this PIN with the service
 * role before it writes anything.
 */
export async function uploadProductImage(
  pin: string,
  productId: string,
  dataUrl: string,
  sortOrder = 0
): Promise<{ id: string; path: string }> {
  const res = await fetch(`${API_BASE}/functions/v1/product-image`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      apikey: import.meta.env.VITE_SUPABASE_ANON_KEY,
      Authorization: `Bearer ${import.meta.env.VITE_SUPABASE_ANON_KEY}`,
    },
    body: JSON.stringify({
      register_token: requireToken(),
      pin,
      product_id: productId,
      image: dataUrl,
      sort_order: sortOrder,
    }),
  });

  let body: { ok?: boolean; id?: string; path?: string; message?: string } = {};
  try {
    body = await res.json();
  } catch {
    /* a proxy or a dropped line can answer with something that is not JSON */
  }
  if (!res.ok || !body.ok) {
    throw new Error(body.message ?? "The photo could not be uploaded.");
  }
  return { id: body.id!, path: body.path! };
}

export async function removeProductImage(pin: string, imageId: string): Promise<void> {
  const { error } = await supabase.rpc("pos_admin_remove_product_image", {
    p_register_token: requireToken(),
    p_pin: pin,
    p_image_id: imageId,
  });
  if (error) throw error;
}
