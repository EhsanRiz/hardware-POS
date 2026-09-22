/**
 * Sold whole, and sold cut — the till's half of the rule.
 *
 * The server decides (0107). This file pins what the TILL believes, which is
 * what a cashier sees on the screen and what prints on a slip during an
 * outage. Two implementations of one rule agree until they don't, so both
 * halves are pinned against the same worked example — R180 the 6 m length,
 * R38 the metre cut, R170 and R35 for trade — and the database tests in
 * supabase/test/schema.test.sql assert the identical figures. A change to one
 * side that forgets the other has somewhere to go red.
 *
 * Held here rather than through a browser because it is arithmetic and
 * labelling: eleven minutes of Playwright proves nothing about a fallback
 * chain that a millisecond of node proves exactly.
 */
import { readFileSync } from "node:fs";
import ts from "typescript";

const src = readFileSync(new URL("../src/lib/packs.ts", import.meta.url), "utf8");
const js = ts.transpileModule(src, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
}).outputText;
const exports_ = {};
new Function("exports", "require", js)(exports_, () => ({}));
const {
  soldBothWays, defaultSoldAs, lineSoldAs, lineKey, priceFor, baseQty,
  allowsFraction, unitLabel, qtyLabel, qtyPrompt,
} = exports_;

let failures = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : ` → got ${JSON.stringify(got)}, wanted ${JSON.stringify(want)}`}`);
};

/** 20 mm pipe: a 6 m length, or cut by the metre. */
const pipe = {
  name: "Pipe 20mm", unit_code: "m", unit_name: "Metre", allows_fraction: true,
  price_retail: 180, price_trade: 170,
  sold_in_packs: true, pack_size: 6, pack_label: "6 m length",
  price_cut_retail: 38, price_cut_trade: 35,
};
/** An ordinary item, to prove nothing about it changed. */
const padlock = {
  name: "Padlock", unit_code: "ea", unit_name: "Each", allows_fraction: false,
  price_retail: 50, price_trade: 45,
};
/** Wire where the shop set no trade cut price: trade falls to the retail CUT. */
const wire = {
  name: "Twin & Earth", unit_code: "m", unit_name: "Metre", allows_fraction: true,
  price_retail: 900, price_trade: 850,
  sold_in_packs: true, pack_size: 50, pack_label: "50 m bundle",
  price_cut_retail: 25, price_cut_trade: null,
};

check("pipe is sold both ways", soldBothWays(pipe), true);
check("a padlock is not", soldBothWays(padlock), false);
// An item with the tick but no pack size is not usable either way, and saying
// so here stops the till drawing a picker with nothing behind it.
check("nor is a half-configured item",
  soldBothWays({ ...pipe, pack_size: null }), false);

// The counter reaches for a whole one first: cutting is the deliberate act.
check("a pipe line starts whole", defaultSoldAs(pipe), "pack");
check("a padlock line is just a padlock", defaultSoldAs(padlock), "unit");

// A line saved before 0107 has no mode at all, and must not read as cut.
check("a line with no mode is whole", lineSoldAs({ product: pipe }), "pack");
check("unless it says so", lineSoldAs({ product: pipe, soldAs: "unit" }), "unit");
// A mode left on a line whose product stopped being sold in packs must not
// price it off a column that is now null.
check("a mode on an ordinary item is ignored",
  lineSoldAs({ product: padlock, soldAs: "pack" }), "unit");

// What names a line in the basket. A product id stopped being enough the day
// one product could be in the sale two ways: everything that pointed at a line
// by product — the quantity box, the × key, the discount, the React key — hit
// both lines at once.
const pipeId = { ...pipe, id: "p8" };
check("a whole line and a cut line are different lines",
  lineKey({ product: pipeId, soldAs: "pack" }) ===
  lineKey({ product: pipeId, soldAs: "unit" }), false);
check("the same line is the same line",
  lineKey({ product: pipeId, soldAs: "unit" }),
  lineKey({ product: { ...pipeId }, soldAs: "unit" }));
// A line saved before 0107 carries no mode and must land on the whole-length
// key, or restoring a parked sale would move it onto the cut price.
check("no mode keys as whole",
  lineKey({ product: pipeId }), lineKey({ product: pipeId, soldAs: "pack" }));
// An ordinary item has exactly one line, however a stray mode got onto it.
check("an ordinary item keys the same either way",
  lineKey({ product: { ...padlock, id: "p1" }, soldAs: "pack" }),
  lineKey({ product: { ...padlock, id: "p1" }, soldAs: "unit" }));
check("and two products never collide",
  lineKey({ product: pipeId, soldAs: "unit" }) ===
  lineKey({ product: { ...wire, id: "p3" }, soldAs: "unit" }), false);

// The money. Four prices, and trade falls down the SAME column.
check("a whole length, retail", priceFor(pipe, false, "pack"), 180);
check("a whole length, trade", priceFor(pipe, true, "pack"), 170);
check("cut, retail", priceFor(pipe, false, "unit"), 38);
check("cut, trade — the trade CUT price, not the trade length price",
  priceFor(pipe, true, "unit"), 35);
// The fallback that is easy to get wrong: no trade cut price set means the
// retail CUT price, never the trade price of a whole bundle.
check("no trade cut price falls to the retail cut price, not the bundle",
  priceFor(wire, true, "unit"), 25);
check("an ordinary item is unaffected", priceFor(padlock, false, "unit"), 50);
check("and its trade price still works", priceFor(padlock, true, "unit"), 45);

// The shelf.
check("two lengths is twelve metres", baseQty(pipe, "pack", 2), 12);
check("2.4 m cut is 2.4 m", baseQty(pipe, "unit", 2.4), 2.4);
check("a padlock is a padlock", baseQty(padlock, "unit", 3), 3);

// The rule the unit alone gets wrong: metres divide, 6 m lengths do not.
check("a whole length cannot be split", allowsFraction(pipe, "pack"), false);
check("a cut can be", allowsFraction(pipe, "unit"), true);
check("a padlock still cannot", allowsFraction(padlock, "unit"), false);

// What it is called, which is what makes a slip readable.
check("a whole one is named as the counter says it",
  unitLabel(pipe, "pack"), "6 m length");
check("a cut is in its base unit", unitLabel(pipe, "unit"), "Metre");
// A shop that ticked the box and left the name blank still gets something
// sayable rather than "undefined".
check("and a blank name falls back to the measurement",
  unitLabel({ ...pipe, pack_label: null }, "pack"), "6 m");

check("the slip says which way it went out",
  qtyLabel(pipe, "pack", 2), "2 x 6 m length");
check("and how much, when it was cut", qtyLabel(pipe, "unit", 2.4), "2.4 Metre");
check("an ordinary line reads as it always did",
  qtyLabel(padlock, "unit", 3), "3 Each");

check("the box asks for the right thing",
  qtyPrompt(pipe, "pack"), "How many 6 m length");
check("and the other right thing", qtyPrompt(pipe, "unit"), "How many Metre");

// The arithmetic a cashier actually reads off the screen, end to end.
check("two lengths comes to R360", priceFor(pipe, false, "pack") * 2, 360);
check("2.4 m comes to R91.20",
  Math.round(priceFor(pipe, false, "unit") * 2.4 * 100) / 100, 91.2);

console.log(`\n${failures} failure(s)`);
process.exit(failures ? 1 : 0);
