/**
 * TillAI's hands. Without a PIN the assistant may only read what a signed-in
 * till can already see, and only the columns each tool names; with one, the
 * report tools carry it to the same PIN-checked RPCs Manage calls, which
 * decide the rights. All of it is decided in supabase/functions/tillai/tools.ts,
 * which has no Deno imports so that this file can hold it to account.
 */
import { readFileSync } from "node:fs";
import ts from "typescript";

const src = readFileSync(new URL("../supabase/functions/tillai/tools.ts", import.meta.url), "utf8");
const js = ts.transpileModule(src, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;
const { TOOLS, scrub, filterCustomers, declarations, systemPrompt, toolNamed, forbidden, dateRange, DAILY_CAP, REPORT_MAX_CHARS } = await import(
  "data:text/javascript;base64," + Buffer.from(js).toString("base64")
);

let failures = 0;
function check(label, actual, expected) {
  const ok = Object.is(actual, expected);
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}  → ${JSON.stringify(actual)}${ok ? "" : ` (expected ${JSON.stringify(expected)})`}`);
}

// The RPCs a signed-in till may call without a PIN, from the migrations. A
// tool without a PIN pointing anywhere else would be reading past what the
// counter shows.
const TOKEN_ONLY = new Set([
  "pos_search_products", "pos_recent_sales", "pos_sale_by_number", "pos_sale_items",
  "pos_list_customers", "pos_customer_history", "pos_customer_by_phone", "pos_org_settings",
  "pos_categories", "pos_list_quotes", "pos_quote_by_number", "pos_quote_items", "pos_list_deliveries",
]);
// The RPCs behind Manage's reports and costs: each takes (token, pin) and
// checks the person's right itself. A PIN tool pointing anywhere else would
// be handing a PIN to something that does not check it.
const PIN_CHECKED = new Set([
  "pos_day_close", "pos_sales_by_department", "pos_admin_list_products", "pos_stock_value",
  "pos_debtors_ageing", "pos_reorder_list", "pos_margin_slipped", "pos_cash_sessions", "pos_vat_by_month",
]);

console.log("--- every tool reads only what the till, or the person, can already see ---");
for (const t of TOOLS) {
  if (t.pin) {
    check(`${t.name} maps to a PIN-checked RPC`, PIN_CHECKED.has(t.rpc), true);
  } else {
    check(`${t.name} maps to a token-only RPC`, TOKEN_ONLY.has(t.rpc), true);
    check(`${t.name} allowlists no forbidden column`, t.allow.some(forbidden), false);
  }
  // The model never chooses the PIN or the token: index.ts adds both.
  check(`${t.name} never lets the model pass a PIN`, "p_pin" in t.args({ pin: "123456", p_pin: "123456" }), false);
  check(`${t.name} never lets the model choose the token`, "p_register_token" in t.args({ p_register_token: "x" }), false);
}
check("every tool the model could name is in the table", toolNamed("write_sale"), undefined);
check("there are token-only tools", TOOLS.some((t) => !t.pin), true);
check("there are PIN tools", TOOLS.some((t) => t.pin), true);
check("the only cost a PIN tool allowlists is the cost price itself",
  TOOLS.filter((t) => t.pin).every((t) => t.allow.every((k) => !forbidden(k) || k === "cost")), true);

console.log("--- the PIN tools are offered only with a PIN ---");
check("declarations without a PIN carry only the token-only tools", declarations(false).length, TOOLS.filter((t) => !t.pin).length);
check("declarations by default are the same", declarations().length, declarations(false).length);
check("declarations with a PIN carry every tool", declarations(true).length, TOOLS.length);
check("no PIN tool leaks into the locked declarations",
  declarations(false).some((d) => toolNamed(d.name).pin), false);

console.log("--- what is forbidden, and what only sounds like it ---");
check("the buying price", forbidden("cost"), true);
check("its cousins", forbidden("unit_cost") && forbidden("cost_price"), true);
check("the bank account", forbidden("bank_account_number"), true);
check("an account balance", forbidden("balance"), true);
check("but not the delivery charge printed on every quote", forbidden("delivery_cost"), false);

console.log("--- results are scrubbed to the allowlist ---");
const search = toolNamed("search_products");
const row = { sku: "CEM50", name: "Cement 42.5N 50kg", price_retail: 115, cost: 88, stock_qty: 40, bin: "A1", supplier_id: "s1" };
const out = scrub(search, [row])[0];
check("the shelf price goes through", out.price_retail, 115);
check("the cost price does not", "cost" in out, false);
check("nor a column nobody listed", "supplier_id" in out, false);
// Belt and braces: even if somebody added "cost" to a token-only tool's
// allowlist, the scrub would still drop it. Only a PIN tool may carry it.
check("a token-only tool cannot allowlist its way to the cost price",
  "cost" in scrub({ ...search, allow: [...search.allow, "cost"] }, [row])[0], false);
check("nor to a margin", "margin_pct" in scrub({ ...search, allow: [...search.allow, "margin_pct"] }, [{ ...row, margin_pct: 1 }])[0], false);
const shop = toolNamed("shop_info");
const settings = scrub(shop, { shop_name: "Ladybrand Hardware", bank_account_number: "1234567890", vat_number: "4001234567" });
check("the shop's name and VAT number go through", settings.vat_number, "4001234567");
check("the bank account does not", "bank_account_number" in settings, false);
check("a null result stays null", scrub(shop, null), null);
check("rows are capped", scrub(search, Array.from({ length: 50 }, () => row)).length, search.maxRows);

console.log("--- with a PIN, cost prices and reports come through as Manage shows them ---");
const costs = toolNamed("product_costs");
const costRow = scrub(costs, [{ ...row, margin_pct: 23, supplier_id: "s1" }])[0];
check("the cost price goes through on the PIN tool", costRow.cost, 88);
check("but still not a column nobody listed", "supplier_id" in costRow, false);
check("nor a margin column nobody listed", "margin_pct" in costRow, false);
check("the PIN tool filters by name", costs.filter([row, { ...row, name: "Sand", sku: "SND" }], "cem").length, 1);
check("and by SKU", costs.filter([row, { ...row, name: "Sand", sku: "SND" }], "snd").length, 1);
const report = toolNamed("sales_report");
const day = { sales_count: 14, total: 4862, by_tender: { cash: 3100, card: 1762 } };
check("a report goes through whole", scrub(report, day), day);
const big = scrub(report, { lines: Array.from({ length: 2000 }, (_, i) => ({ i, name: "Cement 42.5N 50kg", total: 115 })) });
check("a huge report is truncated, not sent", big.truncated, true);
check("and says so", /shorter period/.test(big.note), true);
check("what is kept is within the cap", JSON.stringify(big.head).length <= REPORT_MAX_CHARS, true);
check("and is still the report's shape, with its first rows", big.head.lines[0].name, "Cement 42.5N 50kg");
const bigTotals = scrub(report, { total: 4862, lines: Array.from({ length: 2000 }, (_, i) => ({ i })) });
check("the totals survive the trimming", bigTotals.head.total, 4862);
check("the cap is a real number", REPORT_MAX_CHARS > 1000 && REPORT_MAX_CHARS < 100000, true);

console.log("--- report dates are SAST days, never in the future ---");
const now = new Date("2026-09-09T08:00:00Z");
const range = dateRange({ from: "2026-09-06", to: "2026-09-08" }, now);
check("a day starts at 22:00Z the evening before", range.p_from, "2026-09-05T22:00:00.000Z");
check("and the last day runs to its end", range.p_to, "2026-09-08T22:00:00.000Z");
check("with no dates, today so far", dateRange({}, now).p_from, "2026-09-08T22:00:00.000Z");
check("ending now", dateRange({}, now).p_to, now.toISOString());
check("a 'to' after now is clipped to now", dateRange({ from: "2026-09-07", to: "2026-09-30" }, now).p_to, now.toISOString());
check("rubbish dates fall back", dateRange({ from: "yesterday", to: "lol" }, now).p_to, now.toISOString());
check("margins_slipped clamps its percentage", toolNamed("margins_slipped").args({ below: 500 }).p_below, 95);
check("vat_by_month at most 24", toolNamed("vat_by_month").args({ months: 99 }).p_months, 24);

console.log("--- limits are clamped, whatever the model asks for ---");
check("recent_sales at most 30", toolNamed("recent_sales").args({ limit: 5000 }).p_limit, 30);
check("recent_sales at least 1", toolNamed("recent_sales").args({ limit: -3 }).p_limit, 1);
check("a non-number falls back", toolNamed("search_products").args({ query: "cement", limit: "lots" }).p_limit, 8);

console.log("--- customers are filtered here, not by handing the book to the model ---");
const book = [
  { id: "c1", name: "Thabo Molefe", phone: "+27821234567", code: "MOL01" },
  { id: "c2", name: "Nomsa Dlamini", phone: "+27829876543", code: "DLA01" },
];
check("by part of a name", filterCustomers(book, "molefe").length, 1);
check("by part of a phone, however it is written", filterCustomers(book, "082 987").length, 1);
check("empty query keeps the book", filterCustomers(book, "").length, 2);

console.log("--- what the model is told ---");
const prompt = systemPrompt({ name: "Ladybrand Hardware", till: "Front Counter" }, new Date("2026-09-09T08:00:00Z"));
check("it is told never to do sums with money", /never add up/i.test(prompt), true);
check("locked, it is told reports and costs need a PIN", /need a PIN/i.test(prompt), true);
check("locked, it is not told it has the report tools", /sales_report/.test(prompt), false);
check("it is told it cannot ring up or change anything", /cannot ring up/i.test(prompt), true);
check("it is told plain text, no markdown", /no markdown/i.test(prompt), true);
check("it knows the shop", prompt.includes("Ladybrand Hardware"), true);
check("it knows today, in South Africa", prompt.includes("Today is 2026-09-09"), true);
check("late at night it is still today here, not tomorrow in London",
  systemPrompt({ name: "x", till: "y" }, new Date("2026-09-09T22:30:00Z")).includes("Today is 2026-09-10"), true);
const unlocked = systemPrompt({ name: "Ladybrand Hardware", till: "Front Counter" }, new Date("2026-09-09T08:00:00Z"), true);
check("unlocked, it is told the PIN opened the reports", /unlocked TillAI with their PIN/i.test(unlocked), true);
check("unlocked, it is pointed at sales_report for takings", /sales_report/.test(unlocked), true);
check("unlocked, it is told what 'Not permitted' means", /Not permitted/.test(unlocked), true);
check("unlocked, it still never adds up", /never add up/i.test(unlocked), true);
check("declarations are valid enough for Gemini", declarations(true).every((d) => d.parameters.type === "OBJECT"), true);
check("the daily cap is a real number", DAILY_CAP > 0 && DAILY_CAP < 10000, true);

console.log(`\n${failures} failure(s)`);
process.exit(failures ? 1 : 0);
