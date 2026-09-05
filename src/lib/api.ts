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
import { API_BASE, supabase } from "./supabase";
import type { SaleRow } from "./sales";
import type {
  LoginCandidate,
  AccountRow,
  Category,
  Customer,
  CustomerVisit,
  LedgerEntry,
  Payment,
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
/** Who may sign in at this till: names and roles, nothing else. */
export async function staffForLogin(): Promise<LoginCandidate[]> {
  const { data, error } = await supabase.rpc("pos_staff_for_login", {
    p_register_token: requireToken(),
  });
  if (error) throw error;
  return (data as LoginCandidate[]) ?? [];
}

/**
 * Sign in as a named person.
 *
 * The id is what identifies them; the PIN only confirms it. Passing the PIN
 * alone used to be enough, which is precisely the problem — nothing requires a
 * PIN to be unique, so it was never a safe way to say who somebody is.
 */
export async function login(userId: string, pin: string): Promise<User | null> {
  const { data, error } = await supabase.rpc("pos_login", {
    p_register_token: requireToken(),
    p_user_id: userId,
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
    email: row?.email ?? "",
    bank_name: row?.bank_name ?? "",
    bank_account_name: row?.bank_account_name ?? "",
    bank_account_number: row?.bank_account_number ?? "",
    bank_branch_code: row?.bank_branch_code ?? "",
    receipt_terms: row?.receipt_terms ?? "",
    quote_terms: row?.quote_terms ?? "",
    logo_url: row?.logo_url ?? "",
    // Null rather than a stand-in: settings.vatRate() falls back to the
    // build's constant only when the server has never been reached, and a
    // zero here would print "VAT at 0%" on a brand-new till.
    vat_rate: typeof row?.vat_rate === "number" ? row.vat_rate : null,
    // Defaults to showing them. A server that answered without this field is
    // an old one, and an old one prices every line.
    quote_show_line_prices: row?.quote_show_line_prices !== false,
  };
}

// --- Selling ----------------------------------------------------------------

export interface CreateSaleInput {
  cashierId: string;
  /**
   * [{ product_id, qty, discount_amount?, discount_percent?, discount_reason? }]
   * — the server prices it; the client never sends money. A line discount
   * travels because it is the cashier's decision, but the server re-works a
   * percentage into an amount itself rather than trusting the arithmetic that
   * arrives, and keeps the reason only where there is a discount to explain.
   */
  items: {
    product_id: string;
    qty: number;
    discount_amount?: number;
    discount_percent?: number | null;
    discount_reason?: string | null;
  }[];
  customerId: string | null;
  paymentMethod: string;
  discountAmount: number;
  discountReason: string | null;
  /** Manager's user id when a discount was approved. Re-checked server-side. */
  approvedBy: string | null;
  /** A manager's single-use code, when one was read over the phone instead. */
  approvalCode?: string | null;
  /** Cash physically handed over, for working out the change. */
  amountTendered: number | null;
  paidCash: number | null;
  paidCard: number | null;
  /** Every tender on this sale. The server checks they settle the total. */
  payments?: Payment[] | null;
  /** The buyer's purchase-order number. */
  poNumber?: string | null;
  /** The buyer's VAT number, when it is not already on their account. */
  customerVatNumber?: string | null;
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
    p_approval_code: input.approvalCode ?? null,
    p_amount_tendered: input.amountTendered,
    p_paid_cash: input.paidCash,
    p_paid_card: input.paidCard,
    p_client_ref: input.clientRef,
    p_created_at: input.createdAt,
    p_note: input.note,
    p_payments: input.payments ?? null,
    p_po_number: input.poNumber ?? null,
    p_customer_vat_number: input.customerVatNumber ?? null,
  });
  if (error) throw error;
  return data as Sale;
}

/**
 * A single-use code a manager can read over the phone instead of their PIN.
 *
 * The whole point is that this is safe to say out loud: it approves one
 * discount, once, before it expires, and it cannot sign in or open anything.
 * See supabase/migrations/0039_approval_codes.sql.
 */
export async function issueApprovalCode(
  pin: string,
  minutes: number,
  maxAmount: number | null,
  reason: string | null
): Promise<{ code: string; expires_at: string }> {
  const { data, error } = await supabase.rpc("pos_issue_approval_code", {
    p_register_token: requireToken(),
    p_pin: pin,
    p_minutes: minutes,
    p_max_amount: maxAmount,
    p_reason: reason,
  });
  if (error) throw error;
  const row = (data as { code: string; expires_at: string }[])?.[0];
  if (!row) throw new Error("Could not issue a code");
  return row;
}

export interface ApprovalCodeCheck {
  ok: boolean;
  issued_by_name: string | null;
  max_amount: number | null;
  expires_at: string | null;
}

/**
 * Is this code live? Asked while the cashier types, so a wrong code is caught
 * at the counter rather than at the tender screen. It does not spend the code —
 * that happens with the sale itself, so a code is never burnt on a sale that
 * then fails.
 */
export async function checkApprovalCode(code: string): Promise<ApprovalCodeCheck> {
  const { data, error } = await supabase.rpc("pos_check_approval_code", {
    p_register_token: requireToken(),
    p_code: code,
  });
  if (error) throw error;
  return (data as ApprovalCodeCheck[])?.[0] ?? { ok: false, issued_by_name: null, max_amount: null, expires_at: null };
}

export interface ApprovalCodeRow {
  id: string;
  issued_by_name: string;
  max_amount: number | null;
  reason: string | null;
  created_at: string;
  expires_at: string;
  used_at: string | null;
  used_by_name: string | null;
  doc_number: string | null;
}

/** What has been issued lately and what became of it — the audit trail. */
export async function approvalCodes(pin: string): Promise<ApprovalCodeRow[]> {
  const { data, error } = await supabase.rpc("pos_approval_codes", {
    p_register_token: requireToken(),
    p_pin: pin,
    p_limit: 50,
  });
  if (error) throw error;
  return (data as ApprovalCodeRow[]) ?? [];
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
  /** A manager's PIN, or a one-time code a manager issued (0054). */
  secret: string,
  reason: string | null,
  /** Who is at the till, recorded when a code is spent. */
  cashierId: string | null = null
): Promise<Sale> {
  const { data, error } = await supabase.rpc("pos_void_sale", {
    p_sale_id: saleId,
    p_register_token: requireToken(),
    p_pin: secret,
    p_reason: reason,
    p_cashier_id: cashierId,
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

/**
 * The buyer behind a phone number, or null.
 *
 * The server normalises before it looks, so it does not matter whether the
 * cashier typed 082…, +2782… or 2782….
 */
export async function findCustomerByPhone(
  phone: string
): Promise<Customer | null> {
  const { data, error } = await supabase.rpc("pos_customer_by_phone", {
    p_register_token: requireToken(),
    p_phone: phone,
  });
  if (error) throw error;
  return (data as Customer[])[0] ?? null;
}

/**
 * Record a buyer at the counter, or fetch the one already on file.
 *
 * Authorised by the cashier's own right to take payments — a flow that needed a
 * manager's PIN would never survive a queue. It cannot grant credit: what comes
 * back is always a retail-priced contact with no limit.
 */
export async function quickCustomer(
  cashierId: string,
  phone: string,
  name?: string | null,
  vatNumber?: string | null,
  address?: string | null
): Promise<Customer> {
  const { data, error } = await supabase.rpc("pos_quick_customer", {
    p_register_token: requireToken(),
    p_cashier_id: cashierId,
    p_phone: phone,
    p_name: name ?? null,
    p_vat_number: vatNumber ?? null,
    p_address: address ?? null,
  });
  if (error) throw error;
  return (data as Customer[])[0];
}

// --- Accounts ---------------------------------------------------------------

/** Every account, with what is owed and how old it is. */
export async function accountsOverview(): Promise<AccountRow[]> {
  const { data, error } = await supabase.rpc("pos_accounts_overview", {
    p_register_token: requireToken(),
  });
  if (error) throw error;
  return data as AccountRow[];
}

/** One customer's charges and payments, newest first, with a running balance. */
export async function customerLedger(
  customerId: string,
  limit = 100
): Promise<LedgerEntry[]> {
  const { data, error } = await supabase.rpc("pos_customer_ledger", {
    p_register_token: requireToken(),
    p_customer_id: customerId,
    p_limit: limit,
  });
  if (error) throw error;
  return data as LedgerEntry[];
}

/** What a customer's statement says, for a period (0067). */
export interface CustomerStatement {
  customer: {
    id: string; name: string; phone: string | null; address: string | null;
    vat_number: string | null; credit_limit: number | null;
  };
  from: string;
  to: string;
  /** Deterministic, so asking twice gives the same document. */
  reference: string;
  opening: number;
  lines: {
    at: string; kind: "opening" | "charge" | "payment"; ref: string;
    detail: string; charge: number; payment: number; voided: boolean;
    balance: number;
  }[];
  charges: number;
  payments: number;
  closing: number;
  ageing: {
    current: number; days30: number; days60: number; days90: number;
    total: number; oldest_unpaid: string | null;
  };
  as_at: string;
}

/**
 * One customer's statement: what was owed when the period opened, what moved
 * inside it, and what is owed now. Dates are whole days, inclusive.
 */
export async function customerStatement(
  customerId: string,
  from: string | null = null,
  to: string | null = null
): Promise<CustomerStatement> {
  const { data, error } = await supabase.rpc("pos_customer_statement", {
    p_register_token: requireToken(),
    p_customer_id: customerId,
    p_from: from,
    p_to: to,
  });
  if (error) throw error;
  return data as CustomerStatement;
}

/**
 * A contractor settling their account at the counter.
 *
 * `clientRef` is the replay guard: a tablet at a busy counter double-taps, and
 * without it the shop credits the customer twice for one payment.
 */
export async function takeAccountPayment(
  cashierId: string,
  customerId: string,
  amount: number,
  method: string,
  reference?: string | null,
  note?: string | null,
  clientRef?: string
): Promise<{ payment_id: string; balance: number; available: number | null }> {
  const { data, error } = await supabase.rpc("pos_take_account_payment", {
    p_register_token: requireToken(),
    p_cashier_id: cashierId,
    p_customer_id: customerId,
    p_amount: amount,
    p_method: method,
    p_reference: reference ?? null,
    p_note: note ?? null,
    p_client_ref: clientRef ?? null,
  });
  if (error) throw error;
  return (data as { payment_id: string; balance: number; available: number | null }[])[0];
}

/** Undo a payment taken in error. Manager's PIN; never deletes the entry. */
export async function voidAccountPayment(
  managerPin: string,
  paymentId: string,
  reason: string
): Promise<number> {
  const { data, error } = await supabase.rpc("pos_void_account_payment", {
    p_register_token: requireToken(),
    p_pin: managerPin,
    p_payment_id: paymentId,
    p_reason: reason,
  });
  if (error) throw error;
  return data as number;
}

/** What this buyer has bought before. Completed sales only. */
export async function customerHistory(
  customerId: string,
  limit = 20
): Promise<CustomerVisit[]> {
  const { data, error } = await supabase.rpc("pos_customer_history", {
    p_register_token: requireToken(),
    p_customer_id: customerId,
    p_limit: limit,
  });
  if (error) throw error;
  return data as CustomerVisit[];
}

// --- Quotes -------------------------------------------------------------------

export interface QuoteSummary {
  id: string;
  doc_number: string | null;
  created_at: string;
  cashier_name: string;
  customer_id: string | null;
  customer_name: string | null;
  total: number;
  valid_until: string;
  expired: boolean;
  item_count: number;
  note: string | null;
  /**
   * The archived document, if one was kept. Null means nobody managed to
   * store it — the line was down when the quote was saved — and the till
   * builds one from the quote's own figures instead.
   */
  pdf_path: string | null;
}

export interface QuoteLine {
  product_id: string | null;
  sku: string | null;
  name: string;
  unit_code: string;
  qty: number;
  /** The promise: what the shop quoted on the day. */
  unit_price: number;
  line_total: number;
  /** Today's price, so a drift from the promise is visible before the sale. */
  price_now: number | null;
  still_sold: boolean;
}

/** Save the cart as a quote. Prices snapshot server-side, same as a sale. */
export async function saveQuote(
  cashierId: string,
  items: { product_id: string; qty: number }[],
  customerId: string | null,
  validDays = 14,
  note?: string | null,
  /** Who it is for when there is no account: the name the counter was told. */
  customerName?: string | null
): Promise<{ quote_id: string; doc_number: string; valid_until: string; total: number }> {
  const { data, error } = await supabase.rpc("pos_save_quote", {
    p_register_token: requireToken(),
    p_cashier_id: cashierId,
    p_items: items,
    p_customer_id: customerId,
    p_valid_days: validDays,
    p_note: note ?? null,
    p_customer_name: customerName ?? null,
  });
  if (error) throw error;
  return (data as { quote_id: string; doc_number: string; valid_until: string; total: number }[])[0];
}

export async function listQuotes(limit = 50): Promise<QuoteSummary[]> {
  const { data, error } = await supabase.rpc("pos_list_quotes", {
    p_register_token: requireToken(),
    p_limit: limit,
  });
  if (error) throw error;
  return data as QuoteSummary[];
}

export async function quoteItems(quoteId: string): Promise<QuoteLine[]> {
  const { data, error } = await supabase.rpc("pos_quote_items", {
    p_register_token: requireToken(),
    p_quote_id: quoteId,
  });
  if (error) throw error;
  return data as QuoteLine[];
}

/** Close a quote as converted (with its sale) or cancelled. */
export async function closeQuote(
  cashierId: string,
  quoteId: string,
  status: "converted" | "cancelled",
  saleId?: string | null
): Promise<void> {
  const { error } = await supabase.rpc("pos_close_quote", {
    p_register_token: requireToken(),
    p_cashier_id: cashierId,
    p_quote_id: quoteId,
    p_status: status,
    p_sale_id: saleId ?? null,
  });
  if (error) throw error;
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

/** A sale by the number printed on its slip, or null. Register token only;
    the row is the one the Sales screen lists, so a reprint has every figure. */
export async function saleByNumber(docNumber: string): Promise<SaleRow | null> {
  const { data, error } = await supabase.rpc("pos_sale_by_number", {
    p_register_token: requireToken(),
    p_doc_number: docNumber,
  });
  if (error) throw error;
  return (data as SaleRow | null) ?? null;
}

/** A quote by the number on its slip — any status, so a closed one can say so. */
export async function quoteByNumber(
  docNumber: string
): Promise<(QuoteSummary & { status: string }) | null> {
  const { data, error } = await supabase.rpc("pos_quote_by_number", {
    p_register_token: requireToken(),
    p_doc_number: docNumber,
  });
  if (error) throw error;
  return (data as (QuoteSummary & { status: string })[])[0] ?? null;
}

export async function recentSales(limit = 20): Promise<RecentSale[]> {
  const { data, error } = await supabase.rpc("pos_recent_sales", {
    p_register_token: requireToken(),
    p_limit: limit,
  });
  if (error) throw error;
  return data as RecentSale[];
}

/** What was actually tendered against a sale — for a reprint or a dispute. */
export async function salePayments(saleId: string): Promise<Payment[]> {
  const { data, error } = await supabase.rpc("pos_sale_payments", {
    p_register_token: requireToken(),
    p_sale_id: saleId,
  });
  if (error) throw error;
  return data as Payment[];
}

export async function saleItems(saleId: string): Promise<SaleItem[]> {
  const { data, error } = await supabase.rpc("pos_sale_items", {
    p_register_token: requireToken(),
    p_sale_id: saleId,
  });
  if (error) throw error;
  return data as SaleItem[];
}

// --- The archived quotation (0060) -------------------------------------------

/**
 * Keep a quote's document, or fetch the one already kept.
 *
 * WHY KEEP IT AT ALL. The quote's figures are frozen in quote_items, so
 * rebuilding gives the same prices forever — but not the same page. The
 * shop's address, telephone, terms and logo all live in settings, and the day
 * the shop moves, every old quotation redownloads with the new address on it.
 * That is not the document the customer is holding.
 *
 * Storing is best-effort by design: a quote that could not be archived is
 * still a quote, and the till rebuilds it. Nothing here may throw into the
 * path that saves a sale.
 */
export async function archiveQuotePdf(
  quoteId: string,
  dataUrl: string
): Promise<string | null> {
  try {
    const res = await fetch(`${API_BASE}/functions/v1/quote-pdf`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apikey: import.meta.env.VITE_SUPABASE_ANON_KEY,
        Authorization: `Bearer ${import.meta.env.VITE_SUPABASE_ANON_KEY}`,
      },
      body: JSON.stringify({
        action: "put",
        register_token: requireToken(),
        quote_id: quoteId,
        file: dataUrl,
      }),
    });
    const out = (await res.json()) as { ok?: boolean; path?: string };
    return out.ok ? out.path ?? null : null;
  } catch {
    return null;
  }
}

/** A short-lived URL for the kept document, or null if there is not one. */
export async function archivedQuotePdfUrl(quoteId: string): Promise<string | null> {
  const res = await fetch(`${API_BASE}/functions/v1/quote-pdf`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      apikey: import.meta.env.VITE_SUPABASE_ANON_KEY,
      Authorization: `Bearer ${import.meta.env.VITE_SUPABASE_ANON_KEY}`,
    },
    body: JSON.stringify({
      action: "get",
      register_token: requireToken(),
      quote_id: quoteId,
    }),
  });
  const out = (await res.json()) as { ok?: boolean; url?: string | null };
  if (!out.ok) throw new Error("That document could not be opened.");
  return out.url ?? null;
}

// --- Deliveries (0061) -------------------------------------------------------

export interface DeliveryRow {
  id: string;
  doc_number: string;
  sale_id: string;
  sale_number: string | null;
  customer_name: string;
  address: string;
  deliver_on: string;
  deliver_at: string | null;
  charge: number;
  note: string | null;
  status: "pending" | "delivered";
  created_at: string;
  cashier_name: string | null;
  delivered_at: string | null;
  delivered_by_name: string | null;
  item_count: number;
}

export interface DeliveryLine {
  sku: string | null;
  name: string;
  unit_code: string;
  qty: number;
}

/** The shop's line for charging delivery. Made on first use, by the server. */
export async function deliveryProduct(): Promise<{
  id: string; sku: string; name: string; unit_code: string;
}> {
  const { data, error } = await supabase.rpc("pos_delivery_product", {
    p_register_token: requireToken(),
  });
  if (error) throw error;
  const rows = data as { id: string; sku: string; name: string; unit_code: string }[];
  if (!rows?.length) throw new Error("The delivery line could not be set up.");
  return rows[0];
}

/** Write the note, once the sale that carries the goods exists. */
export async function createDelivery(args: {
  cashierId: string;
  saleId: string;
  customerName: string;
  address: string;
  deliverOn: string;
  deliverAt?: string | null;
  charge?: number;
  note?: string | null;
}): Promise<DeliveryRow> {
  const { data, error } = await supabase.rpc("pos_create_delivery", {
    p_register_token: requireToken(),
    p_cashier_id: args.cashierId,
    p_sale_id: args.saleId,
    p_customer_name: args.customerName,
    p_address: args.address,
    p_deliver_on: args.deliverOn,
    p_deliver_at: args.deliverAt ?? null,
    p_charge: args.charge ?? 0,
    p_note: args.note ?? null,
  });
  if (error) throw error;
  return data as DeliveryRow;
}

export async function listDeliveries(limit = 100): Promise<DeliveryRow[]> {
  const { data, error } = await supabase.rpc("pos_list_deliveries", {
    p_register_token: requireToken(),
    p_limit: limit,
  });
  if (error) throw error;
  return (data as DeliveryRow[]) ?? [];
}

/** What is on the load: the goods, never the charge for carrying them. */
export async function deliveryItems(deliveryId: string): Promise<DeliveryLine[]> {
  const { data, error } = await supabase.rpc("pos_delivery_items", {
    p_register_token: requireToken(),
    p_delivery_id: deliveryId,
  });
  if (error) throw error;
  return (data as DeliveryLine[]) ?? [];
}

/** The signed page came back. Anyone may say so; who said so is recorded. */
export async function markDelivered(
  userId: string, deliveryId: string, note?: string | null
): Promise<DeliveryRow> {
  const { data, error } = await supabase.rpc("pos_mark_delivered", {
    p_register_token: requireToken(),
    p_user_id: userId,
    p_delivery_id: deliveryId,
    p_note: note ?? null,
  });
  if (error) throw error;
  return data as DeliveryRow;
}
