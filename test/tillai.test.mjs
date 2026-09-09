/**
 * TillAI's hands. The assistant may only read what a signed-in till can
 * already see, and only the columns each tool names. Both are decided in
 * supabase/functions/tillai/tools.ts, which has no Deno imports so that
 * this file can hold it to account.
 */
import { readFileSync } from "node:fs";
import ts from "typescript";

const src = readFileSync(new URL("../supabase/functions/tillai/tools.ts", import.meta.url), "utf8");
const js = ts.transpileModule(src, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;
const { TOOLS, scrub, filterCustomers, declarations, systemPrompt, toolNamed, forbidden, DAILY_CAP } = await import(
  "data:text/javascript;base64," + Buffer.from(js).toString("base64")
);

let failures = 0;
function check(label, actual, expected) {
  const ok = Object.is(actual, expected);
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}  → ${JSON.stringify(actual)}${ok ? "" : ` (expected ${JSON.stringify(expected)})`}`);
}

// The RPCs a signed-in till may call without a PIN, from the migrations. A
// tool pointing anywhere else would be reading past what the counter shows.
const TOKEN_ONLY = new Set([
  "pos_search_products", "pos_recent_sales", "pos_sale_by_number", "pos_sale_items",
  "pos_list_customers", "pos_customer_history", "pos_customer_by_phone", "pos_org_settings",
  "pos_categories", "pos_list_quotes", "pos_quote_by_number", "pos_quote_items", "pos_list_deliveries",
]);

console.log("--- every tool reads only what the till can already see ---");
for (const t of TOOLS) {
  check(`${t.name} maps to a token-only RPC`, TOKEN_ONLY.has(t.rpc), true);
  check(`${t.name} never passes a PIN`, "p_pin" in t.args({ pin: "123456", p_pin: "123456" }), false);
  check(`${t.name} never lets the model choose the token`, "p_register_token" in t.args({ p_register_token: "x" }), false);
  check(`${t.name} allowlists no forbidden column`, t.allow.some(forbidden), false);
}
check("every tool the model could name is in the table", toolNamed("write_sale"), undefined);

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
const shop = toolNamed("shop_info");
const settings = scrub(shop, { shop_name: "Ladybrand Hardware", bank_account_number: "1234567890", vat_number: "4001234567" });
check("the shop's name and VAT number go through", settings.vat_number, "4001234567");
check("the bank account does not", "bank_account_number" in settings, false);
check("a null result stays null", scrub(shop, null), null);
check("rows are capped", scrub(search, Array.from({ length: 50 }, () => row)).length, search.maxRows);

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
check("it is told cost prices and reports are behind Manage", /cost prices, reports/i.test(prompt), true);
check("it is told it cannot ring up or change anything", /cannot ring up/i.test(prompt), true);
check("it knows the shop", prompt.includes("Ladybrand Hardware"), true);
check("declarations carry every tool", declarations().length, TOOLS.length);
check("declarations are valid enough for Gemini", declarations().every((d) => d.parameters.type === "OBJECT"), true);
check("the daily cap is a real number", DAILY_CAP > 0 && DAILY_CAP < 10000, true);

console.log(`\n${failures} failure(s)`);
process.exit(failures ? 1 : 0);
