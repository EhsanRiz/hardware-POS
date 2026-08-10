export type Role = "admin" | "manager" | "employee";

export type SaleStatus = "completed" | "pending_approval" | "voided" | "open";

export type PaymentMethod = "cash" | "card" | "account" | "split";

// Customer house account (accounts receivable).
export interface AccountListItem {
  id: string;
  name: string;
  phone: string | null;
  credit_limit: number | null;
  balance: number;
}

export interface Account {
  id: string;
  name: string;
  phone: string | null;
  email: string | null;
  credit_limit: number | null;
  opening_balance: number;
  active: boolean;
  notes: string | null;
  balance: number;
  created_at: string;
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

export interface AccountLedger {
  id: string;
  name: string;
  phone: string | null;
  email: string | null;
  credit_limit: number | null;
  opening_balance: number;
  balance: number;
  entries: LedgerEntry[];
}

export interface User {
  id: string;
  name: string;
  role: Role;
  phone?: string | null;
  email?: string | null;
  permissions?: string[] | null;
}

export interface Product {
  id: string;
  name: string;
  category: string;
  price: number;
  cost?: number | null; // optional cost price (for markup)
  active: boolean;
  sort_order: number;
  image_url: string | null;
  stock_qty: number | null; // null = not tracked
  variants?: ProductVariant[];
}

// A size / option of a product, with its own price and (optional) stock.
export interface ProductVariant {
  id: string;
  name: string | null; // optional descriptor, e.g. "With Milk"
  size: string | null; // optional, e.g. "Large"
  price: number;
  cost?: number | null; // optional cost price (for markup)
  stock_qty: number | null; // null = not tracked
  active: boolean;
  sort_order: number;
}

export interface CartLine {
  product: Product;
  qty: number;
  variant?: ProductVariant; // the chosen size/option, when the product has them
}

export interface Sale {
  id: string;
  cashier_id: string;
  cashier_name: string;
  subtotal: number;
  discount_amount: number;
  discount_reason: string | null;
  tip_amount: number;
  total: number;
  status: SaleStatus;
  approved_by: string | null;
  approved_by_name: string | null;
  payment_method: PaymentMethod | null;
  amount_tendered: number | null;
  change_due: number | null;
  label: string | null;
  account_id?: string | null;
  paid_cash?: number | null; // cash portion of a split payment
  paid_card?: number | null; // card portion of a split payment
  created_at: string;
}

export interface OpenOrder {
  id: string;
  label: string | null;
  cashier_name: string;
  total: number;
  item_count: number;
  created_at: string;
  // Set for orders parked on this device while offline (not yet on the server).
  localId?: string;
  pending?: boolean;
}

export interface OpenOrderItem {
  product_id: string;
  variant_id: string | null;
  name: string;
  unit_price: number;
  qty: number;
}

// A server open order together with its line items, cached on the device so it
// stays visible and reopenable while offline.
export interface OpenOrderFull extends OpenOrder {
  items: OpenOrderItem[];
}

export interface CashMovement {
  id: string;
  type: "pay_in" | "pay_out";
  amount: number;
  reason: string | null;
  by_name: string | null;
  at: string;
}

// Live view of the currently open shift.
export interface OpenSession {
  id: string;
  opened_by_name: string | null;
  opened_at: string;
  opening_float: number;
  cash_sales: number;
  card_sales: number;
  pay_ins: number;
  pay_outs: number;
  expected_cash: number;
  expected_card: number;
  movements: CashMovement[];
}

export interface CashSession {
  id: string;
  opened_by_name: string | null;
  opened_at: string;
  opening_float: number;
  status: "open" | "closed";
  closed_by_name: string | null;
  closed_at: string | null;
  cash_sales: number | null;
  card_sales: number | null;
  pay_ins: number | null;
  pay_outs: number | null;
  expected_cash: number | null;
  counted_cash: number | null;
  cash_variance: number | null;
  expected_card: number | null;
  settled_card: number | null;
  card_variance: number | null;
  notes: string | null;
}

export interface SaleItem {
  id: string;
  name: string;
  unit_price: number;
  qty: number;
  line_total: number;
}

// Minimal shape the receipt builder needs (works for live carts and past sales).
export interface ReceiptItem {
  name: string;
  price: number;
  qty: number;
}
