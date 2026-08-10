import {
  CURRENCY,
  RECEIPT_WIDTH,
  SHOP_ADDRESS,
  VAT_NUMBER,
  VAT_RATE,
} from "./config";
import type { ReceiptItem, Sale } from "./types";

// Plain-text receipt builder. Width-parameterised (RECEIPT_WIDTH columns) so it
// adapts to the paper + font scale. The print layer wraps this with ESC/POS.

function center(text: string, width = RECEIPT_WIDTH): string {
  if (text.length >= width) return text;
  const pad = Math.floor((width - text.length) / 2);
  return " ".repeat(pad) + text;
}

// Left-justified label with a right-justified amount on the SAME line. If the
// label is too long, the amount still stays on the first line and the rest of
// the label wraps onto following lines (the price is never pushed underneath).
function lineItem(left: string, right: string, width = RECEIPT_WIDTH): string {
  const firstLeft = width - right.length - 1; // keep ≥1 space before the amount
  if (left.length <= firstLeft) {
    return left + " ".repeat(width - left.length - right.length) + right;
  }
  const line1 = left.slice(0, firstLeft) + " " + right;
  const rest = left.slice(firstLeft);
  const cont: string[] = [];
  for (let i = 0; i < rest.length; i += width) cont.push(rest.slice(i, i + width));
  return [line1, ...cont].join("\n");
}

function divider(ch = "-", width = RECEIPT_WIDTH): string {
  return ch.repeat(width);
}

// A continuous solid rule (underscores join up) to separate sections.
function solid(width = RECEIPT_WIDTH): string {
  return "_".repeat(width);
}

// ASCII box (prints reliably on any ESC/POS printer) for emphasis.
function boxTop(width = RECEIPT_WIDTH): string {
  return "+" + "-".repeat(width - 2) + "+";
}
function boxRow(left: string, right: string, width = RECEIPT_WIDTH): string {
  return "| " + lineItem(left, right, width - 4) + " |";
}

function amount(n: number): string {
  return `${CURRENCY}${n.toFixed(2)}`;
}

// Emphasis markup (bold / underline). The print layer turns these markers into
// ESC/POS control codes and the on-screen preview turns them into <b>/<u>;
// plain-text (.txt) exports strip them. We wrap a *fully built* line so the
// markers never affect column alignment.
export const BOLD_ON = String.fromCharCode(1);
export const BOLD_OFF = String.fromCharCode(2);
export const UL_ON = String.fromCharCode(3);
export const UL_OFF = String.fromCharCode(4);
function bold(s: string): string {
  return BOLD_ON + s + BOLD_OFF;
}
function underline(s: string): string {
  return UL_ON + s + UL_OFF;
}
const MARKUP_RE = new RegExp(
  "[" + BOLD_ON + BOLD_OFF + UL_ON + UL_OFF + "]",
  "g"
);
export function stripMarkup(s: string): string {
  return s.replace(MARKUP_RE, "");
}

// Short date/time that fits a narrow, large-font receipt.
function fmtDateTime(d: Date): string {
  return `${d.toLocaleDateString()} ${d.toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  })}`;
}

function itemLabel(qty: number, name: string): string {
  return `${qty}x ${name}`;
}

// Shop address + VAT number + slip title, printed under the logo. The shop name
// is intentionally omitted — the printed logo carries the branding.
function shopHeader(out: string[], title: string): void {
  for (const line of SHOP_ADDRESS) out.push(center(line));
  if (VAT_NUMBER) out.push(center(`VAT No: ${VAT_NUMBER}`));
  out.push(center(title));
}

const VAT_PCT = `${+(VAT_RATE * 100).toFixed(2)}%`;

// VAT portion of a VAT-inclusive amount (e.g. 15 out of 115).
function vatOf(inclusiveAmount: number): number {
  return inclusiveAmount - inclusiveAmount / (1 + VAT_RATE);
}

export function buildReceiptText(
  sale: Sale,
  items: ReceiptItem[],
  account?: { name: string; balance: number } | null
): string {
  const out: string[] = [];
  shopHeader(out, "TAX INVOICE");
  out.push("");
  out.push(`Invoice No: ${sale.id.slice(0, 8)}`);
  out.push(fmtDateTime(new Date(sale.created_at)));
  out.push(`By: ${sale.cashier_name}`);
  out.push(solid());

  for (const item of items) {
    out.push(lineItem(itemLabel(item.qty, item.name), amount(item.price * item.qty)));
  }

  // Totals — all amounts right-aligned to the same edge.
  out.push(solid());
  out.push(lineItem("Subtotal", amount(sale.subtotal)));
  if (sale.discount_amount > 0) {
    out.push(lineItem("Discount", `-${amount(sale.discount_amount)}`));
    if (sale.discount_reason) out.push(`(${sale.discount_reason})`);
  }
  if (sale.tip_amount > 0) out.push(lineItem("Tip", amount(sale.tip_amount)));
  out.push(bold(underline(lineItem("TOTAL", amount(sale.total)))));
  // VAT is included in the prices; show the tax portion of the goods total.
  out.push(lineItem(`VAT (${VAT_PCT}) incl`, amount(vatOf(sale.subtotal - sale.discount_amount))));
  out.push(solid());

  if (sale.payment_method === "account") {
    out.push("");
    out.push(lineItem("ON ACCOUNT", ""));
    if (account) {
      out.push(account.name);
      out.push(lineItem("Account balance", amount(account.balance)));
    }
  } else if (sale.payment_method === "split") {
    out.push("");
    out.push(lineItem("Paid", "SPLIT"));
    out.push(lineItem("Cash", amount(sale.paid_cash ?? 0)));
    out.push(lineItem("Card", amount(sale.paid_card ?? 0)));
  } else if (sale.payment_method) {
    out.push("");
    out.push(lineItem("Paid", sale.payment_method.toUpperCase()));
    if (sale.amount_tendered != null)
      out.push(lineItem("Cash", amount(sale.amount_tendered)));
    if (sale.change_due != null)
      out.push(lineItem("Change", amount(sale.change_due)));
  }
  if (sale.approved_by_name) {
    out.push("");
    out.push(`Appr: ${sale.approved_by_name}`);
  }
  out.push(solid());
  out.push(center("Thank you!"));
  out.push("");
  out.push("");
  out.push("");
  return out.join("\n");
}

// A sample slip for testing the printer / RawBT setup on the tablet.
export function buildTestText(): string {
  const out: string[] = [];
  out.push(center("PRINTER TEST"));
  out.push("");
  out.push(fmtDateTime(new Date()));
  out.push(`${RECEIPT_WIDTH} columns`);
  out.push(divider());
  out.push(lineItem("Cement 42.5N 50kg", amount(115)));
  out.push(lineItem("2.5m x Chain 6mm", amount(87.5)));
  out.push(boxTop());
  out.push(boxRow("TOTAL", amount(202.5)));
  out.push(boxTop());
  out.push("");
  out.push(center("It works!"));
  out.push("");
  out.push("");
  out.push("");
  return out.join("\n");
}

// End-of-day reconciliation slip. Works for a single cashier or the whole day
// (pass cashier = null for the combined total).
export function buildEndOfDaySlip(opts: {
  dateLabel: string;
  cashier: string | null;
  salesCount: number;
  cash: number;
  card: number;
  other: number;
  tips: number;
  discount: number;
  total: number; // money collected
  printedBy: string;
  accountRepaidCash?: number;
  accountRepaidCard?: number;
  accountOwed?: number; // charged on account, not collected
}): string {
  const out: string[] = [];
  out.push(center("END OF DAY"));
  out.push("");
  out.push(opts.dateLabel);
  out.push(opts.cashier ? `Staff: ${opts.cashier}` : "All staff");
  out.push(divider());
  out.push(lineItem("No. of sales", String(opts.salesCount)));
  out.push(lineItem("Cash", amount(opts.cash)));
  out.push(lineItem("Card", amount(opts.card)));
  if (opts.other > 0) out.push(lineItem("Unspecified", amount(opts.other)));
  // Cash/Card already include account repayments; note how much for the audit.
  if (opts.accountRepaidCash || opts.accountRepaidCard) {
    const bits: string[] = [];
    if (opts.accountRepaidCash) bits.push(`cash ${amount(opts.accountRepaidCash)}`);
    if (opts.accountRepaidCard) bits.push(`card ${amount(opts.accountRepaidCard)}`);
    out.push(`(incl. acct repaid: ${bits.join(", ")})`);
  }
  out.push(lineItem("Tips", amount(opts.tips)));
  out.push(lineItem("Discounts", `-${amount(opts.discount)}`));
  out.push(boxTop());
  out.push(boxRow("TOTAL COLLECTED", amount(opts.total)));
  out.push(boxTop());
  if (opts.accountOwed) {
    out.push("");
    out.push(lineItem("On account (owed)", amount(opts.accountOwed)));
    out.push("(not collected)");
  }
  out.push(divider("="));
  out.push(`Printed by ${opts.printedBy}`);
  out.push(fmtDateTime(new Date()));
  out.push("");
  out.push("");
  out.push("");
  return out.join("\n");
}

// Aggregate sales report for a chosen date range (money is cash-basis).
export function buildSalesReportSlip(opts: {
  rangeLabel: string;
  salesCount: number;
  collected: number;
  cash: number;
  card: number;
  accountOwed: number;
  tips: number;
  discount: number;
  printedBy: string;
  topItems?: { name: string; qty: number; revenue: number }[];
}): string {
  const out: string[] = [];
  out.push(center("SALES REPORT"));
  out.push("");
  out.push(opts.rangeLabel);
  out.push(divider());
  out.push(lineItem("No. of sales", String(opts.salesCount)));
  out.push(lineItem("Cash", amount(opts.cash)));
  out.push(lineItem("Card", amount(opts.card)));
  out.push(lineItem("Tips", amount(opts.tips)));
  out.push(lineItem("Discounts", `-${amount(opts.discount)}`));
  out.push(boxTop());
  out.push(boxRow("COLLECTED", amount(opts.collected)));
  out.push(boxTop());
  if (opts.accountOwed > 0) {
    out.push("");
    out.push(lineItem("On account (owed)", amount(opts.accountOwed)));
    out.push("(not collected)");
  }
  if (opts.topItems && opts.topItems.length) {
    out.push(divider());
    out.push("Top items:");
    for (const t of opts.topItems)
      out.push(lineItem(`${t.qty}x ${t.name}`, amount(t.revenue)));
  }
  out.push(divider("="));
  out.push(`Printed by ${opts.printedBy}`);
  out.push(fmtDateTime(new Date()));
  out.push("");
  out.push("");
  out.push("");
  return out.join("\n");
}

// Itemised list of every invoice in a date range, with a grand total.
export function buildInvoicesSlip(opts: {
  rangeLabel: string;
  invoices: { no: string; at: string; total: number }[];
  count: number;
  total: number;
  printedBy: string;
}): string {
  const out: string[] = [];
  out.push(center("INVOICES"));
  out.push("");
  out.push(opts.rangeLabel);
  out.push(divider());
  for (const inv of opts.invoices) {
    out.push(lineItem(`#${inv.no} ${inv.at}`, amount(inv.total)));
  }
  if (opts.invoices.length === 0) out.push("No invoices in this period.");
  out.push(boxTop());
  out.push(boxRow(`TOTAL (${opts.count})`, amount(opts.total)));
  out.push(boxTop());
  out.push(divider("="));
  out.push(`Printed by ${opts.printedBy}`);
  out.push(fmtDateTime(new Date()));
  out.push("");
  out.push("");
  out.push("");
  return out.join("\n");
}

// Slip for an account repayment (customer paying down what they owe).
export function buildAccountPaymentSlip(opts: {
  accountName: string;
  amount: number;
  method: string;
  newBalance: number;
  receivedBy: string;
}): string {
  const out: string[] = [];
  shopHeader(out, "ACCOUNT PAYMENT");
  out.push("");
  out.push(opts.accountName);
  out.push(fmtDateTime(new Date()));
  out.push(`By: ${opts.receivedBy}`);
  out.push(solid());
  out.push(lineItem("Amount paid", amount(opts.amount)));
  out.push(lineItem("Method", opts.method.toUpperCase()));
  out.push(boxTop());
  out.push(boxRow("BALANCE DUE", amount(opts.newBalance)));
  out.push(boxTop());
  out.push(solid());
  out.push(center("Thank you!"));
  out.push("");
  out.push("");
  out.push("");
  return out.join("\n");
}

export function buildBillText(opts: {
  items: ReceiptItem[];
  subtotal: number;
  discount: number;
  total: number;
  label?: string | null;
  tipPercents: number[];
}): string {
  const out: string[] = [];
  shopHeader(out, "BILL");
  out.push(center("not a tax invoice"));
  out.push("");
  if (opts.label) out.push(`Tab: ${opts.label}`);
  out.push(fmtDateTime(new Date()));
  out.push(solid());

  for (const item of opts.items) {
    out.push(lineItem(itemLabel(item.qty, item.name), amount(item.price * item.qty)));
  }

  // Totals — all amounts right-aligned to the same edge.
  out.push(solid());
  out.push(lineItem("Subtotal", amount(opts.subtotal)));
  if (opts.discount > 0) out.push(lineItem("Discount", `-${amount(opts.discount)}`));
  out.push(bold(underline(lineItem("TOTAL", amount(opts.total)))));
  out.push(lineItem(`VAT (${VAT_PCT}) incl`, amount(vatOf(opts.total))));
  out.push(solid());

  // Tip options the customer can tick. Each line keeps the tick-box, the
  // percentage and its value grouped together (box + % right next to the
  // amount) rather than spread to opposite edges. The percentage column is
  // padded so the amounts line up. A custom amount goes on the "Tip:" write-in
  // line below, so there's no separate "Other" tick-box here.
  out.push("Add a tip (tick one):");
  const pctWidth = Math.max(...opts.tipPercents.map((p) => `${p}%`.length));
  for (const pct of opts.tipPercents) {
    const label = `${pct}%`.padEnd(pctWidth);
    out.push(`[ ] ${label}  ${amount((opts.total * pct) / 100)}`);
  }
  out.push(solid());

  // Write-in lines — blank space above and between them for writing by pen.
  // The currency sign is pre-printed so the amount is clearly in Maloti.
  const writeRule = "_".repeat(RECEIPT_WIDTH - 8 - CURRENCY.length);
  out.push("");
  out.push(`Tip:   ${CURRENCY} ${writeRule}`);
  out.push("");
  out.push("");
  out.push(bold(`Total: ${CURRENCY} ${writeRule}`));
  out.push(solid());
  out.push(center("Pay at the till"));
  out.push("");
  out.push("");
  out.push("");
  return out.join("\n");
}
