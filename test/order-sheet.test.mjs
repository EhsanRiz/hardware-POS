/**
 * A purchase order as a document: lines ex VAT, VAT at the shop's rate, the
 * supplier where a customer would stand, with their email so Email opens
 * to them. Pure (src/lib/orderSheet.ts).
 */
import { readFileSync } from "node:fs";
import ts from "typescript";

const src = readFileSync(new URL("../src/lib/orderSheet.ts", import.meta.url), "utf8");
const js = ts.transpileModule(src, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
const { orderSheet } = await import("data:text/javascript;base64," + Buffer.from(js).toString("base64"));

let failures = 0;
function check(label, actual, expected) {
  const ok = Object.is(actual, expected);
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}  → ${JSON.stringify(actual)}${ok ? "" : ` (expected ${JSON.stringify(expected)})`}`);
}

const sheet = orderSheet({
  number: "PO-000003", date: "10 Sep 2026",
  supplier: { name: "Jasbro Plumbing", phone: "010 442 0625", vatNumber: "4370229645", email: "info@jasbro.co.za" },
  lines: [
    { sku: "CBL-25-100", name: "Twin & Earth 2.5mm 100m", unit_code: "roll", qty: 6, unit_cost: 50 },
    { sku: null, name: "Something unpriced", unit_code: "ea", qty: 2, unit_cost: null },
    { sku: "PL0065", name: "Comp elbow 15mm", unit_code: "ea", qty: 20, unit_cost: 16.85 },
  ],
  rate: 0.15, expectedOn: "17 Sep 2026", raisedBy: "Manager", deliverTo: "12 Church St, Ladybrand",
});

console.log("--- it is an order, to the supplier ---");
check("kind", sheet.kind, "order");
check("number", sheet.number, "PO-000003");
check("the supplier stands where the customer would", sheet.customer.name, "Jasbro Plumbing");
check("with their email, for the Email button", sheet.customer.email, "info@jasbro.co.za");
check("and their VAT number", sheet.customer.vatNumber, "4370229645");

console.log("--- the money: lines ex VAT, VAT at the shop's rate ---");
check("a line is qty × cost", sheet.lines[0].lineTotal, 300);
check("an unpriced line is nought, not a crash", sheet.lines[1].lineTotal, 0);
check("subtotal, to the cent", sheet.subtotal, 637);
check("VAT at 15%", sheet.vat, 95.55);
check("total incl VAT", sheet.total, 732.55);
check("no discount on an order", sheet.discount, 0);

console.log("--- the rest of the paper ---");
check("where to deliver goes in the note", sheet.note, "Please deliver to: 12 Church St, Ladybrand");
check("when it is expected", sheet.deliverOn, "17 Sep 2026");
check("who raised it", sheet.servedBy, "Manager");
check("the code column carries the shop's SKU", sheet.lines[0].code, "CBL-25-100");
check("a note and a delivery address share the note", orderSheet({ number: "x", date: "d", supplier: { name: "s" }, lines: [], rate: 0.15, note: "Ring first", deliverTo: "Here" }).note, "Please deliver to: Here\nRing first");
check("no address, no note: null", orderSheet({ number: "x", date: "d", supplier: { name: "s" }, lines: [], rate: 0.15 }).note, null);

console.log(`\n${failures} failure(s)`);
process.exit(failures ? 1 : 0);
