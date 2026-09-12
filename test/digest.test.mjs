/**
 * The nightly line, as words: grouped by shop, repeats counted once, and
 * nothing at all on a quiet night. Pure (supabase/functions/error-digest/digest.ts).
 */
import { readFileSync } from "node:fs";
import ts from "typescript";

const src = readFileSync(new URL("../supabase/functions/error-digest/digest.ts", import.meta.url), "utf8");
const js = ts.transpileModule(src, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
const { summarise } = await import("data:text/javascript;base64," + Buffer.from(js).toString("base64"));

let failures = 0;
function check(label, actual, expected) {
  const ok = Object.is(actual, expected);
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}  → ${JSON.stringify(actual)}${ok ? "" : ` (expected ${JSON.stringify(expected)})`}`);
}
const since = new Date("2026-09-09T04:00:00Z");
const orgs = [{ id: "o1", name: "5 Star Hardware" }, { id: "o2", name: "Other Shop" }];
const regs = [{ id: "r1", name: "Front Counter" }, { id: "r2", name: "Back till" }];
const err = (org, reg, message, at = "2026-09-09T10:00:00Z", kind = "error") => ({ org_id: org, register_id: reg, kind, message, at });

console.log("--- a quiet night sends nothing ---");
check("no rows, no email", summarise([], [], orgs, regs, since), null);

console.log("--- errors are grouped by shop and counted once per message ---");
const d = summarise([
  err("o1", "r1", "TypeError: x"), err("o1", "r1", "TypeError: x", "2026-09-09T11:00:00Z"), err("o1", "r2", "TypeError: x"),
  err("o1", "r1", "RangeError: y"),
  err("o2", "r2", "Error: z", "2026-09-09T09:00:00Z", "render"),
], [{ org_id: "o1", unlocked: true, tools: ["products"] }, { org_id: "o1", unlocked: false, tools: [] }], orgs, regs, since);
check("the subject counts errors and shops", d.subject, "InnovaPOS: 5 errors on 2 shops in the last day");
check("the busier shop comes first", d.text.indexOf("5 Star Hardware") < d.text.indexOf("Other Shop"), true);
check("a repeated message is one line with its count", d.text.includes("3× [error] TypeError: x"), true);
check("naming every till it hit", d.text.includes("Front Counter, Back till"), true);
check("and its last time", d.text.includes("last 2026-09-09 11:00Z"), true);
check("the shop's questions are counted", d.text.includes("2 TillAI questions (1 unlocked, 1 answered without a lookup)"), true);
check("the kind is shown", d.text.includes("[render] Error: z"), true);
check("html escapes what a message says", summarise([err("o1", "r1", "<script>")], [], orgs, regs, since).html.includes("&lt;script&gt;"), true);
check("the counts are handed back for the record", d.errors, 5);

console.log("--- questions alone are still a line ---");
const q = summarise([], [{ org_id: "o2", unlocked: false, tools: ["products"] }], orgs, regs, since);
check("a quiet-night subject", q.subject, "InnovaPOS: quiet night, 1 TillAI question");
check("an unknown shop is still named something", summarise([err("o9", "r9", "E")], [], orgs, regs, since).text.includes("a shop: 1 error"), true);

console.log(`\n${failures} failure(s)`);
process.exit(failures ? 1 : 0);
