// The client's whole view of the backend.
//
// Two credentials are in play, and which one a call uses is deliberate:
//
//   * The **register token** (device.ts) authenticates the till itself. It is
//     what makes the offline queue work: a sale taken during a fibre cut is
//     replayed hours later with no human present, so it cannot depend on
//     anybody's PIN. Ordinary selling uses this.
//   * A **PIN** authenticates a person, and is required for the things a
//     manager physically stands at the counter to do — approving a discount,
//     voiding a sale, pairing a till.
import { registerToken } from "./device";
import { supabase } from "./supabase";
import type {
  Category,
  Customer,
  Product,
  RecentSale,
  Register,
  Sale,
  SaleItem,
  ShopSettings,
  User,
} from "./types";

/** Thrown when the till has not been paired to this shop yet. */
export class NotPairedError extends Error {
  constructor() {
    super("This device is not paired to a till yet.");
    this.name = "NotPairedError";
  }
}

function requireToken(): string {
  const token = registerToken();
  if (!token) throw new NotPairedError();
  return token;
}

// --- Sign in ----------------------------------------------------------------

/** Verify a PIN and return the matching user, or null if no match. */
export async function login(pin: string): Promise<User | null> {
  const { data, error } = await supabase.rpc("pos_login", { p_pin: pin });
  if (error) throw error;
  const rows = data as User[];
  return rows?.[0] ?? null;
}

// --- Pairing ----------------------------------------------------------------

/**
 * Pair this device as a till. Returns the token, which is shown exactly once —
 * the server only ever stores its hash.
 */
export async function pairRegister(
  managerPin: string,
  name: string
): Promise<{ register_id: string; token: string }> {
  const { data, error } = await supabase.rpc("pos_pair_register", {
    p_pin: managerPin,
    p_name: name,
  });
  if (error) throw error;
  const rows = data as { register_id: string; token: string }[];
  if (!rows?.[0]) throw new Error("Pairing failed");
  return rows[0];
}

export async function listRegisters(managerPin: string): Promise<Register[]> {
  const { data, error } = await supabase.rpc("pos_list_registers", {
    p_pin: managerPin,
  });
  if (error) throw error;
  return data as Register[];
}

export async function revokeRegister(
  managerPin: string,
  registerId: string
): Promise<void> {
  const { error } = await supabase.rpc("pos_revoke_register", {
    p_pin: managerPin,
    p_register_id: registerId,
  });
  if (error) throw error;
}

// --- Catalogue --------------------------------------------------------------

/**
 * The full sellable range. Read straight from the `catalogue` view rather than
 * an RPC so the service worker can cache it — the till needs the price list
 * available with the network down.
 */
export async function fetchCatalogue(): Promise<Product[]> {
  const { data, error } = await supabase
    .from("catalogue")
    .select("*")
    .order("sort_order", { ascending: true })
    .order("name", { ascending: true });
  if (error) throw error;
  return data as Product[];
}

export async function fetchCategories(): Promise<Category[]> {
  const { data, error } = await supabase
    .from("categories")
    .select("id, name, sort_order")
    .order("sort_order", { ascending: true });
  if (error) throw error;
  return data as Category[];
}

export async function fetchSettings(): Promise<ShopSettings> {
  const { data, error } = await supabase.from("settings").select("key, value");
  if (error) throw error;
  const map = Object.fromEntries(
    (data as { key: string; value: string | null }[]).map((r) => [
      r.key,
      r.value ?? "",
    ])
  );
  return {
    shop_name: map.shop_name ?? "Hardware Shop",
    address_line1: map.address_line1 ?? "",
    address_line2: map.address_line2 ?? "",
    phone: map.phone ?? "",
    vat_number: map.vat_number ?? "",
    currency: map.currency ?? "R",
    registration_number: map.registration_number ?? "",
  };
}

// --- Selling ----------------------------------------------------------------

export interface CreateSaleInput {
  cashierId: string;
  /** [{ product_id, qty }] — the server prices it; the client never sends money. */
  items: { product_id: string; qty: number }[];
  customerId: string | null;
  paymentMethod: string;
  discountAmount: number;
  discountReason: string | null;
  /** Manager's user id when a discount was approved. Re-checked server-side. */
  approvedBy: string | null;
  amountTendered: number | null;
  paidCash: number | null;
  paidCard: number | null;
  /** Idempotency key. The same key always resolves to the same sale. */
  clientRef: string;
  /** When the sale was actually taken — matters for queued offline sales. */
  createdAt: string | null;
  note: string | null;
}

/**
 * Record a sale. Prices, VAT and totals are all recomputed server-side from the
 * catalogue, so a tampered payload cannot change what is charged.
 */
export async function createSale(input: CreateSaleInput): Promise<Sale> {
  const { data, error } = await supabase.rpc("pos_create_sale", {
    p_register_token: requireToken(),
    p_cashier_id: input.cashierId,
    p_items: input.items,
    p_customer_id: input.customerId,
    p_payment_method: input.paymentMethod,
    p_discount_amount: input.discountAmount,
    p_discount_reason: input.discountReason,
    p_approved_by: input.approvedBy,
    p_amount_tendered: input.amountTendered,
    p_paid_cash: input.paidCash,
    p_paid_card: input.paidCard,
    p_client_ref: input.clientRef,
    p_created_at: input.createdAt,
    p_note: input.note,
  });
  if (error) throw error;
  return data as Sale;
}

/** Release a sale parked for approval. The manager PIN is verified server-side. */
export async function approveSale(
  saleId: string,
  managerPin: string
): Promise<Sale> {
  const { data, error } = await supabase.rpc("pos_approve_sale", {
    p_sale_id: saleId,
    p_pin: managerPin,
  });
  if (error) throw error;
  return data as Sale;
}

/** Void a sale: puts the stock back and takes it out of the totals. */
export async function voidSale(
  saleId: string,
  managerPin: string,
  reason: string | null
): Promise<Sale> {
  const { data, error } = await supabase.rpc("pos_void_sale", {
    p_sale_id: saleId,
    p_pin: managerPin,
    p_reason: reason,
  });
  if (error) throw error;
  return data as Sale;
}

// --- Customers --------------------------------------------------------------

export async function listCustomers(): Promise<Customer[]> {
  const { data, error } = await supabase.rpc("pos_list_customers", {
    p_register_token: requireToken(),
  });
  if (error) throw error;
  return data as Customer[];
}

// --- Recent sales -----------------------------------------------------------

export async function recentSales(limit = 20): Promise<RecentSale[]> {
  const { data, error } = await supabase.rpc("pos_recent_sales", {
    p_register_token: requireToken(),
    p_limit: limit,
  });
  if (error) throw error;
  return data as RecentSale[];
}

export async function saleItems(saleId: string): Promise<SaleItem[]> {
  const { data, error } = await supabase.rpc("pos_sale_items", {
    p_register_token: requireToken(),
    p_sale_id: saleId,
  });
  if (error) throw error;
  return data as SaleItem[];
}
