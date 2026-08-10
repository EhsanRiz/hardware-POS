export type Role = "admin" | "manager" | "employee";

export type SaleStatus = "completed" | "pending_approval" | "voided";

export type PaymentMethod = "cash" | "card" | "account" | "split";

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
}

/** A customer account. Trade customers price off `price_trade` automatically. */
export interface Customer {
  id: string;
  code: string | null;
  name: string;
  phone: string | null;
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

export interface LedgerEntry {
  kind: "charge" | "payment";
  at: string;
  amount: number;
  by: string | null;
  note: string | null;
  method: string | null;
  ref: string;
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
}

export interface StockMovement {
  at: string;
  qty_delta: number;
  qty_after: number | null;
  reason: "sale" | "void" | "receipt" | "adjustment" | "stocktake" | "opening";
  by_name: string | null;
  note: string | null;
}
