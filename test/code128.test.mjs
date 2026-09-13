/**
 * The barcode SVG is handed to innerHTML. The text between the barcode
 * markers is the document number — but a control character in a product or
 * buyer's name once put THEIR text there, and it landed inside an attribute
 * with no escaping. The builders now keep such text out of the markers;
 * this holds the second door: whatever the text, it cannot close the quote.
 */
import { readFileSync } from "node:fs";
import ts from "typescript";

const src = readFileSync(new URL("../src/lib/code128.ts", import.meta.url), "utf8");
const js = ts.transpileModule(src, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2020 },
}).outputText;
const { code128Svg } = await import("data:text/javascript;base64," + Buffer.from(js).toString("base64"));

let failures = 0;
const check = (label, ok, detail = "") => {
  if (ok) return;
  failures++;
  console.error(`FAIL ${label}${detail ? ` — ${detail}` : ""}`);
};

const plain = code128Svg("INV-000042");
check("a document number draws bars", /<rect/.test(plain) && plain.includes('aria-label="Barcode INV-000042"'));

const hostile = code128Svg('INV-1"><img src=x onerror=alert(1)>');
check("a quote in the text cannot close the attribute", !hostile.includes('"><img'), hostile);
check("and is written as an entity", hostile.includes("&quot;&gt;&lt;img"), hostile);
check("no img element survives anywhere in the markup", !/<img/.test(hostile), hostile);

if (failures) {
  console.error(`${failures} code128 check(s) failed`);
  process.exit(1);
}
console.log("code128: all checks passed");
