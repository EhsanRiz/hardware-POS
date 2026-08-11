/**
 * Demo mode: the till running against an in-page backend.
 *
 * Built for one purpose — letting someone try the counter without a Supabase
 * project, credentials or a connection. It installs a `fetch` interceptor that
 * answers the same endpoints the real backend does, holding everything in
 * memory for the session.
 *
 * This is compiled in ONLY when VITE_DEMO=1 (see main.tsx), so it is absent
 * from a production bundle. Nothing here is a shortcut taken by the real app:
 * every rule enforced below — fractional quantities, stock limits, idempotent
 * replays — is enforced again in Postgres, because a demo that is more
 * permissive than the product teaches the wrong thing.
 */

interface DemoProduct {
  id: string;
  sku: string;
  barcode: string | null;
  name: string;
  category_id: string;
  category_name: string;
  unit_code: string;
  unit_name: string;
  allows_fraction: boolean;
  price_retail: number;
  price_trade: number | null;
  tax_code: string;
  stock_qty: number | null;
  reorder_level: number | null;
  image_url: null;
  sort_order: number;
  bin: string | null;
}

function p(
  id: string, sku: string, barcode: string | null, name: string,
  cat: string, unit: string, unitName: string, frac: boolean,
  retail: number, trade: number | null, stock: number | null, reorder: number | null
): DemoProduct {
  return {
    id, sku, barcode, name,
    category_id: cat, category_name: cat === "c1" ? "Building" : cat === "c2" ? "Fasteners" : "Plumbing",
    unit_code: unit, unit_name: unitName, allows_fraction: frac,
    price_retail: retail, price_trade: trade, tax_code: "standard",
    stock_qty: stock, reorder_level: reorder, image_url: null, sort_order: 0,
    // A believable shelf location, so the demo shows what the till shows.
    bin: cat === "c1" ? "A" + ((id.charCodeAt(1) % 4) + 1)
       : cat === "c2" ? "F" + ((id.charCodeAt(1) % 3) + 1)
       : "P" + ((id.charCodeAt(1) % 2) + 1),
  };
}

const PRODUCTS: DemoProduct[] = [
  p("d1", "CEM-425-50", "6001240000015", "Cement, 42.5N — 50 kg bag", "c1", "bag", "Bag", false, 120.9, 112, 148, 40),
  p("d2", "REB-Y12", null, "Rebar Y12 — 6 m length", "c1", "m", "Metre", true, 94.7, 86, 220, 40),
  p("d3", "WIR-GAL-20", null, "Galvanised wire, 2.0 mm — loose", "c1", "kg", "Kilogram", true, 31.05, 28, 96, 20),
  p("d4", "SIK-11FC", "6008803000101", "Sikaflex 11FC — 300 ml", "c1", "ea", "Each", false, 119, 108, 41, 10),
  p("d5", "NCN-2550", null, "Nail Concrete 2.5 × 50 mm", "c2", "kg", "Kilogram", true, 68, 61, 40, 10),
  p("d6", "NWR-2550", null, "Nail Wire Round 2.5 × 50 mm", "c2", "kg", "Kilogram", true, 42, 38, 85, 20),
  p("d7", "CHN-06", null, "Chain 6 mm Galvanised", "c1", "m", "Metre", true, 35, 31.5, 120, 30),
  p("d8", "SND-RIV", null, "River Sand", "c1", "m3", "Cubic metre", true, 420, 385, 18, 4),
  p("d9", "PDL-50", "6001234000060", "Padlock 50 mm Brass", "c2", "ea", "Each", false, 89, 80, 45, 10),
  p("d10", "SCR-440", "6001234000022", "Wood Screw 4 × 40 (100)", "c2", "box", "Box", false, 68, 61, 64, 15),
  p("d11", "PPE-20", "6001234000039", "Poly Pipe 20 mm × 25 m", "c3", "roll", "Roll", false, 289, 262, 22, 5),
  p("d12", "ANC-M10", null, "Anchor Bolt Sleeve M10 × 100 mm", "c2", "ea", "Each", false, 18.5, 16, 200, 50),
  p("d13", "CBL-25-100", null, "Twin & Earth 2.5 mm × 100 m", "c3", "roll", "Roll", false, 1450, 1330, 2, 3),
];

const USERS = [
  { pin: "1234", phone: "+27820000001", id: "u1", name: "Manager", role: "admin",
    permissions: [] as string[] },
  { pin: "5678", phone: "+27820000002", id: "u2", name: "Sam", role: "employee",
    permissions: ["take_payments", "apply_discount"] },
];

// Any local-looking or E.164 number pairs the demo till: the demo teaches the
// FLOW (phone identifies the manager, PIN proves it), not a phone directory.
function phoneLooksValid(raw: string): boolean {
  const t = (raw ?? "").replace(/[\s()-]/g, "");
  return /^0\d{9}$/.test(t) || /^[5-6]\d{7}$/.test(t) || /^\+\d{9,15}$/.test(t);
}

const CUSTOMERS = [
  { id: "k1", code: "TRD-001", name: "Mokoena Building Contractors", phone: "051 924 0000",
    is_trade: true, credit_limit: 25000, balance: 4310.5, available: 20689.5 },
  { id: "k2", code: "TRD-002", name: "Free State Plumbing CC", phone: "051 924 0001",
    is_trade: true, credit_limit: 10000, balance: 9450, available: 550 },
];

const sales: { client_ref: string | null; doc: string; row: unknown }[] = [];
let seq = 0;
let paired = false;

function normalize(t: string): string {
  return (t ?? "").toLowerCase()
    .replace(/(\d),(\d)/g, "$1.$2")
    .replace(/(\d)\s*[x*×]\s*(\d)/g, "$1 x $2")
    .replace(/(\d)(mm|cm|m|kg|g|l|ml)\b/g, "$1 $2")
    .replace(/[^a-z0-9. ]+/g, " ").replace(/\s+/g, " ").trim();
}

function editDistance(a: string, b: string, max: number): number {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let best = i;
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1,
                        prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      best = Math.min(best, cur[j]);
    }
    if (best > max) return max + 1;
    prev = cur;
  }
  return prev[b.length];
}

function search(q: string) {
  const n = normalize(q);
  if (!n) return [];
  const toks = n.split(" ").filter((t) => t && t !== "x");
  const text = (x: DemoProduct) => normalize(`${x.name} ${x.sku} ${x.barcode ?? ""}`);
  let hits = PRODUCTS.filter((x) => toks.every((t) => text(x).includes(t)));
  if (!hits.length) {
    hits = PRODUCTS.filter((x) => {
      const words = text(x).split(" ").filter(Boolean);
      return toks.every((t) => {
        const tol = t.length < 4 ? 1 : 2;
        return words.some((w) => editDistance(t, w, tol) <= tol);
      });
    });
  }
  return hits.map((x) => ({ ...x, score: 1 }));
}

function effective(u: (typeof USERS)[number]): string[] {
  return u.role === "admin"
    ? ["take_payments", "apply_discount", "approve_discount", "void_refund",
       "manage_catalogue", "manage_inventory", "manage_purchasing",
       "manage_customers", "manage_quotes", "view_reports", "view_cost_prices",
       "cash_management", "manage_staff", "manage_settings"]
    : u.permissions;
}

function createSale(b: Record<string, unknown>) {
  const ref = (b.p_client_ref as string) ?? null;
  const existing = ref ? sales.find((s) => s.client_ref === ref) : undefined;
  if (existing) return existing.row; // idempotent replay

  const items = (b.p_items as { product_id: string; qty: number }[]) ?? [];
  const customer = CUSTOMERS.find((c) => c.id === b.p_customer_id);
  const trade = customer?.is_trade ?? false;

  let subtotal = 0;
  for (const it of items) {
    const prod = PRODUCTS.find((x) => x.id === it.product_id);
    if (!prod) throw new Error("Product not available");
    if (!prod.allows_fraction && it.qty !== Math.trunc(it.qty)) {
      throw new Error(`${prod.name} is sold per ${prod.unit_name} and cannot be split`);
    }
    if (prod.stock_qty != null && prod.stock_qty < it.qty) {
      throw new Error(`Not enough stock for ${prod.name} (${prod.stock_qty} ${prod.unit_code} on hand)`);
    }
    const price = trade && prod.price_trade != null ? prod.price_trade : prod.price_retail;
    subtotal += Math.round(price * it.qty * 100) / 100;
  }

  const discount = (b.p_discount_amount as number) ?? 0;
  const total = Math.round((subtotal - discount) * 100) / 100;
  const payments = (b.p_payments as { method: string; amount: number }[]) ?? [];
  const nonCash = payments.filter((x) => x.method !== "cash")
    .reduce((s, x) => s + x.amount, 0);
  const rounding = payments.some((x) => x.method === "cash")
    ? (Math.ceil(Math.round((total - nonCash) * 100) / 10 - 0.5) * 10 -
        Math.round((total - nonCash) * 100)) / 100
    : 0;
  const approver = b.p_approved_by as string | null;
  const pending = discount > 0 && !approver;

  if (b.p_payment_method === "account" && customer && !pending
      && customer.available != null && total > customer.available) {
    throw new Error(`Over credit limit: ${customer.available.toFixed(2)} available`);
  }

  // Stock only moves on a completed sale, as in the real RPC.
  if (!pending) {
    for (const it of items) {
      const prod = PRODUCTS.find((x) => x.id === it.product_id)!;
      if (prod.stock_qty != null) prod.stock_qty = Math.round((prod.stock_qty - it.qty) * 1000) / 1000;
    }
    if (customer && b.p_payment_method === "account") {
      customer.balance = Math.round((customer.balance + total) * 100) / 100;
      if (customer.credit_limit != null) customer.available = Math.round((customer.credit_limit - customer.balance) * 100) / 100;
    }
  }

  if (!pending) seq += 1;
  const tendered = b.p_amount_tendered as number | null;
  const row = {
    id: "s" + (seq || sales.length + 1),
    doc_number: pending ? null : "INV-" + String(seq).padStart(6, "0"),
    cashier_id: b.p_cashier_id,
    cashier_name: USERS.find((u) => u.id === b.p_cashier_id)?.name ?? "Cashier",
    customer_id: customer?.id ?? null,
    customer_name: customer?.name ?? null,
    trade_pricing: trade,
    subtotal, discount_amount: discount, discount_reason: b.p_discount_reason ?? null,
    tax_amount: Math.round((total - total / 1.15) * 100) / 100,
    total,
    status: pending ? "pending_approval" : "completed",
    approved_by: approver, approved_by_name: approver ? "Manager" : null,
    payment_method: b.p_payment_method,
    amount_tendered: tendered,
    change_due: tendered != null ? Math.max(0, Math.round((tendered - total) * 100) / 100) : null,
    paid_cash: b.p_paid_cash ?? null, paid_card: b.p_paid_card ?? null,
    rounding,
    po_number: (b.p_po_number as string) ?? null,
    customer_vat_number: (b.p_customer_vat_number as string) ?? null,
    created_at: (b.p_created_at as string) ?? new Date().toISOString(),
  };
  sales.push({ client_ref: ref, doc: row.doc_number ?? "", row });
  return row;
}

/** Install the in-page backend. Called from main.tsx only when VITE_DEMO=1. */
export function installDemoBackend(): void {
  const real = window.fetch.bind(window);

  window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;

    // Anything not aimed at the backend behaves normally.
    if (!/\/rest\/v1\/|\/auth\/v1\//.test(url)) return real(input as RequestInfo, init);

    const ok = (data: unknown) =>
      new Response(JSON.stringify(data), { status: 200, headers: { "Content-Type": "application/json" } });
    const bad = (message: string) =>
      new Response(JSON.stringify({ message, code: "P0001", details: null, hint: null }),
                   { status: 400, headers: { "Content-Type": "application/json" } });

    if (url.includes("/auth/v1/health")) return ok({});

    let body: Record<string, unknown> = {};
    try { body = JSON.parse((init?.body as string) || "{}"); } catch { /* GET */ }

    const path = url.split("/rest/v1/")[1]?.split("?")[0] ?? "";
    const user = USERS.find((u) => u.pin === body.p_pin);

    // A small delay so the interface behaves like something over a network
    // rather than resolving instantly, which hides loading states.
    await new Promise((r) => setTimeout(r, 90));

    switch (path) {
      case "rpc/pos_pair_register":
        if (!phoneLooksValid(String(body.p_phone ?? "")) || body.p_pin !== "1234") {
          return bad("Invalid phone or PIN");
        }
        paired = true;
        return ok([{ register_id: "demo-reg", token: "demo-token" }]);
      case "rpc/pos_login":
        return ok(user ? [{ id: user.id, name: user.name, role: user.role,
                            phone: user.phone, email: null, permissions: effective(user) }] : []);
      case "rpc/pos_search_products":
        return ok(search(String(body.p_query ?? "")));
      case "rpc/pos_list_customers":
        return ok(CUSTOMERS);
      case "rpc/pos_create_sale":
        try { return ok(createSale(body)); }
        catch (e) { return bad(e instanceof Error ? e.message : "Rejected"); }
      case "rpc/pos_admin_list_products":
        if (!user || user.role !== "admin") return bad("Not permitted: manage_catalogue");
        return ok(PRODUCTS.map((x) => ({ ...x, cost: Math.round(x.price_retail * 0.72 * 100) / 100,
                                         description: null, active: true })));
      case "rpc/pos_sale_payments":
        return ok((body.p_payments as unknown[]) ?? []);
      case "rpc/pos_recent_sales":
        return ok(sales.slice(-20).reverse().map((s) => s.row));
      case "rpc/pos_catalogue":
        return ok(PRODUCTS);
      case "rpc/pos_categories":
        return ok([{ id: "c1", name: "Building", sort_order: 10 },
                   { id: "c2", name: "Fasteners", sort_order: 20 },
                   { id: "c3", name: "Plumbing", sort_order: 30 }]);
      case "units_of_measure":
        return ok([
          { code: "ea", name: "Each", allows_fraction: false, sort_order: 10 },
          { code: "m", name: "Metre", allows_fraction: true, sort_order: 20 },
          { code: "m3", name: "Cubic metre", allows_fraction: true, sort_order: 40 },
          { code: "kg", name: "Kilogram", allows_fraction: true, sort_order: 50 },
          { code: "bag", name: "Bag", allows_fraction: false, sort_order: 80 },
          { code: "box", name: "Box", allows_fraction: false, sort_order: 90 },
          { code: "roll", name: "Roll", allows_fraction: false, sort_order: 110 },
        ]);
      case "rpc/pos_org_settings":
        return ok([{
          shop_name: "Ladybrand Hardware",
          address_line1: "12 Church Street",
          address_line2: "Ladybrand, Free State",
          phone: "051 924 0000",
          vat_number: "4001234567",
          currency: "R",
          registration_number: "",
        }]);
      default:
        return ok([]);
    }
  };

  void paired;
}
