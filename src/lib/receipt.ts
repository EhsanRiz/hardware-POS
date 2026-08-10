import { CURRENCY, RECEIPT_WIDTH } from "./config";
import { shopSettings } from "./settings";
import type { CartLine, ReceiptItem, Sale } from "./types";

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
  const firstLeft = width - right.length - 1; // keep >=1 space before the amount
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

function solid(width = RECEIPT_WIDTH): string {
  return "_".repeat(width);
}

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

function fmtDateTime(d: Date): string {
  return `${d.toLocaleDateString()} ${d.toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  })}`;
}

/**
 * Trim trailing zeros from a quantity: 3 stays "3", 2.5 stays "2.5", 0.750
 * becomes "0.75". A hardware invoice reads badly with "3.000 bag".
 */
export function fmtQty(qty: number): string {
  return String(Number(qty.toFixed(3)));
}

/**
 * How a line is described on the slip.
 *
 * The unit is not decoration — "2.5 Chain 6mm" is ambiguous and "2.5 m Chain
 * 6mm" is not, and for anything cut to length the customer is checking exactly
 * this. Whole "each" items keep the familiar "3x Padlock" form.
 */
export function itemLabel(qty: number, unitCode: string, name: string): string {
  return unitCode === "ea"
    ? `${fmtQty(qty)}x ${name}`
    : `${fmtQty(qty)} ${unitCode} ${name}`;
}

/** Unit price shown under a cut-to-length line, e.g. "@ R35.00/m". */
function unitRate(unitPrice: number, unitCode: string): string {
  return `  @ ${amount(unitPrice)}/${unitCode}`;
}

// Shop address + VAT number + slip title, printed under the logo. The shop name
// is intentionally omitted — the printed logo carries the branding.
function shopHeader(out: string[], title: string): void {
  const s = shopSettings();
  for (const line of [s.address_line1, s.address_line2].filter(Boolean)) {
    out.push(center(line));
  }
  if (s.phone) out.push(center(`Tel: ${s.phone}`));
  if (s.vat_number) out.push(center(`VAT No: ${s.vat_number}`));
  out.push(center(title));
}

/**
 * Build a tax invoice for a completed sale.
 *
 * VAT comes from `sale.tax_amount` — the figure the server computed and stored
 * when the sale was rung up — not from a rate applied at print time. Reprinting
 * a two-year-old invoice therefore restates what was actually charged, which is
 * what a tax invoice is supposed to do.
 */
export function buildReceiptText(
  sale: Sale,
  items: ReceiptItem[],
  customer?: { name: string; balance: number } | null
): string {
  const out: string[] = [];
  shopHeader(out, "TAX INVOICE");
  out.push("");

  // A sale taken offline has no document number until it syncs. Say so plainly
  // rather than printing a stand-in that looks like an invoice number.
  if (sale.doc_number) {
    out.push(`Invoice No: ${sale.doc_number}`);
  } else {
    out.push("Invoice No: pending sync");
  }
  out.push(fmtDateTime(new Date(sale.created_at)));
  out.push(`Served by: ${sale.cashier_name}`);
  if (sale.customer_name) out.push(`Customer: ${sale.customer_name}`);
  if (sale.trade_pricing) out.push("Trade pricing");
  out.push(solid());

  for (const item of items) {
    out.push(lineItem(itemLabel(item.qty, item.unit_code, item.name),
                      amount(item.line_total)));
    // Show the rate for anything not sold as a whole unit, so the customer can
    // check the arithmetic on a cut length or a weighed quantity.
    if (item.unit_code !== "ea" || item.qty !== 1) {
      out.push(unitRate(item.unit_price, item.unit_code));
    }
  }

  out.push(solid());
  out.push(lineItem("Subtotal", amount(sale.subtotal)));
  if (sale.discount_amount > 0) {
    out.push(lineItem("Discount", `-${amount(sale.discount_amount)}`));
    if (sale.discount_reason) out.push(`(${sale.discount_reason})`);
  }
  out.push(bold(underline(lineItem("TOTAL", amount(sale.total)))));
  if (sale.tax_amount > 0) {
    out.push(lineItem("VAT included", amount(sale.tax_amount)));
  }
  out.push(solid());

  if (sale.payment_method === "account") {
    out.push("");
    out.push(lineItem("ON ACCOUNT", ""));
    if (customer) {
      out.push(customer.name);
      out.push(lineItem("Account balance", amount(customer.balance)));
    }
  } else if (sale.payment_method === "split") {
    out.push(lineItem("Cash", amount(sale.paid_cash ?? 0)));
    out.push(lineItem("Card", amount(sale.paid_card ?? 0)));
  } else if (sale.payment_method === "cash") {
    if (sale.amount_tendered != null) {
      out.push(lineItem("Cash", amount(sale.amount_tendered)));
    }
    if (sale.change_due != null) {
      out.push(lineItem("Change", amount(sale.change_due)));
    }
  } else if (sale.payment_method === "card") {
    out.push(lineItem("Card", amount(sale.total)));
  }

  out.push("");
  out.push(center("Thank you"));
  out.push("");
  out.push("");
  out.push("");
  return out.join("\n");
}

/**
 * A pro-forma quote for the counter: what the basket costs before payment.
 * Explicitly not a tax invoice — it carries no document number and says so, so
 * it can never be mistaken for one in a shoebox of receipts.
 */
export function buildQuoteText(
  lines: CartLine[],
  opts: { subtotal: number; discount: number; total: number; trade: boolean }
): string {
  const out: string[] = [];
  shopHeader(out, "QUOTE");
  out.push("");
  out.push(fmtDateTime(new Date()));
  if (opts.trade) out.push("Trade pricing");
  out.push(solid());

  for (const l of lines) {
    const lineTotal = l.product.price_retail * l.qty;
    out.push(lineItem(itemLabel(l.qty, l.product.unit_code, l.product.name),
                      amount(lineTotal)));
    if (l.product.unit_code !== "ea" || l.qty !== 1) {
      out.push(unitRate(l.product.price_retail, l.product.unit_code));
    }
  }

  out.push(solid());
  out.push(lineItem("Subtotal", amount(opts.subtotal)));
  if (opts.discount > 0) {
    out.push(lineItem("Discount", `-${amount(opts.discount)}`));
  }
  out.push(boxTop());
  out.push(boxRow("TOTAL", amount(opts.total)));
  out.push(boxTop());
  out.push("");
  out.push(center("not a tax invoice"));
  out.push(center("prices valid today"));
  out.push("");
  out.push("");
  return out.join("\n");
}

/** A sample slip for testing the printer / RawBT setup on the tablet. */
export function buildTestText(): string {
  const out: string[] = [];
  out.push(center("PRINTER TEST"));
  out.push("");
  out.push(fmtDateTime(new Date()));
  out.push(`${RECEIPT_WIDTH} columns`);
  out.push(divider());
  out.push(lineItem(itemLabel(3, "bag", "Cement 42.5N 50kg"), amount(345)));
  out.push(lineItem(itemLabel(2.5, "m", "Chain 6mm"), amount(87.5)));
  out.push(unitRate(35, "m"));
  out.push(boxTop());
  out.push(boxRow("TOTAL", amount(432.5)));
  out.push(boxTop());
  out.push("");
  out.push(center("It works!"));
  out.push("");
  out.push("");
  out.push("");
  return out.join("\n");
}
