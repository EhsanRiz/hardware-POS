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
  };
}

export const USERS = {
  manager: { pin: "1234", phone: "+27820000001", row: { id: "u1", name: "Manager", role: "admin", phone: "+27820000001", email: null, permissions: ["take_payments","apply_discount","approve_discount","manage_catalogue","manage_inventory","view_cost_prices","manage_settings","void_refund","view_reports"] } },
  employee: { pin: "5678", phone: "+27820000002", row: { id: "u2", name: "Sam", role: "employee", phone: "+27820000002", email: null, permissions: ["take_payments","apply_discount"] } },
};

/** The token pos_pair_register hands out; every token-scoped RPC must carry it. */
export const REGISTER_TOKEN = "test-register-token";

export interface RecordedSale {
  client_ref: string | null;
  cashier_id: string;
  customer_id: string | null;
  items: {
    product_id: string;
    qty: number;
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
}

/** Everything the fake server saw, so tests can assert on it. */
export class Backend {
  sales: RecordedSale[] = [];
  calls: string[] = [];
  customers: FakeCustomer[] = [];
  accountPayments: RecordedAccountPayment[] = [];
  stockMoves: { product_id: string; qty_delta: number; reason: string; note: string | null }[] = [];
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
  ];
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
  };
  quotes: { id: string; doc_number: string; status: string; sale_id: string | null;
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
    const inWindow = this.sales.slice(s.fromIndex);
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
    return {
      sales_count: inWindow.length,
      sales_total: total,
      vat_total: round2(total - total / 1.15),
      discount_total: round2(inWindow.reduce((t, x) => t + x.discount_amount, 0)),
      tenders,
      cash_sales: cashSales,
      account_cash: accountCash,
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
        product_id: string; qty: number;
        discount_amount?: number; discount_percent?: number | null;
        discount_reason?: string | null;
      }[]) ?? [];
    let subtotal = 0;
    let itemsDiscount = 0;
    for (const it of items) {
      const p = PRODUCTS.find((x) => x.id === it.product_id);
      if (!p) throw new Error("Product not available");
      if (!p.allows_fraction && it.qty !== Math.trunc(it.qty)) {
        throw new Error(`${p.name} is sold per ${p.unit_name} and cannot be split`);
      }
      if (p.stock_qty != null && p.stock_qty < it.qty) {
        throw new Error(`Not enough stock for ${p.name} (${p.stock_qty} ${p.unit_code} on hand)`);
      }
      const line = Math.round(this.price(p, false) * it.qty * 100) / 100;
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
      id: "s" + this.seq,
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
      status: pending ? "pending_approval" : "completed",
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
export async function installBackend(page: Page): Promise<Backend> {
  const be = new Backend();

  // PRODUCTS is module state and the catalogue editor now writes to it, so a
  // cap set by one test would still be there for the next one in the same
  // worker. Put it back rather than leaving tests to depend on their order.
  for (const p of PRODUCTS) {
    p.max_discount_percent = null;
    p.max_discount_amount = null;
  }

  // Connectivity probe. offline.ts deliberately does not trust navigator.onLine
  // (it sticks after sleep/wake on tablets) and instead asks whether the server
  // answers. The fake has to model that, or the till never notices the line
  // coming back and nothing ever syncs.
  await page.route("**/auth/v1/health*", async (route: Route) => {
    if (be.offline) return route.abort("internetdisconnected");
    return route.fulfill({ status: 200, contentType: "application/json", body: "{}" });
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
      case "rpc/pos_customer_history":
        if (!tokenOk) return fail("Register not paired or revoked");
        return json([]);
      case "rpc/pos_save_quote": {
        if (!tokenOk) return fail("Register not paired or revoked");
        const items = (body.p_items as { product_id: string; qty: number }[]) ?? [];
        if (!items.length) return fail("An empty quote is not a quote");
        const q = {
          id: "q" + (be.quotes.length + 1),
          doc_number: "QUO-" + String(be.quotes.length + 1).padStart(6, "0"),
          status: "open", sale_id: null as string | null,
          customer_id: (body.p_customer_id as string) ?? null,
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
      case "rpc/pos_list_quotes":
        if (!tokenOk) return fail("Register not paired or revoked");
        return json(be.quotes.filter((q) => q.status === "open").map((q) => ({
          id: q.id, doc_number: q.doc_number, created_at: "2026-01-01T08:00:00Z",
          cashier_name: "Sam", customer_id: q.customer_id, customer_name: null,
          total: q.items.reduce((t, i) => t + i.unit_price * i.qty, 0),
          valid_until: "2099-01-01", expired: false,
          item_count: q.items.length, note: null,
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
        return json(PRODUCTS.map((p) => ({ ...p, cost: 50, description: null, active: true })));
      }
      case "rpc/pos_admin_save_product": {
        if (!tokenOk) return fail("Register not paired or revoked");
        if (body.p_pin !== USERS.manager.pin) return fail("Invalid PIN");
        const p = PRODUCTS.find((x) => x.id === body.p_id);
        if (!p) return fail("Product not found");
        const pct = body.p_max_discount_percent;
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
        const closed = {
          ...be.cashSession,
          closed_at: new Date().toISOString(),
          closed_by_name: "Manager",
          counted_cash: counted,
          expected_cash: figures.expected_cash,
          variance: Math.round((counted - figures.expected_cash) * 100) / 100,
          note: (body.p_note as string) ?? null,
          figures,
          movements: be.cashMovements,
        };
        be.closedSessions.unshift(closed);
        be.cashSession = null;
        return json(closed);
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
        const done = inWindow.filter((x) => !parked(x));
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
            status: parked(x) ? "pending_approval" : "completed",
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
        const idx = Number(String(body.p_sale_id ?? "").replace("s", ""));
        const sale = be.sales[idx];
        if (!sale) return json([]);
        // What each line lost, as the server stores it: line_total is the share
        // after this line's own discount AND its share of the sale-level one, so
        // a reprint adds up to the total that was actually taken.
        const gross = (it: (typeof sale.items)[number]) =>
          Math.round(
            (PRODUCTS.find((p) => p.id === it.product_id)?.price_retail ?? 0) *
              it.qty * 100
          ) / 100;
        const own = (it: (typeof sale.items)[number]) =>
          it.discount_percent != null
            ? Math.round(gross(it) * (it.discount_percent / 100) * 100) / 100
            : Math.round((it.discount_amount ?? 0) * 100) / 100;
        const net = sale.items.reduce((t, it) => t + gross(it) - own(it), 0);
        return json(
          sale.items.map((it) => {
            const prod = PRODUCTS.find((p) => p.id === it.product_id)!;
            return {
              name: prod.name, sku: prod.sku, unit_code: prod.unit_code,
              qty: it.qty, unit_price: prod.price_retail,
              line_total:
                net > 0
                  ? Math.round(((gross(it) - own(it)) * sale.total * 100) / net) / 100
                  : 0,
              tax_amount: 0,
              discount_amount: own(it),
              discount_percent: it.discount_percent ?? null,
              discount_reason: it.discount_reason ?? null,
            };
          })
        );
      }

      case "rpc/pos_sale_payments": {
        if (!tokenOk) return fail("Register not paired or revoked");
        const idx = Number(String(body.p_sale_id ?? "").replace("s", ""));
        return json(be.sales[idx]?.payments ?? []);
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
  const ok = page.locator('button:text-is("OK")');
  if (await ok.count()) await ok.first().click();
  await page.waitForSelector('input[placeholder*="Scan barcode"]');
}
