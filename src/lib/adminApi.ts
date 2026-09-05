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
  /** The small print at the foot of a till slip, and of a quote. */
  receipt_terms: string;
  quote_terms: string;
  /** The shop's mark on its A4 documents. A storage path, or "" for none. */
  logo_url: string;
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
 * Record an item the catalogue has never heard of. It lands HIDDEN and, with
 * no price offered, unpriced — the server enforces both, not this comment —
 * for whoever reviews it in Catalogue to price and flip live.
 */
export async function shelfAddItem(
  pin: string,
  barcode: string,
  name: string,
  priceRetail: number | null = null
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

// --- Purchasing: suppliers and the paper they send (0055) --------------------

export interface Supplier {
  id: string;
  code: string | null;
  name: string;
  contact_name: string | null;
  phone: string | null;
  email: string | null;
  address: string | null;
  vat_number: string | null;
  notes: string | null;
  /** Where the money goes when their invoice falls due. */
  bank_name: string | null;
  bank_account_name: string | null;
  bank_account_number: string | null;
  bank_branch_code: string | null;
  active: boolean;
  document_count: number;
}

export type SupplierDocumentKind = "quote" | "invoice" | "delivery_note" | "statement" | "other";

export const DOCUMENT_KIND_LABEL: Record<SupplierDocumentKind, string> = {
  quote: "Quote",
  invoice: "Invoice",
  delivery_note: "Delivery note",
  statement: "Statement",
  other: "Other",
};

export interface SupplierDocument {
  id: string;
  supplier_id: string;
  supplier_name: string;
  kind: SupplierDocumentKind;
  doc_number: string | null;
  doc_date: string | null;
  total: number | null;
  note: string | null;
  status: "stored" | "read" | "received";
  pages: number;
  /** How many item lines were read off it. Zero for a filed photograph. */
  lines: number;
  created_at: string;
  created_by_name: string | null;
}

export interface SupplierPage {
  page_no: number;
  mime: string;
  /** A signed URL, good for a few minutes. */
  url: string | null;
}

export async function purchasingSuppliers(pin: string): Promise<Supplier[]> {
  const { data, error } = await supabase.rpc("pos_purchasing_suppliers", {
    p_register_token: requireToken(),
    p_pin: pin,
  });
  if (error) throw error;
  return (data as Supplier[]) ?? [];
}

export async function purchasingSaveSupplier(
  pin: string,
  s: {
    id: string | null;
    name: string;
    contact_name?: string | null;
    phone?: string | null;
    email?: string | null;
    address?: string | null;
    vat_number?: string | null;
    notes?: string | null;
    bank_name?: string | null;
    bank_account_name?: string | null;
    bank_account_number?: string | null;
    bank_branch_code?: string | null;
  }
): Promise<{ id: string; name: string }> {
  const { data, error } = await supabase.rpc("pos_purchasing_save_supplier", {
    p_register_token: requireToken(),
    p_pin: pin,
    p_id: s.id,
    p_name: s.name,
    p_contact_name: s.contact_name ?? null,
    p_phone: s.phone ?? null,
    p_email: s.email ?? null,
    p_address: s.address ?? null,
    p_vat_number: s.vat_number ?? null,
    p_notes: s.notes ?? null,
    p_bank_name: s.bank_name ?? null,
    p_bank_account_name: s.bank_account_name ?? null,
    p_bank_account_number: s.bank_account_number ?? null,
    p_bank_branch_code: s.bank_branch_code ?? null,
  });
  if (error) throw error;
  return data as { id: string; name: string };
}

export async function purchasingDocuments(
  pin: string,
  supplierId: string | null = null
): Promise<SupplierDocument[]> {
  const { data, error } = await supabase.rpc("pos_purchasing_documents", {
    p_register_token: requireToken(),
    p_pin: pin,
    p_supplier_id: supplierId,
    p_limit: 200,
  });
  if (error) throw error;
  return (data as SupplierDocument[]) ?? [];
}

export async function purchasingAddDocument(
  pin: string,
  d: {
    supplier_id: string;
    kind: SupplierDocumentKind;
    doc_number: string | null;
    doc_date: string | null;
    total: number | null;
    note: string | null;
  }
): Promise<string> {
  const { data, error } = await supabase.rpc("pos_purchasing_add_document", {
    p_register_token: requireToken(),
    p_pin: pin,
    p_supplier_id: d.supplier_id,
    p_kind: d.kind,
    p_doc_number: d.doc_number,
    p_doc_date: d.doc_date,
    p_total: d.total,
    p_note: d.note,
  });
  if (error) throw error;
  return data as string;
}

export async function purchasingDeleteDocument(pin: string, documentId: string): Promise<void> {
  const { error } = await supabase.rpc("pos_purchasing_delete_document", {
    p_register_token: requireToken(),
    p_pin: pin,
    p_document_id: documentId,
  });
  if (error) throw error;
}

async function supplierDocumentCall(body: Record<string, string>): Promise<Record<string, unknown>> {
  const res = await fetch(`${API_BASE}/functions/v1/supplier-document`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      apikey: import.meta.env.VITE_SUPABASE_ANON_KEY,
      Authorization: `Bearer ${import.meta.env.VITE_SUPABASE_ANON_KEY}`,
    },
    body: JSON.stringify({ register_token: requireToken(), pin: body.pin, ...body }),
  });
  let out: Record<string, unknown> = {};
  try {
    out = await res.json();
  } catch {
    /* a proxy or a dropped line can answer with something that is not JSON */
  }
  if (!res.ok || !out.ok) {
    throw new Error((out.message as string) ?? "The page could not be sent.");
  }
  return out;
}

/** One page of a document — a downscaled photo or the PDF itself, as a data URL. */
export async function uploadSupplierPage(
  pin: string,
  documentId: string,
  dataUrl: string
): Promise<number> {
  const out = await supplierDocumentCall({ action: "page", pin, document_id: documentId, file: dataUrl });
  return Number(out.page_no);
}

/** The pages of a document, as URLs the browser may open for a few minutes. */
export async function signSupplierPages(pin: string, documentId: string): Promise<SupplierPage[]> {
  const out = await supplierDocumentCall({ action: "sign", pin, document_id: documentId });
  return (out.pages as SupplierPage[]) ?? [];
}

// --- Reading a supplier's document (0056) ------------------------------------

/** One line as the reader found it on the page, before anybody confirms it. */
export interface ReadLine {
  supplier_code?: string | null;
  description: string;
  qty?: number | null;
  unit_price?: number | null;
  line_total?: number | null;
}

/** What the pages said. Every field is a suggestion until a person agrees. */
export interface ReadDocument {
  supplier_name?: string | null;
  supplier_vat?: string | null;
  supplier_phone?: string | null;
  supplier_email?: string | null;
  supplier_address?: string | null;
  /** Off the foot of the page: where their invoice gets paid. */
  bank_name?: string | null;
  bank_account_name?: string | null;
  bank_account_number?: string | null;
  bank_branch_code?: string | null;
  kind?: SupplierDocumentKind | null;
  doc_number?: string | null;
  doc_date?: string | null;
  subtotal?: number | null;
  tax_total?: number | null;
  total?: number | null;
  currency?: string | null;
  lines: ReadLine[];
}

/**
 * Hand the pages to the reader.
 *
 * Nothing is stored by this call: it answers, the manager confirms, and the
 * filing is a separate step. The key it uses lives on the server.
 */
export async function readSupplierDocument(
  pin: string,
  pages: { mime: string; data: string }[]
): Promise<ReadDocument> {
  const res = await fetch(`${API_BASE}/functions/v1/read-document`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      apikey: import.meta.env.VITE_SUPABASE_ANON_KEY,
      Authorization: `Bearer ${import.meta.env.VITE_SUPABASE_ANON_KEY}`,
    },
    body: JSON.stringify({ register_token: requireToken(), pin, pages }),
  });
  let out: { ok?: boolean; read?: ReadDocument; message?: string } = {};
  try {
    out = await res.json();
  } catch {
    /* a proxy or a dropped line can answer with something that is not JSON */
  }
  if (!res.ok || !out.ok || !out.read) {
    throw new Error(out.message ?? "The pages could not be read.");
  }
  return { ...out.read, lines: out.read.lines ?? [] };
}

/** The supplier this letterhead belongs to, if the shop already buys from it. */
export async function matchSupplier(
  pin: string,
  vatNumber: string | null,
  name: string | null
): Promise<{ id: string; name: string; vat_number: string | null } | null> {
  const { data, error } = await supabase.rpc("pos_purchasing_match_supplier", {
    p_register_token: requireToken(),
    p_pin: pin,
    p_vat_number: vatNumber,
    p_name: name,
  });
  if (error) throw error;
  return (data as { id: string; name: string; vat_number: string | null }[])?.[0] ?? null;
}

export interface FiledDocument {
  document_id: string;
  supplier_id: string;
  supplier_name: string;
  supplier_created: boolean;
  /** Blanks on a supplier we already had, learnt from this letterhead. */
  details_filled: number;
}

/** File a confirmed reading: the supplier, the header and every line, at once. */
export async function fileSupplierDocument(
  pin: string,
  d: {
    supplier_id: string | null;
    supplier_name: string | null;
    supplier_vat: string | null;
    supplier_phone: string | null;
    supplier_email: string | null;
    supplier_address: string | null;
    bank_name: string | null;
    bank_account_name: string | null;
    bank_account_number: string | null;
    bank_branch_code: string | null;
    kind: SupplierDocumentKind;
    doc_number: string | null;
    doc_date: string | null;
    subtotal: number | null;
    tax_total: number | null;
    total: number | null;
    note: string | null;
    lines: ReadLine[];
    read: boolean;
  }
): Promise<FiledDocument> {
  const { data, error } = await supabase.rpc("pos_purchasing_file_document", {
    p_register_token: requireToken(),
    p_pin: pin,
    p_supplier_id: d.supplier_id,
    p_supplier_name: d.supplier_name,
    p_supplier_vat: d.supplier_vat,
    p_supplier_phone: d.supplier_phone,
    p_supplier_email: d.supplier_email,
    p_supplier_address: d.supplier_address,
    p_bank_name: d.bank_name,
    p_bank_account_name: d.bank_account_name,
    p_bank_account_number: d.bank_account_number,
    p_bank_branch_code: d.bank_branch_code,
    p_kind: d.kind,
    p_doc_number: d.doc_number,
    p_doc_date: d.doc_date,
    p_subtotal: d.subtotal,
    p_tax_total: d.tax_total,
    p_total: d.total,
    p_note: d.note,
    p_lines: d.lines,
    p_read: d.read,
  });
  if (error) throw error;
  return (data as FiledDocument[])[0];
}

export interface DocumentLine {
  line_no: number;
  supplier_code: string | null;
  description: string;
  qty: number | null;
  unit_price: number | null;
  line_total: number | null;
  product_id: string | null;
  product_name: string | null;
}

export async function purchasingDocumentLines(
  pin: string,
  documentId: string
): Promise<DocumentLine[]> {
  const { data, error } = await supabase.rpc("pos_purchasing_document_lines", {
    p_register_token: requireToken(),
    p_pin: pin,
    p_document_id: documentId,
  });
  if (error) throw error;
  return (data as DocumentLine[]) ?? [];
}

// --- Receiving a delivery from its own paperwork (0058) ----------------------

/** A line as the receiving screen shows it: what it is, and what it costs. */
export interface ReceiveLine {
  line_no: number;
  supplier_code: string | null;
  description: string;
  qty: number | null;
  unit_price: number | null;
  line_total: number | null;
  /** The product it is already known to be, or null for a person to decide. */
  product_id: string | null;
  product_name: string | null;
  product_sku: string | null;
  stock_qty: number | null;
  /** What it costs the shop today, before this delivery. */
  current_cost: number | null;
  retail: number | null;
  /** True when a person confirmed this pairing before, rather than a guess. */
  remembered: boolean;
}

export async function purchasingReceiveLines(
  pin: string,
  documentId: string
): Promise<ReceiveLine[]> {
  const { data, error } = await supabase.rpc("pos_purchasing_receive_lines", {
    p_register_token: requireToken(),
    p_pin: pin,
    p_document_id: documentId,
  });
  if (error) throw error;
  return (data as ReceiveLine[]) ?? [];
}

export interface ReceivedLine {
  product_id: string;
  name: string;
  received: number;
  stock_qty: number;
  old_cost: number | null;
  new_cost: number | null;
  created: boolean;
}

/**
 * Book the delivery in. All of it or none of it.
 *
 * A line with no quantity was not received; a line with `create` becomes a new
 * product, born inactive and unpriced like a shelf capture, so the till cannot
 * sell something nobody has priced.
 */
export async function purchasingReceiveDocument(
  pin: string,
  documentId: string,
  lines: {
    line_no: number;
    product_id: string | null;
    create?: boolean;
    qty: number;
    unit_cost: number | null;
    remember?: boolean;
  }[]
): Promise<ReceivedLine[]> {
  const { data, error } = await supabase.rpc("pos_purchasing_receive_document", {
    p_register_token: requireToken(),
    p_pin: pin,
    p_document_id: documentId,
    p_lines: lines,
  });
  if (error) throw error;
  return (data as ReceivedLine[]) ?? [];
}

// --- The shop's logo (0059) --------------------------------------------------

/**
 * Upload the shop's mark.
 *
 * Through an edge function, like a product photograph and for the same
 * reason: the browser holds only the anon key. Returns the storage path,
 * which is what the settings then carry.
 */
export async function uploadShopLogo(pin: string, dataUrl: string): Promise<string> {
  const res = await fetch(`${API_BASE}/functions/v1/shop-logo`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      apikey: import.meta.env.VITE_SUPABASE_ANON_KEY,
      Authorization: `Bearer ${import.meta.env.VITE_SUPABASE_ANON_KEY}`,
    },
    body: JSON.stringify({ register_token: requireToken(), pin, image: dataUrl }),
  });
  let out: { ok?: boolean; path?: string; message?: string } = {};
  try {
    out = await res.json();
  } catch {
    /* a proxy or a dropped line can answer with something that is not JSON */
  }
  if (!res.ok || !out.ok || !out.path) {
    throw new Error(out.message ?? "The logo could not be uploaded.");
  }
  return out.path;
}

/**
 * What one delivery costs the shop.
 *
 * Written to the delivery product's cost, which is where every report reads
 * it from: pos_create_sale copies a product's cost onto each line it writes,
 * so setting this once makes the departments table, the items table, the
 * export and the deliveries report all tell the truth about carriage at the
 * same moment.
 */
export async function setDeliveryCost(pin: string, cost: number): Promise<number> {
  const { data, error } = await supabase.rpc("pos_admin_set_delivery_cost", {
    p_register_token: requireToken(),
    p_pin: pin,
    p_cost: cost,
  });
  if (error) throw error;
  return Number(data);
}
