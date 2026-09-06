import type { Page, Route } from "@playwright/test";

/**
 * A stand-in for the Supabase backend, wired in with request interception.
 *
 * Why fake it rather than test against a real project:
 *
 *  - The behaviour worth testing end to end is what happens when the *network
 *    fails* — a sale taken offline, queued, and replayed. That is difficult to
 *    provoke reliably against a live database and trivial here.
 *  - It keeps the suite runnable with no credentials and no connectivity, so it
 *    can gate a pull request.
 *  - It lets a test assert things a live database cannot easily show, such as
 *    "the client sent this sale twice and only one exists".
 *
 * The trade-off is real and worth naming: this verifies the client against a
 * MODEL of the server, so it cannot catch the client and the real RPCs drifting
 * apart. The database side is covered separately, directly in SQL against a live
 * project (see the checks recorded in the README). Anything asserted here about
 * a server response is only as true as this file.
 */

export interface FakeProduct {
  id: string;
  sku: string;
  barcode: string | null;
  name: string;
  category_id: string | null;
  category_name: string | null;
  unit_code: string;
  unit_name: string;
  allows_fraction: boolean;
  price_retail: number;
  price_trade: number | null;
  tax_code: string;
  stock_qty: number | null;
  reorder_level: number | null;
  image_url: string | null;
  sort_order: number;
  bin: string | null;
  /** The shop's ceiling on discounting this line. Null means uncapped. */
  max_discount_percent: number | null;
  max_discount_amount: number | null;
  /** 0061: 'delivery' is priced at the counter; everything else by the shop. */
  kind?: "goods" | "delivery";
  /** 0064: what the line costs the shop, where the shop has said. */
  cost?: number | null;
}

/**
 * The shop's delivery line, as pos_delivery_product() makes it.
 *
 * Not in PRODUCTS: it is not something anybody scans off a shelf, and a
 * catalogue search that turned it up would be a way to sell nothing for
 * nothing. The till asks the server for it when a delivery is arranged.
 */
export const DELIVERY_LINE: FakeProduct = {
  id: "delivery-line", sku: "DELIVERY", barcode: null, name: "Delivery",
  category_id: "cat-delivery", category_name: "Delivery",
  unit_code: "ea", unit_name: "Each",
  allows_fraction: false, price_retail: 0, price_trade: 0,
  tax_code: "standard", stock_qty: null, reorder_level: null, image_url: null,
  sort_order: 0, bin: null, max_discount_percent: null,
  max_discount_amount: null, kind: "delivery",
  // 0064: what a trip costs the shop. Mutable, because the settings screen
  // sets it and the reports read it back.
  cost: null as number | null,
};

/**
 * Every product the fake can sell, the delivery line included.
 *
 * It is deliberately not IN the catalogue — nobody scans it off a shelf — but
 * it does turn up on sales, and the fake used to reach straight into PRODUCTS
 * and find nothing. A sale with a delivery charge on it then threw on the way
 * to any report, the reprint and the export.
 */
export function fakeProduct(id: string | null): FakeProduct | undefined {
  if (!id) return undefined;
  return PRODUCTS.find((p) => p.id === id)
    ?? (id === DELIVERY_LINE.id ? DELIVERY_LINE : undefined);
}

export const PRODUCTS: FakeProduct[] = [
  mk("p1", "CEM-425-50", "6001234000015", "Cement 42.5N 50kg", "bag", "Bag", false, 115, 108, 240, 40),
  mk("p2", "CHN-06", null, "Chain 6mm Galvanised", "m", "Metre", true, 35, 31.5, 120, 30),
  mk("p3", "NAL-100", null, "Wire Nails 100mm loose", "kg", "Kilogram", true, 42, 38, 85, 20),
  mk("p4", "NCN-2550", null, "Nail Concrete 2.5 x 50mm", "kg", "Kilogram", true, 68, 61, 40, 10),
  mk("p5", "PDL-50", "6001234000060", "Padlock 50mm Brass", "ea", "Each", false, 89, 80, 45, 10),
  mk("p6", "CBL-25-100", null, "Twin & Earth 2.5mm 100m", "roll", "Roll", false, 1450, 1330, 2, 3),
];

function mk(
  id: string, sku: string, barcode: string | null, name: string,
  unit_code: string, unit_name: string, allows_fraction: boolean,
  price_retail: number, price_trade: number | null,
  stock_qty: number | null, reorder_level: number | null
): FakeProduct {
  return {
    id, sku, barcode, name,
    category_id: "c1", category_name: "Building",
    unit_code, unit_name, allows_fraction,
    price_retail, price_trade, tax_code: "standard",
    stock_qty, reorder_level, image_url: null, sort_order: 0, bin: "A1",
    max_discount_percent: null, max_discount_amount: null,
    // What the shop paid. Stated once, here, rather than hardcoded separately
    // in the catalogue route and again on a sale line — booking a delivery in
    // at a new price has to be visible in both.
    cost: 50,
  };
}

export const USERS = {
  manager: { pin: "123456", phone: "+27820000001", row: { id: "u1", name: "Manager", role: "admin", phone: "+27820000001", email: null, permissions: ["take_payments","apply_discount","approve_discount","manage_catalogue","manage_inventory","manage_purchasing","view_cost_prices","manage_settings","void_refund","view_reports","shelf_capture"] } },
  employee: { pin: "567890", phone: "+27820000002", row: { id: "u2", name: "Sam", role: "employee", phone: "+27820000002", email: null, permissions: ["take_payments","apply_discount"] } },
  // The aisle: somebody whose only management right is the shelf. As on the
  // server, permissions here are the EFFECTIVE set — role defaults plus the
  // one grant — because that is what pos_login returns.
  shelf: { pin: "777777", phone: "+27820000031", row: { id: "u3", name: "Nomsa", role: "employee", phone: "+27820000031", email: null, permissions: ["take_payments","apply_discount","shelf_capture"] } },
};

/** The token pos_pair_register hands out; every token-scoped RPC must carry it. */
export const REGISTER_TOKEN = "test-register-token";

// PRODUCTS is module state and the shelf screen edits prices on it; taken at
// load, before any test has run, so installBackend can put them back.
const SEED_RETAIL = new Map(PRODUCTS.map((p) => [p.id, p.price_retail]));
const SEED_STOCK = new Map(PRODUCTS.map((p) => [p.id, p.stock_qty]));
const SEED_COST = new Map(PRODUCTS.map((p) => [p.id, p.cost ?? null]));

export interface RecordedSale {
  client_ref: string | null;
  cashier_id: string;
  customer_id: string | null;
  items: {
    product_id: string;
    qty: number;
    /** 0061: the price named at the counter, on an open line only. */
    unit_price?: number;
    discount_amount?: number;
    discount_percent?: number | null;
    /** Kept as the server keeps it: trimmed, cut to 200, and only where there
     *  is a discount for it to explain. */
    discount_reason?: string | null;
  }[];
  payment_method: string;
  discount_amount: number;
  /**
   * Why money came off. The fake hardcoded this to null on the way back, so no
   * test could see a discount reason on a slip — which is how "10% off" could
   * reach the database and never reach the paper without anything noticing.
   */
  discount_reason: string | null;
  approved_by: string | null;
  created_at: string | null;
  total: number;
  /** Every tender the client sent, so a test can assert on the settlement. */
  payments: { method: string; amount: number }[];
  po_number: string | null;
  customer_vat_number: string | null;
  rounding: number;
  /**
   * Whether the discount sat inside what this cashier may give unasked. The
   * server decides this from their limit; carrying it here is what lets the
   * fake tell a sale that completes on its own authority from one that parks.
   */
  within_limit: boolean;
  /**
   * The notes handed over, and what the drawer owes back. The fake used to
   * hardcode both to null, so no test could see the change line on a slip —
   * which is how a settled sale came to report R0.00 change on a R1 000 note.
   */
  amount_tendered: number | null;
  change_due: number | null;
  /** 0054: cancelled at the counter. Stays on the list, struck through. */
  voided?: boolean;
  void_reason?: string | null;
}

/** A buyer on file, in the shape pos_list_customers returns. */
export interface FakeCustomer {
  id: string;
  code: string | null;
  name: string;
  phone: string | null;
  is_trade: boolean;
  credit_limit: number | null;
  balance: number;
  available: number | null;
  // 0067: a statement is about time and about what was owed before it. The
  // fake had none of this, so every statement it could have served would
  // have opened at zero.
  address?: string | null;
  vat_number?: string | null;
  opening_balance?: number;
  created_at?: string;
}

/**
 * Phone numbers reduced the way the server does, so the fake backend matches a
 * repeat buyer on the same rule the real one uses. Deliberately the shortest
 * possible version of `normalize_phone`: the full rules are tested against the
 * real function in test/phone.test.mjs.
 */
function e164(raw: string | null): string | null {
  const typed = (raw ?? "").trim();
  const digits = typed.replace(/\D/g, "");
  if (!digits) return null;
  let out: string;
  if (typed.startsWith("+")) out = `+${digits}`;
  else if (digits.startsWith("00")) out = `+${digits.slice(2)}`;
  else if (digits.startsWith("0")) out = `+27${digits.slice(1)}`;
  else if (digits.startsWith("27") && digits.length > 9) out = `+${digits}`;
  else out = `+27${digits}`;
  return /^\+\d{9,15}$/.test(out) ? out : null;
}

/** A payment against an account, as the fake server recorded it. */
export interface RecordedAccountPayment {
  id: string;
  customer_id: string;
  amount: number;
  method: string;
  reference: string | null;
  client_ref: string | null;
  voided: boolean;
  /** When it was taken. Was not recorded, so a statement could not place it. */
  created_at: string;
}

/** Everything the fake server saw, so tests can assert on it. */
export class Backend {
  sales: RecordedSale[] = [];
  /** The shop's SKU sequence (0053): SKU-000001 is the first one generated. */
  skuSeq = 0;
  calls: string[] = [];
  customers: FakeCustomer[] = [];
  accountPayments: RecordedAccountPayment[] = [];
  stockMoves: { product_id: string; qty_delta: number; reason: string;
    note: string | null; unit_cost?: number | null }[] = [];
  /** The staff roster the back office edits, seeded from the two sign-in users. */
  staff: {
    id: string; name: string; phone: string; role: string;
    status: string; active: boolean; permissions: string[];
    discount_limit_percent: number | null;
    discount_limit_amount: number | null;
    /**
     * Why the last enrolment SMS for this phone failed, as 0043 reports it —
     * null when it went out, or when none was ever asked for. The OTP flow
     * itself happens on the landing page, outside this app, so tests set this
     * directly the way they set a discount limit.
     */
    last_code_error: string | null;
  }[] = [
    { id: "u1", name: "Manager", phone: "+27820000001", role: "admin",
      status: "active", active: true, permissions: [],
      discount_limit_percent: null, discount_limit_amount: null,
      last_code_error: null },
    { id: "u2", name: "Sam", phone: "+27820000002", role: "employee",
      status: "active", active: true, permissions: [],
      discount_limit_percent: null, discount_limit_amount: null,
      last_code_error: null },
    { id: "u3", name: "Nomsa", phone: "+27820000031", role: "employee",
      status: "active", active: true, permissions: ["shelf_capture"],
      discount_limit_percent: null, discount_limit_amount: null,
      last_code_error: null },
  ];
  /** Credit notes written against sales (0045), newest last. */
  returns: {
    id: string; sale_id: string; doc_number: string; reason: string;
    refund_method: string; total: number; tax_total: number;
    by_name: string; created_at: string;
    items: { sale_item_id: string; product_id: string | null; name: string;
             qty: number; line_total: number; restock: boolean }[];
  }[] = [];
  /** Items recorded from the aisle (0044) — born hidden, priced as a proposal. */
  shelfAdded: (FakeProduct & { active: boolean })[] = [];
  /** Photographs the product-image function accepted, newest last. */
  uploadedPhotos: { product_id: string; bytes: number; by_pin: string }[] = [];
  /**
   * The open till session, if any. `fromIndex` stands in for the server's
   * opened_at window: the real one attributes sales by register and time, and
   * for a fake with one till "everything rung up since it opened" is the same
   * set without needing clocks in the test.
   */
  cashSession: {
    id: string; opened_by_name: string; opened_at: string; opening_float: number;
    fromIndex: number; fromPayments: number;
  } | null = null;
  cashMovements: { id: string; kind: string; amount: number; reason: string;
                   by_name: string; created_at: string }[] = [];
  closedSessions: Record<string, unknown>[] = [];
  /** Wrong PINs per person, so the lockout can be asserted on. */
  failedLogins: Record<string, number> = {};
  /**
   * Single-use approval codes, as 0039 stores them — minus the hashing, which
   * is the server's business and not something a browser test can observe.
   */
  approvalCodes: {
    id: string; code: string; issued_by: string; issued_by_name: string;
    max_amount: number | null; reason: string | null;
    expires_at: string; used_at: string | null; used_by_name: string | null;
    doc_number: string | null;
  }[] = [];
  /** 0055: suppliers and the paper they send. Pages keep the data URL sent. */
  suppliers: { id: string; name: string; contact_name: string | null; phone: string | null;
    email: string | null; address?: string | null; vat_number: string | null; notes: string | null;
    bank_name?: string | null; bank_account_name?: string | null;
    bank_account_number?: string | null; bank_branch_code?: string | null }[] = [];
  supplierDocs: { id: string; supplier_id: string; kind: string; doc_number: string | null;
    doc_date: string | null; total: number | null; note: string | null; status: string;
    created_at: string;
    // 0066: what is owed on it and when. Filing a bill and paying it are two
    // different days, and the fake modelled only the first one.
    due_date?: string | null; paid_at?: string | null;
    paid_amount?: number | null; paid_by_name?: string | null }[] = [];
  supplierPages: { document_id: string; page_no: number; mime: string; data: string; by_pin: string }[] = [];
  supplierLines: { document_id: string; line_no: number; supplier_code: string | null;
    description: string; qty: number | null; unit_price: number | null;
    line_total: number | null; product_id?: string | null }[] = [];
  /** 0066: orders placed with a supplier, and the lines on them. */
  purchaseOrders: { id: string; doc_number: string; supplier_id: string; status: string;
    expected_on: string | null; note: string | null; created_at: string;
    created_by_name: string | null; sent_at: string | null }[] = [];
  poLines: { id: string; po_id: string; product_id: string; sku: string | null;
    name: string; unit_code: string; qty: number; unit_cost: number | null;
    received_qty: number }[] = [];
  /** 0058: what a supplier's own code is known to mean. */
  supplierCodes: { supplier_id: string; supplier_code: string; product_id: string }[] = [];
  /**
   * 0056: what the reader says the pages contain. A browser test cannot run a
   * vision model, and should not: what it must pin is what the till DOES with
   * a reading — matches the supplier, shows it for checking, files it whole.
   * Set `readFails` to see the path where the reading does not come back.
   */
  documentReading: Record<string, unknown> = {
    supplier_name: "Jasbro Plumbing",
    supplier_vat: "4370229645",
    supplier_phone: "010 442 0625",
    supplier_email: "info@jasbro.co.za",
    supplier_address: "25 Birmingham Road, Benoni South, 1502",
    bank_name: "FNB",
    bank_account_name: "JASBRO PLUMBING",
    bank_account_number: "62399227258",
    bank_branch_code: "250655",
    kind: "quote",
    doc_number: "27181",
    doc_date: "2026-08-13",
    subtotal: 4609.0,
    tax_total: 691.35,
    total: 5300.35,
    lines: [
      { supplier_code: "PL 0065", description: "COMP ELBOW 15MM", qty: 20, unit_price: 16.85, line_total: 337.0 },
      { supplier_code: "PL 0107", description: "COMP SPARE RING 15MM", qty: 100, unit_price: 1.1, line_total: 110.0 },
    ],
  };
  readFails = false;
  /** How many pages the last reading was given. */
  readPages = 0;
  /** Logos the shop-logo function accepted, newest last. */
  uploadedLogos: string[] = [];
  /** The bytes of the last one, as the data URL it arrived as. */
  logoBytes: string | null = null;
  /**
   * How long the storage bucket takes to answer, in milliseconds.
   *
   * A shop's line is not instant, and a document built before the logo has
   * arrived comes out without it — a race that would show up once, on a real
   * quotation, and never reproduce. Tests that care set this.
   */
  imageDelayMs = 0;
  /** The shop's own details, mutable so a settings save can be asserted on. */
  orgSettings: Record<string, string | boolean> = {
    // A shop that has never been asked prices every line, as 0042 defaults it.
    quote_show_line_prices: true,
    shop_name: "Ladybrand Hardware",
    address_line1: "12 Church St",
    address_line2: "Ladybrand, Free State",
    phone: "051 924 0000",
    vat_number: "4001234567",
    currency: "R",
    registration_number: "",
    email: "",
    bank_name: "",
    bank_account_name: "",
    bank_account_number: "",
    bank_branch_code: "",
    // 0052: the small print, seeded as the migration seeds it.
    receipt_terms: "Returns within 10 days with this invoice and the original packaging. No returns on special orders or tinted paint.",
    quote_terms: "Prices are subject to stock availability.",
    // 0059: no logo until a shop uploads one, and the documents then set the
    // name in type instead.
    logo_url: "",
    // 0064: read off the delivery line, not stored on the shop.
    delivery_cost: null as unknown as string,
  };
  /**
   * The archived quotation PDFs, by quote id. Write once: the fake refuses a
   * second copy exactly as pos_quote_set_pdf does, because "the document the
   * customer is holding cannot be replaced" is the whole feature and a fake
   * that quietly allows it would make a green test out of a broken one.
   */
  archivedQuotes: Record<string, string> = {};
  /**
   * 0065: the stock take sheets. Lines carry the quantity expected WHEN THE
   * SHEET WAS OPENED, because that is the whole rule: posting applies the
   * difference, so a sale rung up while somebody counts still counts.
   */
  stockCounts: {
    id: string; doc_number: string; status: "open" | "posted" | "abandoned";
    category_id: string | null; note: string | null;
    lines: { product_id: string; sku: string; name: string; unit_code: string;
             bin: string | null; expected_qty: number; counted_qty: number | null;
             /** 0068: what it cost, snapshotted at open. */
             unit_cost: number | null }[];
  }[] = [];
  /** 0061: the delivery notes, newest last. */
  deliveries: {
    id: string; doc_number: string; sale_id: string; customer_name: string;
    address: string; deliver_on: string; deliver_at: string | null;
    charge: number; note: string | null; status: "pending" | "delivered";
    cashier_name: string; delivered_by_name: string | null;
    delivered_at: string | null;
  }[] = [];
  quotes: { id: string; doc_number: string; status: string; sale_id: string | null;
    customer_name: string | null;
            customer_id: string | null;
            items: { product_id: string; qty: number; unit_price: number }[] }[] = [];
  /** When set, every request fails as though the connection dropped. */
  offline = false;
  private seq = 0;

  reset() {
    this.sales = [];
    this.calls = [];
    this.customers = [];
    this.accountPayments = [];
    this.stockMoves = [];
    this.quotes = [];
    this.offline = false;
    this.seq = 0;
    this.archivedQuotes = {};
    this.deliveries = [];
    this.stockCounts = [];
  }

  /** Balance the way the real customer_balance() computes it. */
  balance(customerId: string): number {
    const charges = this.sales
      .filter((s) => s.customer_id === customerId && s.payment_method === "account")
      .reduce((t, s) => t + s.total, 0);
    const paid = this.accountPayments
      .filter((p) => p.customer_id === customerId && !p.voided)
      .reduce((t, p) => t + p.amount, 0);
    return Math.round((charges - paid) * 100) / 100;
  }

  /** Sales actually stored, i.e. after idempotent replays collapse. */
  get storedSales() {
    return this.sales;
  }

  /** What the open session's window adds up to. Mirrors cash_session_figures. */
  cashFigures() {
    const s = this.cashSession;
    if (!s) throw new Error("No session");
    // A voided sale is not takings: the cash went back across the counter.
    const inWindow = this.sales.slice(s.fromIndex).filter((x) => !x.voided);
    const tenders: Record<string, number> = {};
    for (const sale of inWindow) {
      for (const p of sale.payments) {
        tenders[p.method] = Math.round(((tenders[p.method] ?? 0) + p.amount) * 100) / 100;
      }
    }
    const round2 = (n: number) => Math.round(n * 100) / 100;
    const total = round2(inWindow.reduce((t, x) => t + x.total, 0));
    // Account settlements taken in cash are drawer money like any other.
    const accountCash = round2(
      this.accountPayments
        .slice(s.fromPayments)
        .filter((p) => p.method === "cash" && !p.voided)
        .reduce((t, p) => t + p.amount, 0)
    );
    const payIn = round2(
      this.cashMovements.filter((m) => m.kind === "pay_in").reduce((t, m) => t + m.amount, 0)
    );
    const payOut = round2(
      this.cashMovements.filter((m) => m.kind === "pay_out").reduce((t, m) => t + m.amount, 0)
    );
    const cashSales = tenders.cash ?? 0;
    // 0047: every settlement method, and the money that went back.
    const accountPayments: Record<string, number> = {};
    for (const p of this.accountPayments.slice(s.fromPayments)) {
      if (p.voided) continue;
      accountPayments[p.method] = round2((accountPayments[p.method] ?? 0) + p.amount);
    }
    const refunds = this.returns.filter((r) => r.created_at >= s.opened_at);
    return {
      sales_count: inWindow.length,
      sales_total: total,
      vat_total: round2(total - total / 1.15),
      discount_total: round2(inWindow.reduce((t, x) => t + x.discount_amount, 0)),
      tenders,
      cash_sales: cashSales,
      account_cash: accountCash,
      account_payments: accountPayments,
      refunds_count: refunds.length,
      refunds_total: round2(refunds.reduce((t, r) => t + r.total, 0)),
      card_expected: round2((tenders.card ?? 0) + (accountPayments.card ?? 0)),
      eft_expected: round2((tenders.eft ?? 0) + (accountPayments.eft ?? 0)),
      pay_in: payIn,
      pay_out: payOut,
      expected_cash: round2(s.opening_float + cashSales + accountCash + payIn - payOut),
    };
  }

  private price(p: FakeProduct, trade: boolean) {
    return trade && p.price_trade != null ? p.price_trade : p.price_retail;
  }

  createSale(body: Record<string, unknown>) {
    const ref = (body.p_client_ref as string) ?? null;
    if (ref) {
      const existing = this.sales.find((s) => s.client_ref === ref);
      // The whole point of the idempotency key: a replay returns the original.
      if (existing) return this.saleRow(existing, false);
    }

    const items =
      (body.p_items as {
        product_id: string; qty: number; unit_price?: number;
        discount_amount?: number; discount_percent?: number | null;
        discount_reason?: string | null;
      }[]) ?? [];
    let subtotal = 0;
    let itemsDiscount = 0;
    for (const it of items) {
      const p = PRODUCTS.find((x) => x.id === it.product_id)
        ?? (it.product_id === DELIVERY_LINE.id ? DELIVERY_LINE : undefined);
      if (!p) throw new Error("Product not available");
      if (!p.allows_fraction && it.qty !== Math.trunc(it.qty)) {
        throw new Error(`${p.name} is sold per ${p.unit_name} and cannot be split`);
      }
      if (p.stock_qty != null && p.stock_qty < it.qty) {
        throw new Error(`Not enough stock for ${p.name} (${p.stock_qty} ${p.unit_code} on hand)`);
      }
      // 0061: an open line carries the price the counter named; anything else
      // is priced by the shop however loudly the request asks otherwise. The
      // rule is the server's line_price(), mirrored here so a test cannot pass
      // against a fake that is more generous than the database.
      const unit = p.kind === "delivery" && it.unit_price != null
        ? Math.round(it.unit_price * 100) / 100
        : this.price(p, false);
      const line = Math.round(unit * it.qty * 100) / 100;
      // The percentage decides, as it does on the server: a client sending a
      // percentage and a mismatched amount must not get to choose which wins.
      const lineDisc =
        it.discount_percent != null
          ? Math.round(line * (it.discount_percent / 100) * 100) / 100
          : Math.round((it.discount_amount ?? 0) * 100) / 100;
      if (lineDisc > line) {
        throw new Error(`Discount on ${p.name} is more than the line comes to`);
      }
      // Kept the way the server keeps it — bounded, trimmed, and dropped on a
      // line nobody discounted — so a test cannot pass here and fail there.
      const why = (it.discount_reason ?? "").slice(0, 200).trim();
      it.discount_reason = lineDisc > 0 && why ? why : null;
      subtotal += line;
      itemsDiscount += lineDisc;
    }
    itemsDiscount = Math.round(itemsDiscount * 100) / 100;
    const saleDiscount = (body.p_discount_amount as number) ?? 0;
    // Everything off, so subtotal - discount = total reads correctly whichever
    // kind of discount was given.
    const discount = Math.round((itemsDiscount + saleDiscount) * 100) / 100;
    const total = Math.round((subtotal - discount) * 100) / 100;

    // Both ceilings walk the lines together, exactly as pos_create_sale does,
    // because both need the same figure: what the line actually loses, its own
    // discount plus its share of the sale-level one.
    //
    //   the item cap      refuses, whoever asks
    //   the percent limit is a RATE and holds on every line
    //   the rand limit    is a ceiling on the whole sale
    //
    // Either half of a limit exceeded sends the sale for approval.
    // A single-use code, spent with the sale it releases — never before, so a
    // sale that fails a stock check does not burn the manager's code.
    const codeTyped = (body.p_approval_code as string) ?? null;
    let code: (typeof this.approvalCodes)[number] | undefined;
    if (codeTyped) {
      code = this.approvalCodes.find(
        (c) => c.code === codeTyped && !c.used_at && Date.parse(c.expires_at) > Date.now()
      );
      if (!code) {
        throw new Error(
          "That approval code was not accepted. It may have expired or already been used."
        );
      }
      if (code.max_amount != null && discount > code.max_amount + 0.005) {
        throw new Error(
          `That code releases up to ${code.max_amount.toFixed(2)}, and this discount is ${discount.toFixed(2)}.`
        );
      }
    }

    const cashier = this.staff.find((u) => u.id === body.p_cashier_id);
    const limitPct = cashier?.discount_limit_percent ?? null;
    const limitAmt = cashier?.discount_limit_amount ?? null;
    let within = limitPct != null || limitAmt != null;
    if (limitAmt != null && discount > limitAmt + 0.005) within = false;

    const netSubtotal = Math.round((subtotal - itemsDiscount) * 100) / 100;
    if (discount > 0) {
      for (const it of items) {
        const p = PRODUCTS.find((x) => x.id === it.product_id)!;
        const line = Math.round(this.price(p, false) * it.qty * 100) / 100;
        const lineDisc =
          it.discount_percent != null
            ? Math.round(line * (it.discount_percent / 100) * 100) / 100
            : Math.round((it.discount_amount ?? 0) * 100) / 100;
        const share =
          netSubtotal > 0
            ? Math.round(((line - lineDisc) * total * 100) / netSubtotal) / 100
            : 0;
        const taken = Math.round((line - share) * 100) / 100;

        if (
          within &&
          limitPct != null &&
          taken > Math.round(line * (limitPct / 100) * 100) / 100 + 0.005
        ) {
          within = false;
        }

        if (p.max_discount_percent == null && p.max_discount_amount == null) continue;
        const caps: number[] = [];
        if (p.max_discount_percent != null) {
          caps.push(Math.round(line * (p.max_discount_percent / 100) * 100) / 100);
        }
        if (p.max_discount_amount != null) {
          caps.push(Math.round(p.max_discount_amount * it.qty * 100) / 100);
        }
        const cap = Math.min(...caps);
        if (taken > cap + 0.005) {
          throw new Error(
            `${p.name} is capped at ${cap.toFixed(2)} off and this sale takes ` +
              `${taken.toFixed(2)} off it. Lower the discount.`
          );
        }
      }
    }

    const payments =
      (body.p_payments as { method: string; amount: number }[]) ?? [];
    // Mirrors public.cash_rounding: nearest 10c, halves down, cash only.
    const nonCash = payments
      .filter((x) => x.method !== "cash")
      .reduce((s, x) => s + x.amount, 0);
    const rounding = payments.some((x) => x.method === "cash")
      ? (Math.ceil(Math.round((total - nonCash) * 100) / 10 - 0.5) * 10 -
          Math.round((total - nonCash) * 100)) / 100
      : 0;
    const tendered = (body.p_amount_tendered as number) ?? null;
    const paid = payments.reduce((s, x) => s + x.amount, 0);
    if (payments.length > 0 && Math.abs(paid - (total + rounding)) > 0.005) {
      throw new Error(
        `Payments of ${paid.toFixed(2)} do not settle ${total.toFixed(2)}`
      );
    }

    const sale: RecordedSale = {
      client_ref: ref,
      cashier_id: body.p_cashier_id as string,
      customer_id: (body.p_customer_id as string) ?? null,
      items,
      payment_method: (body.p_payment_method as string) ?? "cash",
      discount_amount: discount,
      discount_reason: (body.p_discount_reason as string) ?? null,
      // The approver is the manager who ISSUED the code, not the cashier who
      // typed it — anything else puts the wrong name on the invoice.
      approved_by: code ? code.issued_by : ((body.p_approved_by as string) ?? null),
      created_at: (body.p_created_at as string) ?? null,
      total,
      payments,
      po_number: (body.p_po_number as string) ?? null,
      customer_vat_number: (body.p_customer_vat_number as string) ?? null,
      rounding,
      within_limit: within,
      amount_tendered: tendered,
      // Mirrors the server: change comes off the settled figure, so a cash
      // sale rounded down to the nearest 10c gives back the rounding too.
      change_due:
        tendered != null
          ? Math.max(0, Math.round((tendered - (total + rounding)) * 100) / 100)
          : null,
    };
    this.sales.push(sale);
    const row = this.saleRow(sale, true);
    if (code) {
      code.used_at = new Date().toISOString();
      code.used_by_name = cashier?.name ?? null;
      code.doc_number = row.doc_number;
    }
    return row;
  }

  private saleRow(sale: RecordedSale, fresh: boolean) {
    if (fresh) this.seq += 1;
    // A discount inside what the cashier may give on their own authority
    // completes with no approver recorded — nobody was asked. The fake used to
    // park every unapproved discount, which is what the shop did before limits
    // existed and would have hidden the whole feature from these tests.
    const pending =
      sale.discount_amount > 0 && !sale.approved_by && !sale.within_limit;
    return {
      // The id every other handler resolves it by: its index in the list.
      // It used to be the 1-based sequence, so a sale rung on the till came
      // back with an id under which its own lines could not be found.
      id: "s" + this.sales.indexOf(sale),
      doc_number: pending ? null : "INV-" + String(this.seq).padStart(6, "0"),
      cashier_id: sale.cashier_id,
      cashier_name: "Sam",
      customer_id: sale.customer_id,
      customer_name: this.customers.find((c) => c.id === sale.customer_id)?.name ?? null,
      trade_pricing: this.customers.find((c) => c.id === sale.customer_id)?.is_trade ?? false,
      subtotal: sale.total + sale.discount_amount,
      discount_amount: sale.discount_amount,
      discount_reason: sale.discount_reason,
      tax_amount: Math.round((sale.total - sale.total / 1.15) * 100) / 100,
      total: sale.total,
      status: sale.voided ? "voided" : pending ? "pending_approval" : "completed",
      approved_by: sale.approved_by,
      approved_by_name: sale.approved_by ? "Manager" : null,
      payment_method: sale.payment_method,
      amount_tendered: sale.amount_tendered,
      change_due: sale.change_due,
      paid_cash: null,
      paid_card: null,
      rounding: sale.rounding,
      po_number: sale.po_number,
      customer_vat_number: sale.customer_vat_number,
      created_at: sale.created_at ?? new Date().toISOString(),
    };
  }
}

/** Mirrors normalize_search_text() so search results match the real server. */
function normalize(t: string): string {
  return (t ?? "").toLowerCase()
    .replace(/(\d),(\d)/g, "$1.$2")
    .replace(/(\d)\s*[x*×]\s*(\d)/g, "$1 x $2")
    .replace(/(\d)(mm|cm|m|kg|g|l|ml)\b/g, "$1 $2")
    .replace(/[^a-z0-9. ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function searchProducts(q: string) {
  const n = normalize(q);
  if (!n) return [];
  const toks = n.split(" ").filter((t) => t && t !== "x");
  return PRODUCTS.filter((p) => {
    const text = normalize(p.name + " " + p.sku + " " + (p.barcode ?? ""));
    return toks.every((t) => text.includes(t));
  }).map((p) => ({ ...p, score: 1 }));
}

/**
 * Install the fake backend on a page. Returns the Backend so a test can flip it
 * offline and inspect what it received.
 */

/**
 * A sale's lines as pos_sale_items serves them, ids included — one place, so
 * the return handlers and the reprint can never price the same line two ways.
 * line_total carries the line's own discount AND its share of the sale-level
 * one, exactly as the server stores it.
 */
/** How many of something has gone out of the door recently (0066). */
function soldRecently(be: Backend, productId: string): number {
  let n = 0;
  for (const sale of be.sales) {
    for (const it of sale.items) {
      if (it.product_id === productId) n += it.qty;
    }
  }
  return n;
}

/** Who it was last bought from, so an order can be raised without looking. */
function lastSupplierOf(be: Backend, productId: string): string | null {
  for (let i = be.supplierCodes.length - 1; i >= 0; i--) {
    if (be.supplierCodes[i].product_id === productId) {
      return be.suppliers.find((s) => s.id === be.supplierCodes[i].supplier_id)?.name ?? null;
    }
  }
  return null;
}

/** A purchase order as pos_po_list returns it, with its lines counted (0066). */
function poRow(be: Backend, o: Backend["purchaseOrders"][number]) {
  const lines = be.poLines.filter((l) => l.po_id === o.id);
  return {
    id: o.id, doc_number: o.doc_number,
    supplier: be.suppliers.find((s) => s.id === o.supplier_id)?.name ?? "—",
    supplier_id: o.supplier_id, status: o.status, expected_on: o.expected_on,
    note: o.note, created_at: o.created_at, created_by_name: o.created_by_name,
    sent_at: o.sent_at, lines: lines.length,
    total: Math.round(lines.reduce((t, l) => t + l.qty * (l.unit_cost ?? 0), 0) * 100) / 100,
    outstanding_lines: lines.filter((l) => l.received_qty < l.qty).length,
  };
}

export function fakeSaleLines(be: Backend, saleId: string) {
  const idx = Number(String(saleId).replace("s", ""));
  const sale = be.sales[idx];
  if (!sale) return [];
  // An open line is worth what the counter said, as line_price() decides on
  // the server; everything else is worth what the shop prices it at.
  const unitOf = (it: (typeof sale.items)[number]) => {
    const p = fakeProduct(it.product_id);
    return p?.kind === "delivery" && it.unit_price != null
      ? it.unit_price
      : p?.price_retail ?? 0;
  };
  const gross = (it: (typeof sale.items)[number]) =>
    Math.round(unitOf(it) * it.qty * 100) / 100;
  const own = (it: (typeof sale.items)[number]) =>
    it.discount_percent != null
      ? Math.round(gross(it) * (it.discount_percent / 100) * 100) / 100
      : Math.round((it.discount_amount ?? 0) * 100) / 100;
  const net = sale.items.reduce((t, it) => t + gross(it) - own(it), 0);
  return sale.items.map((it, n) => {
    const prod = fakeProduct(it.product_id)!;
    const line_total =
      net > 0
        ? Math.round(((gross(it) - own(it)) * sale.total * 100) / net) / 100
        : 0;
    return {
      id: `${saleId}-i${n}`,
      product_id: prod.id,
      name: prod.name, sku: prod.sku, unit_code: prod.unit_code,
      allows_fraction: prod.allows_fraction,
      qty: it.qty, unit_price: unitOf(it),
      // What the shop paid for it, copied onto the line as pos_create_sale
      // copies products.cost — including a price booked in against a purchase
      // order. The delivery line costs whatever the shop has said a trip is,
      // null until it says (0064).
      cost_at_sale: prod.cost ?? null,
      line_total,
      tax_amount: Math.round((line_total - line_total / 1.15) * 100) / 100,
      discount_amount: own(it),
      discount_percent: it.discount_percent ?? null,
      discount_reason: it.discount_reason ?? null,
    };
  });
}

export async function installBackend(page: Page): Promise<Backend> {
  const be = new Backend();

  // PRODUCTS is module state and the catalogue editor now writes to it, so a
  // cap set by one test would still be there for the next one in the same
  // worker. Put it back rather than leaving tests to depend on their order.
  // Products the catalogue editor created in an earlier test are not seed.
  for (let i = PRODUCTS.length - 1; i >= 0; i--) {
    if (PRODUCTS[i].id.startsWith("new")) PRODUCTS.splice(i, 1);
  }
  for (const p of PRODUCTS) {
    p.max_discount_percent = null;
    p.max_discount_amount = null;
    // The shelf screen writes photographs and price fixes onto module state.
    p.image_url = null;
    p.price_retail = SEED_RETAIL.get(p.id)!;
    p.stock_qty = SEED_STOCK.get(p.id) ?? null;
    // Booking a delivery in against an order writes cost onto module state too.
    p.cost = SEED_COST.get(p.id) ?? null;
  }

  // Connectivity probe. offline.ts deliberately does not trust navigator.onLine
  // (it sticks after sleep/wake on tablets) and instead asks whether the server
  // answers. The fake has to model that, or the till never notices the line
  // coming back and nothing ever syncs.
  await page.route("**/auth/v1/health*", async (route: Route) => {
    if (be.offline) return route.abort("internetdisconnected");
    return route.fulfill({ status: 200, contentType: "application/json", body: "{}" });
  });

  // The product-image edge function: the till never writes to storage
  // directly, it hands the photo and the PIN to this endpoint. The fake keeps
  // the same order the real one documents — check, then "upload", then record
  // — and accepts the same two rights (shelf_capture or manage_catalogue).
  await page.route("**/functions/v1/product-image", async (route: Route) => {
    if (be.offline) return route.abort("internetdisconnected");
    let b: Record<string, string> = {};
    try {
      b = JSON.parse(route.request().postData() || "{}");
    } catch { /* not JSON, falls through to the checks below */ }
    const respond = (status: number, data: unknown) =>
      route.fulfill({ status, contentType: "application/json", body: JSON.stringify(data) });

    if (b.register_token !== REGISTER_TOKEN) {
      return respond(403, { ok: false, message: "Register not paired or revoked" });
    }
    const u = Object.values(USERS).find((x) => x.pin === b.pin);
    if (!u || !u.row.permissions.some((p) => p === "shelf_capture" || p === "manage_catalogue")) {
      return respond(403, { ok: false, message: "Not permitted" });
    }
    const target =
      PRODUCTS.find((p) => p.id === b.product_id) ??
      be.shelfAdded.find((p) => p.id === b.product_id);
    if (!target) return respond(400, { ok: false, message: "Product not found" });
    if (!/^data:image\/(jpeg|png|webp);base64,./.test(String(b.image ?? ""))) {
      return respond(400, { ok: false, message: "Unreadable image" });
    }

    const path = `org1/${b.product_id}/${be.uploadedPhotos.length + 1}.jpg`;
    be.uploadedPhotos.push({
      product_id: String(b.product_id),
      bytes: String(b.image).length,
      by_pin: String(b.pin),
    });
    // The first photograph becomes the thumbnail, as 0020 does it.
    target.image_url = target.image_url ?? path;
    return respond(200, { ok: true, id: "img" + be.uploadedPhotos.length, path });
  });

  // 0059: the shop's logo. Its own door, gated on manage_settings, and it
  // records itself through the ordinary settings RPC.
  await page.route("**/functions/v1/shop-logo", async (route: Route) => {
    if (be.offline) return route.abort("internetdisconnected");
    let b: Record<string, string> = {};
    try {
      b = JSON.parse(route.request().postData() || "{}");
    } catch { /* falls through to the checks below */ }
    const respond = (status: number, data: unknown) =>
      route.fulfill({ status, contentType: "application/json", body: JSON.stringify(data) });
    if (b.register_token !== REGISTER_TOKEN) {
      return respond(403, { ok: false, message: "Register not paired or revoked" });
    }
    const u = Object.values(USERS).find((x) => x.pin === b.pin);
    if (!u || !u.row.permissions.includes("manage_settings")) {
      return respond(403, { ok: false, message: "Not permitted" });
    }
    if (!/^data:image\/(png|jpeg|webp|svg\+xml);base64,./.test(String(b.image ?? ""))) {
      return respond(400, { ok: false, message: "Use a PNG, JPEG, WebP or SVG" });
    }
    const path = `org1/logo/${be.uploadedLogos.length + 1}.png`;
    be.uploadedLogos.push(path);
    be.orgSettings.logo_url = path;
    // Keep the bytes, because something now READS them back: the PDF writer
    // has to put the picture inside the file, and a bucket that stores an
    // upload and then serves nothing is a fake that lies about the one thing
    // the feature depends on.
    be.logoBytes = String(b.image);
    return respond(200, { ok: true, path });
  });

  // The storage bucket, for the objects the fake has actually been given. A
  // real one serves these with CORS headers, and without them a canvas that
  // draws the logo is tainted and the PDF silently comes out without it — so
  // the header is part of what is being modelled, not decoration.
  await page.route(/\/storage\/v1\/object\/public\/product-images\//, async (route: Route) => {
    if (be.offline) return route.abort("internetdisconnected");
    if (be.imageDelayMs) {
      await new Promise((r) => setTimeout(r, be.imageDelayMs));
    }
    const m = /^data:(image\/[a-z+]+);base64,(.*)$/.exec(be.logoBytes ?? "");
    if (!m) return route.fulfill({ status: 404, body: "" });
    return route.fulfill({
      status: 200,
      contentType: m[1],
      headers: { "access-control-allow-origin": "*" },
      body: Buffer.from(m[2], "base64"),
    });
  });

  // 0060: the archived quotation. put keeps it once; get hands back a URL.
  // The bytes come back as the data URL they arrived as, which is a thing a
  // browser test can actually fetch.
  await page.route("**/functions/v1/quote-pdf", async (route: Route) => {
    if (be.offline) return route.abort("internetdisconnected");
    let b: Record<string, string> = {};
    try {
      b = JSON.parse(route.request().postData() || "{}");
    } catch { /* falls through to the checks below */ }
    const respond = (status: number, data: unknown) =>
      route.fulfill({ status, contentType: "application/json", body: JSON.stringify(data) });
    if (b.register_token !== REGISTER_TOKEN) {
      return respond(403, { ok: false, message: "Register not paired or revoked" });
    }
    const id = String(b.quote_id ?? "");
    if (!be.quotes.some((q) => q.id === id)) {
      return respond(404, { ok: false, message: "Unknown quote" });
    }
    if (b.action === "get") {
      const kept = be.archivedQuotes[id];
      return respond(200, { ok: true, url: kept ?? null });
    }
    if (be.archivedQuotes[id]) {
      return respond(200, { ok: true, path: `org1/quotes/${id}.pdf`, stored: false });
    }
    if (!/^data:application\/pdf;base64,./.test(String(b.file ?? ""))) {
      return respond(400, { ok: false, message: "Unreadable document" });
    }
    be.archivedQuotes[id] = String(b.file);
    return respond(200, { ok: true, path: `org1/quotes/${id}.pdf`, stored: true });
  });

  // 0055: the supplier-document function. Pages in, signed URLs out; the fake
  // hands back the very data URL it was given, which is what a browser test
  // can look at.
  await page.route("**/functions/v1/supplier-document", async (route: Route) => {
    if (be.offline) return route.abort("internetdisconnected");
    let b: Record<string, string> = {};
    try {
      b = JSON.parse(route.request().postData() || "{}");
    } catch { /* falls through to the checks below */ }
    const respond = (status: number, data: unknown) =>
      route.fulfill({ status, contentType: "application/json", body: JSON.stringify(data) });
    if (b.register_token !== REGISTER_TOKEN) {
      return respond(403, { ok: false, message: "Register not paired or revoked" });
    }
    const u = Object.values(USERS).find((x) => x.pin === b.pin);
    if (!u || !u.row.permissions.includes("manage_purchasing")) {
      return respond(403, { ok: false, message: "Not permitted" });
    }
    const doc = be.supplierDocs.find((d) => d.id === b.document_id);
    if (!doc) return respond(404, { ok: false, message: "Document not found" });
    if (b.action === "sign") {
      return respond(200, {
        ok: true,
        pages: be.supplierPages.filter((pg) => pg.document_id === doc.id)
          .map((pg) => ({ page_no: pg.page_no, mime: pg.mime, url: pg.data })),
      });
    }
    const m = /^data:(image\/(?:jpeg|png|webp)|application\/pdf);base64,./.exec(String(b.file ?? ""));
    if (!m) return respond(400, { ok: false, message: "Use a photo (JPEG, PNG, WebP) or a PDF" });
    const page_no = be.supplierPages.filter((pg) => pg.document_id === doc.id).length + 1;
    be.supplierPages.push({ document_id: doc.id, page_no, mime: m[1], data: String(b.file), by_pin: String(b.pin) });
    return respond(200, { ok: true, page_no, path: `org1/${doc.id}/${page_no}` });
  });

  // 0056: the reader. The model itself is not here — what a test can pin is
  // that the till sends the pages, shows the answer for checking, and files
  // exactly what was on that screen.
  await page.route("**/functions/v1/read-document", async (route: Route) => {
    if (be.offline) return route.abort("internetdisconnected");
    let b: Record<string, unknown> = {};
    try {
      b = JSON.parse(route.request().postData() || "{}");
    } catch { /* falls through to the checks below */ }
    const respond = (status: number, data: unknown) =>
      route.fulfill({ status, contentType: "application/json", body: JSON.stringify(data) });
    if (b.register_token !== REGISTER_TOKEN) {
      return respond(403, { ok: false, message: "Register not paired or revoked" });
    }
    const u = Object.values(USERS).find((x) => x.pin === b.pin);
    if (!u || !u.row.permissions.includes("manage_purchasing")) {
      return respond(403, { ok: false, message: "Not permitted" });
    }
    const pages = (b.pages as { mime: string; data: string }[]) ?? [];
    if (pages.length === 0) return respond(400, { ok: false, message: "No pages to read" });
    be.readPages = pages.length;
    if (be.readFails) {
      return respond(502, { ok: false, message: "The pages could not be read. File them and type the details in." });
    }
    return respond(200, { ok: true, read: be.documentReading, model: "fake" });
  });

  await page.route("**/rest/v1/**", async (route: Route) => {
    const url = new URL(route.request().url());
    // The till now calls its own origin and a Worker forwards /api to Supabase,
    // so the path arrives as /api/rest/v1/... in production and /rest/v1/...
    // in any older build. Strip whatever precedes the API prefix.
    const path = url.pathname.replace(/^.*\/rest\/v1\//, "");
    be.calls.push(path);

    if (be.offline) {
      // What a dropped connection actually looks like to the client.
      await route.abort("internetdisconnected");
      return;
    }

    const json = (data: unknown, status = 200) =>
      route.fulfill({ status, contentType: "application/json", body: JSON.stringify(data) });
    const fail = (message: string) =>
      route.fulfill({
        status: 400, contentType: "application/json",
        body: JSON.stringify({ message, code: "P0001", details: null, hint: null }),
      });

    let body: Record<string, unknown> = {};
    try {
      body = JSON.parse(route.request().postData() || "{}");
    } catch { /* GETs have no body */ }

    // The real till RPCs resolve the org from the register token before
    // anything else; the fake enforces the same so a client that forgets the
    // token fails the suite instead of only failing in production.
    const tokenOk = body.p_register_token === REGISTER_TOKEN;
    const purchasing = (pin: unknown) =>
      Object.values(USERS).some((u) => u.pin === pin && u.row.permissions.includes("manage_purchasing"));

    switch (path) {
      case "rpc/pos_pair_register": {
        if (body.p_phone !== USERS.manager.phone || body.p_pin !== USERS.manager.pin) {
          return fail("Invalid phone or PIN");
        }
        return json([{ register_id: "reg1", token: REGISTER_TOKEN }]);
      }
      case "rpc/pos_login": {
        if (!tokenOk) return fail("Register not paired or revoked");
        // The PIN confirms an identity now; it does not choose one. A PIN that
        // is right for somebody else is simply wrong here, which is the whole
        // point of naming who is signing in.
        const target = Object.values(USERS).find((u) => u.row.id === body.p_user_id);
        if (!target) return json([]);
        const tries = be.failedLogins[target.row.id] ?? 0;
        if (tries >= 5) return fail(`Too many wrong PINs for ${target.row.name}. Try again in 15 minutes.`);
        if (target.pin !== body.p_pin) {
          be.failedLogins[target.row.id] = tries + 1;
          return json([]);
        }
        delete be.failedLogins[target.row.id];
        // The limit rides the login row, as it does on the server: the till
        // caches it and needs it with the line down.
        const staffRow = be.staff.find((x) => x.id === target.row.id);
        return json([
          {
            ...target.row,
            discount_limit_percent: staffRow?.discount_limit_percent ?? null,
            discount_limit_amount: staffRow?.discount_limit_amount ?? null,
          },
        ]);
      }
      case "rpc/pos_list_customers":
        if (!tokenOk) return fail("Register not paired or revoked");
        return json(be.customers);
      case "rpc/pos_customer_by_phone": {
        if (!tokenOk) return fail("Register not paired or revoked");
        const want = e164(String(body.p_phone ?? ""));
        if (!want) return json([]);
        return json(be.customers.filter((c) => e164(c.phone) === want));
      }
      case "rpc/pos_quick_customer": {
        if (!tokenOk) return fail("Register not paired or revoked");
        const want = e164(String(body.p_phone ?? ""));
        if (!want) return fail("That does not look like a phone number");
        const existing = be.customers.find((c) => e164(c.phone) === want);
        if (existing) return json([existing]);
        // No credit, retail price — the server will not let a cashier do more.
        const made: FakeCustomer = {
          id: `k${be.customers.length + 1}`,
          code: null,
          name: String(body.p_name ?? "").trim() || want,
          phone: String(body.p_phone ?? "").trim(),
          is_trade: false,
          credit_limit: 0,
          balance: 0,
          available: 0,
        };
        be.customers.push(made);
        return json([made]);
      }
      case "rpc/pos_customer_history": {
        if (!tokenOk) return fail("Register not paired or revoked");
        // Newest first, as 0023 lists them; the number is the one the Sales
        // screen and pos_sale_by_number give the same sale.
        const mine = be.sales
          .map((x, i) => ({ x, i }))
          .filter(({ x }) => x.customer_id === body.p_customer_id && !x.voided)
          .reverse();
        return json(mine.map(({ x, i }) => ({
          sale_id: "s" + i,
          doc_number: "INV-" + String(i + 1).padStart(6, "0"),
          created_at: x.created_at ?? new Date().toISOString(),
          total: x.total,
          payment_method: x.payment_method,
          item_count: x.items.length,
          summary: x.items
            .map((it) => PRODUCTS.find((p) => p.id === it.product_id)?.name ?? "?")
            .join(", "),
        })));
      }
      case "rpc/pos_save_quote": {
        if (!tokenOk) return fail("Register not paired or revoked");
        const items = (body.p_items as { product_id: string; qty: number }[]) ?? [];
        if (!items.length) return fail("An empty quote is not a quote");
        const q = {
          id: "q" + (be.quotes.length + 1),
          doc_number: "QUO-" + String(be.quotes.length + 1).padStart(6, "0"),
          status: "open", sale_id: null as string | null,
          customer_id: (body.p_customer_id as string) ?? null,
          // 0052: the account's name when there is an account, otherwise
          // whatever the counter was told.
          customer_name: body.p_customer_id
            ? be.customers.find((c) => c.id === body.p_customer_id)?.name ?? null
            : (String(body.p_customer_name ?? "").trim() || null),
          items: items.map((it) => ({
            product_id: it.product_id, qty: it.qty,
            unit_price: PRODUCTS.find((x) => x.id === it.product_id)?.price_retail ?? 0,
          })),
        };
        be.quotes.push(q);
        const total = q.items.reduce((t, i) => t + i.unit_price * i.qty, 0);
        return json([{ quote_id: q.id, doc_number: q.doc_number,
          valid_until: "2099-01-01", total }]);
      }
      // ---- 0051: a slip scanned back in. Register token only. ----
      // ---- 0054: "actually, no". A manager's PIN or a phoned code. ----
      case "rpc/pos_void_sale": {
        if (!tokenOk) return fail("Register not paired or revoked");
        const idx = Number(String(body.p_sale_id ?? "").replace(/^s/, ""));
        const x = be.sales[idx];
        if (!x) return fail("Sale not found");
        if (x.voided) return fail("Already voided");
        if (be.returns.some((r) => r.sale_id === body.p_sale_id)) {
          return fail("Part of this sale has been returned — return the rest instead of cancelling");
        }
        const secret = String(body.p_pin ?? "");
        if (secret === USERS.manager.pin) {
          // fine
        } else if (secret === USERS.employee.pin || secret === USERS.shelf.pin) {
          return fail("Not permitted: void_refund");
        } else {
          const code = be.approvalCodes.find(
            (c) => c.code === secret && !c.used_at && Date.parse(c.expires_at) > Date.now()
          );
          if (!code) {
            return fail("Not a manager's PIN, and not a code we recognise. A code may have expired or already been used.");
          }
          if (code.max_amount != null && x.total > code.max_amount + 0.005) {
            return fail(`That code covers up to ${code.max_amount.toFixed(2)}, and this sale is ${x.total.toFixed(2)}.`);
          }
          const who = Object.values(USERS).find((u) => u.row.id === body.p_cashier_id);
          if (!who) return fail("A code has to be used by a signed-in cashier");
          code.used_at = new Date().toISOString();
          code.used_by_name = who.row.name;
          code.doc_number = "INV-" + String(idx + 1).padStart(6, "0");
        }
        x.voided = true;
        x.void_reason = String(body.p_reason ?? "").trim() || null;
        // Stock is not put back here because a sale never takes it off in
        // this fake; the database test is where restocking is proved.
        return json({ ...be.saleRow(x, false), id: body.p_sale_id, status: "voided" });
      }
      case "rpc/pos_sale_by_number": {
        if (!tokenOk) return fail("Register not paired or revoked");
        const want = String(body.p_doc_number ?? "").trim().toUpperCase();
        const idx = be.sales.findIndex((_, i) => "INV-" + String(i + 1).padStart(6, "0") === want);
        if (idx < 0) return json(null);
        const x = be.sales[idx];
        const r2 = (n: number) => Math.round(n * 100) / 100;
        // The same row the Sales screen lists, so a reprint has every figure.
        return json({
          id: "s" + idx, doc_number: want,
          created_at: x.created_at ?? new Date().toISOString(),
          cashier_name: Object.values(USERS).find((u) => u.row.id === x.cashier_id)?.row.name ?? "",
          customer_name: be.customers.find((c) => c.id === x.customer_id)?.name ?? null,
          customer_phone: null, customer_address: null, trade_pricing: false,
          subtotal: r2(x.total + x.discount_amount), total: x.total,
          tax_amount: r2(x.total - x.total / 1.15),
          discount_amount: x.discount_amount, discount_reason: x.discount_reason,
          paid_cash: null, paid_card: null, status: x.voided ? "voided" : "completed",
          payment_method: x.payment_method, amount_tendered: x.amount_tendered,
          change_due: x.change_due, rounding: x.rounding, po_number: x.po_number,
          customer_vat_number: x.customer_vat_number,
          approved_by_name: x.approved_by ? "Manager" : null, approved_by_code: false,
          item_count: x.items.length,
        });
      }
      case "rpc/pos_quote_by_number": {
        if (!tokenOk) return fail("Register not paired or revoked");
        const want = String(body.p_doc_number ?? "").trim().toUpperCase();
        const q = be.quotes.find((x) => x.doc_number.toUpperCase() === want);
        if (!q) return json([]);
        return json([{
          id: q.id, doc_number: q.doc_number, created_at: "2026-01-01T08:00:00Z",
          cashier_name: "Sam", customer_id: q.customer_id, customer_name: q.customer_name,
          total: q.items.reduce((t, i) => t + i.unit_price * i.qty, 0),
          valid_until: "2099-01-01", expired: false,
          item_count: q.items.length, note: null, status: q.status,
        }]);
      }
      // 0065: the stock take.
      case "rpc/pos_stock_count_open": {
        if (!tokenOk) return fail("Register not paired or revoked");
        if (body.p_pin !== USERS.manager.pin) return fail("Not permitted");
        const cat = (body.p_category_id as string) ?? null;
        // 0069: two open sheets over the same shelves both snapshot the same
        // expected figure, so posting both takes the shortage off twice.
        const clash = be.stockCounts.find(
          (x) => x.status === "open"
              && (x.category_id === null || cat === null || x.category_id === cat));
        if (clash) {
          return fail(`A count of these shelves is already open (${clash.doc_number}). `
                      + "Finish it or abandon it first.");
        }
        // And a sheet with nothing on it is not a stock take.
        if (!PRODUCTS.some((p) => p.stock_qty != null
                                  && (!cat || p.category_id === cat))) {
          return fail("There is nothing on a shelf in there to count");
        }
        const row = {
          id: `sc${be.stockCounts.length + 1}`,
          doc_number: `CNT-${String(be.stockCounts.length + 1).padStart(6, "0")}`,
          status: "open" as const, category_id: cat,
          note: (body.p_note as string) ?? null,
          // Tracked lines only: a delivery charge is not in aisle three.
          lines: PRODUCTS.filter((p) => p.stock_qty != null)
            .filter((p) => !cat || p.category_id === cat)
            .map((p) => ({
              product_id: p.id, sku: p.sku, name: p.name,
              unit_code: p.unit_code, bin: p.bin,
              expected_qty: p.stock_qty!, counted_qty: null as number | null,
              // 0068: what it cost, snapshotted at open exactly as the
              // expected quantity is.
              unit_cost: p.cost ?? null,
            })),
        };
        be.stockCounts.push(row);
        return json({ id: row.id, doc_number: row.doc_number, status: row.status });
      }
      case "rpc/pos_stock_counts": {
        if (!tokenOk) return fail("Register not paired or revoked");
        if (body.p_pin !== USERS.manager.pin) return fail("Not permitted");
        return json([...be.stockCounts].reverse().map((c) => ({
          id: c.id, doc_number: c.doc_number, status: c.status, note: c.note,
          department: PRODUCTS.find((p) => p.category_id === c.category_id)?.category_name ?? null,
          started_at: "2026-01-01T08:00:00Z", started_by_name: "Ehsan Rizvi",
          posted_at: c.status === "posted" ? "2026-01-01T09:00:00Z" : null,
          posted_by_name: c.status === "posted" ? "Ehsan Rizvi" : null,
          lines: c.lines.length,
          counted: c.lines.filter((l) => l.counted_qty != null).length,
          variances: c.lines.filter(
            (l) => l.counted_qty != null && l.counted_qty !== l.expected_qty).length,
          short_value: Math.round(c.lines.reduce((t, l) =>
            l.counted_qty != null && l.counted_qty < l.expected_qty
              ? t + (l.expected_qty - l.counted_qty) * (l.unit_cost ?? 0)
              : t, 0) * 100) / 100,
        })));
      }
      case "rpc/pos_stock_count_lines": {
        if (!tokenOk) return fail("Register not paired or revoked");
        if (body.p_pin !== USERS.manager.pin) return fail("Not permitted");
        const c = be.stockCounts.find((x) => x.id === body.p_count_id);
        if (!c) return fail("Unknown stock count");
        return json(c.lines.map((l, n) => {
          const v = l.counted_qty == null ? null : l.counted_qty - l.expected_qty;
          return {
            id: `${c.id}-l${n}`, ...l,
            // Read live, not copied onto the sheet: scanning is about finding
            // the row now.
            barcode: fakeProduct(l.product_id)?.barcode ?? null,
            variance: v,
            variance_value: v == null || l.unit_cost == null
              ? null : Math.round(v * l.unit_cost * 100) / 100,
            counted_at: l.counted_qty == null ? null : "2026-01-01T08:30:00Z",
          };
        }));
      }
      case "rpc/pos_stock_count_set": {
        if (!tokenOk) return fail("Register not paired or revoked");
        if (body.p_pin !== USERS.manager.pin) return fail("Not permitted");
        const c = be.stockCounts.find((x) => x.id === body.p_count_id);
        if (!c) return fail("Unknown stock count");
        if (c.status !== "open") return fail(`That count has already been ${c.status}`);
        const l = c.lines.find((x) => x.product_id === body.p_product_id);
        if (!l) return fail("That line is not on this count");
        const q = body.p_qty == null ? null : Number(body.p_qty);
        if (q != null && q < 0) return fail("A shelf cannot hold less than nothing");
        l.counted_qty = q;
        return json(q);
      }
      case "rpc/pos_stock_count_post": {
        if (!tokenOk) return fail("Register not paired or revoked");
        if (body.p_pin !== USERS.manager.pin) return fail("Not permitted");
        const c = be.stockCounts.find((x) => x.id === body.p_count_id);
        if (!c) return fail("Unknown stock count");
        if (c.status !== "open") return fail(`That count has already been ${c.status}`);
        let moved = 0, up = 0, down = 0, valueUp = 0, valueDown = 0;
        for (const l of c.lines) {
          // Uncounted lines are left alone; counted ones move by the
          // DIFFERENCE against what was expected when the sheet opened, not
          // to the counted figure — the shop kept trading meanwhile.
          if (l.counted_qty == null || l.counted_qty === l.expected_qty) continue;
          const delta = l.counted_qty - l.expected_qty;
          const p = PRODUCTS.find((x) => x.id === l.product_id);
          if (p && p.stock_qty != null) p.stock_qty += delta;
          // 0068: the movement carries what the units cost, or the loss can
          // be counted but never added up.
          be.stockMoves.push({
            product_id: l.product_id, qty_delta: delta, reason: "stocktake",
            note: `Counted ${l.counted_qty}, expected ${l.expected_qty}`,
            unit_cost: l.unit_cost ?? null,
          });
          moved++;
          if (delta > 0) { up += delta; valueUp += delta * (l.unit_cost ?? 0); }
          else { down -= delta; valueDown -= delta * (l.unit_cost ?? 0); }
        }
        c.status = "posted";
        const r2 = (n: number) => Math.round(n * 100) / 100;
        return json({ lines_moved: moved, units_up: up, units_down: down,
                      value_up: r2(valueUp), value_down: r2(valueDown) });
      }
      case "rpc/pos_stock_count_abandon": {
        if (!tokenOk) return fail("Register not paired or revoked");
        if (body.p_pin !== USERS.manager.pin) return fail("Not permitted");
        const c = be.stockCounts.find((x) => x.id === body.p_count_id);
        if (!c || c.status !== "open") return fail("That count cannot be abandoned");
        c.status = "abandoned";
        return json(null);
      }
      // 0068: what walked out of the door without being sold.
      case "rpc/pos_shrinkage": {
        if (!tokenOk) return fail("Register not paired or revoked");
        if (body.p_pin !== USERS.manager.pin) return fail("Not permitted: view_reports");
        if (String(body.p_from) > String(body.p_to)) {
          return fail("A report cannot end before it starts");
        }
        // A sale is not a loss: only what left the shelves any other way.
        const lost = be.stockMoves.filter(
          (m) => (m.reason === "stocktake" || m.reason === "adjustment")
                 && m.qty_delta < 0);
        const key = (m: typeof lost[number]) => `${m.product_id}|${m.reason}`;
        const groups = new Map<string, { qty: number; at_cost: number;
                                         estimated: boolean; uncosted: boolean;
                                         reason: string; product_id: string }>();
        for (const m of lost) {
          const p = fakeProduct(m.product_id);
          // Three states: the cost on the movement, today's cost, or no idea.
          const known = m.unit_cost ?? p?.cost ?? null;
          const g = groups.get(key(m)) ?? {
            qty: 0, at_cost: 0, estimated: false, uncosted: false,
            reason: m.reason, product_id: m.product_id,
          };
          g.qty += -m.qty_delta;
          g.at_cost += -m.qty_delta * (known ?? 0);
          g.estimated = g.estimated || (m.unit_cost == null && p?.cost != null);
          g.uncosted = g.uncosted || known == null;
          groups.set(key(m), g);
        }
        const r2 = (n: number) => Math.round(n * 100) / 100;
        const rows = [...groups.values()].map((g) => {
          const p = fakeProduct(g.product_id);
          return {
            department: p?.category_name ?? "—", item: p?.name ?? "—",
            sku: p?.sku ?? null, reason: g.reason, qty: g.qty,
            at_cost: r2(g.at_cost), estimated: g.estimated,
            uncosted: g.uncosted,
          };
        }).sort((a, b) => b.at_cost - a.at_cost);
        return json({
          rows,
          totals: {
            at_cost: r2(rows.reduce((t, r) => t + r.at_cost, 0)),
            counted_short: r2(rows.filter((r) => r.reason === "stocktake")
              .reduce((t, r) => t + r.at_cost, 0)),
            written_off: r2(rows.filter((r) => r.reason === "adjustment")
              .reduce((t, r) => t + r.at_cost, 0)),
            lines: rows.length,
            any_estimated: rows.some((r) => r.estimated),
            uncosted_lines: rows.filter((r) => r.uncosted).length,
            uncosted_units: r2(rows.filter((r) => r.uncosted)
              .reduce((t, r) => t + r.qty, 0)),
          },
          from: body.p_from, to: body.p_to,
        });
      }
      case "rpc/pos_reorder_list": {
        if (!tokenOk) return fail("Register not paired or revoked");
        if (body.p_pin !== USERS.manager.pin) return fail("Not permitted");
        return json(PRODUCTS
          .filter((p) => p.stock_qty != null && p.reorder_level != null
                      && p.stock_qty <= p.reorder_level)
          .map((p) => ({
            product_id: p.id, sku: p.sku, item: p.name,
            department: p.category_name ?? "—", unit: p.unit_code, bin: p.bin,
            on_hand: p.stock_qty, reorder_level: p.reorder_level,
            short: p.reorder_level! - p.stock_qty!,
            // Was hardcoded to 50, and sold_30d to zero, which meant the screen
            // that exists to say HOW FAST something goes always said "none".
            cost: p.cost ?? null,
            supplier: lastSupplierOf(be, p.id),
            sold_30d: soldRecently(be, p.id),
          }))
          .sort((a, b) => b.short - a.short));
      }

      // ---- 0066: ordering from a supplier, and what is owed for it. ----
      case "rpc/pos_po_create": {
        if (!tokenOk) return fail("Register not paired or revoked");
        if (!purchasing(body.p_pin)) return fail("Not permitted: manage_purchasing");
        const sup = be.suppliers.find((x) => x.id === body.p_supplier_id);
        if (!sup) return fail("Unknown supplier");
        const row = {
          id: `po${be.purchaseOrders.length + 1}`,
          doc_number: `PO-${String(be.purchaseOrders.length + 1).padStart(6, "0")}`,
          supplier_id: sup.id, status: "draft",
          expected_on: (body.p_expected_on as string) ?? null,
          note: String(body.p_note ?? "").trim() || null,
          created_at: new Date().toISOString(),
          created_by_name: USERS.manager.row.name, sent_at: null,
        };
        be.purchaseOrders.push(row);
        return json(poRow(be, row));
      }
      case "rpc/pos_po_set_line": {
        if (!tokenOk) return fail("Register not paired or revoked");
        if (!purchasing(body.p_pin)) return fail("Not permitted: manage_purchasing");
        const po = be.purchaseOrders.find((x) => x.id === body.p_po_id);
        if (!po) return fail("Unknown order");
        if (po.status !== "draft" && po.status !== "sent") {
          return fail(`That order is ${po.status} and cannot be changed`);
        }
        const prod = fakeProduct(String(body.p_product_id));
        if (!prod) return fail("Unknown product");
        const qty = Number(body.p_qty);
        const cost = body.p_unit_cost == null ? null : Number(body.p_unit_cost);
        const at = be.poLines.findIndex(
          (l) => l.po_id === po.id && l.product_id === prod.id);
        if (!Number.isFinite(qty) || qty <= 0) {
          if (at >= 0) be.poLines.splice(at, 1);
          return json(null);
        }
        // Changing your mind is not ordering twice: the line moves, it is not
        // added again.
        if (at >= 0) {
          be.poLines[at].qty = qty;
          be.poLines[at].unit_cost = cost ?? be.poLines[at].unit_cost ?? prod.cost ?? null;
        } else {
          be.poLines.push({
            id: `pol${be.poLines.length + 1}`, po_id: po.id, product_id: prod.id,
            sku: prod.sku, name: prod.name, unit_code: prod.unit_code,
            qty, unit_cost: cost ?? prod.cost ?? null, received_qty: 0,
          });
        }
        return json(null);
      }
      case "rpc/pos_po_from_reorder": {
        if (!tokenOk) return fail("Register not paired or revoked");
        if (!purchasing(body.p_pin)) return fail("Not permitted: manage_purchasing");
        const sup = be.suppliers.find((x) => x.id === body.p_supplier_id);
        if (!sup) return fail("Unknown supplier");
        const row = {
          id: `po${be.purchaseOrders.length + 1}`,
          doc_number: `PO-${String(be.purchaseOrders.length + 1).padStart(6, "0")}`,
          supplier_id: sup.id, status: "draft",
          expected_on: (body.p_expected_on as string) ?? null,
          note: "From the reorder list", created_at: new Date().toISOString(),
          created_by_name: USERS.manager.row.name, sent_at: null,
        };
        be.purchaseOrders.push(row);
        for (const p of PRODUCTS) {
          if (p.stock_qty == null || p.reorder_level == null) continue;
          if (p.stock_qty > p.reorder_level) continue;
          be.poLines.push({
            id: `pol${be.poLines.length + 1}`, po_id: row.id, product_id: p.id,
            sku: p.sku, name: p.name, unit_code: p.unit_code,
            // The shortfall plus a month's selling, so it does not come
            // straight back onto the list.
            // At least one: a zero is not an order line, and on the server
            // it violates `check (qty > 0)` and kills the whole insert.
            qty: Math.max(1, Math.ceil(Math.max(p.reorder_level - p.stock_qty, 0)
                                       + soldRecently(be, p.id))),
            unit_cost: p.cost ?? null, received_qty: 0,
          });
        }
        return json(poRow(be, row));
      }
      case "rpc/pos_po_list": {
        if (!tokenOk) return fail("Register not paired or revoked");
        if (!purchasing(body.p_pin)) return fail("Not permitted: manage_purchasing");
        const live = (st: string) => ["draft", "sent", "part"].includes(st);
        return json([...be.purchaseOrders]
          .map((o) => poRow(be, o))
          .sort((a, b) => (live(b.status) ? 1 : 0) - (live(a.status) ? 1 : 0)
                       || b.created_at.localeCompare(a.created_at)));
      }
      case "rpc/pos_po_lines": {
        if (!tokenOk) return fail("Register not paired or revoked");
        if (!purchasing(body.p_pin)) return fail("Not permitted: manage_purchasing");
        return json(be.poLines
          .filter((l) => l.po_id === body.p_po_id)
          .map((l) => ({
            id: l.id, product_id: l.product_id, sku: l.sku, name: l.name,
            unit_code: l.unit_code, qty: l.qty, unit_cost: l.unit_cost,
            received_qty: l.received_qty,
            outstanding: Math.max(l.qty - l.received_qty, 0),
            on_hand: fakeProduct(l.product_id)?.stock_qty ?? null,
          }))
          .sort((a, b) => a.name.localeCompare(b.name)));
      }
      case "rpc/pos_po_send": {
        if (!tokenOk) return fail("Register not paired or revoked");
        if (!purchasing(body.p_pin)) return fail("Not permitted: manage_purchasing");
        const po = be.purchaseOrders.find((x) => x.id === body.p_po_id);
        if (!po) return fail("Unknown order");
        if (po.status !== "draft") return fail(`That order has already been ${po.status}`);
        if (!be.poLines.some((l) => l.po_id === po.id)) {
          return fail("An order with nothing on it is not an order");
        }
        po.status = "sent";
        po.sent_at = new Date().toISOString();
        return json(poRow(be, po));
      }
      case "rpc/pos_po_receive": {
        if (!tokenOk) return fail("Register not paired or revoked");
        if (!purchasing(body.p_pin)) return fail("Not permitted: manage_purchasing");
        const po = be.purchaseOrders.find((x) => x.id === body.p_po_id);
        if (!po) return fail("Unknown order");
        if (po.status === "cancelled" || po.status === "received") {
          return fail(`That order is ${po.status}`);
        }
        let moved = 0;
        for (const item of (body.p_lines as { line_id: string; qty: number;
                                              unit_cost?: number | null }[]) ?? []) {
          const line = be.poLines.find((l) => l.id === item.line_id && l.po_id === po.id);
          if (!line) return fail("That line is not on this order");
          const qty = Number(item.qty);
          if (!Number.isFinite(qty) || qty <= 0) continue;
          const cost = item.unit_cost == null ? null : Number(item.unit_cost);
          const prod = fakeProduct(line.product_id);
          if (prod && prod.stock_qty != null) prod.stock_qty += qty;
          be.stockMoves.push({
            product_id: line.product_id, qty_delta: qty, reason: "receipt",
            note: `${po.doc_number} line ${line.name}`,
          });
          // Cost is a fact and is recorded; retail is a decision and is not
          // touched. Same rule the server keeps.
          if (cost != null && prod) prod.cost = cost;
          line.received_qty += qty;
          if (cost != null) line.unit_cost = cost;
          moved += 1;
        }
        const left = be.poLines.filter(
          (l) => l.po_id === po.id && l.received_qty < l.qty).length;
        if (moved > 0) po.status = left === 0 ? "received" : "part";
        return json({ lines_received: moved, lines_outstanding: left });
      }
      case "rpc/pos_po_cancel": {
        if (!tokenOk) return fail("Register not paired or revoked");
        if (!purchasing(body.p_pin)) return fail("Not permitted: manage_purchasing");
        const po = be.purchaseOrders.find((x) => x.id === body.p_po_id);
        if (!po || (po.status !== "draft" && po.status !== "sent")) {
          return fail("That order cannot be cancelled now");
        }
        po.status = "cancelled";
        po.note = String(body.p_reason ?? "").trim() || po.note;
        return json(null);
      }
      case "rpc/pos_supplier_payables": {
        if (!tokenOk) return fail("Register not paired or revoked");
        if (!purchasing(body.p_pin)) return fail("Not permitted: manage_purchasing");
        // Whole days, as `current_date - due_date` counts them on the server.
        // Subtracting timestamps and rounding made a bill fifteen days late
        // report as sixteen, depending on the hour the test ran.
        const dayOf = (iso: string) => Math.floor(Date.parse(`${iso.slice(0, 10)}T00:00:00Z`) / 86400000);
        const today = Math.floor(Date.now() / 86400000);
        const rows = be.supplierDocs
          .filter((d) => d.kind === "invoice" && d.paid_at == null)
          .map((d) => {
            const total = d.total ?? 0;
            const paid = d.paid_amount ?? 0;
            const late = d.due_date == null ? null
              : Math.max(0, today - dayOf(d.due_date));
            return {
              id: d.id,
              supplier: be.suppliers.find((s) => s.id === d.supplier_id)?.name ?? "—",
              supplier_id: d.supplier_id, doc_number: d.doc_number,
              doc_date: d.doc_date, due_date: d.due_date ?? null,
              total, paid, outstanding: Math.round((total - paid) * 100) / 100,
              days_late: late, status: d.status,
            };
          })
          .sort((a, b) => (b.days_late ?? -1) - (a.days_late ?? -1)
                       || b.outstanding - a.outstanding);
        return json({
          rows,
          totals: {
            total: Math.round(rows.reduce((t, r) => t + r.outstanding, 0) * 100) / 100,
            overdue: Math.round(rows.reduce(
              (t, r) => t + ((r.days_late ?? 0) > 0 ? r.outstanding : 0), 0) * 100) / 100,
            undated: rows.filter((r) => r.due_date == null).length,
            documents: rows.length,
          },
        });
      }
      case "rpc/pos_supplier_mark_paid": {
        if (!tokenOk) return fail("Register not paired or revoked");
        if (!purchasing(body.p_pin)) return fail("Not permitted: manage_purchasing");
        const d = be.supplierDocs.find((x) => x.id === body.p_document_id);
        if (!d) return fail("Unknown document");
        if (d.kind !== "invoice" && d.kind !== "statement") {
          return fail(`A ${d.kind} is not something the shop owes money against`);
        }
        const amount = body.p_amount == null ? null : Number(body.p_amount);
        if (amount != null && amount <= 0) return fail("A payment has to be for something");
        const already = d.paid_amount ?? 0;
        const paid = already + (amount ?? ((d.total ?? 0) - already));
        d.paid_amount = Math.round(paid * 100) / 100;
        d.paid_by_name = USERS.manager.row.name;
        if (body.p_due != null) d.due_date = String(body.p_due);
        // A PART PAYMENT IS NOT A PAID BILL. The balance stays visible.
        d.paid_at = d.paid_amount >= (d.total ?? 0) ? new Date().toISOString() : null;
        return json({ ...d });
      }
      case "rpc/pos_supplier_set_due": {
        if (!tokenOk) return fail("Register not paired or revoked");
        if (!purchasing(body.p_pin)) return fail("Not permitted: manage_purchasing");
        const d = be.supplierDocs.find((x) => x.id === body.p_document_id);
        if (!d) return fail("Unknown document");
        d.due_date = body.p_due == null ? null : String(body.p_due);
        return json(null);
      }

      // 0061: deliveries.
      case "rpc/pos_admin_set_delivery_cost": {
        if (!tokenOk) return fail("Register not paired or revoked");
        if (body.p_pin !== USERS.manager.pin) return fail("Not permitted");
        const c = Number(body.p_cost);
        if (!Number.isFinite(c) || c < 0) {
          return fail("A delivery cannot cost less than nothing");
        }
        // Onto the delivery line itself, which is where every report reads it.
        DELIVERY_LINE.cost = Math.round(c * 100) / 100;
        be.orgSettings.delivery_cost = DELIVERY_LINE.cost as unknown as string;
        return json(DELIVERY_LINE.cost);
      }
      case "rpc/pos_delivery_product": {
        if (!tokenOk) return fail("Register not paired or revoked");
        // From the one definition, not a second copy of it: the till prints
        // the unit this hands back, and the sale is priced off DELIVERY_LINE.
        // With the two written out separately a wrong unit could sail through
        // the printed slip while the pricing still looked right.
        return json([{ id: DELIVERY_LINE.id, sku: DELIVERY_LINE.sku,
                       name: DELIVERY_LINE.name,
                       unit_code: DELIVERY_LINE.unit_code }]);
      }
      case "rpc/pos_create_delivery": {
        if (!tokenOk) return fail("Register not paired or revoked");
        const sale = be.sales[Number(String(body.p_sale_id ?? "").replace(/^s/, ""))];
        if (!sale) return fail("Unknown sale");
        if (String(body.p_customer_name ?? "").trim() === "") {
          return fail("A delivery needs a name");
        }
        // Asked twice is a double tap, not a second load — the same rule
        // pos_create_delivery keeps, and the reason the note is not rewritten.
        const already = be.deliveries.find((d) => d.sale_id === body.p_sale_id);
        if (already) return json(already);
        const u = Object.values(USERS).find((x) => x.row.id === body.p_cashier_id);
        const row = {
          id: `d${be.deliveries.length + 1}`,
          doc_number: `DEL-${String(be.deliveries.length + 1).padStart(6, "0")}`,
          sale_id: String(body.p_sale_id),
          customer_name: String(body.p_customer_name),
          address: String(body.p_address),
          deliver_on: String(body.p_deliver_on),
          deliver_at: (body.p_deliver_at as string) ?? null,
          charge: Number(body.p_charge ?? 0),
          note: (body.p_note as string) ?? null,
          status: "pending" as const,
          cashier_name: u?.row.name ?? "Sam",
          delivered_by_name: null,
          delivered_at: null,
        };
        be.deliveries.push(row);
        return json(row);
      }
      case "rpc/pos_list_deliveries": {
        if (!tokenOk) return fail("Register not paired or revoked");
        const rows = [...be.deliveries].sort((a, b) =>
          a.status === b.status ? 0 : a.status === "pending" ? -1 : 1);
        return json(rows.map((d) => {
          const sale = be.sales[Number(d.sale_id.replace(/^s/, ""))];
          return {
            ...d,
            sale_number: sale ? `INV-${String(be.sales.indexOf(sale) + 1).padStart(6, "0")}` : null,
            created_at: "2026-01-01T08:00:00Z",
            // Goods only: the carriage charge is a line on the invoice, not
            // something anybody signs for at a gate.
            item_count: (sale?.items ?? []).filter(
              (i: { product_id: string }) => i.product_id !== "delivery-line").length,
          };
        }));
      }
      case "rpc/pos_delivery_items": {
        if (!tokenOk) return fail("Register not paired or revoked");
        const d = be.deliveries.find((x) => x.id === body.p_delivery_id);
        if (!d) return fail("Unknown delivery");
        const sale = be.sales[Number(d.sale_id.replace(/^s/, ""))];
        return json((sale?.items ?? [])
          .filter((i: { product_id: string }) => i.product_id !== "delivery-line")
          .map((i: { product_id: string; qty: number }) => {
            const prod = PRODUCTS.find((x) => x.id === i.product_id);
            return { sku: prod?.sku ?? null, name: prod?.name ?? "?",
                     unit_code: prod?.unit_code ?? "ea", qty: i.qty };
          }));
      }
      case "rpc/pos_mark_delivered": {
        if (!tokenOk) return fail("Register not paired or revoked");
        const d = be.deliveries.find((x) => x.id === body.p_delivery_id);
        if (!d) return fail("Unknown delivery");
        if (d.status === "delivered") {
          return fail("That delivery is already marked as delivered");
        }
        const u = Object.values(USERS).find((x) => x.row.id === body.p_user_id);
        d.status = "delivered";
        d.delivered_at = new Date().toISOString();
        d.delivered_by_name = u?.row.name ?? "Sam";
        if (body.p_note) d.note = String(body.p_note);
        return json(d);
      }
      case "rpc/pos_list_quotes":
        if (!tokenOk) return fail("Register not paired or revoked");
        return json(be.quotes.filter((q) => q.status === "open").map((q) => ({
          id: q.id, doc_number: q.doc_number, created_at: "2026-01-01T08:00:00Z",
          cashier_name: "Sam", customer_id: q.customer_id, customer_name: q.customer_name,
          total: q.items.reduce((t, i) => t + i.unit_price * i.qty, 0),
          valid_until: "2099-01-01", expired: false,
          item_count: q.items.length, note: null,
          // 0060: whether the document that went out was kept. Null means the
          // till rebuilds one.
          pdf_path: be.archivedQuotes[q.id] ? `org1/quotes/${q.id}.pdf` : null,
        })));
      case "rpc/pos_quote_items": {
        if (!tokenOk) return fail("Register not paired or revoked");
        const q = be.quotes.find((x) => x.id === body.p_quote_id);
        if (!q) return fail("Unknown quote");
        return json(q.items.map((i) => {
          const prod = PRODUCTS.find((x) => x.id === i.product_id);
          return { product_id: i.product_id, sku: prod?.sku ?? null,
            name: prod?.name ?? "?", unit_code: prod?.unit_code ?? "ea",
            qty: i.qty, unit_price: i.unit_price,
            line_total: i.unit_price * i.qty,
            price_now: prod?.price_retail ?? null, still_sold: !!prod };
        }));
      }
      case "rpc/pos_close_quote": {
        if (!tokenOk) return fail("Register not paired or revoked");
        const q = be.quotes.find(
          (x) => x.id === body.p_quote_id && x.status === "open");
        if (!q) return fail("Quote already closed or unknown");
        if (body.p_status === "converted" && !body.p_sale_id) {
          return fail("A converted quote needs its sale");
        }
        q.status = String(body.p_status);
        q.sale_id = (body.p_sale_id as string) ?? null;
        return json(null);
      }
      case "rpc/pos_receive_stock": {
        if (!tokenOk) return fail("Register not paired or revoked");
        if (body.p_pin !== USERS.manager.pin) return fail("Not permitted: manage_inventory");
        const lines = (body.p_lines as { product_id: string; qty: number }[]) ?? [];
        if (!lines.length) return fail("Nothing to receive");
        for (const l of lines) {
          if (!(l.qty > 0)) return fail("Every line needs a quantity above zero");
          if (!PRODUCTS.find((x) => x.id === l.product_id)) {
            return fail("Unknown product on the delivery");
          }
        }
        return json(lines.map((l) => {
          const prod = PRODUCTS.find((x) => x.id === l.product_id)!;
          if (prod.stock_qty != null) {
            prod.stock_qty = Math.round((prod.stock_qty + l.qty) * 1000) / 1000;
          }
          be.stockMoves.push({ product_id: prod.id, qty_delta: l.qty,
            reason: "receipt", note: (body.p_reference as string) ?? null });
          return { product_id: prod.id, name: prod.name, received: l.qty,
                   stock_qty: prod.stock_qty };
        }));
      }
      case "rpc/pos_stock_movements":
        if (!tokenOk) return fail("Register not paired or revoked");
        if (body.p_pin !== USERS.manager.pin) return fail("Not permitted: manage_inventory");
        return json(be.stockMoves.map((m, i) => ({
          at: new Date().toISOString(), product_id: m.product_id,
          product_name: PRODUCTS.find((x) => x.id === m.product_id)?.name ?? "?",
          qty_delta: m.qty_delta,
          qty_after: PRODUCTS.find((x) => x.id === m.product_id)?.stock_qty ?? 0,
          reason: m.reason, by_name: "Manager", note: m.note,
        })).reverse().slice(0, Number(body.p_limit ?? 100)));
      case "rpc/pos_admin_adjust_stock": {
        if (!tokenOk) return fail("Register not paired or revoked");
        if (body.p_pin !== USERS.manager.pin) return fail("Not permitted: manage_inventory");
        const prod = PRODUCTS.find((x) => x.id === body.p_product_id);
        if (!prod || prod.stock_qty == null) return fail("Product not found");
        const newQty = Number(body.p_new_qty);
        if (!(newQty >= 0)) return fail("Counted quantity cannot be negative");
        be.stockMoves.push({ product_id: prod.id, qty_delta: newQty - prod.stock_qty,
          reason: "adjustment", note: (body.p_note as string) ?? null });
        prod.stock_qty = newQty;
        return json(prod);
      }
      case "rpc/pos_accounts_overview":
        if (!tokenOk) return fail("Register not paired or revoked");
        return json(
          be.customers
            .filter((c) => (c.credit_limit ?? 1) > 0 || be.balance(c.id) !== 0)
            .map((c) => ({
              ...c,
              balance: be.balance(c.id),
              available: c.credit_limit == null ? null
                : Math.round((c.credit_limit - be.balance(c.id)) * 100) / 100,
              // The fake backend has no dated history; everything reads current.
              current_due: be.balance(c.id),
              days30: 0, days60: 0, days90: 0,
              oldest_unpaid: null, last_payment_at: null,
            }))
        );
      case "rpc/pos_customer_ledger": {
        if (!tokenOk) return fail("Register not paired or revoked");
        const custId = body.p_customer_id as string;
        let running = 0;
        const rows: unknown[] = [];
        for (const s of be.sales.filter(
          (x) => x.customer_id === custId && x.payment_method === "account")) {
          running += s.total;
          rows.push({ kind: "charge", entry_at: s.created_at ?? new Date().toISOString(),
            ref: "INV", detail: "Invoice", charge: s.total, payment: 0,
            balance: Math.round(running * 100) / 100, entry_id: "c" + rows.length,
            voided: false });
        }
        for (const p of be.accountPayments.filter((x) => x.customer_id === custId)) {
          if (!p.voided) running -= p.amount;
          rows.push({ kind: "payment", entry_at: new Date().toISOString(),
            ref: p.reference ?? "", detail: p.method, charge: 0,
            payment: p.voided ? 0 : p.amount,
            balance: Math.round(running * 100) / 100, entry_id: p.id,
            voided: p.voided });
        }
        return json(rows.reverse());
      }
      // 0067: the statement a customer is sent.
      case "rpc/pos_customer_statement": {
        if (!tokenOk) return fail("Register not paired or revoked");
        const cust = be.customers.find((c) => c.id === body.p_customer_id);
        if (!cust) return fail("Unknown customer");
        const day = (iso: string) => iso.slice(0, 10);
        const to = (body.p_to as string) ?? day(new Date().toISOString());
        const from = (body.p_from as string)
          ?? `${to.slice(0, 7)}-01`;
        if (from > to) return fail("A statement cannot end before it starts");

        type Entry = { at: string; kind: string; ref: string; detail: string;
                       charge: number; payment: number; voided: boolean };
        const all: Entry[] = [];
        if (cust.opening_balance) {
          all.push({
            at: cust.created_at ?? new Date(0).toISOString(), kind: "opening",
            ref: "", detail: "Opening balance", charge: cust.opening_balance,
            payment: 0, voided: false,
          });
        }
        be.sales.forEach((sale, i) => {
          if (sale.customer_id !== cust.id) return;
          // A sale paid at the counter is not on the account.
          if (sale.payment_method !== "account") return;
          all.push({
            at: sale.created_at ?? new Date().toISOString(), kind: "charge",
            ref: `INV-${String(i + 1).padStart(6, "0")}`, detail: "Invoice",
            charge: sale.total, payment: 0, voided: false,
          });
        });
        for (const p of be.accountPayments) {
          if (p.customer_id !== cust.id) continue;
          all.push({
            at: p.created_at, kind: "payment", ref: p.reference ?? "",
            // A reversed payment is shown, marked, and pays nothing.
            detail: p.method.charAt(0).toUpperCase() + p.method.slice(1)
                    + (p.voided ? " (reversed)" : ""),
            charge: 0, payment: p.voided ? 0 : p.amount, voided: p.voided,
          });
        }
        all.sort((a, b) => a.at.localeCompare(b.at));

        const r2 = (n: number) => Math.round(n * 100) / 100;
        const opening = r2(all
          .filter((e) => day(e.at) < from)
          .reduce((t, e) => t + e.charge - e.payment, 0));
        const inside = all.filter((e) => day(e.at) >= from && day(e.at) <= to);
        let running = opening;
        const lines = inside.map((e) => {
          running = r2(running + e.charge - e.payment);
          return { ...e, balance: running };
        });
        const charges = r2(inside.reduce((t, e) => t + e.charge, 0));
        const payments = r2(inside.reduce((t, e) => t + e.payment, 0));
        const closing = r2(opening + charges - payments);

        // Ageing, oldest first, as customer_aging does it: payments are
        // consumed against charges oldest first and what is left is bucketed
        // by the age of the charge it belongs to.
        const paid = all.reduce((t, e) => t + e.payment, 0);
        const today = Math.floor(Date.now() / 86400000);
        let cum = 0;
        const bucket = { current: 0, days30: 0, days60: 0, days90: 0 };
        for (const e of all) {
          if (!e.charge) continue;
          cum += e.charge;
          const owing = Math.max(0, Math.min(e.charge, cum - paid));
          if (!owing) continue;
          const age = today - Math.floor(Date.parse(`${day(e.at)}T00:00:00Z`) / 86400000);
          if (age < 30) bucket.current += owing;
          else if (age < 60) bucket.days30 += owing;
          else if (age < 90) bucket.days60 += owing;
          else bucket.days90 += owing;
        }
        // A credit balance is money in hand, not an aged debt.
        bucket.current = r2(bucket.current + Math.min(0, closing
          - (bucket.current + bucket.days30 + bucket.days60 + bucket.days90)));

        return json({
          customer: {
            id: cust.id, name: cust.name, phone: cust.phone,
            address: cust.address ?? null, vat_number: cust.vat_number ?? null,
            credit_limit: cust.credit_limit,
          },
          from, to,
          reference: `STM-${to.replace(/-/g, "")}-${cust.id.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
          opening, lines, charges, payments, closing,
          ageing: {
            current: r2(bucket.current), days30: r2(bucket.days30),
            days60: r2(bucket.days60), days90: r2(bucket.days90),
            total: closing, oldest_unpaid: null,
          },
          as_at: new Date().toISOString(),
        });
      }
      case "rpc/pos_take_account_payment": {
        if (!tokenOk) return fail("Register not paired or revoked");
        const cust = be.customers.find((c) => c.id === body.p_customer_id);
        if (!cust) return fail("Unknown customer");
        const amt = Math.round(Number(body.p_amount) * 100) / 100;
        if (!(amt > 0)) return fail("A payment must be more than nothing");
        const cref = (body.p_client_ref as string) ?? null;
        // The replay guard, exactly as the real RPC behaves.
        const dup = cref
          ? be.accountPayments.find((p) => p.client_ref === cref)
          : undefined;
        const pay = dup ?? {
          id: "ap" + (be.accountPayments.length + 1),
          customer_id: cust.id,
          amount: amt,
          method: String(body.p_method ?? "cash"),
          reference: (body.p_reference as string) ?? null,
          client_ref: cref,
          created_at: new Date().toISOString(),
          voided: false,
        };
        if (!dup) be.accountPayments.push(pay);
        return json([{ payment_id: pay.id, balance: be.balance(cust.id),
          available: cust.credit_limit == null ? null
            : Math.round((cust.credit_limit - be.balance(cust.id)) * 100) / 100 }]);
      }
      case "rpc/pos_void_account_payment": {
        if (!tokenOk) return fail("Register not paired or revoked");
        if (body.p_pin !== USERS.manager.pin) return fail("Not permitted: void_refund");
        const pay = be.accountPayments.find(
          (p) => p.id === body.p_payment_id && !p.voided);
        if (!pay) return fail("No such payment");
        pay.voided = true;
        return json(be.balance(pay.customer_id));
      }
      case "rpc/pos_sale_payments":
        if (!tokenOk) return fail("Register not paired or revoked");
        return json(be.sales.at(-1)?.payments ?? []);
      case "rpc/pos_search_products":
        if (!tokenOk) return fail("Register not paired or revoked");
        return json(searchProducts(String(body.p_query ?? "")));
      case "rpc/pos_create_sale": {
        if (!tokenOk) return fail("Register not paired or revoked");
        try {
          return json(be.createSale(body));
        } catch (e) {
          return fail(e instanceof Error ? e.message : "Rejected");
        }
      }
      case "rpc/pos_admin_list_products": {
        if (!tokenOk) return fail("Register not paired or revoked");
        if (body.p_pin !== USERS.manager.pin) return fail("Invalid PIN");
        // Shelf-recorded items ride along with their real active flag, so the
        // catalogue's "hidden" filter can show a reviewer what the aisle
        // captured — hardcoding active:true here would hide exactly the rows
        // this screen exists to review.
        return json([
          ...PRODUCTS.map((p) => ({ ...p, description: null, active: true })),
          ...be.shelfAdded.map((p) => ({ ...p, cost: null, description: null })),
        ]);
      }
      case "rpc/pos_shelf_lookup": {
        if (!tokenOk) return fail("Register not paired or revoked");
        const u = Object.values(USERS).find((x) => x.pin === body.p_pin);
        if (!u) return fail("Invalid PIN");
        if (!u.row.permissions.some((p) => p === "shelf_capture" || p === "manage_catalogue")) {
          return fail("Not permitted: shelf_capture");
        }
        const code = String(body.p_barcode ?? "").trim();
        const hit =
          PRODUCTS.find((p) => p.barcode === code) ??
          be.shelfAdded.find((p) => p.barcode === code);
        if (!hit) return json([]);
        return json([{
          id: hit.id, name: hit.name, barcode: hit.barcode,
          unit_code: hit.unit_code, price_retail: hit.price_retail,
          active: (hit as { active?: boolean }).active ?? true,
          has_photo: hit.image_url != null,
        }]);
      }
      case "rpc/pos_shelf_add_item": {
        if (!tokenOk) return fail("Register not paired or revoked");
        const u = Object.values(USERS).find((x) => x.pin === body.p_pin);
        if (!u) return fail("Invalid PIN");
        if (!u.row.permissions.some((p) => p === "shelf_capture" || p === "manage_catalogue")) {
          return fail("Not permitted: shelf_capture");
        }
        const code = String(body.p_barcode ?? "").trim();
        if (!/^\d{6,14}$/.test(code)) return fail("A barcode is 6 to 14 digits");
        if (String(body.p_name ?? "").trim() === "") return fail("A name is required");
        // 0046: a price is optional at the shelf; none means "not priced yet".
        const price = body.p_price_retail == null ? 0 : Number(body.p_price_retail);
        if (price < 0) return fail("A price cannot be negative");
        if (PRODUCTS.some((p) => p.barcode === code) || be.shelfAdded.some((p) => p.barcode === code)) {
          return fail("That barcode is already in the catalogue — scan it again to add a photo");
        }
        const row = {
          id: "sh" + (be.shelfAdded.length + 1),
          sku: "SHELF-" + code, barcode: code,
          name: String(body.p_name).trim(),
          category_id: null, category_name: null,
          unit_code: "ea", unit_name: "Each", allows_fraction: false,
          price_retail: price, price_trade: null, tax_code: "standard",
          stock_qty: null, reorder_level: null, image_url: null,
          sort_order: 0, bin: null,
          max_discount_percent: null, max_discount_amount: null,
          // Born hidden, exactly as 0044 insists — there is no argument to
          // say otherwise, here or on the server.
          active: false,
        };
        be.shelfAdded.push(row);
        return json([{
          id: row.id, name: row.name, barcode: row.barcode,
          unit_code: row.unit_code, price_retail: row.price_retail,
          active: false, has_photo: false,
        }]);
      }
      case "rpc/pos_shelf_set_price": {
        if (!tokenOk) return fail("Register not paired or revoked");
        const u = Object.values(USERS).find((x) => x.pin === body.p_pin);
        if (!u) return fail("Invalid PIN");
        // manage_catalogue and NOT the shelf grant: the fence the whole
        // permission exists to hold.
        if (!u.row.permissions.includes("manage_catalogue")) {
          return fail("Not permitted: manage_catalogue");
        }
        const target =
          PRODUCTS.find((p) => p.id === body.p_product_id) ??
          be.shelfAdded.find((p) => p.id === body.p_product_id);
        if (!target) return fail("Product not found");
        const v = Number(body.p_price_retail);
        if (!(v >= 0)) return fail("A retail price is required");
        target.price_retail = v;
        return json(v);
      }
      case "rpc/pos_admin_save_product": {
        if (!tokenOk) return fail("Register not paired or revoked");
        if (body.p_pin !== USERS.manager.pin) return fail("Invalid PIN");
        const pct = body.p_max_discount_percent;
        if (body.p_id == null) {
          // 0053: born with the shop's next code unless one was typed.
          if (!String(body.p_name ?? "").trim()) return fail("A name is required");
          const typed = String(body.p_sku ?? "").trim();
          const sku = typed || "SKU-" + String(++be.skuSeq).padStart(6, "0");
          if (PRODUCTS.some((x) => x.sku === sku)) return fail("That SKU already exists");
          const made = mk("new" + PRODUCTS.length, sku, (body.p_barcode as string) || null,
            String(body.p_name), "ea", "Each", false, Number(body.p_price_retail ?? 0),
            null, Number(body.p_stock_qty ?? 0), null);
          PRODUCTS.push(made);
          return json([{ ...made }]);
        }
        const p = PRODUCTS.find((x) => x.id === body.p_id);
        if (!p) return fail("Product not found");
        if (pct != null && (Number(pct) < 0 || Number(pct) > 100)) {
          return fail("A discount cap is a percentage between 0 and 100");
        }
        // Null clears the cap, unlike the picture in 0027 — an empty box has
        // to be able to remove one.
        p.max_discount_percent = pct == null ? null : Number(pct);
        p.max_discount_amount =
          body.p_max_discount_amount == null ? null : Number(body.p_max_discount_amount);
        p.name = String(body.p_name ?? p.name);
        p.price_retail = Number(body.p_price_retail ?? p.price_retail);
        return json([{ ...p }]);
      }
      // ---- 0055: suppliers and their paperwork. manage_purchasing. ----
      case "rpc/pos_purchasing_suppliers": {
        if (!tokenOk) return fail("Register not paired or revoked");
        if (!purchasing(body.p_pin)) return fail("Not permitted: manage_purchasing");
        return json(be.suppliers.map((s) => ({
          address: null, bank_name: null, bank_account_name: null,
          bank_account_number: null, bank_branch_code: null,
          ...s, code: null, active: true,
          document_count: be.supplierDocs.filter((d) => d.supplier_id === s.id).length,
        })));
      }
      case "rpc/pos_purchasing_save_supplier": {
        if (!tokenOk) return fail("Register not paired or revoked");
        if (!purchasing(body.p_pin)) return fail("Not permitted: manage_purchasing");
        const name = String(body.p_name ?? "").trim();
        if (!name) return fail("A supplier needs a name");
        const clean = (v: unknown) => (String(v ?? "").trim() || null);
        const fields = {
          name, contact_name: clean(body.p_contact_name), phone: clean(body.p_phone),
          email: clean(body.p_email), address: clean(body.p_address),
          vat_number: clean(body.p_vat_number), notes: clean(body.p_notes),
          bank_name: clean(body.p_bank_name), bank_account_name: clean(body.p_bank_account_name),
          bank_account_number: clean(body.p_bank_account_number),
          bank_branch_code: clean(body.p_bank_branch_code),
        };
        if (body.p_id) {
          const s = be.suppliers.find((x) => x.id === body.p_id);
          if (!s) return fail("Supplier not found");
          Object.assign(s, fields);
          return json({ ...s });
        }
        const made = { id: "sup" + (be.suppliers.length + 1), ...fields };
        be.suppliers.push(made);
        return json({ ...made });
      }
      case "rpc/pos_purchasing_match_supplier": {
        if (!tokenOk) return fail("Register not paired or revoked");
        if (!purchasing(body.p_pin)) return fail("Not permitted: manage_purchasing");
        const hit = matchSupplier(be, body.p_vat_number, body.p_name);
        return json(hit ? [{ id: hit.id, name: hit.name, vat_number: hit.vat_number }] : []);
      }
      case "rpc/pos_purchasing_file_document": {
        if (!tokenOk) return fail("Register not paired or revoked");
        if (!purchasing(body.p_pin)) return fail("Not permitted: manage_purchasing");
        const kind = String(body.p_kind ?? "");
        if (!["quote", "invoice", "delivery_note", "statement", "other"].includes(kind)) {
          return fail("Say what kind of document it is");
        }
        let sup = body.p_supplier_id
          ? be.suppliers.find((x) => x.id === body.p_supplier_id)
          : matchSupplier(be, body.p_supplier_vat, body.p_supplier_name);
        if (body.p_supplier_id && !sup) return fail("Supplier not found");
        let created = false;
        if (!sup) {
          const name = String(body.p_supplier_name ?? "").trim();
          if (!name) return fail("A supplier needs a name");
          const off = (v: unknown) => (String(v ?? "").trim() || null);
          sup = {
            id: "sup" + (be.suppliers.length + 1), name,
            contact_name: null,
            phone: off(body.p_supplier_phone),
            email: off(body.p_supplier_email),
            address: off(body.p_supplier_address),
            vat_number: off(body.p_supplier_vat),
            notes: null,
            bank_name: off(body.p_bank_name),
            bank_account_name: off(body.p_bank_account_name),
            bank_account_number: off(body.p_bank_account_number),
            bank_branch_code: off(body.p_bank_branch_code),
          };
          be.suppliers.push(sup);
          created = true;
        }
        // 0057: fill the blanks on a supplier we already had, never overwrite.
        let filled = 0;
        if (!created) {
          const learn = (
            key: "phone" | "email" | "address" | "vat_number" | "bank_name" |
                 "bank_account_name" | "bank_account_number" | "bank_branch_code",
            from: unknown
          ) => {
            const v = String(from ?? "").trim();
            if (v && !sup![key]) {
              sup![key] = v;
              filled += 1;
            }
          };
          learn("phone", body.p_supplier_phone);
          learn("email", body.p_supplier_email);
          learn("address", body.p_supplier_address);
          learn("vat_number", body.p_supplier_vat);
          learn("bank_name", body.p_bank_name);
          learn("bank_account_name", body.p_bank_account_name);
          learn("bank_account_number", body.p_bank_account_number);
          learn("bank_branch_code", body.p_bank_branch_code);
        }
        const lines = (body.p_lines as Record<string, unknown>[]) ?? [];
        const doc = {
          id: "doc" + (be.supplierDocs.length + 1), supplier_id: sup.id, kind,
          doc_number: (String(body.p_doc_number ?? "").trim() || null),
          doc_date: (body.p_doc_date as string) ?? null,
          total: body.p_total == null ? null : Number(body.p_total),
          note: (String(body.p_note ?? "").trim() || null),
          status: body.p_read ? "read" : "stored",
          created_at: new Date().toISOString(),
        };
        be.supplierDocs.push(doc);
        let no = 0;
        for (const l of lines) {
          const description = String(l.description ?? "").trim();
          if (!description) continue;
          no += 1;
          be.supplierLines.push({
            document_id: doc.id, line_no: no,
            supplier_code: (String(l.supplier_code ?? "").trim() || null),
            description,
            qty: l.qty == null ? null : Number(l.qty),
            unit_price: l.unit_price == null ? null : Number(l.unit_price),
            line_total: l.line_total == null ? null : Number(l.line_total),
          });
        }
        return json([{ document_id: doc.id, supplier_id: sup.id, supplier_name: sup.name,
          supplier_created: created, details_filled: filled }]);
      }
      // ---- 0058: the delivery note becomes stock on the shelf. ----
      case "rpc/pos_purchasing_receive_lines": {
        if (!tokenOk) return fail("Register not paired or revoked");
        if (!purchasing(body.p_pin)) return fail("Not permitted: manage_purchasing");
        const d = be.supplierDocs.find((x) => x.id === body.p_document_id);
        if (!d) return fail("Document not found");
        return json(be.supplierLines
          .filter((l) => l.document_id === d.id)
          .map((l) => {
            const code = be.supplierCodes.find(
              (c) => c.supplier_id === d.supplier_id && c.supplier_code === l.supplier_code
            );
            // The same order the server trusts: a confirmed pairing, then the
            // supplier's code being our own SKU, then an earlier match.
            const bySku = l.supplier_code
              ? PRODUCTS.find((p) => p.sku.toLowerCase() === l.supplier_code!.toLowerCase())
              : undefined;
            const pid = l.product_id ?? code?.product_id ?? bySku?.id ?? null;
            const prod = PRODUCTS.find((p) => p.id === pid);
            return {
              ...l, product_id: pid, product_name: prod?.name ?? null,
              product_sku: prod?.sku ?? null, stock_qty: prod?.stock_qty ?? null,
              current_cost: prod ? 50 : null, retail: prod?.price_retail ?? null,
              remembered: !!code,
            };
          }));
      }
      case "rpc/pos_purchasing_receive_document": {
        if (!tokenOk) return fail("Register not paired or revoked");
        if (!purchasing(body.p_pin)) return fail("Not permitted: manage_purchasing");
        const d = be.supplierDocs.find((x) => x.id === body.p_document_id);
        if (!d) return fail("Document not found");
        if (d.status === "received") return fail("This document has already been booked in");
        const wanted = (body.p_lines as Record<string, unknown>[]) ?? [];
        const out: Record<string, unknown>[] = [];
        for (const w of wanted) {
          const qty = Number(w.qty ?? 0);
          if (!(qty > 0)) continue;
          const src = be.supplierLines.find(
            (l) => l.document_id === d.id && l.line_no === Number(w.line_no)
          );
          if (!src) return fail(`No line ${w.line_no} on this document`);
          let pid = (w.product_id as string) ?? null;
          let created = false;
          if (!pid) {
            if (!w.create) return fail(`Line ${w.line_no} has nothing to receive it against`);
            // Born inactive and unpriced, as the shelf's captures are.
            const made = mk("new" + PRODUCTS.length, "SKU-" + String(++be.skuSeq).padStart(6, "0"),
              null, src.description, "ea", "Each", false, 0, null, 0, null);
            PRODUCTS.push(made);
            pid = made.id;
            created = true;
          }
          const prod = PRODUCTS.find((p) => p.id === pid);
          if (!prod) return fail(`Unknown product on line ${w.line_no}`);
          const oldCost = created ? null : 50;
          const cost = w.unit_cost == null ? null : Number(w.unit_cost);
          prod.stock_qty = Math.round(((prod.stock_qty ?? 0) + qty) * 1000) / 1000;
          be.stockMoves.push({ product_id: pid, qty_delta: qty, reason: "receipt",
            note: d.doc_number ?? "Goods received" });
          src.product_id = pid;
          if ((w.remember ?? true) && src.supplier_code) {
            const at = be.supplierCodes.findIndex(
              (c) => c.supplier_id === d.supplier_id && c.supplier_code === src.supplier_code
            );
            const row = { supplier_id: d.supplier_id, supplier_code: src.supplier_code, product_id: pid };
            if (at >= 0) be.supplierCodes[at] = row; else be.supplierCodes.push(row);
          }
          out.push({ product_id: pid, name: prod.name, received: qty,
            stock_qty: prod.stock_qty, old_cost: oldCost,
            new_cost: cost ?? oldCost, created });
        }
        if (out.length === 0) return fail("Nothing to receive");
        d.status = "received";
        return json(out);
      }
      case "rpc/pos_purchasing_document_lines": {
        if (!tokenOk) return fail("Register not paired or revoked");
        if (!purchasing(body.p_pin)) return fail("Not permitted: manage_purchasing");
        return json(be.supplierLines
          .filter((l) => l.document_id === body.p_document_id)
          .map((l) => ({ ...l, product_id: null, product_name: null })));
      }
      case "rpc/pos_purchasing_add_document": {
        if (!tokenOk) return fail("Register not paired or revoked");
        if (!purchasing(body.p_pin)) return fail("Not permitted: manage_purchasing");
        if (!be.suppliers.some((s) => s.id === body.p_supplier_id)) return fail("Supplier not found");
        const kind = String(body.p_kind ?? "");
        if (!["quote", "invoice", "delivery_note", "statement", "other"].includes(kind)) {
          return fail("Say what kind of document it is");
        }
        const d = {
          id: "doc" + (be.supplierDocs.length + 1), supplier_id: String(body.p_supplier_id), kind,
          doc_number: (String(body.p_doc_number ?? "").trim() || null),
          doc_date: (body.p_doc_date as string) ?? null,
          total: body.p_total == null ? null : Number(body.p_total),
          note: (String(body.p_note ?? "").trim() || null),
          status: "stored", created_at: new Date().toISOString(),
        };
        be.supplierDocs.push(d);
        return json(d.id);
      }
      case "rpc/pos_purchasing_documents": {
        if (!tokenOk) return fail("Register not paired or revoked");
        if (!purchasing(body.p_pin)) return fail("Not permitted: manage_purchasing");
        return json(be.supplierDocs
          .filter((d) => !body.p_supplier_id || d.supplier_id === body.p_supplier_id)
          .slice().reverse()
          .map((d) => ({
            ...d,
            supplier_name: be.suppliers.find((s) => s.id === d.supplier_id)?.name ?? "?",
            pages: be.supplierPages.filter((pg) => pg.document_id === d.id).length,
            lines: be.supplierLines.filter((l) => l.document_id === d.id).length,
            created_by_name: "Manager",
          })));
      }
      case "rpc/pos_purchasing_delete_document": {
        if (!tokenOk) return fail("Register not paired or revoked");
        if (!purchasing(body.p_pin)) return fail("Not permitted: manage_purchasing");
        const i = be.supplierDocs.findIndex((d) => d.id === body.p_document_id && d.status === "stored");
        if (i < 0) return fail("Document not found, or it has already been booked in");
        be.supplierDocs.splice(i, 1);
        be.supplierPages = be.supplierPages.filter((pg) => pg.document_id !== body.p_document_id);
        be.supplierLines = be.supplierLines.filter((l) => l.document_id !== body.p_document_id);
        return json(null);
      }

      case "rpc/pos_org_settings":
        if (!tokenOk) return fail("Register not paired or revoked");
        // The rate the till displays comes from the server, as it does in
        // 0038 — the screen must not be able to outlive what is charged.
        return json([{ ...be.orgSettings, vat_rate: 0.15 }]);

      case "rpc/pos_admin_save_settings": {
        if (!tokenOk) return fail("Register not paired or revoked");
        if (body.p_pin !== USERS.manager.pin) return fail("Invalid PIN");
        Object.assign(
          be.orgSettings,
          body.p_settings as Record<string, string | boolean>
        );
        return json(null);
      }

      case "rpc/pos_cash_session_open": {
        if (!tokenOk) return fail("Register not paired or revoked");
        if (body.p_pin !== USERS.manager.pin) return fail("Invalid PIN");
        if (be.cashSession) return fail("This till already has a session open");
        be.cashSession = {
          id: "cs1",
          opened_by_name: "Manager",
          opened_at: new Date().toISOString(),
          opening_float: Number(body.p_opening_float ?? 0),
          fromIndex: be.sales.length,
          fromPayments: be.accountPayments.length,
        };
        be.cashMovements = [];
        return json(be.cashSession);
      }

      case "rpc/pos_cash_session_status": {
        // Register token only, as 0047 has it: a time and a name, no figures.
        if (!tokenOk) return fail("Register not paired or revoked");
        if (!be.cashSession) return json(null);
        const hours = (Date.now() - new Date(be.cashSession.opened_at).getTime()) / 36e5;
        return json({
          id: be.cashSession.id,
          opened_at: be.cashSession.opened_at,
          opened_by_name: be.cashSession.opened_by_name,
          hours_open: Math.round(hours * 10) / 10,
        });
      }

      case "rpc/pos_cash_session_current": {
        if (!tokenOk) return fail("Register not paired or revoked");
        if (body.p_pin !== USERS.manager.pin) return fail("Invalid PIN");
        if (!be.cashSession) return json(null);
        return json({
          ...be.cashSession,
          closed_at: null, closed_by_name: null, counted_cash: null,
          expected_cash: null, variance: null, note: null,
          figures: be.cashFigures(),
          movements: be.cashMovements,
        });
      }

      case "rpc/pos_cash_movement": {
        if (!tokenOk) return fail("Register not paired or revoked");
        if (body.p_pin !== USERS.manager.pin) return fail("Invalid PIN");
        if (!be.cashSession) return fail("No session is open on this till");
        if (!String(body.p_reason ?? "").trim()) return fail("A reason is required");
        const row = {
          id: "m" + (be.cashMovements.length + 1),
          kind: String(body.p_kind),
          amount: Number(body.p_amount),
          reason: String(body.p_reason).trim(),
          by_name: "Manager",
          created_at: new Date().toISOString(),
        };
        be.cashMovements.push(row);
        return json(row);
      }

      case "rpc/pos_cash_session_close": {
        if (!tokenOk) return fail("Register not paired or revoked");
        if (body.p_pin !== USERS.manager.pin) return fail("Invalid PIN");
        if (!be.cashSession) return fail("No session is open on this till");
        const figures = be.cashFigures();
        const counted = Number(body.p_counted_cash);
        // 0048: the machine and the bank against the till, and the banking.
        const opt = (v: unknown) => (v == null ? null : Number(v));
        const cardC = opt(body.p_card_counted), eftC = opt(body.p_eft_counted), bankedC = opt(body.p_banked);
        if ((cardC ?? 0) < 0 || (eftC ?? 0) < 0 || (bankedC ?? 0) < 0) return fail("A total cannot be negative");
        if (bankedC != null && bankedC > counted) return fail("More cannot be banked than was counted");
        const r2 = (n: number) => Math.round(n * 100) / 100;
        const closed = {
          ...be.cashSession,
          closed_at: new Date().toISOString(),
          closed_by_name: "Manager",
          counted_cash: counted,
          expected_cash: figures.expected_cash,
          variance: r2(counted - figures.expected_cash),
          card_counted: cardC,
          card_expected: cardC == null ? null : figures.card_expected,
          card_variance: cardC == null ? null : r2(cardC - figures.card_expected),
          eft_counted: eftC,
          eft_expected: eftC == null ? null : figures.eft_expected,
          eft_variance: eftC == null ? null : r2(eftC - figures.eft_expected),
          banked: bankedC,
          float_kept: bankedC == null ? null : r2(counted - bankedC),
          note: (body.p_note as string) ?? null,
          figures,
          movements: be.cashMovements,
        };
        be.closedSessions.unshift(closed);
        be.cashSession = null;
        return json(closed);
      }

      // ---- 0049: reports. Read-only views over what the fake has recorded. ----
      case "rpc/pos_day_close":
      case "rpc/pos_sales_by_department":
      case "rpc/pos_vat_by_month":
      case "rpc/pos_deliveries_report":
      case "rpc/pos_sales_by_cashier":
      case "rpc/pos_money_back":
      case "rpc/pos_item_movement":
      case "rpc/pos_stock_value":
      case "rpc/pos_margin_slipped":
      case "rpc/pos_debtors_ageing":
      case "rpc/pos_purchases_by_supplier":
      case "rpc/pos_export_sales": {
        if (!tokenOk) return fail("Register not paired or revoked");
        if (body.p_pin !== USERS.manager.pin) return fail("Not permitted: view_reports");
        const r2 = (n: number) => Math.round(n * 100) / 100;
        const from = body.p_from ? new Date(String(body.p_from)).getTime() : -Infinity;
        const to = body.p_to ? new Date(String(body.p_to)).getTime() : Infinity;
        if (to < from) return fail("Those dates are the wrong way round");
        const at = (iso: string | null) => (iso ? new Date(iso).getTime() : Date.now());
        const inWin = (iso: string | null) => at(iso) >= from && at(iso) < to;
        const done = be.sales.map((sale, i) => ({ sale, i })).filter(({ sale }) => inWin(sale.created_at));

        if (path === "rpc/pos_day_close") {
          const tenders: Record<string, number> = {};
          for (const { sale } of done) for (const p of sale.payments) tenders[p.method] = r2((tenders[p.method] ?? 0) + p.amount);
          const acct: Record<string, number> = {};
          for (const p of be.accountPayments) if (!p.voided) acct[p.method] = r2((acct[p.method] ?? 0) + p.amount);
          const refunds = be.returns.filter((r) => inWin(r.created_at));
          const sessions = [
            ...be.closedSessions.map((c) => ({ ...c, register_name: "Front Counter" })),
            ...(be.cashSession
              ? [{ ...be.cashSession, closed_at: null, closed_by_name: null, counted_cash: null,
                   expected_cash: null, variance: null, banked: null, float_kept: null,
                   card_counted: null, card_variance: null, note: null,
                   figures: be.cashFigures(), movements: be.cashMovements,
                   register_name: "Front Counter" }]
              : []),
          ] as Record<string, unknown>[];
          const num = (v: unknown) => (typeof v === "number" ? v : 0);
          const sum = (k: string) => r2(sessions.reduce((t, x) => t + num(x[k]), 0));
          const total = r2(done.reduce((t, { sale }) => t + sale.total, 0));
          return json({
            sessions,
            totals: {
              sales_count: done.length, sales_total: total,
              vat_total: r2(total - total / 1.15),
              discount_total: r2(done.reduce((t, { sale }) => t + sale.discount_amount, 0)),
              refunds_count: refunds.length, refunds_total: r2(refunds.reduce((t, r) => t + r.total, 0)),
              tenders, account_payments: acct,
              card_expected: r2((tenders.card ?? 0) + (acct.card ?? 0)),
              eft_expected: r2((tenders.eft ?? 0) + (acct.eft ?? 0)),
              sessions_open: be.cashSession ? 1 : 0,
              floats: sum("opening_float"), cash_expected: sum("expected_cash"),
              cash_counted: sum("counted_cash"), cash_variance: sum("variance"),
              card_counted: sum("card_counted"), card_variance: sum("card_variance"),
              eft_counted: sum("eft_counted"), eft_variance: sum("eft_variance"),
              banked: sum("banked"), float_kept: sum("float_kept"),
            },
          });
        }

        // Every line of every completed sale in the window, priced as the
        // server prices them. Cost is the 50 the catalogue fake reports.
        const lines = done.flatMap(({ sale, i }) =>
          fakeSaleLines(be, "s" + i).map((l) => ({ sale, line: l })));

        if (path === "rpc/pos_sales_by_department") {
          const by: Record<string, { lines: number; qty: number; sales: number; vat: number; cost: number }> = {};
          for (const { line } of lines) {
            const dept = fakeProduct(line.product_id)?.category_name ?? "—";
            const d = (by[dept] ??= { lines: 0, qty: 0, sales: 0, vat: 0, cost: 0 });
            d.lines++; d.qty += line.qty; d.sales = r2(d.sales + line.line_total);
            d.vat = r2(d.vat + line.tax_amount); d.cost = r2(d.cost + 50 * line.qty);
          }
          return json(Object.entries(by).map(([department, d]) => {
            const net = r2(d.sales - d.vat);
            const margin = r2(net - d.cost);
            return { department, lines: d.lines, qty: d.qty, sales: d.sales, vat: d.vat, net,
                     cost: d.cost, uncosted_lines: 0, margin,
                     margin_percent: net > 0 ? Math.round((margin / net) * 1000) / 10 : null };
          }).sort((a, b) => b.sales - a.sales));
        }

        if (path === "rpc/pos_vat_by_month") {
          const by: Record<string, { n: number; gross: number; vat: number; refunds: number; rvat: number }> = {};
          const key = (iso: string | null) => (iso ? new Date(iso) : new Date()).toISOString().slice(0, 7);
          for (const sale of be.sales) {
            const m = (by[key(sale.created_at)] ??= { n: 0, gross: 0, vat: 0, refunds: 0, rvat: 0 });
            m.n++; m.gross = r2(m.gross + sale.total); m.vat = r2(m.vat + (sale.total - sale.total / 1.15));
          }
          for (const r of be.returns) {
            const m = (by[key(r.created_at)] ??= { n: 0, gross: 0, vat: 0, refunds: 0, rvat: 0 });
            m.refunds = r2(m.refunds + r.total); m.rvat = r2(m.rvat + r.tax_total);
          }
          return json(Object.entries(by).sort(([a], [b]) => (a < b ? 1 : -1)).map(([month, m]) => ({
            month, sales_count: m.n, gross: m.gross, vat: r2(m.vat), net: r2(m.gross - m.vat),
            refunds: m.refunds, refunds_vat: m.rvat, vat_due: r2(m.vat - m.rvat),
          })));
        }

        // 0063 ------------------------------------------------------------
        if (path === "rpc/pos_deliveries_report") {
          const made = be.deliveries.filter((d) => {
            // The fake stamps nothing on a note, so everything it holds counts
            // as made in the window under test.
            void d;
            return true;
          });
          const today = new Date().toISOString().slice(0, 10);
          const carriageLines = lines.filter(
            ({ line }) => line.product_id === DELIVERY_LINE.id);
          const carriageNet = carriageLines
            .reduce((t, { line }) => r2(t + line.line_total - line.tax_amount), 0);
          // cost_at_sale, as the server records it: the figure as it stood when
          // the trip was made.
          const carriageCost = carriageLines
            .reduce((t, { line }) => r2(t + (line.cost_at_sale ?? 0) * line.qty), 0);
          return json({
            totals: {
              count: made.length,
              delivered: made.filter((d) => d.status === "delivered").length,
              outstanding: made.filter((d) => d.status === "pending").length,
              late: be.deliveries.filter(
                (d) => d.status === "pending" && d.deliver_on < today).length,
              carriage: r2(made.reduce((t, d) => t + d.charge, 0)),
              carriage_free: made.filter((d) => d.charge === 0).length,
              carriage_net: carriageNet,
              carriage_cost: carriageCost,
              carriage_margin: r2(carriageNet - carriageCost),
            },
            outstanding: be.deliveries
              .filter((d) => d.status === "pending")
              .sort((a, b) => (a.deliver_on < b.deliver_on ? -1 : 1))
              .map((d) => ({
                id: d.id, doc_number: d.doc_number, customer_name: d.customer_name,
                address: d.address, deliver_on: d.deliver_on, deliver_at: d.deliver_at,
                charge: d.charge, cashier_name: d.cashier_name,
                sale_number: "INV-" + String(
                  Number(d.sale_id.replace(/^s/, "")) + 1).padStart(6, "0"),
                days_late: Math.max(0, Math.round(
                  (Date.parse(today) - Date.parse(d.deliver_on)) / 86400000)),
              })),
          });
        }

        if (path === "rpc/pos_sales_by_cashier") {
          const by: Record<string, { n: number; sales: number; vat: number; disc: number }> = {};
          for (const { sale } of done) {
            const who = Object.values(USERS)
              .find((u) => u.row.id === sale.cashier_id)?.row.name ?? "—";
            const c = (by[who] ??= { n: 0, sales: 0, vat: 0, disc: 0 });
            c.n++; c.sales = r2(c.sales + sale.total);
            c.vat = r2(c.vat + (sale.total - sale.total / 1.15));
            // As the server keeps it: sales.discount_amount is ALREADY the
            // whole discount, lines included. Adding the lines again here
            // would count every marked-down item twice.
            c.disc = r2(c.disc + sale.discount_amount);
          }
          const rr = be.returns;
          return json(Object.entries(by).map(([cashier, c]) => ({
            cashier, sales_count: c.n, sales: c.sales, net: r2(c.sales - c.vat),
            average: r2(c.sales / Math.max(c.n, 1)), discount: c.disc,
            refunds_count: rr.length, refunds: r2(rr.reduce((t, x) => t + x.total, 0)),
          })).sort((a, b) => b.sales - a.sales));
        }

        if (path === "rpc/pos_money_back") {
          return json([
            ...be.returns.filter((r) => inWin(r.created_at)).map((r) => ({
              kind: "return", at: r.created_at, amount: r.total,
              doc_number: r.doc_number, against: null,
              who: r.by_name ?? null, reason: r.reason, refund_method: r.refund_method,
            })),
            ...be.sales.map((sale, i) => ({ sale, i }))
              .filter(({ sale }) => sale.voided && inWin(sale.created_at))
              .map(({ sale, i }) => ({
                kind: "cancelled", at: sale.created_at ?? new Date().toISOString(),
                amount: sale.total,
                doc_number: "INV-" + String(i + 1).padStart(6, "0"),
                against: null,
                who: Object.values(USERS).find((u) => u.row.id === sale.cashier_id)?.row.name ?? null,
                reason: sale.void_reason ?? null, refund_method: sale.payment_method,
              })),
          ]);
        }

        if (path === "rpc/pos_item_movement") {
          const by: Record<string, { item: string; dept: string; qty: number; unit: string;
                                     lines: number; sales: number; vat: number; cost: number }> = {};
          for (const { line } of lines) {
            const prod = fakeProduct(line.product_id);
            const k = line.sku ?? line.name;
            const it = (by[k] ??= { item: line.name, dept: prod?.category_name ?? "—",
              qty: 0, unit: line.unit_code, lines: 0, sales: 0, vat: 0, cost: 0 });
            it.qty += line.qty; it.lines++;
            it.sales = r2(it.sales + line.line_total);
            it.vat = r2(it.vat + line.tax_amount);
            it.cost = r2(it.cost + 50 * line.qty);
          }
          return json(Object.entries(by).map(([sku, it]) => ({
            sku, item: it.item, department: it.dept, qty: it.qty, unit: it.unit,
            lines: it.lines, sales: it.sales, net: r2(it.sales - it.vat),
            cost: it.cost, uncosted_lines: 0, margin: r2(it.sales - it.vat - it.cost),
            on_hand: PRODUCTS.find((p) => p.sku === sku)?.stock_qty ?? null,
          })).sort((a, b) => b.sales - a.sales));
        }

        if (path === "rpc/pos_stock_value") {
          // Tracked lines only, as the server does: a service has no shelf.
          const tracked = PRODUCTS.filter((p) => p.stock_qty != null);
          const by: Record<string, { lines: number; units: number; cost: number; retail: number }> = {};
          for (const p of tracked) {
            const d = (by[p.category_name ?? "—"] ??= { lines: 0, units: 0, cost: 0, retail: 0 });
            d.lines++; d.units += p.stock_qty!;
            d.cost = r2(d.cost + 50 * p.stock_qty!);
            d.retail = r2(d.retail + p.price_retail * p.stock_qty!);
          }
          return json({
            departments: Object.entries(by).map(([department, d]) => ({
              department, lines: d.lines, units: d.units, at_cost: d.cost,
              at_retail: d.retail, uncosted_lines: 0, negative_lines: 0,
            })).sort((a, b) => b.at_cost - a.at_cost),
            totals: {
              at_cost: r2(tracked.reduce((t, p) => t + 50 * p.stock_qty!, 0)),
              at_retail: r2(tracked.reduce((t, p) => t + p.price_retail * p.stock_qty!, 0)),
              units: tracked.reduce((t, p) => t + p.stock_qty!, 0),
              lines: tracked.length, uncosted_lines: 0,
              negative_lines: tracked.filter((p) => p.stock_qty! < 0).length,
            },
          });
        }

        if (path === "rpc/pos_margin_slipped") {
          const below = Number(body.p_below ?? 15);
          // Cost is the catalogue fake's 50 throughout; retail less VAT is
          // what it is measured against, as the server measures it.
          return json(PRODUCTS.filter((p) => p.price_retail > 0)
            .map((p) => {
              const net = r2(p.price_retail / 1.15);
              return { sku: p.sku, item: p.name, department: p.category_name ?? "—",
                cost: 50, retail: p.price_retail, on_hand: p.stock_qty,
                net_retail: net, margin: r2(net - 50),
                margin_percent: Math.round(((net - 50) / net) * 1000) / 10,
                below_cost: net < 50 };
            })
            .filter((r) => (r.margin_percent ?? 0) < below)
            .sort((a, b) => (a.margin_percent ?? 0) - (b.margin_percent ?? 0)));
        }

        if (path === "rpc/pos_debtors_ageing") {
          const rows = be.customers
            .map((c) => ({ c, due: be.balance(c.id) }))
            .filter(({ due }) => due > 0)
            .map(({ c, due }) => ({
              customer_id: c.id, customer: c.name, code: c.code, phone: c.phone,
              current_due: due, days30: 0, days60: 0, days90: 0, total_due: due,
              oldest_unpaid: null, credit_limit: c.credit_limit,
            }));
          return json({
            rows,
            totals: {
              current: r2(rows.reduce((t, r) => t + r.current_due, 0)),
              days30: 0, days60: 0, days90: 0,
              total: r2(rows.reduce((t, r) => t + r.total_due, 0)),
              accounts: rows.length,
            },
          });
        }

        if (path === "rpc/pos_purchases_by_supplier") {
          const by: Record<string, { docs: number; received: number; total: number; quoted: number }> = {};
          for (const d of be.supplierDocs) {
            const name = be.suppliers.find((x) => x.id === d.supplier_id)?.name ?? "—";
            const g = (by[name] ??= { docs: 0, received: 0, total: 0, quoted: 0 });
            g.docs++;
            if (d.status === "received") g.received++;
            if (d.kind === "quote") g.quoted = r2(g.quoted + (d.total ?? 0));
            else g.total = r2(g.total + (d.total ?? 0));
          }
          return json(Object.entries(by).map(([supplier, g]) => ({
            supplier, documents: g.docs, received: g.received,
            total: g.total, quoted: g.quoted, last_document: null,
          })).sort((a, b) => b.total - a.total));
        }

        // Export
        return json(lines.map(({ sale, line }, n) => ({
          doc_number: "INV-" + String(be.sales.indexOf(sale) + 1).padStart(6, "0"),
          created_at: sale.created_at ?? new Date().toISOString(),
          status: "completed",
          cashier: Object.values(USERS).find((u) => u.row.id === sale.cashier_id)?.row.name ?? "",
          customer: be.customers.find((c) => c.id === sale.customer_id)?.name ?? null,
          payment_method: sale.payment_method,
          sku: line.sku, item: line.name,
          department: fakeProduct(line.product_id)?.category_name ?? null,
          qty: line.qty, unit: line.unit_code, unit_price: line.unit_price,
          line_total: line.line_total, vat: line.tax_amount, discount: line.discount_amount,
          cost_at_sale: 50, _n: n,
        })));
      }

      case "rpc/pos_cash_session_suggested_float": {
        if (!tokenOk) return fail("Register not paired or revoked");
        if (body.p_pin !== USERS.manager.pin) return fail("Invalid PIN");
        const last = be.closedSessions[0] as { float_kept?: number | null } | undefined;
        return json(last?.float_kept ?? null);
      }

      case "rpc/pos_cash_sessions":
        if (!tokenOk) return fail("Register not paired or revoked");
        if (body.p_pin !== USERS.manager.pin) return fail("Invalid PIN");
        return json(be.closedSessions);

      case "rpc/pos_sales_history": {
        if (!tokenOk) return fail("Register not paired or revoked");
        if (body.p_pin !== USERS.manager.pin) return fail("Invalid PIN");
        const from = Date.parse(String(body.p_from));
        const to = Date.parse(String(body.p_to));
        // End-exclusive, as the server does it, so a sale at 23:59:59 lands on
        // the day it was rung up rather than in a gap between two windows.
        const inWindow = be.sales.filter((x) => {
          const at = Date.parse(x.created_at ?? new Date().toISOString());
          return at >= from && at < to;
        });
        const round2 = (n: number) => Math.round(n * 100) / 100;
        // A sale parked for approval is not takings and has no invoice number
        // yet. The fake hardcoded "completed" on every row, so no test could
        // ever see one — which is how a Sales screen with no way to release a
        // parked sale went unnoticed.
        const parked = (x: RecordedSale) =>
          x.discount_amount > 0 && !x.approved_by && !x.within_limit;
        const done = inWindow.filter((x) => !parked(x) && !x.voided);
        const tenders: Record<string, number> = {};
        for (const sale of done) {
          for (const p of sale.payments) {
            tenders[p.method] = round2((tenders[p.method] ?? 0) + p.amount);
          }
        }
        const gross = round2(done.reduce((t, x) => t + x.total, 0));
        return json({
          rows: inWindow.map((x, i) => {
            const docNumber = parked(x) ? null : "INV-" + String(i + 1).padStart(6, "0");
            return {
            id: "s" + i,
            doc_number: docNumber,
            created_at: x.created_at ?? new Date().toISOString(),
            cashier_name: "Sam",
            customer_name: null,
            customer_phone: null,
            customer_address: null,
            trade_pricing: false,
            subtotal: round2(x.total + x.discount_amount),
            // Was hardcoded null here too, so no test could see a sale-level
            // reason come back out of the history the way the Sales screen
            // reads it.
            discount_reason: x.discount_reason,
            paid_cash: null,
            paid_card: null,
            total: x.total,
            tax_amount: round2(x.total - x.total / 1.15),
            discount_amount: x.discount_amount,
            status: x.voided ? "voided" : parked(x) ? "pending_approval" : "completed",
            payment_method: x.payment_method,
            amount_tendered: x.amount_tendered,
            change_due: x.change_due,
            rounding: x.rounding,
            po_number: x.po_number,
            customer_vat_number: x.customer_vat_number,
            approved_by_name: x.approved_by ? "Manager" : null,
            // Released by a code rather than a PIN — the codes point at the
            // invoice they spent themselves on, as approval_codes does.
            approved_by_code:
              docNumber != null &&
              be.approvalCodes.some((c) => c.doc_number === docNumber),
            item_count: x.items.length,
          };
          }),
          totals: {
            count: done.length,
            gross,
            vat: round2(gross - gross / 1.15),
            discount: round2(done.reduce((t, x) => t + x.discount_amount, 0)),
            voided: 0,
            tenders,
          },
        });
      }

      case "rpc/pos_issue_approval_code": {
        if (!tokenOk) return fail("Register not paired or revoked");
        if (body.p_pin !== USERS.manager.pin) return fail("Invalid PIN");
        const minutes = Number(body.p_minutes ?? 10);
        const expires = new Date(Date.now() + minutes * 60_000).toISOString();
        // Fixed digits: a test that cannot read the code back cannot assert on
        // anything it does. The server draws them at random.
        const made = String(100000 + be.approvalCodes.length);
        be.approvalCodes.unshift({
          id: "ac" + (be.approvalCodes.length + 1),
          code: made,
          issued_by: USERS.manager.row.id,
          issued_by_name: USERS.manager.row.name,
          max_amount: body.p_max_amount == null ? null : Number(body.p_max_amount),
          reason: (body.p_reason as string) ?? null,
          expires_at: expires,
          used_at: null,
          used_by_name: null,
          doc_number: null,
        });
        return json([{ code: made, expires_at: expires }]);
      }

      case "rpc/pos_check_approval_code": {
        if (!tokenOk) return fail("Register not paired or revoked");
        const hit = be.approvalCodes.find(
          (c) =>
            c.code === body.p_code &&
            !c.used_at &&
            Date.parse(c.expires_at) > Date.now()
        );
        return json([
          hit
            ? {
                ok: true,
                issued_by_name: hit.issued_by_name,
                max_amount: hit.max_amount,
                expires_at: hit.expires_at,
              }
            : { ok: false, issued_by_name: null, max_amount: null, expires_at: null },
        ]);
      }

      case "rpc/pos_approval_codes": {
        if (!tokenOk) return fail("Register not paired or revoked");
        if (body.p_pin !== USERS.manager.pin) return fail("Invalid PIN");
        return json(be.approvalCodes.map((c) => ({ ...c, created_at: c.expires_at })));
      }

      case "rpc/pos_approve_sale": {
        if (!tokenOk) return fail("Register not paired or revoked");
        // Whoever is standing here, not whoever opened the back office.
        if (body.p_pin !== USERS.manager.pin) return fail("Invalid PIN");
        const idx = Number(String(body.p_sale_id ?? "").replace("s", ""));
        const sale = be.sales[idx];
        if (!sale) return fail("Sale not found");
        sale.approved_by = USERS.manager.row.id;
        return json({ id: body.p_sale_id, status: "completed" });
      }

      case "rpc/pos_sale_items": {
        if (!tokenOk) return fail("Register not paired or revoked");
        // Served from the same helper the return handlers price with, so a
        // reprint and a refund can never disagree about a line.
        return json(fakeSaleLines(be, String(body.p_sale_id ?? "")));
      }

      case "rpc/pos_sale_payments": {
        if (!tokenOk) return fail("Register not paired or revoked");
        const idx = Number(String(body.p_sale_id ?? "").replace("s", ""));
        return json(be.sales[idx]?.payments ?? []);
      }

      case "rpc/pos_sale_returns": {
        if (!tokenOk) return fail("Register not paired or revoked");
        if (body.p_pin !== USERS.manager.pin) return fail("Invalid PIN");
        const saleId = String(body.p_sale_id ?? "");
        return json(
          be.returns
            .filter((r) => r.sale_id === saleId)
            .flatMap((r) =>
              r.items.map((i) => ({
                id: r.id, doc_number: r.doc_number, reason: r.reason,
                refund_method: r.refund_method, total: r.total,
                tax_total: r.tax_total, by_name: r.by_name,
                created_at: r.created_at,
                sale_item_id: i.sale_item_id, item_name: i.name,
                item_qty: i.qty, item_line_total: i.line_total,
                item_restock: i.restock,
              }))
            )
        );
      }

      case "rpc/pos_return_sale": {
        if (!tokenOk) return fail("Register not paired or revoked");
        const u = Object.values(USERS).find((x) => x.pin === body.p_pin);
        if (!u) return fail("Invalid PIN");
        if (!u.row.permissions.includes("void_refund")) {
          return fail("Not permitted: void_refund");
        }
        const saleId = String(body.p_sale_id ?? "");
        const idx = Number(saleId.replace("s", ""));
        const sale = be.sales[idx];
        if (!sale) return fail("Sale not found");
        const parked = sale.discount_amount > 0 && !sale.approved_by && !sale.within_limit;
        if (parked) return fail("Only a completed sale can take a return");
        if (String(body.p_reason ?? "").trim() === "") {
          return fail("A reason is required — it goes on the credit note");
        }
        const items = (body.p_items ?? []) as {
          sale_item_id: string; qty: number; restock?: boolean;
        }[];
        if (!items.length) return fail("Nothing to return");

        // How the money goes back is decided by how it came in.
        let method = "cash";
        if (sale.payment_method === "account") {
          method = "account";
        } else if (!be.cashSession) {
          return fail(
            "A cash refund needs the till session open — money cannot leave a drawer nobody is counting"
          );
        }

        const lines = fakeSaleLines(be, saleId);
        const returnedQty = (lineId: string) =>
          be.returns
            .filter((r) => r.sale_id === saleId)
            .flatMap((r) => r.items)
            .filter((i) => i.sale_item_id === lineId)
            .reduce((t, i) => t + i.qty, 0);
        const returnedTotal = (lineId: string) =>
          be.returns
            .filter((r) => r.sale_id === saleId)
            .flatMap((r) => r.items)
            .filter((i) => i.sale_item_id === lineId)
            .reduce((t, i) => t + i.line_total, 0);

        const seen = new Set<string>();
        let total = 0;
        let tax = 0;
        const outItems: (typeof be.returns)[number]["items"] = [];
        for (const it of items) {
          const line = lines.find((l) => l.id === it.sale_item_id);
          if (!line) return fail("That line is not on this sale");
          if (seen.has(line.id)) return fail(`${line.name} appears twice on this return`);
          seen.add(line.id);
          const qty = Number(it.qty);
          if (!(qty > 0)) return fail("A returned quantity must be more than nothing");
          if (!line.allows_fraction && qty !== Math.trunc(qty)) {
            return fail(`${line.name} is sold whole and comes back whole`);
          }
          const prev = returnedQty(line.id);
          if (qty > line.qty - prev) {
            return fail(
              `Only ${line.qty - prev} of ${line.qty} ${line.unit_code} left to return on ${line.name}`
            );
          }
          // The server's cents rule: the last of a line refunds exactly what
          // remains un-refunded, however earlier partials rounded.
          const refund =
            qty === line.qty - prev
              ? Math.round((line.line_total - returnedTotal(line.id)) * 100) / 100
              : Math.round((line.line_total * qty) / line.qty * 100) / 100;
          const lineTax = Math.round((refund - refund / 1.15) * 100) / 100;
          total = Math.round((total + refund) * 100) / 100;
          tax = Math.round((tax + lineTax) * 100) / 100;
          outItems.push({
            sale_item_id: line.id, product_id: line.product_id,
            name: line.name, qty, line_total: refund,
            restock: it.restock ?? true,
          });
          if (it.restock ?? true) {
            const prod = PRODUCTS.find((exists) => exists.id === line.product_id);
            if (prod && prod.stock_qty != null) prod.stock_qty += qty;
          }
        }
        if (!(total > 0)) return fail("This return refunds nothing");

        const row = {
          id: "r" + (be.returns.length + 1),
          sale_id: saleId,
          doc_number: "CRN-" + String(be.returns.length + 1).padStart(6, "0"),
          reason: String(body.p_reason).trim(),
          refund_method: method,
          total, tax_total: tax,
          by_name: u.row.name,
          created_at: new Date().toISOString(),
          items: outItems,
        };
        be.returns.push(row);

        // Cash leaves the drawer through the same door as every other
        // pay-out, so cash-up already counts it.
        if (method === "cash") {
          be.cashMovements.push({
            id: "m" + (be.cashMovements.length + 1),
            kind: "pay_out", amount: total,
            reason: `Refund ${row.doc_number}`,
            by_name: u.row.name, created_at: row.created_at,
          });
        }

        return json([{
          return_id: row.id, doc_number: row.doc_number,
          refund_method: row.refund_method, total: row.total,
          tax_total: row.tax_total,
        }]);
      }

      case "rpc/pos_staff_for_login":
        if (!tokenOk) return fail("Register not paired or revoked");
        // Only people who can actually sign in: active, with a PIN set.
        return json(
          be.staff
            .filter((u) => u.active && u.status === "active")
            .map((u) => ({ id: u.id, name: u.name, role: u.role }))
            .sort((a, b) => a.name.localeCompare(b.name))
        );

      case "rpc/pos_admin_list_users":
        if (!tokenOk) return fail("Register not paired or revoked");
        if (body.p_pin !== USERS.manager.pin) return fail("Invalid PIN");
        return json(be.staff.map((s) => ({ ...s })));

      case "rpc/pos_admin_invite_user": {
        if (!tokenOk) return fail("Register not paired or revoked");
        if (body.p_pin !== USERS.manager.pin) return fail("Invalid PIN");
        // Normalised exactly as pos_admin_invite_user does it: a local ZA or
        // Lesotho number is stored in E.164, because that is what the enrolment
        // lookup matches on and a mismatch there fails silently by design.
        let phone = String(body.p_phone ?? "").replace(/[\s()-]/g, "");
        if (/^0\d{9}$/.test(phone)) phone = "+27" + phone.slice(1);
        else if (/^[5-6]\d{7}$/.test(phone)) phone = "+266" + phone;
        if (!/^\+\d{9,15}$/.test(phone)) {
          return fail("Phone must be a valid number, e.g. 082 123 4567 or +266 5800 0000");
        }
        if (be.staff.some((s) => s.phone === phone)) {
          return fail("That phone number is already registered");
        }
        const row = {
          id: "u" + (be.staff.length + 1),
          name: String(body.p_name),
          phone,
          role: String(body.p_role ?? "employee"),
          // Invited, with no PIN of their own yet — which is the whole point:
          // nobody is handed a credential they did not choose.
          status: "invited",
          active: true,
          permissions: (body.p_permissions as string[]) ?? [],
          discount_limit_percent: null,
          discount_limit_amount: null,
          last_code_error: null,
        };
        be.staff.push(row);
        return json([row]);
      }

      case "rpc/pos_admin_update_user": {
        if (!tokenOk) return fail("Register not paired or revoked");
        if (body.p_pin !== USERS.manager.pin) return fail("Invalid PIN");
        const row = be.staff.find((s) => s.id === body.p_user_id);
        if (!row) return fail("No such staff member");
        // Mirrors the migration's guard: the manager holding the PIN cannot
        // shut themselves out mid-shift.
        if (row.id === USERS.manager.row.id && body.p_active === false) {
          return fail("You cannot change your own role or sign yourself out");
        }
        if (body.p_name != null) row.name = String(body.p_name);
        if (body.p_role != null) row.role = String(body.p_role);
        if (body.p_permissions != null) row.permissions = body.p_permissions as string[];
        if (body.p_active != null) {
          row.active = body.p_active as boolean;
          row.status = row.active ? (row.status === "invited" ? "invited" : "active") : "disabled";
        }
        // Zero clears; null leaves alone. There is no such thing as a zero
        // limit, so zero is free to mean "take it away".
        if (body.p_discount_limit_percent != null) {
          const n = Number(body.p_discount_limit_percent);
          if (n < 0 || n > 100) {
            return fail("A discount limit is a percentage between 0 and 100");
          }
          row.discount_limit_percent = n === 0 ? null : n;
        }
        if (body.p_discount_limit_amount != null) {
          const n = Number(body.p_discount_limit_amount);
          row.discount_limit_amount = n === 0 ? null : n;
        }
        return json([{ ...row }]);
      }

      case "rpc/pos_admin_delete_user": {
        if (!tokenOk) return fail("Register not paired or revoked");
        if (body.p_pin !== USERS.manager.pin) return fail("Invalid PIN");
        const i = be.staff.findIndex((s) => s.id === body.p_user_id);
        if (i < 0) return fail("No such staff member");
        // Anyone whose name is on an invoice is disabled, not deleted.
        if (be.sales.some((s) => s.cashier_id === be.staff[i].id)) {
          be.staff[i].active = false;
          be.staff[i].status = "disabled";
          return json("disabled");
        }
        be.staff.splice(i, 1);
        return json("deleted");
      }

      case "rpc/pos_categories":
        if (!tokenOk) return fail("Register not paired or revoked");
        return json([{ id: "c1", name: "Building", sort_order: 10 }]);
      case "rpc/pos_catalogue":
        if (!tokenOk) return fail("Register not paired or revoked");
        return json(PRODUCTS);
      case "units_of_measure":
        return json([
          { code: "ea", name: "Each", allows_fraction: false, sort_order: 10 },
          { code: "m", name: "Metre", allows_fraction: true, sort_order: 20 },
          { code: "kg", name: "Kilogram", allows_fraction: true, sort_order: 50 },
          { code: "bag", name: "Bag", allows_fraction: false, sort_order: 80 },
        ]);
      default:
        return json([]);
    }
  });

  return be;
}

/** Pair the till and sign in, which every till test needs first. */
export async function pairAndSignIn(page: Page, pin = USERS.employee.pin) {
  await page.goto("/");
  await page.locator('input[type=tel]').fill(USERS.manager.phone);
  await page.locator('input[type=password]').fill(USERS.manager.pin);
  await page.getByRole("button", { name: /Pair this till/i }).click();
  // Sign-in names who is on the till before it offers a PIN pad, so the person
  // is chosen first and the keys only exist afterwards.
  const person = Object.values(USERS).find((u) => u.pin === pin)!;
  await page.getByRole("button", { name: new RegExp(`^${person.row.name}\\b`) }).click();
  await page.waitForSelector('button:text-is("1")');
  for (const d of pin.split("")) await page.locator(`button:text-is("${d}")`).first().click();
  await page.waitForSelector('input[placeholder*="Scan barcode"]');
}

/**
 * The supplier a letterhead belongs to, as 0056 matches it: VAT number first
 * and digits only, then the name, case and spacing aside.
 */
function matchSupplier(be: Backend, vat: unknown, name: unknown) {
  const digits = String(vat ?? "").replace(/\D/g, "");
  if (digits) {
    const byVat = be.suppliers.find(
      (s) => (s.vat_number ?? "").replace(/\D/g, "") === digits
    );
    if (byVat) return byVat;
  }
  const n = String(name ?? "").trim().toLowerCase();
  if (n) return be.suppliers.find((s) => s.name.trim().toLowerCase() === n);
  return undefined;
}
