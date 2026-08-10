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

/** The pairing token, or NotPairedError. Shared with adminApi — same rule. */
export function requireToken(): string {
  const token = registerToken();
  if (!token) throw new NotPairedError();
  return token;
}

// --- Sign in ----------------------------------------------------------------

/**
 * Verify a PIN and return the matching user, or null if no match.
 *
 * The check is scoped to this till's organization by the register token — two
 * shops' staff may well pick the same six digits, and neither must ever
 * resolve to the other. That is also why sign-in needs no phone number.
 */
export async function login(pin: string): Promise<User | null> {
  const { data, error } = await supabase.rpc("pos_login", {
    p_register_token: requireToken(),
    p_pin: pin,
  });
  if (error) throw error;
  const rows = data as User[];
  return rows?.[0] ?? null;
}

// --- Pairing ----------------------------------------------------------------

/**
 * Pair this device as a till. The manager's phone identifies them globally
 * (this is the one moment the org is unknown — afterwards the token carries
 * it), the PIN proves it. Returns the token, which is shown exactly once —
 * the server only ever stores its hash.
 */
export async function pairRegister(
  managerPhone: string,
  managerPin: string,
  name: string
): Promise<{ register_id: string; token: string }> {
  const { data, error } = await supabase.rpc("pos_pair_register", {
    p_phone: managerPhone,
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
    p_register_token: requireToken(),
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
    p_register_token: requireToken(),
    p_pin: managerPin,
    p_register_id: registerId,
  });
  if (error) throw error;
}

// --- Catalogue --------------------------------------------------------------

/**
 * The full sellable range for THIS shop. The register token names the org, so
 * an unpaired browser sees nothing at all — there is no anonymous read of any
 * catalogue any more. Offline resilience comes from the till's own cache
 * (localCache in POS.tsx), which survives outages just as the old
 * service-worker-cached view did.
 */
export async function fetchCatalogue(): Promise<Product[]> {
  const { data, error } = await supabase.rpc("pos_catalogue", {
    p_register_token: requireToken(),
  });
  if (error) throw error;
  return data as Product[];
}

export async function fetchCategories(): Promise<Category[]> {
  const { data, error } = await supabase.rpc("pos_categories", {
    p_register_token: requireToken(),
  });
  if (error) throw error;
  return data as Category[];
}

export async function fetchSettings(): Promise<ShopSettings> {
  const { data, error } = await supabase.rpc("pos_org_settings", {
    p_register_token: requireToken(),
  });
  if (error) throw error;
  const row = (data as ShopSettings[])?.[0];
  return {
    shop_name: row?.shop_name ?? "Hardware Shop",
    address_line1: row?.address_line1 ?? "",
    address_line2: row?.address_line2 ?? "",
    phone: row?.phone ?? "",
    vat_number: row?.vat_number ?? "",
    currency: row?.currency ?? "R",
    registration_number: row?.registration_number ?? "",
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
    p_register_token: requireToken(),
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
    p_register_token: requireToken(),
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

// --- Search -----------------------------------------------------------------

/**
 * Server-side product search: normalises the query, matches every word
 * independently, tolerates typos, and ranks the results.
 *
 * Preferred over the on-device search when the network is up, because it sees
 * the whole catalogue and uses real trigram indexes. `searchProductsLocal` in
 * search.ts is the offline equivalent.
 */
export async function searchProducts(
  query: string,
  limit = 25
): Promise<Product[]> {
  const { data, error } = await supabase.rpc("pos_search_products", {
    p_register_token: requireToken(),
    p_query: query,
    p_limit: limit,
  });
  if (error) throw error;
  // The RPC returns a score alongside the product shape; the till doesn't need
  // it, and dropping it here keeps Product honest.
  return (data as (Product & { score: number })[]).map(({ score: _s, ...p }) => p);
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
