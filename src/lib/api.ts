import { supabase } from "./supabase";
import type {
  Account,
  AccountLedger,
  AccountListItem,
  CartLine,
  CashMovement,
  CashSession,
  OpenOrder,
  OpenOrderFull,
  OpenOrderItem,
  OpenSession,
  PaymentMethod,
  Product,
  ReceiptItem,
  Sale,
  SaleItem,
  User,
} from "./types";

/** Verify a PIN and return the matching user, or null if no match. */
export async function login(pin: string): Promise<User | null> {
  const { data, error } = await supabase.rpc("pos_login", { p_pin: pin });
  if (error) throw error;
  const rows = data as User[];
  return rows?.[0] ?? null;
}

export async function fetchProducts(): Promise<Product[]> {
  const { data, error } = await supabase
    .from("products")
    .select("*, variants:product_variants(*)")
    .eq("active", true)
    .order("category", { ascending: true })
    .order("sort_order", { ascending: true });
  if (error) throw error;
  // Keep each product's variants ordered (price ascending within sort_order).
  const products = (data as Product[]).map((p) => ({
    ...p,
    variants: (p.variants ?? [])
      .slice()
      .sort((a, b) => a.sort_order - b.sort_order || a.price - b.price),
  }));
  return products;
}

function itemsPayload(lines: CartLine[]) {
  return lines.map((l) => ({
    product_id: l.product.id,
    variant_id: l.variant?.id ?? null,
    qty: l.qty,
  }));
}

/**
 * Record a sale. The server recomputes the subtotal from product prices,
 * so the client cannot tamper with totals. If a discount is applied by an
 * employee, the returned sale comes back as `pending_approval`.
 */
export async function createSale(params: {
  cashierId: string;
  lines: CartLine[];
  discountAmount: number;
  discountReason: string | null;
}): Promise<Sale> {
  const { data, error } = await supabase.rpc("pos_create_sale", {
    p_cashier_id: params.cashierId,
    p_items: itemsPayload(params.lines),
    p_discount_amount: params.discountAmount,
    p_discount_reason: params.discountReason,
  });
  if (error) throw error;
  return data as Sale;
}

/** Release a pending sale. The manager PIN is verified server-side. */
export async function approveSale(
  saleId: string,
  managerPin: string
): Promise<Sale> {
  const { data, error } = await supabase.rpc("pos_approve_sale", {
    p_sale_id: saleId,
    p_manager_pin: managerPin,
  });
  if (error) throw error;
  return data as Sale;
}

// --- Manager menu administration (all PIN-verified server-side) -------------

/** List every product (including inactive). Doubles as a manager-PIN check. */
export async function managerListProducts(
  managerPin: string
): Promise<Product[]> {
  const { data, error } = await supabase.rpc("pos_manager_list_products", {
    p_manager_pin: managerPin,
  });
  if (error) throw error;
  return data as Product[];
}

export interface ProductInput {
  id?: string | null;
  name: string;
  category: string;
  price: number;
  cost: number | null;
  image_url: string | null;
  active: boolean;
  sort_order: number;
  stock_qty: number | null;
}

/** Create (omit id) or update a product (no variants). Used by bulk import. */
export async function managerUpsertProduct(
  managerPin: string,
  p: ProductInput
): Promise<Product> {
  const { data, error } = await supabase.rpc("pos_manager_upsert_product", {
    p_manager_pin: managerPin,
    p_id: p.id ?? null,
    p_name: p.name,
    p_category: p.category,
    p_price: p.price,
    p_image_url: p.image_url,
    p_active: p.active,
    p_sort_order: p.sort_order,
    p_stock_qty: p.stock_qty,
  });
  if (error) throw error;
  return data as Product;
}

export interface VariantInput {
  id?: string | null;
  name: string | null;
  size: string | null;
  price: number;
  cost: number | null;
  stock_qty: number | null;
  active: boolean;
  sort_order: number;
}

/**
 * Create/update a product and replace its full variant set in one call.
 * Variants present are upserted; any existing variant not listed is removed.
 */
export async function managerSaveProduct(
  managerPin: string,
  p: ProductInput,
  variants: VariantInput[]
): Promise<Product> {
  const { data, error } = await supabase.rpc("pos_manager_save_product", {
    p_manager_pin: managerPin,
    p_id: p.id ?? null,
    p_name: p.name,
    p_category: p.category,
    p_price: p.price,
    p_cost: p.cost,
    p_image_url: p.image_url,
    p_active: p.active,
    p_sort_order: p.sort_order,
    p_stock_qty: p.stock_qty,
    p_variants: variants,
  });
  if (error) throw error;
  return data as Product;
}

/** Permanently delete a product (its variants cascade; sale history is kept). */
export async function managerDeleteProduct(
  managerPin: string,
  id: string
): Promise<void> {
  const { error } = await supabase.rpc("pos_manager_delete_product", {
    p_manager_pin: managerPin,
    p_id: id,
  });
  if (error) throw error;
}

/** Rename a category (moves every product in it; merges if the name exists). */
export async function managerRenameCategory(
  managerPin: string,
  oldName: string,
  newName: string
): Promise<void> {
  const { error } = await supabase.rpc("pos_manager_rename_category", {
    p_manager_pin: managerPin,
    p_old: oldName,
    p_new: newName,
  });
  if (error) throw error;
}

/** Delete a category by reassigning its products (default to "Other"). */
export async function managerDeleteCategory(
  managerPin: string,
  name: string,
  reassignTo = "Other"
): Promise<void> {
  const { error } = await supabase.rpc("pos_manager_delete_category", {
    p_manager_pin: managerPin,
    p_name: name,
    p_reassign_to: reassignTo,
  });
  if (error) throw error;
}

// --- Staff management -------------------------------------------------------

export type StaffRole = "admin" | "manager" | "employee";

export interface StaffMember {
  id: string;
  name: string;
  role: StaffRole;
  active: boolean;
  phone?: string | null;
  email?: string | null;
  permissions?: string[] | null;
  created_at?: string;
}

export async function managerListUsers(
  managerPin: string
): Promise<StaffMember[]> {
  const { data, error } = await supabase.rpc("pos_manager_list_users", {
    p_manager_pin: managerPin,
  });
  if (error) throw error;
  return data as StaffMember[];
}

/** Create (omit id) or update a staff member. Leave pin null to keep it. */
export async function managerUpsertUser(
  managerPin: string,
  u: {
    id?: string | null;
    name: string;
    role: StaffRole;
    pin: string | null;
    active: boolean;
    phone: string | null;
    email: string | null;
    permissions: string[];
  }
): Promise<StaffMember> {
  const { data, error } = await supabase.rpc("pos_manager_upsert_user", {
    p_manager_pin: managerPin,
    p_id: u.id ?? null,
    p_name: u.name,
    p_role: u.role,
    p_pin: u.pin,
    p_active: u.active,
    p_phone: u.phone,
    p_email: u.email,
    p_permissions: u.permissions,
  });
  if (error) throw error;
  return (data as StaffMember[])[0];
}

/** Update your own profile, re-authenticated with your current PIN. */
export async function updateProfile(
  currentPin: string,
  p: { name: string; phone: string | null; email: string | null; newPin: string | null }
): Promise<{ id: string; name: string; role: "manager" | "employee"; phone: string | null; email: string | null }> {
  const { data, error } = await supabase.rpc("pos_update_profile", {
    p_pin: currentPin,
    p_name: p.name,
    p_phone: p.phone,
    p_email: p.email,
    p_new_pin: p.newPin,
  });
  if (error) throw error;
  return (data as any[])[0];
}

// --- Sales reporting --------------------------------------------------------

export interface SalesSummary {
  sales_count: number;
  gross: number;
  discount: number;
  tips: number;
  net: number; // money collected: cash + card + account repayments
  cash: number;
  card: number;
  account_owed: number; // on-account charges in the period (not yet collected)
  account_repaid: number; // account repayments collected in the period
  top_items: { name: string; qty: number; revenue: number }[];
  by_cashier: { name: string; sales: number; net: number }[];
  by_method: Record<string, number>;
}

export async function salesSummary(
  managerPin: string,
  from: Date,
  to: Date
): Promise<SalesSummary> {
  const { data, error } = await supabase.rpc("pos_manager_sales_summary", {
    p_manager_pin: managerPin,
    p_from: from.toISOString(),
    p_to: to.toISOString(),
  });
  if (error) throw error;
  return data as SalesSummary;
}

export interface ItemHistoryEntry {
  sale_id: string;
  at: string;
  name: string;
  qty: number;
  unit_price: number;
  line_total: number;
  cashier_name: string;
}
export interface ItemHistory {
  total_qty: number;
  total_revenue: number;
  sale_count: number;
  entries: ItemHistoryEntry[];
}

/** Every completed sale line for one product in a date range, with totals. */
export async function itemHistory(
  managerPin: string,
  productId: string,
  from: Date,
  to: Date
): Promise<ItemHistory> {
  const { data, error } = await supabase.rpc("pos_manager_item_history", {
    p_manager_pin: managerPin,
    p_product_id: productId,
    p_from: from.toISOString(),
    p_to: to.toISOString(),
  });
  if (error) throw error;
  return data as ItemHistory;
}

// --- End-of-day report (any active staff member) ----------------------------

export interface EodCashier {
  name: string;
  sales: number;
  net: number;
  cash: number; // includes account repayments collected in cash
  card: number; // includes account repayments collected by card
  account: number;
  other: number;
  tips: number;
  discount: number;
  repaid_cash: number;
  repaid_card: number;
}

export interface EndOfDayReport {
  sales_count: number;
  gross: number;
  discount: number;
  tips: number;
  net: number;
  cash: number; // sales + account repayments collected in cash
  card: number; // sales + account repayments collected by card
  account: number; // on-account charges (owed, not collected)
  other: number;
  account_repaid_cash: number; // portion of `cash` that was a tab settlement
  account_repaid_card: number; // portion of `card` that was a tab settlement
  by_cashier: EodCashier[];
}

export async function endOfDay(
  pin: string,
  from: Date,
  to: Date
): Promise<EndOfDayReport> {
  const { data, error } = await supabase.rpc("pos_end_of_day", {
    p_pin: pin,
    p_from: from.toISOString(),
    p_to: to.toISOString(),
  });
  if (error) throw error;
  return data as EndOfDayReport;
}

export async function managerListSales(
  managerPin: string,
  from: Date,
  to: Date,
  opts: { cashier?: string; onlyDiscounted?: boolean; itemName?: string } = {}
): Promise<Sale[]> {
  const { data, error } = await supabase.rpc("pos_manager_list_sales", {
    p_manager_pin: managerPin,
    p_from: from.toISOString(),
    p_to: to.toISOString(),
    p_cashier_name: opts.cashier ?? null,
    p_only_discounted: opts.onlyDiscounted ?? false,
    p_item_name: opts.itemName ?? null,
  });
  if (error) throw error;
  return data as Sale[];
}

export async function managerSaleItems(
  managerPin: string,
  saleId: string
): Promise<SaleItem[]> {
  const { data, error } = await supabase.rpc("pos_manager_sale_items", {
    p_manager_pin: managerPin,
    p_sale_id: saleId,
  });
  if (error) throw error;
  return data as SaleItem[];
}

/** Void / refund a completed sale (restores stock, drops it from reports). */
export async function voidSale(
  pin: string,
  saleId: string,
  reason: string
): Promise<Sale> {
  const { data, error } = await supabase.rpc("pos_void_sale", {
    p_pin: pin,
    p_sale_id: saleId,
    p_reason: reason,
  });
  if (error) throw error;
  return data as Sale;
}

// --- Open orders & payment --------------------------------------------------

/** Create (orderId null) or update an open order (table/tab). */
export async function saveOrder(
  cashierId: string,
  orderId: string | null,
  label: string,
  lines: CartLine[]
): Promise<Sale> {
  const { data, error } = await supabase.rpc("pos_save_order", {
    p_cashier_id: cashierId,
    p_order_id: orderId,
    p_label: label,
    p_items: itemsPayload(lines),
  });
  if (error) throw error;
  return data as Sale;
}

/**
 * Idempotent pay. Carries a client-generated UUID so replaying a queued
 * (offline) sale can never create a duplicate — the server returns the existing
 * row if it has already seen that UUID. `offline` replays relax the live stock
 * check and trust an `approvedBy` that was verified against the device cache.
 */
export async function payOrderV2(params: {
  clientUuid: string;
  cashierId: string;
  orderId: string | null;
  lines: CartLine[];
  discountAmount: number;
  discountReason: string | null;
  tipAmount: number;
  paymentMethod: PaymentMethod;
  amountTendered: number | null;
  approverPin: string | null;
  approvedBy?: string | null;
  createdAt?: string | null;
  offline?: boolean;
  accountId?: string | null;
  paidCash?: number | null; // cash portion for a split payment
  paidCard?: number | null; // card portion for a split payment
}): Promise<Sale> {
  const { data, error } = await supabase.rpc("pos_pay_order_v2", {
    p_client_uuid: params.clientUuid,
    p_cashier_id: params.cashierId,
    p_order_id: params.orderId,
    p_items: itemsPayload(params.lines),
    p_discount_amount: params.discountAmount,
    p_discount_reason: params.discountReason,
    p_tip_amount: params.tipAmount,
    p_payment_method: params.paymentMethod,
    p_amount_tendered: params.amountTendered,
    p_approver_pin: params.approverPin,
    p_approved_by: params.approvedBy ?? null,
    p_created_at: params.createdAt ?? null,
    p_offline: params.offline ?? false,
    p_account_id: params.accountId ?? null,
    p_paid_cash: params.paidCash ?? null,
    p_paid_card: params.paidCard ?? null,
  });
  if (error) throw error;
  return data as Sale;
}

// A completed sale with its line items, for re-printing a receipt at the till.
export interface RecentSale extends Sale {
  items: ReceiptItem[];
  account_name: string | null;
  account_balance: number | null;
}

/** Last N completed sales (with items) so any cashier can reprint a receipt. */
export async function recentSales(
  cashierId: string,
  limit = 5
): Promise<RecentSale[]> {
  const { data, error } = await supabase.rpc("pos_recent_sales", {
    p_cashier_id: cashierId,
    p_limit: limit,
  });
  if (error) throw error;
  return data as RecentSale[];
}

export async function listOpenOrders(cashierId: string): Promise<OpenOrder[]> {
  const { data, error } = await supabase.rpc("pos_list_open_orders", {
    p_cashier_id: cashierId,
  });
  if (error) throw error;
  return data as OpenOrder[];
}

/** Open orders with their line items, in one call (cached for offline use). */
export async function listOpenOrdersFull(
  cashierId: string
): Promise<OpenOrderFull[]> {
  const { data, error } = await supabase.rpc("pos_open_orders_full", {
    p_cashier_id: cashierId,
  });
  if (error) throw error;
  return data as OpenOrderFull[];
}

export async function getOrderItems(
  cashierId: string,
  orderId: string
): Promise<OpenOrderItem[]> {
  const { data, error } = await supabase.rpc("pos_get_order_items", {
    p_cashier_id: cashierId,
    p_order_id: orderId,
  });
  if (error) throw error;
  return data as OpenOrderItem[];
}

export async function cancelOrder(
  cashierId: string,
  orderId: string
): Promise<void> {
  const { error } = await supabase.rpc("pos_cancel_order", {
    p_cashier_id: cashierId,
    p_order_id: orderId,
  });
  if (error) throw error;
}

/** Finalise a sale (fresh cart or open order) with tip + payment method. */
export async function payOrder(params: {
  cashierId: string;
  orderId: string | null;
  lines: CartLine[];
  discountAmount: number;
  discountReason: string | null;
  tipAmount: number;
  paymentMethod: PaymentMethod;
  amountTendered: number | null;
  approverPin: string | null;
}): Promise<Sale> {
  const { data, error } = await supabase.rpc("pos_pay_order", {
    p_cashier_id: params.cashierId,
    p_order_id: params.orderId,
    p_items: itemsPayload(params.lines),
    p_discount_amount: params.discountAmount,
    p_discount_reason: params.discountReason,
    p_tip_amount: params.tipAmount,
    p_payment_method: params.paymentMethod,
    p_amount_tendered: params.amountTendered,
    p_approver_pin: params.approverPin,
  });
  if (error) throw error;
  return data as Sale;
}

// --- Cash-up / reconciliation -----------------------------------------------

export async function openCashSession(
  pin: string,
  openingFloat: number
): Promise<CashSession> {
  const { data, error } = await supabase.rpc("pos_open_cash_session", {
    p_pin: pin,
    p_opening_float: openingFloat,
  });
  if (error) throw error;
  return data as CashSession;
}

export async function getOpenSession(pin: string): Promise<OpenSession | null> {
  const { data, error } = await supabase.rpc("pos_get_open_session", {
    p_pin: pin,
  });
  if (error) throw error;
  return (data as OpenSession | null) ?? null;
}

export async function addCashMovement(
  pin: string,
  sessionId: string,
  type: "pay_in" | "pay_out",
  amount: number,
  reason: string
): Promise<CashMovement> {
  const { data, error } = await supabase.rpc("pos_add_cash_movement", {
    p_pin: pin,
    p_session_id: sessionId,
    p_type: type,
    p_amount: amount,
    p_reason: reason,
  });
  if (error) throw error;
  return data as CashMovement;
}

export async function closeCashSession(
  pin: string,
  sessionId: string,
  countedCash: number | null,
  settledCard: number | null,
  notes: string
): Promise<CashSession> {
  const { data, error } = await supabase.rpc("pos_close_cash_session", {
    p_pin: pin,
    p_session_id: sessionId,
    p_counted_cash: countedCash,
    p_settled_card: settledCard,
    p_notes: notes,
  });
  if (error) throw error;
  return data as CashSession;
}

export async function listCashSessions(pin: string): Promise<CashSession[]> {
  const { data, error } = await supabase.rpc("pos_list_cash_sessions", {
    p_pin: pin,
  });
  if (error) throw error;
  return data as CashSession[];
}

/** Set (or clear, with null) a product's tracked stock. */
export async function managerSetStock(
  pin: string,
  productId: string,
  stockQty: number | null
): Promise<Product> {
  const { data, error } = await supabase.rpc("pos_manager_set_stock", {
    p_pin: pin,
    p_product_id: productId,
    p_stock_qty: stockQty,
  });
  if (error) throw error;
  return data as Product;
}

// --- Customer accounts (house accounts / accounts receivable) ---------------

/** Till: active accounts with balances, for charging or taking repayments. */
export async function listAccounts(cashierId: string): Promise<AccountListItem[]> {
  const { data, error } = await supabase.rpc("pos_list_accounts", {
    p_cashier_id: cashierId,
  });
  if (error) throw error;
  return data as AccountListItem[];
}

/** Till: full ledger (charges + repayments + balance) for one account. */
export async function accountLedger(
  cashierId: string,
  accountId: string
): Promise<AccountLedger> {
  const { data, error } = await supabase.rpc("pos_account_ledger", {
    p_cashier_id: cashierId,
    p_account_id: accountId,
  });
  if (error) throw error;
  return data as AccountLedger;
}

/** Till: record a repayment against an account. Returns the new balance. */
export async function recordAccountPayment(params: {
  cashierId: string;
  accountId: string;
  amount: number;
  method: "cash" | "card";
  note: string | null;
}): Promise<{ id: string; amount: number; method: string; balance: number }> {
  const { data, error } = await supabase.rpc("pos_record_account_payment", {
    p_cashier_id: params.cashierId,
    p_account_id: params.accountId,
    p_amount: params.amount,
    p_method: params.method,
    p_note: params.note,
  });
  if (error) throw error;
  return data as { id: string; amount: number; method: string; balance: number };
}

/** Admin: list every account (active + inactive) with balances. */
export async function managerListAccounts(managerPin: string): Promise<Account[]> {
  const { data, error } = await supabase.rpc("pos_manager_list_accounts", {
    p_pin: managerPin,
  });
  if (error) throw error;
  return data as Account[];
}

/** Admin: create (omit id) or update an account. */
export async function managerUpsertAccount(
  managerPin: string,
  a: {
    id?: string | null;
    name: string;
    phone: string | null;
    email: string | null;
    credit_limit: number | null;
    opening_balance: number;
    active: boolean;
    notes: string | null;
  }
): Promise<Account> {
  const { data, error } = await supabase.rpc("pos_manager_upsert_account", {
    p_pin: managerPin,
    p_id: a.id ?? null,
    p_name: a.name,
    p_phone: a.phone,
    p_email: a.email,
    p_credit_limit: a.credit_limit,
    p_opening_balance: a.opening_balance,
    p_active: a.active,
    p_notes: a.notes,
  });
  if (error) throw error;
  return data as Account;
}

/**
 * Admin: zero an account's outstanding balance as a write-off (no payment
 * taken). Recorded in the ledger and excluded from the cash drawer / EOD.
 * Returns the new balance (0).
 */
export async function managerClearAccount(
  managerPin: string,
  accountId: string,
  note?: string | null
): Promise<{ id: string; amount: number; balance: number }> {
  const { data, error } = await supabase.rpc("pos_manager_clear_account", {
    p_pin: managerPin,
    p_account_id: accountId,
    p_note: note ?? null,
  });
  if (error) throw error;
  return data as { id: string; amount: number; balance: number };
}

/** Upload an item photo to the public bucket and return its public URL. */
export async function uploadProductImage(file: File): Promise<string> {
  const ext = file.name.split(".").pop()?.toLowerCase() || "jpg";
  const path = `${crypto.randomUUID()}.${ext}`;
  const { error } = await supabase.storage
    .from("product-images")
    .upload(path, file, { cacheControl: "3600", upsert: false });
  if (error) throw error;
  const { data } = supabase.storage.from("product-images").getPublicUrl(path);
  return data.publicUrl;
}
