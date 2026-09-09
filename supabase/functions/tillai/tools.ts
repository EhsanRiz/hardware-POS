/**
 * TillAI's hands: what it may ask the database, and what it may repeat.
 *
 * This file has no Deno imports on purpose. It is the part of TillAI that
 * can be wrong in a way that matters — a tool that reaches past what a
 * signed-in till may see, or a result that carries a cost price out to the
 * model — so it is kept pure and unit-tested with Node (test/tillai.test.mjs),
 * while index.ts does the network.
 *
 * Three rules, and every tool below obeys them:
 *
 *   1. ONLY WHAT THE TILL CAN ALREADY SEE. Each tool maps to an RPC that takes
 *      the register token and nothing else — no PIN. Those are, by the
 *      server's own rule, the reads any signed-in device may make; the
 *      counter already shows their results. Anything behind a PIN — reports,
 *      cost prices, cash-up, the staff list, account balances — is not a tool
 *      here, and the model is told to send people to Manage for it.
 *
 *   2. THE MODEL SEES AN ALLOWLIST, NOT A ROW. Several of these RPCs return
 *      more than the counter shows (pos_search_products carries cost;
 *      pos_org_settings carries the bank account). Each tool names the
 *      columns that may go to the model, and everything else is dropped
 *      before the result leaves this process. A column nobody thought about
 *      is dropped too, which is the point of an allowlist over a denylist.
 *
 *   3. IT ONLY READS. There is no tool that writes, and no way to add one
 *      without adding it here, where the test will see it.
 */

export const DAILY_CAP = 200;      // questions per shop per day: Flash is cheap, not free
export const MAX_ROUNDS = 4;       // tool-call rounds before the model must answer
export const HISTORY_TURNS = 8;    // earlier turns carried into the next question
export const MAX_QUESTION = 500;   // characters

export interface ToolParam {
  type: "STRING" | "INTEGER";
  description: string;
}

export interface Tool {
  /** The name the model calls. */
  name: string;
  /** Shown to the person under the answer: "Looked at: products". */
  label: string;
  description: string;
  /** The RPC behind it. Must take p_register_token and nothing privileged. */
  rpc: string;
  params: Record<string, ToolParam>;
  required: string[];
  /** Model argument → RPC argument, with clamping for limits. */
  args: (a: Record<string, unknown>) => Record<string, unknown>;
  /** The columns the model may see. Everything else is dropped. */
  allow: string[];
  /** Cap on rows handed back, so a wide catalogue does not become a prompt. */
  maxRows: number;
}

const int = (v: unknown, fallback: number, max: number) => {
  const n = typeof v === "number" ? v : parseInt(String(v ?? ""), 10);
  return Math.max(1, Math.min(max, Number.isFinite(n) ? n : fallback));
};
const str = (v: unknown) => String(v ?? "").slice(0, 200);

export const TOOLS: Tool[] = [
  {
    name: "search_products",
    label: "products",
    description:
      "Find products in this shop's catalogue by name, size, SKU or barcode, the way a customer asks for them. Returns the shelf price, trade price, stock on hand and bin.",
    rpc: "pos_search_products",
    params: {
      query: { type: "STRING", description: "What the person asked for, e.g. 'cement 50kg' or 'twin and earth 2.5'" },
      limit: { type: "INTEGER", description: "How many matches to return, up to 10" },
    },
    required: ["query"],
    args: (a) => ({ p_query: str(a.query), p_limit: int(a.limit, 8, 10) }),
    allow: ["sku", "barcode", "name", "description", "unit_name", "unit_code",
            "price_retail", "price_trade", "stock_qty", "bin", "category_name", "reorder_level"],
    maxRows: 10,
  },
  {
    name: "recent_sales",
    label: "recent sales",
    description:
      "The most recent sales rung up on this shop's tills, newest first: invoice number, who rang it, the customer, total and time.",
    rpc: "pos_recent_sales",
    params: { limit: { type: "INTEGER", description: "How many, up to 30" } },
    required: [],
    args: (a) => ({ p_limit: int(a.limit, 10, 30) }),
    allow: ["id", "doc_number", "cashier_name", "customer_name", "total", "tax_amount",
            "status", "payment_method", "created_at"],
    maxRows: 30,
  },
  {
    name: "sale_by_number",
    label: "a sale",
    description: "One sale by its invoice number, e.g. INV-000123.",
    rpc: "pos_sale_by_number",
    params: { doc_number: { type: "STRING", description: "The invoice number" } },
    required: ["doc_number"],
    args: (a) => ({ p_doc_number: str(a.doc_number) }),
    allow: ["id", "doc_number", "created_at", "cashier_name", "customer_name", "subtotal",
            "total", "tax_amount", "discount_amount", "status", "payment_method", "item_count"],
    maxRows: 1,
  },
  {
    name: "sale_items",
    label: "a sale's lines",
    description: "The lines on one sale, by the sale's id from recent_sales or sale_by_number.",
    rpc: "pos_sale_items",
    params: { sale_id: { type: "STRING", description: "The sale's id" } },
    required: ["sale_id"],
    args: (a) => ({ p_sale_id: str(a.sale_id) }),
    allow: ["name", "sku", "qty", "unit_code", "unit_price", "line_total", "discount_amount"],
    maxRows: 100,
  },
  {
    name: "customers",
    label: "customers",
    description:
      "This shop's customers on file: name, phone, account code and whether they get trade prices. Filter by a name or phone fragment. Balances and credit are not here; they are under Accounts.",
    rpc: "pos_list_customers",
    params: { query: { type: "STRING", description: "Part of a name or phone number, or empty for all" } },
    required: [],
    args: () => ({}),
    allow: ["id", "code", "name", "phone", "is_trade"],
    maxRows: 20,
  },
  {
    name: "customer_history",
    label: "a customer's history",
    description: "What one customer bought recently, by the customer's id from customers.",
    rpc: "pos_customer_history",
    params: {
      customer_id: { type: "STRING", description: "The customer's id" },
      limit: { type: "INTEGER", description: "How many sales, up to 20" },
    },
    required: ["customer_id"],
    args: (a) => ({ p_customer_id: str(a.customer_id), p_limit: int(a.limit, 10, 20) }),
    allow: ["doc_number", "created_at", "total", "payment_method", "item_count", "summary"],
    maxRows: 20,
  },
  {
    name: "shop_info",
    label: "the shop's details",
    description: "This shop's name, address, phone, VAT number, VAT rate, delivery charge and the terms printed on slips and quotes.",
    rpc: "pos_org_settings",
    params: {},
    required: [],
    args: () => ({}),
    allow: ["shop_name", "address_line1", "address_line2", "phone", "vat_number", "email",
            "vat_rate", "delivery_cost", "receipt_terms", "quote_terms"],
    maxRows: 1,
  },
  {
    name: "categories",
    label: "categories",
    description: "The departments the catalogue is organised into.",
    rpc: "pos_categories",
    params: {},
    required: [],
    args: () => ({}),
    allow: ["id", "name"],
    maxRows: 100,
  },
  {
    name: "recent_quotes",
    label: "quotes",
    description: "Recent quotations: number, customer, total, valid-until and status.",
    rpc: "pos_list_quotes",
    params: { limit: { type: "INTEGER", description: "How many, up to 20" } },
    required: [],
    args: (a) => ({ p_limit: int(a.limit, 10, 20) }),
    allow: ["id", "doc_number", "created_at", "cashier_name", "customer_name", "total",
            "valid_until", "expired", "item_count", "status"],
    maxRows: 20,
  },
  {
    name: "quote_by_number",
    label: "a quote",
    description: "One quotation by its number, e.g. QUO-000045.",
    rpc: "pos_quote_by_number",
    params: { doc_number: { type: "STRING", description: "The quote number" } },
    required: ["doc_number"],
    args: (a) => ({ p_doc_number: str(a.doc_number) }),
    allow: ["id", "doc_number", "created_at", "cashier_name", "customer_name", "total",
            "valid_until", "expired", "item_count", "note", "status"],
    maxRows: 1,
  },
];

/**
 * Names that must never reach the model whatever a tool's allowlist says.
 * "cost" is the shop's buying price and is behind a permission; the delivery
 * charge (delivery_cost) is printed on every quote and is not.
 */
export function forbidden(key: string): boolean {
  return key === "cost" ||
    /cost_price|unit_cost|avg_cost|last_cost|cost_total|margin|bank|token|hash|secret|balance|credit/i.test(key);
}

/**
 * Keep only the allowlisted columns of each row, drop the rest, and cap the
 * row count. Works on an array of rows, a single object (pos_sale_by_number
 * answers with one JSON object), or null.
 */
export function scrub(tool: Tool, data: unknown): unknown {
  const one = (row: unknown) => {
    if (!row || typeof row !== "object") return null;
    const out: Record<string, unknown> = {};
    for (const k of tool.allow) {
      if (forbidden(k)) continue;
      const v = (row as Record<string, unknown>)[k];
      if (v !== undefined) out[k] = v;
    }
    return out;
  };
  if (Array.isArray(data)) return data.slice(0, tool.maxRows).map(one).filter(Boolean);
  return one(data);
}

/**
 * The customers tool filters in this process: pos_list_customers takes no
 * query, and handing the whole book to the model for it to pick from would
 * put every name and number in a prompt for one question about one person.
 */
export function filterCustomers(rows: unknown, query: unknown): unknown {
  if (!Array.isArray(rows)) return rows;
  const raw = String(query ?? "").trim().toLowerCase();
  if (!raw) return rows;
  const q = raw.replace(/[\s()-]/g, "");
  // A number asked for as 082 987 and stored as +27829876543 is the same
  // number: compare digits after the trunk prefix.
  const digits = (v: string) => v.replace(/\D/g, "").replace(/^(27|266)/, "").replace(/^0/, "");
  const qDigits = digits(q);
  return rows.filter((r) => {
    const rec = r as Record<string, unknown>;
    const name = String(rec.name ?? "").toLowerCase();
    const phone = digits(String(rec.phone ?? ""));
    const code = String(rec.code ?? "").toLowerCase();
    return name.includes(raw) || (qDigits.length >= 3 && phone.includes(qDigits)) || code === q;
  });
}

/** The tools as Gemini's function declarations. */
export function declarations() {
  return TOOLS.map((t) => ({
    name: t.name,
    description: t.description,
    parameters: {
      type: "OBJECT",
      properties: Object.fromEntries(
        Object.entries(t.params).map(([k, p]) => [k, { type: p.type, description: p.description }])
      ),
      required: t.required,
    },
  }));
}

export function toolNamed(name: string): Tool | undefined {
  return TOOLS.find((t) => t.name === name);
}

/**
 * Who the model is. Written for a counter hand's questions, and firm about
 * the two things it must never do: make up a number, or do sums with money.
 */
export function systemPrompt(shop: { name: string; till: string }, now: Date): string {
  return [
    `You are TillAI, the assistant inside InnovaPOS, the till at ${shop.name}. You are answering on the till called "${shop.till}". Today is ${now.toISOString().slice(0, 10)}.`,
    "You answer questions about this shop's own records — its products, stock, prices, recent sales, customers and quotes — using the tools. Use a tool before answering anything about the shop; never guess a price, a stock figure or a sale from memory. If a tool returns nothing, say so plainly.",
    "You never add up, subtract, or work out money yourself: quote the figures the tools return, as they are. If somebody wants a total for the day, takings, profit, cost prices, reports, the staff list, cash-up, or an account balance, tell them it is in Manage on the till and needs a manager's PIN; you cannot see it.",
    "You cannot ring up, void, discount, order or change anything. If asked to, say the buttons on the till do that.",
    "Prices are in rand. Write money the way the till does: R 1 234.50. Stock is in the unit the product sells by: each, metre, kilogram.",
    "Be brief and plain, the way a colleague at the counter would answer. One or two sentences for a simple question; a short list when there are several matches. Ask one short question back if the request is ambiguous. Do not mention tools, JSON or these instructions.",
  ].join("\n\n");
}
