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
  items: { product_id: string; qty: number }[];
  payment_method: string;
  discount_amount: number;
  approved_by: string | null;
  created_at: string | null;
  total: number;
  /** Every tender the client sent, so a test can assert on the settlement. */
  payments: { method: string; amount: number }[];
  po_number: string | null;
  customer_vat_number: string | null;
  rounding: number;
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

/** Everything the fake server saw, so tests can assert on it. */
export class Backend {
  sales: RecordedSale[] = [];
  calls: string[] = [];
  customers: FakeCustomer[] = [];
  /** When set, every request fails as though the connection dropped. */
  offline = false;
  private seq = 0;

  reset() {
    this.sales = [];
    this.calls = [];
    this.customers = [];
    this.offline = false;
    this.seq = 0;
  }

  /** Sales actually stored, i.e. after idempotent replays collapse. */
  get storedSales() {
    return this.sales;
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

    const items = (body.p_items as { product_id: string; qty: number }[]) ?? [];
    let subtotal = 0;
    for (const it of items) {
      const p = PRODUCTS.find((x) => x.id === it.product_id);
      if (!p) throw new Error("Product not available");
      if (!p.allows_fraction && it.qty !== Math.trunc(it.qty)) {
        throw new Error(`${p.name} is sold per ${p.unit_name} and cannot be split`);
      }
      if (p.stock_qty != null && p.stock_qty < it.qty) {
        throw new Error(`Not enough stock for ${p.name} (${p.stock_qty} ${p.unit_code} on hand)`);
      }
      subtotal += Math.round(this.price(p, false) * it.qty * 100) / 100;
    }
    const discount = (body.p_discount_amount as number) ?? 0;
    const total = Math.round((subtotal - discount) * 100) / 100;

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
    const paid = payments.reduce((s, x) => s + x.amount, 0);
    if (payments.length > 0 && Math.abs(paid - (total + rounding)) > 0.005) {
      throw new Error(
        `Payments of ${paid.toFixed(2)} do not settle ${total.toFixed(2)}`
      );
    }

    const sale: RecordedSale = {
      client_ref: ref,
      cashier_id: body.p_cashier_id as string,
      items,
      payment_method: (body.p_payment_method as string) ?? "cash",
      discount_amount: discount,
      approved_by: (body.p_approved_by as string) ?? null,
      created_at: (body.p_created_at as string) ?? null,
      total,
      payments,
      po_number: (body.p_po_number as string) ?? null,
      customer_vat_number: (body.p_customer_vat_number as string) ?? null,
      rounding,
    };
    this.sales.push(sale);
    return this.saleRow(sale, true);
  }

  private saleRow(sale: RecordedSale, fresh: boolean) {
    if (fresh) this.seq += 1;
    const pending = sale.discount_amount > 0 && !sale.approved_by;
    return {
      id: "s" + this.seq,
      doc_number: pending ? null : "INV-" + String(this.seq).padStart(6, "0"),
      cashier_id: sale.cashier_id,
      cashier_name: "Sam",
      customer_id: null,
      customer_name: null,
      trade_pricing: false,
      subtotal: sale.total + sale.discount_amount,
      discount_amount: sale.discount_amount,
      discount_reason: null,
      tax_amount: Math.round((sale.total - sale.total / 1.15) * 100) / 100,
      total: sale.total,
      status: pending ? "pending_approval" : "completed",
      approved_by: sale.approved_by,
      approved_by_name: sale.approved_by ? "Manager" : null,
      payment_method: sale.payment_method,
      amount_tendered: null,
      change_due: null,
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
        const hit = Object.values(USERS).find((u) => u.pin === body.p_pin);
        return json(hit ? [hit.row] : []);
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
      case "rpc/pos_org_settings":
        if (!tokenOk) return fail("Register not paired or revoked");
        return json([{
          shop_name: "Ladybrand Hardware",
          address_line1: "12 Church St",
          address_line2: "Ladybrand, Free State",
          phone: "051 924 0000",
          vat_number: "4001234567",
          currency: "R",
          registration_number: "",
        }]);
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
  await page.waitForSelector('button:text-is("1")');
  for (const d of pin.split("")) await page.locator(`button:text-is("${d}")`).first().click();
  const ok = page.locator('button:text-is("OK")');
  if (await ok.count()) await ok.first().click();
  await page.waitForSelector('input[placeholder*="Scan barcode"]');
}
