// The ESC/POS stream for a barcode. The slip prints the document number on its
// own line above the bars, so the printer must NOT print it again beneath them
// (GS H 0) — with GS H 2 the invoice number appeared twice on every slip.
import { readFileSync } from "fs";
import ts from "typescript";

const src = readFileSync("src/lib/print.ts", "utf8");
const js = ts.transpileModule(src, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
}).outputText;

// print.ts leans on four sibling modules; none of them matter to the bytes a
// barcode produces, so each is stood in for by the least that lets it load.
const stubs = {
  "./config": { PRINT_WIDTH_SCALE: 1, PRINT_HEIGHT_SCALE: 1 },
  "./logoRaster": { LOGO_ESCPOS_B64: "" },
  "./printPreview": { openPrintPreview: () => {} },
  "./receipt": { stripMarkup: (s) => s },
};
const exports_ = {};
new Function("exports", "require", js)(exports_, (m) => stubs[m] ?? {});
const { buildEscPos } = exports_;

const results = [];
const check = (label, ok, detail = "") => {
  results.push(ok);
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${ok ? "" : `  (${detail})`}`);
};

console.log("--- print: barcode bytes ---");
const GS = 0x1d;
const bytes = buildEscPos("Invoice No: INV-000001\n\x05INV-000001\x06\n");
const hri = [];
for (let i = 0; i + 2 < bytes.length; i++) {
  if (bytes[i] === GS && bytes[i + 1] === 0x48) hri.push(bytes[i + 2]);
}
check("the barcode sets an HRI position exactly once", hri.length === 1, `saw ${hri.length}`);
check("and it is 'none' — the number is already printed above the bars", hri[0] === 0, `GS H ${hri[0]}`);

// The bars themselves still go: GS k 73 (Code 128) with the {B set-B prefix.
let hasBars = false;
for (let i = 0; i + 5 < bytes.length; i++) {
  if (bytes[i] === GS && bytes[i + 1] === 0x6b && bytes[i + 2] === 0x49
      && bytes[i + 4] === 0x7b && bytes[i + 5] === 0x42) hasBars = true;
}
check("the Code 128 bars are still emitted", hasBars);


console.log("--- print: control bytes in a name ---");
// A product named with ESC p (drawer kick), GS V (cut) and a bell must print
// as its letters and nothing else: no byte below a space but the newline.
const evil = buildEscPos("Cement\x1bp\x00\x07 bag\x1dV\x00\nNext");
// Legitimate ESC/POS the builder itself emits (init, size, alignment) sits at
// the start and around the barcode; a name's bytes are between the letters.
const textStart = evil.indexOf("C".charCodeAt(0));
const textEnd = evil.lastIndexOf("t".charCodeAt(0));
const inText = evil.slice(textStart, textEnd + 1).filter((b) => b < 0x20 && b !== 0x0a);
check("no control byte from a name reaches the printer", inText.length === 0, `saw ${inText.map((b) => b.toString(16)).join(" ")}`);
check("the letters around them still print", String.fromCharCode(...evil.slice(textStart, textStart + 6)) === "Cement");

const withBar = buildEscPos("\x05INV\x01-1\x06");
const k = withBar.indexOf(0x6b); // GS k 73 n, then "{B" + data
const n = withBar[k + 2];
const payload = withBar.slice(k + 3, k + 3 + n);
check("a barcode region keeps only printable ASCII", payload.every((b) => b >= 0x20 && b <= 0x7e), payload.join(","));

const failed = results.filter((r) => !r).length;
if (failed) {
  console.error(`\n${failed} check(s) failed`);
  process.exit(1);
}
console.log("\nall print checks passed");
