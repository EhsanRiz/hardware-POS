// The A4 documents that leave the building: a quotation a builder signs, and
// a tax invoice a bookkeeper files.
//
// Not a replacement for the till slip. A 48-column thermal print is right for
// a walk-in buying a padlock, and wrong for a R40 000 quote or for an account
// customer whose accountant needs the shop's VAT number, the customer's own
// details and a serial number on one page. Both exist, for different people.
import type { ShopSettings } from "./types";

export type SheetKind = "quote" | "invoice";

export interface SheetLine {
  /** The shop's own code, so a customer can quote it back. */
  code?: string | null;
  description: string;
  qty: number;
  unit: string;
  unitPrice: number;
  /** Money off this line, if any. */
  discount?: number;
  lineTotal: number;
}

export interface SheetCustomer {
  name?: string | null;
  address?: string | null;
  phone?: string | null;
  /** Their VAT registration — what makes this a FULL tax invoice. */
  vatNumber?: string | null;
}

export interface Sheet {
  kind: SheetKind;
  /** The shop's own serial number for it. */
  number: string;
  date: string;
  validUntil?: string | null;
  customer: SheetCustomer;
  poNumber?: string | null;
  lines: SheetLine[];
  subtotal: number;
  discount: number;
  vat: number;
  total: number;
  note?: string | null;
  servedBy?: string | null;
  trade?: boolean;
  /** How it was paid, on an invoice that has been settled. */
  paidWith?: string | null;
}

export const SHEET_TITLE: Record<SheetKind, string> = {
  quote: "Quotation",
  // The words matter: SARS asks for them on the document itself.
  invoice: "Tax Invoice",
};

/** The shop's block, as the head of the document sets it. */
export function shopBlock(s: ShopSettings): string[] {
  return [
    s.address_line1,
    s.address_line2,
    s.phone ? `Tel ${s.phone}` : "",
    s.email ?? "",
    s.vat_number ? `VAT No ${s.vat_number}` : "",
    s.registration_number ? `Reg No ${s.registration_number}` : "",
  ].filter((v) => (v ?? "").trim() !== "") as string[];
}

/** The document as plain text, for the body of an email. */
export function sheetAsText(sheet: Sheet, s: ShopSettings): string {
  const money = (n: number) => `${s.currency ?? "R"} ${n.toFixed(2)}`;
  const out: string[] = [];
  out.push(s.shop_name);
  out.push(...shopBlock(s));
  out.push("");
  out.push(`${SHEET_TITLE[sheet.kind]} ${sheet.number}`);
  out.push(sheet.date);
  if (sheet.validUntil) out.push(`Valid until ${sheet.validUntil}`);
  if (sheet.customer.name) out.push(`For: ${sheet.customer.name}`);
  if (sheet.poNumber) out.push(`Your order: ${sheet.poNumber}`);
  out.push("");
  for (const l of sheet.lines) {
    out.push(
      `${l.qty} ${l.unit} × ${l.description}` +
      (l.code ? ` (${l.code})` : "") +
      ` — ${money(l.lineTotal)}`
    );
  }
  out.push("");
  out.push(`Subtotal ${money(sheet.subtotal)}`);
  if (sheet.discount > 0) out.push(`Discount -${money(sheet.discount)}`);
  out.push(`VAT ${money(sheet.vat)}`);
  out.push(`Total ${money(sheet.total)}`);
  const terms = sheet.kind === "quote" ? s.quote_terms : s.receipt_terms;
  if (terms && terms.trim()) {
    out.push("");
    out.push(terms.trim());
  }
  return out.join("\n");
}
