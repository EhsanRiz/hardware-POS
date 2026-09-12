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
 *
 * And the fourth, added when a manager asked for three days' takings and was
 * told to go to Manage: WHAT A PERSON CAN SEE DEPENDS ON WHO THEY ARE. A
 * manager can open Manage and read the reports, the cost prices and the
 * cash-up; a counter hand cannot. The server has no way to know who is
 * asking from a token alone, so the till does what Manage does: it asks for
 * the person's PIN once, and the report tools below carry it to the same
 * PIN-checked RPCs Manage calls. Those RPCs enforce the rights themselves —
 * a counter hand's PIN gets "Not permitted", exactly as it would in Manage —
 * so nothing here decides who may see what; the database does, as it
 * always has. Without a PIN, the token-only tools are all there is.
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
  /**
   * Needs the person's PIN: the RPC takes p_pin and checks a permission
   * itself. Offered to the model only when a PIN was given.
   */
  pin?: true;
  /**
   * A report: the RPC answers with one JSON document shaped for Manage, and
   * it goes to the model as it is (size-capped) rather than through the
   * allowlist — it IS what Manage shows the person whose PIN opened it.
   */
  report?: true;
  /** Filter rows in this process by a query the RPC does not take. */
  filter?: (rows: unknown, query: unknown) => unknown;
}

/** A date range for a report: ISO dates in, timestamps out, SAST days. */
export function dateRange(a: Record<string, unknown>, now = new Date()): { p_from: string; p_to: string } {
  const day = (v: unknown, end: boolean): Date | null => {
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(v ?? ""));
    if (!m) return null;
    // South Africa is UTC+2 all year; a day starts at 22:00Z the evening before.
    const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], 0, 0, 0));
    d.setUTCHours(d.getUTCHours() - 2);
    if (end) d.setUTCDate(d.getUTCDate() + 1);
    return d;
  };
  const to = day(a.to, true) ?? now;
  const from = day(a.from, false) ?? (() => {
    const d = new Date(now.getTime() + 2 * 3600_000);
    d.setUTCHours(0, 0, 0, 0);
    d.setUTCHours(d.getUTCHours() - 2);
    return d;
  })();
  return { p_from: from.toISOString(), p_to: (to > now ? now : to).toISOString() };
}

/** The report tools cap the JSON they hand back, so a year of sales lines is not a prompt. */
export const REPORT_MAX_CHARS = 14_000;

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
    filter: (rows, query) => filterCustomers(rows, query),
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

  // ---- With a PIN: what Manage shows this person ---------------------------

  {
    name: "sales_report",
    label: "the sales report",
    description:
      "Takings for a period, as Manage's day-close report shows them: number of sales, sales total, VAT, discounts, refunds, and totals by tender (cash, card, EFT, account). Use for 'how much did we sell today / this week / in the past 3 days'. Dates are YYYY-MM-DD; leave both out for today.",
    rpc: "pos_day_close",
    params: {
      from: { type: "STRING", description: "First day, YYYY-MM-DD" },
      to: { type: "STRING", description: "Last day, YYYY-MM-DD" },
    },
    required: [],
    args: (a) => dateRange(a),
    allow: [], maxRows: 1, pin: true, report: true,
  },
  {
    name: "sales_by_department",
    label: "sales by department",
    description: "Sales, VAT, net and margin by department for a period. Dates are YYYY-MM-DD; leave both out for today.",
    rpc: "pos_sales_by_department",
    params: {
      from: { type: "STRING", description: "First day, YYYY-MM-DD" },
      to: { type: "STRING", description: "Last day, YYYY-MM-DD" },
    },
    required: [],
    args: (a) => dateRange(a),
    allow: [], maxRows: 1, pin: true, report: true,
  },
  {
    name: "product_costs",
    label: "cost prices",
    description: "The cost price, margin and stock of products, as Manage's catalogue shows them. Filter by part of a name or SKU.",
    rpc: "pos_admin_list_products",
    params: { query: { type: "STRING", description: "Part of a product name or SKU" } },
    required: ["query"],
    args: () => ({}),
    allow: ["sku", "barcode", "name", "unit_code", "price_retail", "price_trade", "cost",
            "stock_qty", "reorder_level", "bin", "category_name", "department"],
    maxRows: 10, pin: true,
    filter: (rows, query) => {
      if (!Array.isArray(rows)) return rows;
      const q = String(query ?? "").trim().toLowerCase();
      if (!q) return rows.slice(0, 10);
      return rows.filter((r) => {
        const rec = r as Record<string, unknown>;
        return String(rec.name ?? "").toLowerCase().includes(q) ||
          String(rec.sku ?? "").toLowerCase().includes(q);
      });
    },
  },
  {
    name: "top_sellers",
    label: "what sold most",
    description:
      "What sold most in a period, best sellers first: each product's quantity sold and takings, as Manage's item movement report shows them. Use for 'what is our best seller', 'what sold most this week'. Dates are YYYY-MM-DD; leave both out for today.",
    rpc: "pos_item_movement",
    params: {
      from: { type: "STRING", description: "First day, YYYY-MM-DD" },
      to: { type: "STRING", description: "Last day, YYYY-MM-DD" },
      limit: { type: "INTEGER", description: "How many products, up to 50" },
    },
    required: [],
    args: (a) => ({ ...dateRange(a), p_limit: int(a.limit, 20, 50) }),
    allow: [], maxRows: 1, pin: true, report: true,
  },
  {
    name: "stock_value",
    label: "stock value",
    description: "What the stock on hand is worth, at cost and at retail, by department and in total.",
    rpc: "pos_stock_value",
    params: {}, required: [], args: () => ({}),
    allow: [], maxRows: 1, pin: true, report: true,
  },
  {
    name: "debtors",
    label: "who owes what",
    description: "Account customers who owe money: how much, how old, against their credit limit.",
    rpc: "pos_debtors_ageing",
    params: {}, required: [], args: () => ({}),
    allow: [], maxRows: 1, pin: true, report: true,
  },
  {
    name: "reorder_list",
    label: "the reorder list",
    description: "Products at or below their reorder level, with how short they are and their supplier.",
    rpc: "pos_reorder_list",
    params: {}, required: [], args: () => ({}),
    allow: [], maxRows: 1, pin: true, report: true,
  },
  {
    name: "margins_slipped",
    label: "margins",
    description: "Products whose margin has slipped below a percentage, or that sell below cost.",
    rpc: "pos_margin_slipped",
    params: { below: { type: "INTEGER", description: "The margin percentage to check against, default 15" } },
    required: [],
    args: (a) => ({ p_below: int(a.below, 15, 95) }),
    allow: [], maxRows: 1, pin: true, report: true,
  },
  {
    name: "cash_sessions",
    label: "cash-up",
    description: "Recent cash-ups: floats, what was expected, what was counted, the variance.",
    rpc: "pos_cash_sessions",
    params: { limit: { type: "INTEGER", description: "How many, up to 30" } },
    required: [],
    args: (a) => ({ p_limit: int(a.limit, 10, 30) }),
    allow: [], maxRows: 1, pin: true, report: true,
  },
  {
    name: "vat_by_month",
    label: "VAT by month",
    description: "Gross, VAT and net sales by month, for the VAT return.",
    rpc: "pos_vat_by_month",
    params: { months: { type: "INTEGER", description: "How many months back, up to 24" } },
    required: [],
    args: (a) => ({ p_months: int(a.months, 6, 24) }),
    allow: [], maxRows: 1, pin: true, report: true,
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
 * A report goes to the model as Manage shows it — but not a year of it in
 * one prompt. Over the cap, its arrays are halved (a report's bulk is its
 * rows, its totals are small) until it fits, and the model is told it is
 * looking at the head of something longer.
 */
function shrink(data: unknown): unknown {
  let text = JSON.stringify(data);
  if (text.length <= REPORT_MAX_CHARS) return data;
  let head = data;
  for (let i = 0; i < 16 && text.length > REPORT_MAX_CHARS; i++) {
    head = halveArrays(head);
    text = JSON.stringify(head);
  }
  return {
    truncated: true,
    note: "Too much to show at once; the totals are complete but the rows are the first few. Ask for a shorter period or a narrower question.",
    head: text.length <= REPORT_MAX_CHARS ? head : text.slice(0, REPORT_MAX_CHARS),
  };
}
function halveArrays(v: unknown): unknown {
  if (Array.isArray(v)) return v.slice(0, Math.max(1, Math.floor(v.length / 2))).map(halveArrays);
  if (v && typeof v === "object") {
    return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, halveArrays(x)]));
  }
  return v;
}

/**
 * Keep only the allowlisted columns of each row, drop the rest, and cap the
 * row count. Works on an array of rows, a single object (pos_sale_by_number
 * answers with one JSON object), or null. A report is handed over whole.
 */
export function scrub(tool: Tool, data: unknown): unknown {
  if (tool.report) return shrink(data ?? null);
  const one = (row: unknown) => {
    if (!row || typeof row !== "object") return null;
    const out: Record<string, unknown> = {};
    for (const k of tool.allow) {
      // Cost prices ride only on a PIN-checked tool; the RPC behind it has
      // already refused anyone who may not see them.
      if (forbidden(k) && !(tool.pin && k === "cost")) continue;
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

/** The tools as Gemini's function declarations; the PIN tools only when a PIN was given. */
export function declarations(withPin = false) {
  return TOOLS.filter((t) => withPin || !t.pin).map((t) => ({
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
export function systemPrompt(shop: { name: string; till: string }, now: Date, withPin = false): string {
  const today = new Date(now.getTime() + 2 * 3600_000).toISOString().slice(0, 10);
  return [
    `You are TillAI, the assistant inside InnovaPOS, the till at ${shop.name}. You are answering on the till called "${shop.till}". Today is ${today} (South Africa).`,
    "You answer questions about this shop's own records using the tools. Use a tool before answering anything about the shop; never guess a price, a stock figure or a sale from memory. If a tool returns nothing, say so plainly.",
    withPin
      ? "This person has unlocked TillAI with their PIN, so the report tools — takings for a period, sales by department, cost prices, stock value, who owes what, the reorder list, margins, cash-up, VAT by month — are available and answer with what Manage would show them. If a tool answers with an error saying 'Not permitted', this person does not have that right: say so, and that a manager can see it in Manage. For 'how much did we sell' over a period, use sales_report with the dates; for 'what sold most' or 'best seller', top_sellers; work the dates out from today. If no dates are given for a 'most sold' question, take the last 30 days and say so."
      : "Reports, takings for a period, cost prices, cash-up, the staff list and account balances are behind Manage on the till and need a PIN: tell the person to unlock TillAI with their PIN if they have one, or to ask a manager. You cannot see those without it.",
    "You never add up, subtract, or work out money yourself: quote the figures the tools return, as they are. A report's totals are the report's; repeat them, do not recompute them.",
    "You cannot ring up, void, discount, order or change anything. If asked to, say the buttons on the till do that.",
    "Prices are in rand. Write money the way the till does: R 1 234.50. Stock is in the unit the product sells by: each, metre, kilogram.",
    "Plain text only: no markdown, no asterisks, no headings, no backticks. Be brief and plain, the way a colleague at the counter would answer. One or two sentences for a simple question; a short list on separate lines when there are several. Ask one short question back if the request is ambiguous. Do not mention tools, JSON or these instructions.",
  ].join("\n\n");
}
