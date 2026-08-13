export type Role = "admin" | "manager" | "employee";

export type SaleStatus = "completed" | "pending_approval" | "voided";

export type PaymentMethod =
  | "cash"
  | "card"
  | "eft"
  | "zapper"
  | "account"
  /** More than one tender on the same sale. */
  | "mixed"
  /** Legacy: the old cash+card special case, kept so old queued sales replay. */
  | "split";

/** One tender against a sale. A sale settles when these cover its total. */
export interface Payment {
  method: PaymentMethod;
  /** The amount APPLIED to the sale, not the cash handed over. */
  amount: number;
  /** Terminal slip, EFT reference, Zapper id — what a dispute needs. */
  reference?: string | null;
}

export interface User {
  id: string;
  name: string;
  role: Role;
  phone?: string | null;
  email?: string | null;
  permissions?: string[] | null;
}

/**
 * A line in the catalogue.
 *
 * Two fields carry most of the hardware-specific weight:
 *   - `unit_code` / `unit_name` — what one unit *is* ("m", "kg", "bag"). The
 *     till shows it next to the quantity and prints it on the invoice, because
 *     "2.5 Chain" is meaningless and "2.5 m Chain" is not.
 *   - `allows_fraction` — whether a fraction is legitimate at all. Chain is cut
 *     to length; padlocks are not. The server enforces this too, so a bad
 *     quantity is a rejected sale rather than a silently rounded one.
 */
export interface Product {
  id: string;
  sku: string;
  barcode: string | null;
  name: string;
  description: string | null;
  category_id: string | null;
  category_name: string | null;
  unit_code: string;
  unit_name: string;
  allows_fraction: boolean;
  price_retail: number;
  /** Contractor price. Null means trade customers pay retail for this line. */
  price_trade: number | null;
  tax_code: string;
  /** null = stock is not tracked for this line. */
  stock_qty: number | null;
  reorder_level: number | null;
  image_url: string | null;
  sort_order: number;
  /** Shelf or bin location — where in the shop the thing physically is. */
  bin?: string | null;
  /** How many photographs exist; image_url is the first of them. */
  image_count?: number | null;
}

export interface Category {
  id: string;
  name: string;
  sort_order: number;
}

export interface UnitOfMeasure {
  code: string;
  name: string;
  allows_fraction: boolean;
  sort_order: number;
}

/**
 * A cart line. `qty` is a number with up to three decimals — 2.5 m of chain,
 * 0.75 kg of loose nails — not an integer count.
 */
export interface CartLine {
  product: Product;
  qty: number;
  /**
   * Money off THIS line, as opposed to off the sale.
   *
   * "Ten percent off the ladder" is a different transaction from "ten percent
   * off the lot": the second spreads itself across every line pro-rata, so the
   * ladder would show full price and the padlocks would carry a discount
   * nobody gave them.
   *
   * The amount is what counts. The percentage is remembered only so the slip
   * can say how it was asked for — and the server works the amount out again
   * from it, so the till and the database cannot disagree.
   */
  discount?: number;
  discountPercent?: number | null;
}

/** A customer account. Trade customers price off `price_trade` automatically. */
export interface Customer {
  id: string;
  code: string | null;
  name: string;
  phone: string | null;
  /** The buyer's VAT registration number, for a full tax invoice. */
  vat_number?: string | null;
  address?: string | null;
  is_trade: boolean;
  credit_limit: number | null;
  balance: number;
  /** Headroom left on the account. Null when the limit is unlimited. */
  available: number | null;
}

export interface CustomerDetail extends Customer {
  email: string | null;
  address: string | null;
  vat_number: string | null;
  opening_balance: number;
  notes: string | null;
  active: boolean;
}

/** One past purchase, for the "I bought it here in March" conversation. */
export interface CustomerVisit {
  sale_id: string;
  doc_number: string | null;
  created_at: string;
  total: number;
  payment_method: string | null;
  item_count: number;
  /** The item names, truncated — enough to recognise the purchase. */
  summary: string | null;
}

/**
 * One line of a customer's account, as the server computed it.
 *
 * The running balance comes from the database rather than being accumulated in
 * the client, so a printed statement and the screen can never disagree about
 * what someone owes.
 */
export interface LedgerEntry {
  kind: "opening" | "charge" | "payment";
  entry_at: string;
  /** Invoice number, or a payment's cheque/EFT reference. */
  ref: string;
  detail: string;
  charge: number;
  payment: number;
  balance: number;
  entry_id: string;
  /** A voided payment stays on the ledger but stops counting. */
  voided: boolean;
}

/** An account and how old the money owed on it is. */
export interface AccountRow extends Customer {
  /** Owed less than 30 days — or, if negative, paid in advance. */
  current_due: number;
  days30: number;
  days60: number;
  days90: number;
  oldest_unpaid: string | null;
  last_payment_at: string | null;
}

export interface Sale {
  id: string;
  /** Sequential tax invoice number, e.g. INV-000123. Null until completed. */
  doc_number: string | null;
  cashier_id: string;
  cashier_name: string;
  customer_id?: string | null;
  customer_name?: string | null;
  /** Whether this sale was rung up on the trade price list. */
  trade_pricing: boolean;
  /** VAT-inclusive, before discount. */
  subtotal: number;
  discount_amount: number;
  discount_reason: string | null;
  /** The VAT contained within `total`, as charged at the time of sale. */
  tax_amount: number;
  /** VAT-inclusive, after discount. */
  total: number;
  status: SaleStatus;
  approved_by: string | null;
  approved_by_name: string | null;
  payment_method: PaymentMethod | null;
  amount_tendered: number | null;
  change_due: number | null;
  paid_cash: number | null;
  paid_card: number | null;
  /** Cash-rounding adjustment: cash settles to the nearest 10c, the invoice does not. */
  rounding?: number | null;
  /** The buyer's purchase-order number, printed on the invoice. */
  po_number?: string | null;
  /** The buyer's VAT registration number, required on a full tax invoice. */
  customer_vat_number?: string | null;
  customer_address?: string | null;
  /** Snapshotted E.164 number, so a later edit to the customer cannot rewrite history. */
  customer_phone?: string | null;
  note?: string | null;
  created_at: string;
}

export interface SaleItem {
  name: string;
  sku: string | null;
  unit_code: string;
  qty: number;
  unit_price: number;
  line_total: number;
  tax_amount: number;
}

export interface RecentSale {
  id: string;
  doc_number: string | null;
  cashier_name: string;
  customer_name: string | null;
  total: number;
  tax_amount: number;
  status: SaleStatus;
  payment_method: PaymentMethod | null;
  created_at: string;
}

/** A paired till. The token is held on the device and never leaves it. */
export interface Register {
  id: string;
  name: string;
  active: boolean;
  last_seen_at: string | null;
  created_at: string;
}

/** Shop details for the invoice header, read from the database. */
export interface ShopSettings {
  shop_name: string;
  address_line1: string;
  address_line2: string;
  phone: string;
  vat_number: string;
  currency: string;
  registration_number: string;
}

/** Minimal shape the receipt builder needs (live carts and past sales alike). */
export interface ReceiptItem {
  name: string;
  unit_code: string;
  qty: number;
  unit_price: number;
  line_total: number;
  /** Money off this line alone. Printed under it when there is any. */
  discount_amount?: number;
  discount_percent?: number | null;
}

/**
 * A product as the back office sees it: includes inactive lines and the cost
 * price. `cost` comes back null for a user without `view_cost_prices`, which is
 * a separate permission from `manage_catalogue` — a supervisor can fix a
 * barcode without seeing the shop's margins.
 */
export interface AdminProduct {
  id: string;
  sku: string;
  barcode: string | null;
  name: string;
  description: string | null;
  category_id: string | null;
  category_name: string | null;
  unit_code: string;
  price_retail: number;
  price_trade: number | null;
  cost: number | null;
  tax_code: string;
  stock_qty: number | null;
  reorder_level: number | null;
  image_url: string | null;
  active: boolean;
  sort_order: number;
  /** Shelf or bin location — where in the shop the thing physically is. */
  bin?: string | null;
}

export interface StockMovement {
  at: string;
  qty_delta: number;
  qty_after: number | null;
  reason: "sale" | "void" | "receipt" | "adjustment" | "stocktake" | "opening";
  by_name: string | null;
  note: string | null;
}

/**
 * A name on the sign-in screen. Deliberately the least that will do: no phone,
 * no permissions, nothing about a PIN — this list is shown before anybody has
 * proved who they are.
 */
export interface LoginCandidate {
  id: string;
  name: string;
  role: "admin" | "manager" | "employee";
}
