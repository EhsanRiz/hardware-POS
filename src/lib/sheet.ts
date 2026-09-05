// The A4 documents that leave the building: a quotation a builder signs, and
// a tax invoice a bookkeeper files.
//
// Not a replacement for the till slip. A 48-column thermal print is right for
// a walk-in buying a padlock, and wrong for a R40 000 quote or for an account
// customer whose accountant needs the shop's VAT number, the customer's own
// details and a serial number on one page. Both exist, for different people.
import type { ShopSettings } from "./types";

export type SheetKind = "quote" | "invoice" | "delivery" | "statement";

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

/**
 * One movement on an account, as a statement shows it.
 *
 * Not a SheetLine: a statement has no quantities and no unit prices. Forcing
 * it into the item table would put "1 ea" against a payment.
 */
export interface StatementEntry {
  /** Already formatted, by lib/dates. */
  date: string;
  ref: string;
  detail: string;
  charge: number;
  payment: number;
  /** The balance after this entry — the column a customer actually reads. */
  balance: number;
}

export interface StatementBody {
  from: string;
  to: string;
  /** Everything before the window, in one figure. */
  opening: number;
  entries: StatementEntry[];
  charges: number;
  payments: number;
  closing: number;
  /** How old the money is, as at today. */
  ageing: { current: number; days30: number; days60: number; days90: number };
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
  /** Where the load is going. */
  deliverTo?: string | null;
  deliverOn?: string | null;
  /** What the shop promised: "after 14:00", "Tue morning". */
  deliverAt?: string | null;
  /** The invoice these goods were sold on, so an office can match the two. */
  invoiceNumber?: string | null;
  /** Set on a statement, and only on a statement. */
  statement?: StatementBody;
}

export const SHEET_TITLE: Record<SheetKind, string> = {
  quote: "Quotation",
  // The words matter: SARS asks for them on the document itself.
  invoice: "Tax Invoice",
  delivery: "Delivery Note",
  statement: "Statement",
};

/**
 * A delivery note carries no money.
 *
 * The customer signs for goods received, not for what they cost — and the
 * person signing at a gate is often not the person who is paying. The invoice
 * carries the figures and travels with the load or after it.
 */
export const SHEET_PRICED: Record<SheetKind, boolean> = {
  quote: true,
  invoice: true,
  delivery: false,
  // A statement carries money, but not in the item table: see `statement`.
  statement: true,
};

/**
 * Where the shop is — the first line under its name.
 *
 * Kept apart from how to reach it because one run of address, telephone, email
 * and two registration numbers is a wall a reader has to search. Two short
 * lines answer two different questions: where do I go, and who am I dealing
 * with.
 */
export function shopWhere(s: ShopSettings): string[] {
  return [s.address_line1, s.address_line2]
    .filter((v) => (v ?? "").trim() !== "") as string[];
}

/** How to reach the shop, and who it is in law — the second line. */
export function shopReach(s: ShopSettings): string[] {
  return [
    s.phone ? `Tel ${s.phone}` : "",
    s.email ?? "",
    s.vat_number ? `VAT No ${s.vat_number}` : "",
    s.registration_number ? `Reg No ${s.registration_number}` : "",
  ].filter((v) => (v ?? "").trim() !== "") as string[];
}

/** Both, one per line — how the plain-text email body sets the letterhead. */
export function shopBlock(s: ShopSettings): string[] {
  return [...shopWhere(s), ...shopReach(s)];
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
  if (sheet.deliverTo) out.push(sheet.deliverTo);
  if (sheet.deliverOn) {
    out.push(`Delivery: ${sheet.deliverOn}${sheet.deliverAt ? `, ${sheet.deliverAt}` : ""}`);
  }
  if (sheet.invoiceNumber) out.push(`Invoice: ${sheet.invoiceNumber}`);
  if (sheet.poNumber) out.push(`Your order: ${sheet.poNumber}`);
  out.push("");
  if (sheet.statement) {
    const st = sheet.statement;
    out.push(`${st.from} to ${st.to}`);
    out.push("");
    out.push(`Balance brought forward ${money(st.opening)}`);
    for (const e of st.entries) {
      out.push(
        `${e.date}  ${e.ref ? `${e.ref}  ` : ""}${e.detail}` +
        (e.charge ? `  charge ${money(e.charge)}` : "") +
        (e.payment ? `  paid ${money(e.payment)}` : "") +
        `  balance ${money(e.balance)}`
      );
    }
    out.push("");
    out.push(`Charged ${money(st.charges)}`);
    out.push(`Paid ${money(st.payments)}`);
    out.push(`Balance now due ${money(st.closing)}`);
    out.push(
      `Current ${money(st.ageing.current)} · 30 days ${money(st.ageing.days30)}` +
      ` · 60 days ${money(st.ageing.days60)} · 90+ days ${money(st.ageing.days90)}`
    );
    const t = (s.receipt_terms ?? "").trim();
    if (t) { out.push(""); out.push(t); }
    return out.join("\n");
  }
  for (const l of sheet.lines) {
    out.push(
      `${l.qty} ${l.unit} × ${l.description}` +
      (l.code ? ` (${l.code})` : "") +
      (SHEET_PRICED[sheet.kind] ? ` — ${money(l.lineTotal)}` : "")
    );
  }
  if (SHEET_PRICED[sheet.kind]) {
    out.push("");
    out.push(`Subtotal ${money(sheet.subtotal)}`);
    if (sheet.discount > 0) out.push(`Discount -${money(sheet.discount)}`);
    out.push(`VAT ${money(sheet.vat)}`);
    out.push(`Total ${money(sheet.total)}`);
  }
  const terms = sheet.kind === "quote" ? s.quote_terms
    : sheet.kind === "delivery" ? null : s.receipt_terms;
  if (terms && terms.trim()) {
    out.push("");
    out.push(terms.trim());
  }
  return out.join("\n");
}
