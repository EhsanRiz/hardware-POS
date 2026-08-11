/**
 * Cash rounding, checked against the rule the shop actually follows.
 *
 * South Africa stopped minting 1c, 2c and 5c coins, so a cash total of R187.05
 * cannot be handed over. Cash settles to the nearest 10c and an exact half
 * rounds DOWN, in the customer's favour. The invoice total is never rounded —
 * VAT is computed on it — so this only ever adjusts the cash portion.
 *
 * This must stay in step with public.cash_rounding() in migration 0019. If the
 * two disagree, the till shows one number and charges another.
 */
import { readFileSync } from "node:fs";
import ts from "typescript";

const src = readFileSync(new URL("../src/lib/money.ts", import.meta.url), "utf8");
const js = ts.transpileModule(src, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2020 },
}).outputText;
const { cashRounding, money } = await import(
  "data:text/javascript;base64," + Buffer.from(js).toString("base64")
);

let failures = 0;
function check(label, actual, expected) {
  const ok = Object.is(actual, expected);
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}  → ${actual}${ok ? "" : ` (expected ${expected})`}`);
}

console.log("--- cash rounding, nearest 10c, halves down ---");
check("exact 10c needs no adjustment", cashRounding(187.0), 0);
check("187.05 settles down to 187.00", cashRounding(187.05), -0.05);
check("186.95 settles down to 186.90", cashRounding(186.95), -0.05);
check("187.06 settles up to 187.10", cashRounding(187.06), 0.04);
check("187.04 settles down to 187.00", cashRounding(187.04), -0.04);
check("187.01 settles down", cashRounding(187.01), -0.01);
check("187.09 settles up", cashRounding(187.09), 0.01);
check("3c settles to zero", cashRounding(0.03), -0.03);
check("zero is zero", cashRounding(0), 0);

console.log("\n--- the adjusted amount is always a whole 10c ---");
for (const amount of [1.01, 12.34, 99.99, 187.05, 4990.07, 0.06]) {
  const settled = Math.round((amount + cashRounding(amount)) * 100);
  check(`${money(amount)} settles on a 10c boundary`, settled % 10, 0);
}

console.log("\n--- the shop never gains more than 5c on a sale ---");
for (let cents = 0; cents < 200; cents++) {
  const adj = Math.round(cashRounding(cents / 100) * 100);
  if (adj > 5 || adj < -5) {
    failures++;
    console.log(`FAIL  ${cents}c adjusts by ${adj}c`);
  }
}
console.log(`PASS  every adjustment across 200 amounts is within ±5c`);

console.log(`\n${failures} failure(s)`);
process.exit(failures ? 1 : 0);
