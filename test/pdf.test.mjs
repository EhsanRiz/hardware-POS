// The emailed document is a real PDF file, not the till slip in the body of a
// message. These checks read the bytes the writer produces: the structure a
// reader needs to open it at all, and the text and geometry a builder needs to
// be able to read it once it is open.
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
const sheetMod = load("src/lib/sheet.ts", {});
const { sheetAsPdf, sheetFileName, widthOf } = load("src/lib/pdf.ts", {
  "./money": moneyMod,
  "./sheet": sheetMod,
});

const results = [];
const check = (label, ok, detail = "") => {
  results.push(ok);
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${ok ? "" : `  (${detail})`}`);
};

const shop = {
  shop_name: "5 Star Hardware Store",
  address_line1: "27B Piet Retief St",
  address_line2: "Ladybrand, 9745",
  phone: "065 735 2766",
  vat_number: "4230323000",
  currency: "R",
  registration_number: "",
  email: "",
  quote_terms: "Prices are subject to stock availability.",
  receipt_terms: "Returns within 10 days.",
};
const quote = {
  kind: "quote",
  number: "QUO-000020",
  date: "4 Sep 2026",
  validUntil: "18 Sep 2026",
  customer: { name: "Morija Exp" },
  lines: [{
    code: "NAIL-25-50", description: "Nail Wire Round 2.5 x 50mm",
    qty: 2, unit: "kg", unitPrice: 42, lineTotal: 84,
  }],
  subtotal: 73.04, discount: 0, vat: 10.96, total: 84,
};

const bytes = sheetAsPdf(quote, shop);
const text = Buffer.from(bytes).toString("latin1");

console.log("--- pdf: a file a reader can open ---");
check("it starts with the PDF header", text.startsWith("%PDF-1.4"), text.slice(0, 8));
check("and ends with the trailer marker", text.trimEnd().endsWith("%%EOF"));
check("there is a catalogue, a page tree and a page", /\/Type \/Catalog/.test(text)
  && /\/Type \/Pages/.test(text) && /\/Type \/Page\b/.test(text));
check("the page is A4, in points", /MediaBox \[0 0 595.28 841.89\]/.test(text));
// The cross-reference table is how a reader finds anything at all: every
// offset in it must land on the object it claims.
const xrefAt = Number(text.slice(text.lastIndexOf("startxref") + 9).trim().split("\n")[0]);
check("startxref points at the xref table", text.slice(xrefAt, xrefAt + 4) === "xref",
  JSON.stringify(text.slice(xrefAt, xrefAt + 8)));
const offsets = [...text.slice(xrefAt).matchAll(/^(\d{10}) 00000 n $/gm)].map((m) => Number(m[1]));
check("every object offset lands on its object", offsets.length > 4
  && offsets.every((o, i) => text.slice(o).startsWith(`${i + 1} 0 obj`)),
  `${offsets.length} offsets`);
// A wrong /Length truncates the page in a strict reader, which is most of them.
const declared = [...text.matchAll(/<< \/Length (\d+) >>\nstream\n/g)];
check("the content stream length is the length of the stream", declared.every((m) => {
  const start = m.index + m[0].length;
  return text.slice(start + Number(m[1]), start + Number(m[1]) + 10) === "\nendstream";
}), `${declared.length} streams`);

console.log("--- pdf: what is on the page ---");
const has = (s) => text.includes(`(${s}) Tj`);
check("the shop's name is set on it", has("5 Star Hardware Store"));
check("the address is one line and the contact details another",
  has("27B Piet Retief St, Ladybrand, 9745")
  && has("Tel 065 735 2766 \\267 VAT No 4230323000"));
check("it says what it is", has("Quotation") && has("QUO-000020"));
check("it names the customer", has("Morija Exp"));
check("the line is on it", has("Nail Wire Round 2.5 x 50mm") && has("NAIL-25-50"));
// The money formatter's thin space has no WinAnsi byte; it becomes a plain
// space rather than a question mark in the middle of a price.
check("the total is legible money, not mojibake", has("R 84.00"), "R 84.00");
check("the shop's own small print is on it", has("Prices are subject to stock availability."));
check("the invoice's small print is not", !has("Returns within 10 days."));
check("there is a line for the builder to sign", has("ACCEPTED BY") && has("Signature"));
check("InnovaPOS signs the foot", /InnovaPOS \\267 a product of InnovaEarth/.test(text));
check("and the E&OE disclaimer is there", has("E&OE. This document is computer generated and is valid without a signature."));

console.log("--- pdf: it is laid out, not stacked ---");
// THE CHECK THAT SHOULD HAVE BEEN FIRST. Every string, on every document, has
// to fit between the margins — and the ones that did not were the document
// number, the date, and the total, all drawn left-aligned FROM the right
// margin and running off the edge of the paper. The assertion below this one
// missed it: it matched the first "R 84.00" in the file, which was the line
// amount in the table, not the total underneath it. A test that finds the
// first thing that matches is a test that can be satisfied by the wrong thing.
const inside = (pdf, label) => {
  const bad = [...pdf.matchAll(
    /\/(F\d) ([\d.]+) Tf [\d. ]+rg 1 0 0 1 (-?[\d.]+) (-?[\d.]+) Tm \(([^)]*)\) Tj/g
  )].map((m) => ({
    x: Number(m[3]), y: Number(m[4]), text: m[5],
    end: Number(m[3]) + widthOf(m[5], Number(m[2]), m[1] === "F2"),
  })).filter((d) => d.x < 20 || d.end > 595.28 - 20 || d.y < 10 || d.y > 841.89 - 20);
  check(`nothing runs off the paper (${label})`, bad.length === 0,
    bad.slice(0, 3).map((d) => `"${d.text}" ${d.x.toFixed(0)}..${d.end.toFixed(0)}`).join("; "));
};
inside(text, "a one-line quotation");
// Right-aligned money is the whole reason the width tables exist: without them
// every figure starts at the same x and the column is ragged on the wrong side.
const place = (s) => {
  const m = text.match(new RegExp(`1 0 0 1 (-?[\\d.]+) (-?[\\d.]+) Tm \\(${s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\) Tj`));
  return m ? { x: Number(m[1]), y: Number(m[2]) } : null;
};
const right = 595.28 - 16 * (72 / 25.4);
// Two amounts of different lengths, set in the same style. Right-aligned they
// start at different x and end at the same edge; left-aligned — which is what
// you get if the width tables are wrong or unused — they start at the same x.
const twoLines = Buffer.from(sheetAsPdf({
  ...quote,
  lines: [
    { code: "A", description: "Short", qty: 1, unit: "ea", unitPrice: 84, lineTotal: 84 },
    { code: "B", description: "Long", qty: 1, unit: "ea", unitPrice: 12345.5, lineTotal: 12345.5 },
  ],
}, shop)).toString("latin1");
const at = (s) => {
  const m = twoLines.match(new RegExp(`1 0 0 1 (-?[\\d.]+) (-?[\\d.]+) Tm \\(${s}\\) Tj`));
  return m ? Number(m[1]) : null;
};
const short = at("R 84.00");
const long = at("R 12 345.50");
check("a longer amount starts further left, so the column ends flush",
  short !== null && long !== null && long < short - 15,
  `short ${short}, long ${long}`);
check("and neither runs past the right margin", short !== null && short < right && long < right,
  `right margin ${right.toFixed(2)}`);
check("the foot is near the bottom of the page, not under the last line",
  place("E&OE. This document is computer generated and is valid without a signature.").y < 90);
check("the letterhead is at the top", place("5 Star Hardware Store").y > 780);

// A description is the one field with no ceiling on it, and the quantities sit
// in the middle of the row rather than at the end. Set to the space between
// the description and the unit price, a long one ran straight through them.
const wide = Buffer.from(sheetAsPdf({
  ...quote,
  lines: [{
    code: "PVC-110",
    description: "PVC Sewer Pipe 110mm x 6m Class 34 solvent weld, SABS approved, grey",
    qty: 12, unit: "ea", unitPrice: 289.5, lineTotal: 3474,
  }],
}, shop)).toString("latin1");
const drawn = [...wide.matchAll(/1 0 0 1 ([\d.]+) [\d.]+ Tm \(([^)]*)\) Tj/g)]
  .map((m) => ({ x: Number(m[1]), s: m[2] }));
inside(wide, "a very long description");
const qty = drawn.find((d) => d.s === "12 ea");
const descLines = drawn.filter((d) => d.s.includes("PVC Sewer Pipe") || d.s.includes("SABS"));
check("a long description wraps rather than running on", descLines.length >= 2,
  `${descLines.length} lines`);
check("and no part of it reaches the quantity column",
  qty && descLines.every((d) => d.x + widthOf(d.s, 10) < qty.x - 4),
  qty ? `qty starts at ${qty.x}, widest description ends at ${Math.max(
    ...descLines.map((d) => d.x + widthOf(d.s, 10)))}` : "no qty found");

console.log("--- pdf: the invoice differs from the quote ---");
const inv = Buffer.from(sheetAsPdf({
  ...quote, kind: "invoice", number: "INV-000123", customer: { name: "Mokoena" },
}, { ...shop, bank_name: "FNB", bank_account_number: "62012345678" })).toString("latin1");
inside(inv, "a tax invoice with banking");
check("a tax invoice says so", inv.includes("(Tax Invoice) Tj"));
check("it has no signature block", !inv.includes("(ACCEPTED BY) Tj"));
check("it says where to pay while it is owed", inv.includes("(62012345678) Tj"));
check("a paid one does not", !Buffer.from(sheetAsPdf(
  { ...quote, kind: "invoice", number: "INV-1", paidWith: "Cash" },
  { ...shop, bank_name: "FNB", bank_account_number: "62012345678" }
)).toString("latin1").includes("(62012345678) Tj"));

console.log("--- pdf: more lines than fit on a page ---");
const many = sheetAsPdf({
  ...quote,
  lines: Array.from({ length: 60 }, (_, i) => ({
    code: `C-${i}`, description: `Item number ${i}`, qty: 1, unit: "ea",
    unitPrice: 10, lineTotal: 10,
  })),
}, shop);
const manyText = Buffer.from(many).toString("latin1");
inside(manyText, "sixty lines over two pages");
const pageCount = (manyText.match(/\/Type \/Page\b/g) || []).length;
check("it runs onto a second page rather than off the first", pageCount >= 2, `${pageCount} pages`);
check("and the count in the page tree agrees",
  new RegExp(`/Count ${pageCount}\\b`).test(manyText));
check("every line made it on", manyText.includes("(Item number 59) Tj"));
// Being IN the file is not being ON the paper. With the table's page break
// disabled the last twenty lines were still written into the stream, at
// coordinates hundreds of points below the bottom edge, and both checks above
// stayed green over a document nobody could read. This is the one that fails.
const ys = [...manyText.matchAll(/1 0 0 1 -?[\d.]+ (-?[\d.]+) Tm/g)].map((m) => Number(m[1]));
check("and none of it is drawn off the bottom of the paper",
  ys.length > 60 && ys.every((y) => y > 10 && y < 841.89),
  `${ys.length} strings, lowest at ${Math.min(...ys)}`);
check("the column heads repeat on the new page",
  (manyText.match(/\(DESCRIPTION\) Tj/g) || []).length === pageCount);

console.log("--- pdf: the shop's own mark ---");
// A one-pixel JPEG is a real JPEG: SOI, a minimal frame, EOI. What matters
// here is that the bytes go in untouched and the reader is told how to read
// them, not what the picture is.
const JPEG = Buffer.from(
  "/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0a" +
  "HBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAA" +
  "AAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==", "base64");
const withLogo = Buffer.from(sheetAsPdf(quote, shop, {
  jpeg: new Uint8Array(JPEG), width: 400, height: 120,
})).toString("latin1");
check("the image is declared as a JPEG the reader can decode",
  /\/Subtype \/Image \/Width 400 \/Height 120 \/ColorSpace \/DeviceRGB \/BitsPerComponent 8 \/Filter \/DCTDecode/
    .test(withLogo));
check("its bytes go in whole and its length is honest", (() => {
  const m = withLogo.match(/\/Filter \/DCTDecode \/Length (\d+) >>\nstream\n/);
  if (!m) return false;
  const start = m.index + m[0].length;
  return Number(m[1]) === JPEG.length
    && withLogo.slice(start, start + JPEG.length) === JPEG.toString("latin1")
    && withLogo.slice(start + JPEG.length, start + JPEG.length + 10) === "\nendstream";
})());
check("the page can reach it", /\/XObject << \/Im1 5 0 R >>/.test(withLogo));
// 400x120 into the screen's own 20mm x 80mm box. The box is 226.77 x 56.69pt,
// wider in proportion than the mark, so the HEIGHT binds: 56.69 tall and
// 188.98 wide, centred on a 595.28pt page at x = 203.15. A mark stretched to
// fill the box instead would come out 226.77 x 56.69 and visibly squashed.
check("it is drawn to fit its box, not stretched to fill it",
  /q 188.98 0 0 56.69 203.15 [\d.]+ cm \/Im1 Do Q/.test(withLogo),
  (withLogo.match(/q [\d.]+ 0 0 [\d.]+ [\d.]+ [\d.]+ cm/) || ["none"])[0]);
check("the shop's name is still set beneath it", withLogo.includes("(5 Star Hardware Store) Tj"));
inside(withLogo, "a quotation with a logo");
// Everything below the mark moves down by its height; nothing may be pushed
// off the page or on top of anything else.
const titleY = (pdf) => Number(pdf.match(/1 0 0 1 [\d.]+ ([\d.]+) Tm \(Quotation\) Tj/)[1]);
check("and the rest of the letterhead moves down to make room for it",
  titleY(withLogo) < titleY(text) - 60,
  `with ${titleY(withLogo)}, without ${titleY(text)}`);
// No logo, no image machinery at all — an empty /XObject entry is a reference
// to an object that is not there.
check("a shop with no logo gets no image objects", !text.includes("/XObject")
  && !text.includes("/DCTDecode"));

console.log("--- pdf: the file it arrives as ---");
check("the attachment is named for the document",
  sheetFileName(quote) === "Quotation-QUO-000020.pdf", sheetFileName(quote));
check("and a tax invoice's name has no space in it",
  sheetFileName({ ...quote, kind: "invoice", number: "INV-9" }) === "Tax-Invoice-INV-9.pdf");

const failed = results.filter((r) => !r).length;
console.log(`\n${failed} failure(s)`);
if (failed) process.exit(1);
