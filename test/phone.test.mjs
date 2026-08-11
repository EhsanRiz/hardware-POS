/**
 * Phone normalisation, which is the whole repeat-buyer feature in one function.
 *
 * If this is wrong the failure is silent and expensive: the same contractor
 * gets a fresh customer record on every visit, "repeat buyer" means nothing,
 * and the returns counter can no longer find what anyone bought. Nothing
 * throws. The data just quietly becomes useless.
 *
 * This must stay in step with public.normalize_phone() in migration 0023. If
 * the two disagree, the till finds a buyer offline that the server does not
 * find online, or the other way round.
 */
import { readFileSync } from "node:fs";
import ts from "typescript";

const src = readFileSync(new URL("../src/lib/phone.ts", import.meta.url), "utf8");
const js = ts.transpileModule(src, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2020 },
}).outputText;
const { normalizePhone, looksLikePhone, formatPhone, phoneMatches } = await import(
  "data:text/javascript;base64," + Buffer.from(js).toString("base64")
);

let failures = 0;
function check(label, actual, expected) {
  const ok = Object.is(actual, expected);
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}  → ${JSON.stringify(actual)}${ok ? "" : ` (expected ${JSON.stringify(expected)})`}`);
}

console.log("--- one buyer, however they write their number ---");
const SAME = [
  "082 123 4567",
  "0821234567",
  "+27 82 123 4567",
  "+27821234567",
  "27821234567",
  "0027821234567",
  "82 123 4567",
  "082-123-4567",
  "(082) 123 4567",
  " 082 123 4567 ",
];
for (const spelling of SAME) {
  check(`"${spelling}"`, normalizePhone(spelling), "+27821234567");
}

console.log("\n--- and they are all genuinely the same key ---");
const distinct = new Set(SAME.map((s) => normalizePhone(s)));
check("ten spellings collapse to one", distinct.size, 1);

console.log("\n--- a number that is not this shop's country ---");
check("Lesotho, typed in full", normalizePhone("+266 5800 0001"), "+26658000001");
check("Lesotho via 00", normalizePhone("00266 5800 0001"), "+26658000001");
check("a Lesotho shop's own default", normalizePhone("5800 0001", "+266"), "+26658000001");

console.log("\n--- rubbish is rejected, not stored ---");
check("empty", normalizePhone(""), null);
check("whitespace", normalizePhone("   "), null);
check("null", normalizePhone(null), null);
check("undefined", normalizePhone(undefined), null);
check("a name", normalizePhone("Mokoena"), null);
check("a mistyped five digits", normalizePhone("12345"), null);
check("too short even with a code", normalizePhone("0821234"), null);
check("absurdly long", normalizePhone("+1234567890123456789"), null);

console.log("\n--- a landline is a phone number too ---");
check("Ladybrand landline", normalizePhone("051 924 0000"), "+27519240000");

console.log("\n--- telling a number from a name ---");
check("a phone", looksLikePhone("082 123 4567"), true);
check("a partial phone", looksLikePhone("082123"), true);
check("a name", looksLikePhone("Mokoena"), false);
check("an account code", looksLikePhone("TRD-001"), false);
check("too few digits to guess", looksLikePhone("12"), false);

console.log("\n--- shown back the way people write it ---");
check("mobile", formatPhone("+27821234567"), "082 123 4567");
check("foreign left alone", formatPhone("+26658000001"), "+26658000001");
check("nothing", formatPhone(null), "");

console.log("\n--- matching while the cashier is still typing ---");
check("full number", phoneMatches("082 123 4567", "0821234567"), true);
check("different spelling", phoneMatches("+27821234567", "082 123 4567"), true);
check("partial", phoneMatches("082 123 4567", "1234"), true);
check("a different buyer", phoneMatches("082 123 4567", "0839999999"), false);
check("too little to go on", phoneMatches("082 123 4567", "08"), false);
check("no number on file", phoneMatches(null, "0821234567"), false);

console.log(`\n${failures} failure(s)`);
process.exit(failures ? 1 : 0);
