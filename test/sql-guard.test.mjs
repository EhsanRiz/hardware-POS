/**
 * The SQL guard, tested like anything else that stands between a mistake and a
 * shop that cannot trade.
 *
 * .claude/hooks/guard-sql.mjs refuses the statements that cannot be undone,
 * because Claude runs SQL against the live database with no prompt in front of
 * it. A guard nobody tests is a guard that quietly stops guarding — and the
 * confidence stays behind after the protection has gone, which is worse than
 * never having had one.
 *
 * The allow cases matter as much as the deny ones. A guard that refuses a
 * legitimate DROP FUNCTION, or a migration's backfill, is one people learn to
 * work around, and then it protects nothing.
 */
import { execFileSync } from "node:child_process";

const run = (tool, query) => {
  const out = execFileSync("node", [".claude/hooks/guard-sql.mjs"], {
    input: JSON.stringify({ tool_name: tool, tool_input: { query } }), encoding: "utf8",
  });
  return out.trim() ? "DENY" : "allow";
};
const E = "mcp__Supabase__execute_sql", M = "mcp__Supabase__apply_migration";
let bad = 0;
const t = (want, tool, q, why) => {
  const got = run(tool, q);
  if (got !== want) { bad++; console.log(`FAIL  ${why}\n      wanted ${want}, got ${got}`); }
  else console.log(`ok    ${got.padEnd(5)} ${why}`);
};

// --- must be refused -------------------------------------------------------
t("DENY", E, "drop table public.sales", "drop table");
t("DENY", M, "DROP TABLE public.products;", "drop table in a migration too");
t("DENY", E, "truncate public.sale_items", "truncate");
t("DENY", E, "delete from public.products", "delete with no where");
t("DENY", E, "update public.products set price_retail = 0", "update with no where");
t("DENY", E, "delete from a where id=1; delete from b;", "second statement unbounded");
t("DENY", E, "drop   \n  table  public.sales", "whitespace does not hide it");
t("DENY", E, "DrOp TaBlE public.sales", "case does not hide it");

// --- must be allowed -------------------------------------------------------
t("allow", E, "select * from public.products limit 5", "an ordinary read");
t("allow", E, "update public.products set price_retail = 10 where id = 'x'", "bounded update");
t("allow", E, "delete from public.products where id = 'x'", "bounded delete");
t("allow", M, "drop function if exists public.pos_catalogue(text);", "DROP FUNCTION — CLAUDE.md requires it");
t("allow", M, "update public.sale_items set base_qty = qty", "unbounded backfill IS what a migration does");
t("allow", E, "-- drop table public.sales\nselect 1", "a drop inside a comment is not a statement");
t("allow", E, "select * from notes where body = 'please delete from stock'", "a phrase inside a string is not a statement");
t("allow", M, "create or replace function f() returns void as $$ begin delete from t; end $$ language plpgsql", "a function body is not the statement being run");
t("allow", E, "", "an empty query decides nothing");

// --- the guard itself breaking must REFUSE, not wave through ---------------
const broken = execFileSync("node", [".claude/hooks/guard-sql.mjs"], { input: "{not json", encoding: "utf8" });
if (!broken.includes('"deny"')) { bad++; console.log("FAIL  a broken guard must fail CLOSED"); }
else console.log("ok    DENY  a broken guard fails closed, not open");

console.log(`\n${bad} failure(s)`);
process.exit(bad ? 1 : 0);
