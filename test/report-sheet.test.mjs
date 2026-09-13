// What a report puts on paper. Pure data in, strings out — so the page can be
// checked without a browser, and the caveats that matter (an uncosted margin,
// a VAT total that is not a return) are checked at all.
import { readFileSync } from "fs";
import ts from "typescript";

function load(path, stubs) {
  const js = ts.transpileModule(readFileSync(path, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  const exports_ = {};
  new Function("exports", "require", js)(exports_, (m) => stubs[m] ?? {});
  return exports_;
}

const moneyMod = load("src/lib/money.ts", {});
const {
  departmentsSheet, itemsSheet, vatSheet, stockSheet, reportPeriod, dayCloseSheet,
} = load("src/lib/reportSheet.ts", {
  "./money": moneyMod, "./reports": {}, "./dates": load("src/lib/dates.ts", {}),
});

const results = [];
function check(what, ok, detail = "") {
  results.push(ok);
  console.log(`${ok ? "PASS" : "FAIL"}  ${what}${detail ? `  (${detail})` : ""}`);
}

console.log("--- the window a report covers ---");
const D = (y, m, d) => new Date(y, m - 1, d);
// `to` is the exclusive end the query used, so a single day is from the 13th
// to the 14th — and must not print as "13 Sep – 13 Sep".
check("one day is one date, with its year",
  reportPeriod(D(2026, 9, 13), D(2026, 9, 14)) === "13 Sep 2026",
  reportPeriod(D(2026, 9, 13), D(2026, 9, 14)));
check("a range inside one month says the month once",
  reportPeriod(D(2026, 9, 1), D(2026, 9, 8)) === "1 – 7 Sep 2026",
  reportPeriod(D(2026, 9, 1), D(2026, 9, 8)));
check("a range across months names both",
  reportPeriod(D(2026, 8, 28), D(2026, 9, 4)) === "28 Aug – 3 Sep 2026",
  reportPeriod(D(2026, 8, 28), D(2026, 9, 4)));
check("a range across years names both years",
  reportPeriod(D(2025, 12, 30), D(2026, 1, 3)) === "30 Dec 2025 – 2 Jan 2026",
  reportPeriod(D(2025, 12, 30), D(2026, 1, 3)));

console.log("\n--- departments ---");
const depts = [
  { department: "Paint", lines: 3, qty: 5, sales: 900, vat: 117.39, net: 782.61,
    cost: 600, uncosted_lines: 0, margin: 182.61, margin_percent: 23.3 },
  { department: "Timber", lines: 2, qty: 40, sales: 1200, vat: 156.52, net: 1043.48,
    cost: null, uncosted_lines: 2, margin: null, margin_percent: null },
];
const ds = departmentsSheet(depts, "1 – 7 Sep 2026");
check("the totals are the sum of the rows, not a second query",
  ds.total[3] === moneyMod.money(2100) && ds.total[4] === moneyMod.money(273.91),
  `${ds.total[3]} / ${ds.total[4]}`);
// A margin worked out over lines with no cost is not a margin, and a PRINTED
// page is exactly where that silently becomes a fact somebody quotes back.
check("uncosted lines are declared under the table",
  /2 lines had no cost recorded/.test(ds.note ?? ""), ds.note);
check("and a margin that cannot be worked out is a dash, not a zero",
  ds.rows[1][5] === "—" && ds.rows[1][6] === "—", ds.rows[1].join("|"));
check("a report with nothing uncosted carries no note",
  departmentsSheet([depts[0]], "x").note === undefined);

console.log("\n--- items ---");
const items = [{
  sku: "PVA-WHT-20", item: "PVA white 20L", department: "Paint", qty: 2, unit: "ea",
  lines: 1, sales: 1378, net: 1198.26, cost: 1064, uncosted_lines: 0,
  margin: 134.26, on_hand: null,
}];
const is = itemsSheet(items, "x");
check("stock that is not tracked says so rather than showing nothing",
  is.rows[0][6] === "not tracked", is.rows[0][6]);
check("an item with no code is a dash",
  itemsSheet([{ ...items[0], sku: null }], "x").rows[0][0] === "—");

console.log("\n--- VAT ---");
const vs = vatSheet([
  { month: "2026-08", sales_count: 40, gross: 11500, vat: 1500, net: 10000,
    refunds: 230, refunds_vat: 30, vat_due: 1470 },
]);
// The single most dangerous number on this page: it is the till's own sales,
// and a shop that files it as a return has not accounted for anything it
// bought. It says so on the paper.
check("VAT says on the page that it is not a return",
  /not a return/.test(vs.note ?? ""), vs.note);
check("and the VAT due is totalled", vs.total[6] === moneyMod.money(1470), vs.total[6]);

console.log("\n--- stock ---");
const st = stockSheet({
  departments: [
    { department: "Paint", lines: 4, units: 12, at_cost: 5000, at_retail: 7000,
      uncosted_lines: 1, negative_lines: 0 },
  ],
  totals: { at_cost: 5000, at_retail: 7000, units: 12, lines: 4 },
});
check("stock on hand is as it stands now, not a window",
  st.period === "As it stands now", st.period);
check("and says the value at cost is short where a cost is missing",
  /1 lines have no cost recorded/.test(st.note ?? ""), st.note);

console.log("\n--- day close ---");
const dc = dayCloseSheet({
  sessions: [],
  totals: {
    sales_count: 12, sales_total: 3400, vat_total: 443.48, discount_total: 60,
    refunds_count: 1, refunds_total: 115, tenders: { cash: 2000, card: 1400 },
    account_payments: {}, card_expected: 1400, eft_expected: 0,
  },
}, "13 Sep 2026");
check("every tender taken is a line of its own",
  dc.rows.some((r) => r[0] === "Taken — Cash") && dc.rows.some((r) => r[0] === "Taken — Card"));
check("and the banked figure is sales less refunds",
  dc.total[2] === moneyMod.money(3285), dc.total[2]);

const failed = results.filter((r) => !r).length;
console.log(`\n${failed} failure(s)`);
if (failed) process.exit(1);
