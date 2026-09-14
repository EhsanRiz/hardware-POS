/**
 * The bell's list: what gets a row, in what order, and in what words.
 *
 * buildNotices is kept pure in src/lib/notices.ts so this can hold it without
 * a browser. The rules it encodes are the ones that decide whether a bell is
 * read or ignored: no row for a zero, no row for something that is not this
 * device's business, the customer standing at the counter first, and the
 * counts in words rather than as bare numbers to be decoded.
 */
import { readFileSync } from "node:fs";
import ts from "typescript";

const src = readFileSync(new URL("../src/lib/notices.ts", import.meta.url), "utf8");
const js = ts.transpileModule(src, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
}).outputText;
const exports_ = {};
new Function("exports", "require", js)(exports_, () => ({}));
const { buildNotices, signature } = exports_;

let failures = 0;
const check = (label, got, want) => {
  const a = JSON.stringify(got), b = JSON.stringify(want);
  if (a !== b) { failures++; console.error(`FAIL ${label}: got ${a}, wanted ${b}`); }
};

const none = { pending: 0, failed: 0 };
const kinds = (ns) => ns.map((n) => n.kind);

// Nothing waiting is no list at all — not a list of noughts.
check("a quiet shop has an empty bell",
  buildNotices({ approvals: 0, deliveries_late: 0, low_stock: 0 }, none), []);

// Null is "not your business" and reads the same as nothing: neither is a row.
check("what this device may not see is not a row",
  buildNotices({ approvals: null, low_stock: null }, none), []);

// The order is the order things matter in. A customer at the counter first,
// the back office last.
check("the order is what matters first",
  kinds(buildNotices({
    approvals: 1, deliveries_late: 2, deliveries_today: 3, drawer_open: 1,
    low_stock: 9, staff_no_pin: 1, unpriced: 4, orders_overdue: 2,
  }, { pending: 5, failed: 1 })),
  ["approvals", "failed", "deliveries_late", "deliveries_today", "drawer_open",
   "pending", "staff_no_pin", "unpriced", "orders_overdue", "low_stock"]);

// One of a thing reads as one of a thing.
const one = buildNotices({ approvals: 1, deliveries_late: 1 }, none);
check("one sale waiting", one[0].line, "1 sale is waiting for a manager");
check("one delivery late", one[1].line, "1 delivery should already have gone");
const many = buildNotices({ approvals: 3, deliveries_late: 2 }, none);
check("three sales waiting", many[0].line, "3 sales are waiting for a manager");
check("two deliveries late", many[1].line, "2 deliveries should already have gone");

// With the line down there is no shop half at all, and the device's own half
// is exactly what still matters: the sales it is holding.
check("offline, the queue is still the news",
  buildNotices(null, { pending: 4, failed: 1 }).map((n) => n.line),
  ["1 sale the server refused", "4 sales still to reach the server"]);

// Every row knows where it is dealt with, by the same keys the menu uses.
check("each row knows where it goes",
  buildNotices({ approvals: 1, drawer_open: 1, low_stock: 1, unpriced: 1 },
    { pending: 0, failed: 2 }).map((n) => n.goes),
  ["approvals", "failed", "cashup", "catalogue", "stock"]);

// The dot means "new since you looked", so the signature has to move when a
// count moves — not only when a kind appears.
const before = signature(buildNotices({ approvals: 1 }, none));
check("the same list signs the same",
  signature(buildNotices({ approvals: 1 }, none)), before);
if (signature(buildNotices({ approvals: 2 }, none)) === before) {
  failures++;
  console.error("FAIL a second sale waiting must mark the bell as new");
}
if (signature(buildNotices({ approvals: 1, low_stock: 1 }, none)) === before) {
  failures++;
  console.error("FAIL a new kind of notice must mark the bell as new");
}

if (failures) {
  console.error(`${failures} failure(s)`);
  process.exit(1);
}
console.log("notices: all checks passed");
