// The number formatter, per CLAUDE.md hard constraint 4: R 3 019.82 with thin
// spaces, two decimals always. Every price a customer checks goes through here.
import { readFileSync } from "fs";

const src = readFileSync("src/lib/money.ts", "utf8");
const THIN = " ";

// Transpile the module properly rather than stripping types with regexes — the
// point of these tests is that the real implementation is correct.
import ts from "typescript";
const js = ts.transpileModule(src, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
}).outputText;
const exports_ = {};
new Function("exports", js)(exports_);
const { money, quantity, vatWithin } = exports_;

const results = [];
const eq = (label, actual, expected) => {
  const ok = actual === expected;
  results.push(ok);
  const show = (s) => String(s).replace(/ /g, "‸"); // ‸ marks a thin space
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}  → "${show(actual)}"${ok ? "" : `  (wanted "${show(expected)}")`}`);
};

console.log("--- money ---");
eq("the spec's own example", money(3019.82), `R${THIN}3${THIN}019.82`);
eq("under a thousand",       money(119),     `R${THIN}119.00`);
eq("exactly a thousand",     money(1000),    `R${THIN}1${THIN}000.00`);
eq("two groups",             money(2418),    `R${THIN}2${THIN}418.00`);
eq("millions",               money(1234567.5), `R${THIN}1${THIN}234${THIN}567.50`);
eq("zero",                   money(0),       `R${THIN}0.00`);
eq("always two decimals",    money(31.05),   `R${THIN}31.05`);
eq("rounds half up",         money(0.005),   `R${THIN}0.01`);
eq("no currency prefix",     money(284.1, { currency: false }), "284.10");
eq("negative, plain",        money(-80.18),  `-R${THIN}80.18`);
eq("negative, true minus",   money(-80.18, { signed: true }), `−R${THIN}80.18`);
eq("survives NaN",           money(NaN),     `R${THIN}0.00`);

console.log("\n--- quantity ---");
eq("whole units drop the unit", quantity(20, "ea"),        "20");
eq("cut length",                quantity(2.5, "m"),        "2.5 m");
eq("trailing zeros trimmed",    quantity(3.0, "bag"),      "3 bag");
eq("weighed keeps 2 decimals",  quantity(6.4, "kg", true), "6.40 kg");
eq("sub-gram precision",        quantity(0.755, "kg"),     "0.755 kg");
eq("grouped quantity",          quantity(1200, "ea"),      `1${THIN}200`);

console.log("\n--- VAT within an inclusive price ---");
eq("the spec's total",  vatWithin(3019.82, 0.15), 393.89);
eq("a single bag",      vatWithin(115, 0.15),     15);
eq("zero-rated",        vatWithin(115, 0),        0);

console.log(`\n${results.filter((r) => !r).length} failure(s) of ${results.length}`);
process.exit(results.every(Boolean) ? 0 : 1);
