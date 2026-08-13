/**
 * The two discount ceilings, checked as arithmetic.
 *
 * These figures are shown to a cashier before they press Apply, and the same
 * rule is enforced again in pos_create_sale. If the two disagree the till
 * promises a discount the server then refuses, in front of a customer — which
 * is the exact failure the client-side copy exists to prevent, so it is worth
 * pinning the awkward cases here rather than only in a browser test.
 *
 * Must stay in step with supabase/migrations/0037_discount_limits.sql.
 */
import { readFileSync } from "node:fs";
import ts from "typescript";

const src = readFileSync(new URL("../src/lib/discountLimits.ts", import.meta.url), "utf8");
const js = ts.transpileModule(src, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2020 },
}).outputText;
const { lineCap, saleDiscountCeiling, staffCeiling } = await import(
  "data:text/javascript;base64," + Buffer.from(js).toString("base64")
);

let failures = 0;
function check(label, actual, expected) {
  const ok = Object.is(actual, expected);
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}  → ${actual}${ok ? "" : ` (expected ${expected})`}`);
}

console.log("--- the item cap ---");
check("nothing set is no cap", lineCap({ qty: 1, unitPrice: 115 }), null);
check(
  "5% of one bag",
  lineCap({ qty: 1, unitPrice: 115, maxDiscountPercent: 5 }),
  5.75
);
// The rand cap is PER UNIT, so it scales with the order the way a percentage
// does. A flat per-line cap would tighten the more somebody bought, which is
// the opposite of what anybody setting one intends.
check(
  "R1 a bag, ten bags",
  lineCap({ qty: 10, unitPrice: 115, maxDiscountAmount: 1 }),
  10
);
check(
  "both set — the tighter binds",
  lineCap({ qty: 10, unitPrice: 115, maxDiscountPercent: 5, maxDiscountAmount: 1 }),
  10
);
check(
  "and the other way round",
  lineCap({ qty: 1, unitPrice: 115, maxDiscountPercent: 5, maxDiscountAmount: 50 }),
  5.75
);
// Zero is a real cap, not an absent one: "this line is never discounted".
check("zero caps at nothing", lineCap({ qty: 3, unitPrice: 115, maxDiscountAmount: 0 }), 0);

console.log("\n--- how much a blanket discount can be, given the caps ---");
const uncapped = [{ qty: 1, price: 115, cap: null }];
check("no caps, the whole net subtotal", saleDiscountCeiling(uncapped), 115);
check("an empty basket", saleDiscountCeiling([]), 0);

// One capped line on its own: the blanket discount lands entirely on it, so
// the ceiling is just the cap.
check(
  "one capped line",
  saleDiscountCeiling([{ qty: 1, price: 115, cap: 5.75 }]),
  5.75
);

// A capped line beside an uncapped one. The blanket discount spreads pro-rata,
// so the cement takes 115/1565 of it; holding that under R5.75 allows R78.25
// off the sale in total — far more than the cap itself, because most of it
// lands on the cable.
check(
  "a capped line beside an uncapped one",
  saleDiscountCeiling([
    { qty: 1, price: 115, cap: 5.75 },
    { qty: 1, price: 1450, cap: null },
  ]),
  78.25
);

// A line already at its cap can take no share of anything further, so no
// blanket discount is possible at all — not even one aimed at the other line.
// The server would refuse it, so the till must not offer it.
check(
  "a line already at its cap shuts the blanket discount",
  saleDiscountCeiling([
    { qty: 1, price: 115, discount: 5.75, cap: 5.75 },
    { qty: 1, price: 1450, cap: null },
  ]),
  0
);

// Part-used headroom leaves only what is left. On a single line the blanket
// discount lands entirely on it, so the two kinds of discount simply add up
// against the same cap — which is the property that stops a cashier giving R5
// off the line and then R10 off the sale to get past a R10 ceiling.
check(
  "half the cap already given",
  saleDiscountCeiling([{ qty: 1, price: 100, discount: 5, cap: 10 }]),
  5
);

console.log("\n--- what a person may give without asking ---");
check("nobody", staffCeiling(null, 1000), null);
check("no limit set", staffCeiling({ id: "u", name: "Sam", role: "employee" }, 1000), null);
check(
  "ten percent of the sale",
  staffCeiling({ id: "u", name: "Sam", role: "employee", discount_limit_percent: 10 }, 1000),
  100
);
check(
  "a rand figure",
  staffCeiling({ id: "u", name: "Sam", role: "employee", discount_limit_amount: 50 }, 1000),
  50
);
// The limit is per sale, so the percentage half moves with the basket while
// the rand half does not — which is the whole reason a shop would set both.
check(
  "both — on a small sale the percentage binds",
  staffCeiling(
    { id: "u", name: "Sam", role: "employee", discount_limit_percent: 10, discount_limit_amount: 200 },
    1000
  ),
  100
);
check(
  "both — on a large sale the rand figure binds",
  staffCeiling(
    { id: "u", name: "Sam", role: "employee", discount_limit_percent: 10, discount_limit_amount: 200 },
    5000
  ),
  200
);

console.log(`\n${failures} failure(s)`);
process.exit(failures ? 1 : 0);
