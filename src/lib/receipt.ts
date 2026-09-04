import type { CashSession } from "./cashup";
import type { DayClose } from "./reports";
import { CURRENCY, RECEIPT_WIDTH } from "./config";
import { formatPhone } from "./phone";
import { shopSettings } from "./settings";
import type {
  CartLine,
  LedgerEntry,
  Payment,
  PaymentMethod,
  ReceiptItem,
  Sale,
} from "./types";
import { fmtDate, fmtDateTime } from "./dates";

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
/** The text between these prints as a Code 128 barcode, number beneath. */
export const BAR_ON = String.fromCharCode(5);
export const BAR_OFF = String.fromCharCode(6);
function bold(s: string): string {
  return BOLD_ON + s + BOLD_OFF;
}
function underline(s: string): string {
  return UL_ON + s + UL_OFF;
}
/**
 * A document number as a barcode, so the paper can come back to the counter
 * and be scanned into the same box that scans products. Its own line; the
 * number is printed under the bars by the printer, so it is not repeated.
 */
function barcode(docNumber: string): string {
  return BAR_ON + docNumber + BAR_OFF;
}
const MARKUP_RE = new RegExp(
  "[" + BOLD_ON + BOLD_OFF + UL_ON + UL_OFF + BAR_ON + BAR_OFF + "]",
  "g"
);
/**
 * A paragraph of small print, folded to the paper.
 *
 * Words are kept whole and blank lines in the shop's text start a new
 * paragraph, so the returns policy reads as it was typed and not as one
 * 300-character line the printer chops wherever it runs out of paper.
 */
export function wrapTerms(text: string, width = RECEIPT_WIDTH): string[] {
  const out: string[] = [];
  for (const para of text.replace(/\r/g, "").split(/\n\s*\n/)) {
    const words = para.split(/\s+/).filter(Boolean);
    if (!words.length) continue;
    if (out.length) out.push("");
    let line = "";
    for (const w of words) {
      if (line && line.length + 1 + w.length > width) {
        out.push(line);
        line = w;
      } else {
        line = line ? `${line} ${w}` : w;
      }
    }
    if (line) out.push(line);
  }
  return out;
}

/** The shop's small print, if it has any, under a rule of its own, centred. */
function termsBlock(out: string[], text: string | null | undefined): void {
  // Folded two columns short of the paper on each side, so a centred
  // paragraph reads as a block with margins rather than ragged full lines.
  const lines = wrapTerms((text ?? "").trim(), RECEIPT_WIDTH - 4);
  if (!lines.length) return;
  out.push(divider());
  out.push(...lines.map((l) => center(l)));
}

export function stripMarkup(s: string): string {
  return s.replace(MARKUP_RE, "");
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

/** What each tender is called on the slip. */
const PAYMENT_LABEL: Record<PaymentMethod, string> = {
  cash: "Cash",
  card: "Card",
  eft: "EFT",
  zapper: "Zapper",
  account: "On account",
  mixed: "Mixed",
  split: "Cash + card",
};

/** Unit price shown under a cut-to-length line, e.g. "@ R35.00/m". */
function unitRate(unitPrice: number, unitCode: string): string {
  return `  @ ${amount(unitPrice)}/${unitCode}`;
}

// Shop name, address, VAT number and slip title.
//
// The name used to be omitted because a printed logo image carried it. There
// is no logo image any more, and a tax invoice without the supplier's name on
// it is not a valid tax invoice — SARS requires the supplier's name, address
// and VAT registration number on the face of the document. So the name is
// printed, in bold, as the first thing on the slip.
function shopHeader(out: string[], title: string): void {
  const s = shopSettings();
  if (s.shop_name) out.push(bold(center(s.shop_name)));
  for (const line of [s.address_line1, s.address_line2].filter(Boolean)) {
    out.push(center(line));
  }
  if (s.phone) out.push(center(`Tel: ${s.phone}`));
  if (s.vat_number) out.push(center(`VAT No: ${s.vat_number}`));
  if (s.registration_number) out.push(center(`Reg No: ${s.registration_number}`));
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
  customer?: { name: string; balance: number } | null,
  payments?: Payment[] | null
): string {
  const out: string[] = [];
  shopHeader(out, "TAX INVOICE");
  out.push("");

  // A sale with no document number has not been invoiced, and there are two
  // quite different reasons for that. One is waiting for a connection; the
  // other is waiting for a manager. Printing "pending sync" over both told a
  // customer holding a parked sale that the shop's line was down, which is not
  // what happened and not what they need to do about it.
  // Centred, over the centred bars, so the number and its barcode read as
  // one block rather than a label hanging off the left margin.
  if (sale.doc_number) {
    out.push(center(`Invoice No: ${sale.doc_number}`));
    out.push(barcode(sale.doc_number));
  } else if (sale.status === "pending_approval") {
    out.push(center("NOT AN INVOICE — awaiting approval"));
  } else {
    out.push(center("Invoice No: pending sync"));
  }
  out.push(fmtDateTime(new Date(sale.created_at)));
  out.push(`Served by: ${sale.cashier_name}`);
  // The RECIPIENT block. SARS requires the buyer's name, address and VAT
  // registration number on a full tax invoice — mandatory above R5 000, which
  // an ordinary pump or a pallet of cement clears. Printed whenever we have it.
  if (sale.customer_name) out.push(`Customer: ${sale.customer_name}`);
  if (sale.customer_address) {
    for (const line of sale.customer_address.split("\n")) {
      if (line.trim()) out.push(`  ${line.trim()}`);
    }
  }
  // Not required by SARS, but it is what the buyer quotes at the returns
  // counter, so printing it tells them the number we hold is the right one.
  if (sale.customer_phone) out.push(`  ${formatPhone(sale.customer_phone)}`);
  if (sale.customer_vat_number) out.push(`Customer VAT No: ${sale.customer_vat_number}`);
  // The buyer's own order number: their bookkeeper rejects an invoice without it.
  if (sale.po_number) out.push(`Order No: ${sale.po_number}`);
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
    // Money taken off this line, under the line it came off. Without it the
    // customer sees a total that does not match the price they were quoted and
    // has nothing on the paper to explain the difference.
    if (item.discount_amount && item.discount_amount > 0) {
      // The reason rides on the same row rather than taking one of its own: a
      // basket of ten marked-down lines would otherwise add ten lines to a slip
      // printed on 80mm paper. Truncation is the printer's, and losing the tail
      // of "damaged box, agreed with Sipho" costs nothing — the full text is on
      // the sale.
      const label = item.discount_percent
        ? `  less ${item.discount_percent}%`
        : "  less discount";
      out.push(
        lineItem(
          item.discount_reason ? `${label} (${item.discount_reason})` : label,
          `-${amount(item.discount_amount)}`
        )
      );
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

  // Cash rounding is shown as its own line, never folded into the total: the
  // invoice total is the taxable amount and must stay exactly what was billed,
  // while the cash actually handed over settles to the nearest 10c.
  const rounding = sale.rounding ?? 0;
  if (rounding !== 0) {
    out.push(lineItem("Cash rounding", `${rounding > 0 ? "" : "-"}${amount(Math.abs(rounding))}`));
    out.push(bold(lineItem("TO PAY", amount(sale.total + rounding))));
  }
  out.push(solid());

  // Every tender, in the order it was taken. A sale can be settled by several.
  const taken = payments ?? [];
  if (taken.length > 0) {
    for (const p of taken) {
      out.push(lineItem(PAYMENT_LABEL[p.method] ?? p.method, amount(p.amount)));
      if (p.reference) out.push(`  ref ${p.reference}`);
    }
    if (sale.amount_tendered != null && sale.change_due != null && sale.change_due > 0) {
      out.push(lineItem("Cash received", amount(sale.amount_tendered)));
      out.push(lineItem("Change", amount(sale.change_due)));
    }
  } else if (sale.payment_method === "account") {
    out.push(lineItem("ON ACCOUNT", ""));
  } else if (sale.payment_method === "split") {
    out.push(lineItem("Cash", amount(sale.paid_cash ?? 0)));
    out.push(lineItem("Card", amount(sale.paid_card ?? 0)));
  } else if (sale.payment_method === "cash") {
    if (sale.amount_tendered != null) out.push(lineItem("Cash", amount(sale.amount_tendered)));
    if (sale.change_due != null) out.push(lineItem("Change", amount(sale.change_due)));
  } else if (sale.payment_method) {
    out.push(lineItem(PAYMENT_LABEL[sale.payment_method] ?? sale.payment_method, amount(sale.total)));
  }

  if (customer && (sale.payment_method === "account" || taken.some((p) => p.method === "account"))) {
    out.push(customer.name);
    out.push(lineItem("Account balance", amount(customer.balance)));
  }

  // Where to pay, but only on a slip that leaves with the money still owed.
  // A cash customer has already paid and does not need the shop's account
  // number; an EFT or account customer cannot settle without it, and printing
  // it on every till slip would put the shop's banking on the floor of the car
  // park a hundred times a day.
  const owed =
    sale.payment_method === "account" ||
    sale.payment_method === "eft" ||
    taken.some((p) => p.method === "account" || p.method === "eft");
  if (owed) bankingBlock(out);

  // The returns policy, on the paper the customer brings back. The sign
  // behind the counter is not in their kitchen drawer; the slip is.
  termsBlock(out, shopSettings().receipt_terms);

  out.push("");
  out.push(center("Thank you"));
  out.push("");
  out.push("");
  out.push("");
  return out.join("\n");
}

/** The shop's account, for somebody who still has to pay it. */
function bankingBlock(out: string[]): void {
  const s = shopSettings();
  const rows: [string, string][] = [
    ["Bank", s.bank_name ?? ""],
    ["Account name", s.bank_account_name ?? ""],
    ["Account no", s.bank_account_number ?? ""],
    ["Branch code", s.bank_branch_code ?? ""],
  ];
  const filled = rows.filter(([, v]) => v.trim() !== "");
  // Nothing set is not a heading with nothing under it.
  if (filled.length === 0) return;
  out.push("");
  out.push(divider());
  out.push(bold("PAYMENT DETAILS"));
  for (const [label, value] of filled) out.push(lineItem(label, value));
}

/**
 * A pro-forma quote for the counter: what the basket costs before payment.
 * Explicitly not a tax invoice — it carries no document number and says so, so
 * it can never be mistaken for one in a shoebox of receipts.
 */
/**
 * One line of a quote, however it got here: the till's cart (a product and a
 * quantity, priced for this customer) or a saved quote read back from the
 * server (the promise as it was made, with today's product long since
 * repriced or gone). The paper is the same either way, so the builder takes
 * the paper's own shape and the two callers each map to it.
 */
export interface QuoteTextLine {
  name: string;
  unit_code: string;
  qty: number;
  /** The unit price this customer was quoted. */
  unit: number;
  /** Money off this line, already worked out. */
  off?: number;
  discountPercent?: number | null;
}

/** The till's cart as quote lines, priced the way the customer is priced. */
export function cartQuoteLines(lines: CartLine[], trade: boolean): QuoteTextLine[] {
  return lines.map((l) => ({
    name: l.product.name,
    unit_code: l.product.unit_code,
    qty: l.qty,
    // The price this customer is actually being quoted. It read price_retail
    // regardless, so a trade quote printed retail against every line while the
    // subtotal underneath was worked out at trade — the paper disagreed with
    // itself, in the customer's favour on the total and against them on every
    // line above it.
    unit:
      trade && l.product.price_trade != null ? l.product.price_trade : l.product.price_retail,
    off: l.discount ?? 0,
    discountPercent: l.discountPercent,
  }));
}

export function buildQuoteText(
  lines: QuoteTextLine[],
  opts: {
    subtotal: number;
    discount: number;
    total: number;
    trade: boolean;
    /** Set when the quote was saved: the number the builder brings back. */
    docNumber?: string | null;
    validUntil?: string | null;
    /** Who it is for. A quote with no name on it is a price list. */
    customerName?: string | null;
    /** When the quote was made. Now, unless it is being reprinted. */
    createdAt?: string | null;
    /**
     * Whether each line carries a price. False prints the scope and one total
     * — the ordinary way a trade counter quotes a job, because an itemised
     * quote is a shopping list a competitor can price against.
     *
     * The lines themselves never go: a quote that does not say what is
     * included is not a quote, it is a number.
     *
     * Left unset it follows the shop's setting, read from the same device
     * cache the header is read from — so it is right offline, and so the two
     * places that print a quote cannot drift apart by one of them forgetting.
     */
    showLinePrices?: boolean;
  }
): string {
  const out: string[] = [];
  const priced =
    opts.showLinePrices ?? shopSettings().quote_show_line_prices !== false;
  shopHeader(out, "QUOTE");
  out.push("");
  if (opts.docNumber) {
    out.push(bold(opts.docNumber));
    out.push(barcode(opts.docNumber));
  }
  const made = opts.createdAt ? new Date(opts.createdAt) : new Date();
  out.push(fmtDateTime(Number.isNaN(made.getTime()) ? new Date() : made));
  if (opts.customerName?.trim()) out.push(`For: ${opts.customerName.trim()}`);
  if (opts.trade) out.push("Trade pricing");
  out.push(solid());

  for (const l of lines) {
    const unit = l.unit;
    const label = itemLabel(l.qty, l.unit_code, l.name);

    if (!priced) {
      out.push(label);
      continue;
    }

    // Money off this line, taken off this line. Ignoring it printed full price
    // on a line that had been marked down, and left the difference unexplained
    // between the subtotal and the total.
    const gross = unit * l.qty;
    const off = l.off ?? 0;
    out.push(lineItem(label, amount(gross - off)));
    if (l.unit_code !== "ea" || l.qty !== 1) {
      out.push(unitRate(unit, l.unit_code));
    }
    if (off > 0) {
      out.push(
        lineItem(
          l.discountPercent ? `  less ${l.discountPercent}%` : "  less discount",
          `-${amount(off)}`
        )
      );
    }
  }

  out.push(solid());
  // Laid out exactly as the invoice lays it out, so the two documents read the
  // same way: gross subtotal, everything that came off, and the total those two
  // produce. `discount` is ALL of it, lines and blanket together — the quote
  // was passed only the blanket one, so a line discount left a gap between the
  // subtotal and the total with nothing on the paper to account for it.
  //
  // On a totals-only quote none of it appears. A subtotal with no lines above
  // it to explain it is just the total again, one row higher.
  if (priced) {
    out.push(lineItem("Subtotal", amount(opts.subtotal)));
    if (opts.discount > 0) {
      out.push(lineItem("Discount", `-${amount(opts.discount)}`));
    }
  }
  out.push(boxTop());
  out.push(boxRow("TOTAL", amount(opts.total)));
  out.push(boxTop());
  out.push("");
  out.push(center("not a tax invoice"));
  out.push(
    center(
      opts.validUntil
        ? `prices held until ${shortDate(opts.validUntil)}`
        : "prices valid today"
    )
  );
  if (opts.docNumber) {
    out.push(center(`quote this number to buy: ${opts.docNumber}`));
  }
  // Its own small print, not the invoice's: nothing has been sold yet, so a
  // returns policy is beside the point and "subject to stock" is the point.
  termsBlock(out, shopSettings().quote_terms);
  out.push("");
  out.push("");
  return out.join("\n");
}

/**
 * A customer's account statement, for the contractor's bookkeeper.
 *
 * Chronological — oldest first — because a statement is read as a story: what
 * was owed, what was paid, where it stands. The ledger screen shows newest
 * first because at a counter the question is "what just happened"; on paper
 * the question is "how did we get here".
 */
export function buildStatementText(
  who: { name: string; phone: string | null; code: string | null },
  entries: LedgerEntry[],
  balance: number,
  aging: { current: number; days30: number; days60: number; days90: number }
): string {
  const out: string[] = [];
  shopHeader(out, "ACCOUNT STATEMENT");
  out.push("");
  out.push(fmtDateTime(new Date()));
  out.push(bold(who.name));
  if (who.code) out.push(`Account: ${who.code}`);
  out.push(solid());

  for (const e of [...entries].reverse()) {
    const what = e.ref ? `${e.ref} ${e.detail}` : e.detail;
    if (e.voided) {
      // Shown, struck through in words: a statement with silent gaps is how
      // disputes become unwinnable.
      out.push(lineItem(`${shortDate(e.entry_at)} ${what} (VOID)`, amount(0)));
      continue;
    }
    out.push(
      lineItem(
        `${shortDate(e.entry_at)} ${what}`,
        e.charge ? amount(e.charge) : `-${amount(e.payment)}`
      )
    );
  }

  out.push(solid());
  const owed = aging.days30 + aging.days60 + aging.days90;
  if (owed > 0) {
    out.push(lineItem("Not yet due", amount(Math.max(aging.current, 0))));
    if (aging.days30 > 0) out.push(lineItem("30 days", amount(aging.days30)));
    if (aging.days60 > 0) out.push(lineItem("60 days", amount(aging.days60)));
    if (aging.days90 > 0) out.push(lineItem("90+ days OVERDUE", amount(aging.days90)));
  }
  out.push(boxTop());
  out.push(
    boxRow(balance < 0 ? "IN CREDIT" : "BALANCE DUE", amount(Math.abs(balance)))
  );
  out.push(boxTop());
  out.push("");
  out.push(center("not a tax invoice"));
  out.push("");
  out.push("");
  return out.join("\n");
}

/**
 * The cash-up slip.
 *
 * Ordered the way a manager checks it: what the till says was sold, then what
 * that means the drawer should hold, then what was actually counted, and the
 * difference last and boxed. The variance is the reason this piece of paper
 * exists — a slip that buries it among the takings is a sales summary, not a
 * cash-up — so it is the one figure in the box, and it is named "OVER" or
 * "SHORT" rather than left as a signed number for somebody to interpret at the
 * end of a long day.
 */
export function buildCashUpText(s: CashSession): string {
  const out: string[] = [];
  const f = s.figures;
  shopHeader(out, "CASH-UP");
  out.push("");
  out.push(lineItem("Opened", fmtDateTime(new Date(s.opened_at))));
  out.push(lineItem("By", s.opened_by_name));
  if (s.closed_at) {
    out.push(lineItem("Closed", fmtDateTime(new Date(s.closed_at))));
    if (s.closed_by_name) out.push(lineItem("Counted by", s.closed_by_name));
  }
  out.push(solid());

  out.push(bold("TAKINGS"));
  out.push(lineItem(`Sales (${f.sales_count})`, amount(f.sales_total)));
  // Money that went back. Without this line "Sales" reads gross and the
  // only trace of a refund is a pay-out further down.
  if ((f.refunds_total ?? 0) > 0) {
    out.push(lineItem(`Refunds (${f.refunds_count ?? 0})`, `-${amount(f.refunds_total!)}`));
    out.push(lineItem("Net", amount(f.sales_total - f.refunds_total!)));
  }
  if (f.discount_total > 0) out.push(lineItem("Discounts given", amount(f.discount_total)));
  out.push(lineItem("VAT within", amount(f.vat_total)));
  out.push(divider());

  // Every tender, including the ones that never touch the drawer: the manager
  // reconciling a card machine's own total needs this line to check it against.
  for (const [method, value] of Object.entries(f.tenders)) {
    const label = PAYMENT_LABEL[method as PaymentMethod] ?? method;
    out.push(lineItem(label, amount(value)));
  }
  // Account settlements, by method, for the same reason: a card machine's
  // batch does not know whether a swipe was a sale or a debtor paying up.
  for (const [method, value] of Object.entries(f.account_payments ?? {})) {
    const label = PAYMENT_LABEL[method as PaymentMethod] ?? method;
    out.push(lineItem(`Account paid by ${label.toLowerCase()}`, amount(value)));
  }
  out.push(divider());

  out.push(bold("THE DRAWER"));
  out.push(lineItem("Opening float", amount(s.opening_float)));
  out.push(lineItem("Cash sales", amount(f.cash_sales)));
  if (f.account_cash > 0) out.push(lineItem("Account payments in cash", amount(f.account_cash)));
  if (f.pay_in > 0) out.push(lineItem("Paid in", amount(f.pay_in)));
  if (f.pay_out > 0) out.push(lineItem("Paid out", `-${amount(f.pay_out)}`));
  out.push(lineItem("Expected in drawer", amount(s.expected_cash ?? f.expected_cash)));
  out.push(lineItem("Counted", s.counted_cash == null ? "—" : amount(s.counted_cash)));

  if (s.variance != null) {
    const over = s.variance > 0;
    out.push(boxTop());
    out.push(
      boxRow(
        Math.abs(s.variance) < 0.005 ? "BALANCED" : over ? "OVER" : "SHORT",
        amount(Math.abs(s.variance))
      )
    );
    out.push(boxTop());
  }

  // The card machine and the bank against the till, and the banking: each a
  // comparison that used to live on a scrap of paper, if it happened at all.
  const settlement = (title: string, expected: number | null | undefined,
                      counted: number | null | undefined, variance: number | null | undefined) => {
    if (counted == null) return;
    out.push("");
    out.push(bold(title));
    out.push(lineItem("Till says", amount(expected ?? 0)));
    out.push(lineItem("Machine says", amount(counted)));
    const v = variance ?? 0;
    out.push(lineItem(Math.abs(v) < 0.005 ? "Agrees" : v > 0 ? "Over" : "Short", amount(Math.abs(v))));
  };
  settlement("CARD MACHINE", s.card_expected ?? s.figures.card_expected, s.card_counted, s.card_variance);
  settlement("EFT", s.eft_expected ?? s.figures.eft_expected, s.eft_counted, s.eft_variance);
  if (s.banked != null) {
    out.push("");
    out.push(bold("BANKING"));
    out.push(lineItem("Banked", amount(s.banked)));
    out.push(lineItem("Float kept for tomorrow", amount(s.float_kept ?? 0)));
  }

  if (s.movements?.length) {
    out.push("");
    out.push(bold("IN AND OUT"));
    for (const m of s.movements) {
      out.push(
        lineItem(
          `${shortDate(m.created_at)} ${m.reason}`,
          (m.kind === "pay_out" ? "-" : "") + amount(m.amount)
        )
      );
    }
  }

  if (s.note) {
    out.push("");
    out.push(bold("NOTE"));
    out.push(s.note);
  }

  out.push("");
  out.push(center("signed ............................"));
  out.push("");
  out.push(center("not a tax invoice"));
  out.push("");
  out.push("");
  return out.join("\n");
}

/**
 * The whole shop's day on one slip: every till's drawer and card check side
 * by side, then the totals across them. The cash-up is per till; this is
 * what the owner pins to the banking bag.
 */
export function buildDayCloseText(d: DayClose, from: Date, to: Date): string {
  const out: string[] = [];
  const t = d.totals;
  shopHeader(out, "DAY CLOSE");
  out.push("");
  const oneDay = to.getTime() - from.getTime() <= 36e5 * 25;
  out.push(lineItem(oneDay ? "Day" : "From", fmtDateTime(from).slice(0, 10)));
  if (!oneDay) out.push(lineItem("To", fmtDateTime(new Date(to.getTime() - 1)).slice(0, 10)));
  out.push(lineItem("Printed", fmtDateTime(new Date())));
  out.push(solid());

  out.push(bold("TAKINGS"));
  out.push(lineItem(`Sales (${t.sales_count})`, amount(t.sales_total)));
  if (t.refunds_total > 0) {
    out.push(lineItem(`Refunds (${t.refunds_count})`, `-${amount(t.refunds_total)}`));
    out.push(lineItem("Net", amount(t.sales_total - t.refunds_total)));
  }
  if (t.discount_total > 0) out.push(lineItem("Discounts given", amount(t.discount_total)));
  out.push(lineItem("VAT within", amount(t.vat_total)));
  out.push(divider());
  for (const [method, value] of Object.entries(t.tenders ?? {})) {
    out.push(lineItem(PAYMENT_LABEL[method as PaymentMethod] ?? method, amount(value)));
  }
  for (const [method, value] of Object.entries(t.account_payments ?? {})) {
    const label = PAYMENT_LABEL[method as PaymentMethod] ?? method;
    out.push(lineItem(`Account paid by ${label.toLowerCase()}`, amount(value)));
  }

  out.push("");
  out.push(bold("THE TILLS"));
  if (!d.sessions.length) out.push("No drawer was opened.");
  for (const s of d.sessions) {
    out.push(`${s.register_name ?? "Till"} — ${s.closed_at ? "closed" : "STILL OPEN"}`);
    out.push(lineItem("  Expected", amount(s.expected_cash ?? s.figures.expected_cash)));
    if (s.counted_cash != null) {
      out.push(lineItem("  Counted", amount(s.counted_cash)));
      const v = s.variance ?? 0;
      out.push(lineItem(Math.abs(v) < 0.005 ? "  Balanced" : v > 0 ? "  Over" : "  Short", amount(Math.abs(v))));
    }
    if (s.card_counted != null) {
      const v = s.card_variance ?? 0;
      out.push(lineItem("  Card machine", `${amount(s.card_counted)} ${Math.abs(v) < 0.005 ? "ok" : (v > 0 ? "+" : "-") + amount(Math.abs(v))}`));
    }
    if (s.banked != null) out.push(lineItem("  Banked", amount(s.banked)));
  }

  out.push("");
  out.push(bold("ACROSS THE SHOP"));
  out.push(lineItem("Cash expected", amount(t.cash_expected)));
  out.push(lineItem("Cash counted", amount(t.cash_counted)));
  out.push(boxTop());
  out.push(boxRow(
    Math.abs(t.cash_variance) < 0.005 ? "CASH BALANCED" : t.cash_variance > 0 ? "CASH OVER" : "CASH SHORT",
    amount(Math.abs(t.cash_variance))
  ));
  out.push(boxTop());
  out.push(lineItem("Card: till", amount(t.card_expected)));
  out.push(lineItem("Card: machine", amount(t.card_counted)));
  if (t.eft_expected > 0 || t.eft_counted > 0) {
    out.push(lineItem("EFT: till", amount(t.eft_expected)));
    out.push(lineItem("EFT: bank", amount(t.eft_counted)));
  }
  out.push(lineItem("Banked", amount(t.banked)));
  out.push(lineItem("Float kept", amount(t.float_kept)));
  if (t.sessions_open > 0) {
    out.push("");
    out.push(center(`${t.sessions_open} drawer${t.sessions_open === 1 ? "" : "s"} still open`));
  }
  out.push("");
  out.push(center("not a tax invoice"));
  out.push("");
  out.push("");
  return out.join("\n");
}

/** "12 Mar 2026" — the same form as everywhere else; it fits the line. */
function shortDate(iso: string): string {
  return fmtDate(iso);
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

/**
 * The credit note.
 *
 * Prints what a customer and an auditor both need from the same piece of
 * paper: which invoice it reverses, what came back and where each item went
 * (shelf or written off), the VAT being returned, how the money went back,
 * and who approved it. The figures come from the stored return, never
 * recomputed — a credit note reprinted next year must restate what was
 * actually refunded, exactly as a tax invoice must.
 */
export function buildCreditNoteText(cn: {
  doc_number: string;
  created_at: string;
  sale_doc_number: string | null;
  sale_payment_method: string | null;
  reason: string;
  refund_method: string;
  total: number;
  tax_total: number;
  by_name: string;
  items: { name: string; unit_code: string; qty: number; line_total: number; restock: boolean }[];
}): string {
  const out: string[] = [];
  shopHeader(out, "CREDIT NOTE");
  out.push("");
  out.push(bold(center(cn.doc_number)));
  if (cn.sale_doc_number) {
    out.push(center(`against Tax Invoice ${cn.sale_doc_number}`));
    // The invoice's barcode, not the credit note's: what a counter looks up
    // is the sale, and the credit notes hang off it.
    out.push(barcode(cn.sale_doc_number));
  }
  out.push(fmtDateTime(new Date(cn.created_at)));
  out.push(solid());

  for (const i of cn.items) {
    out.push(lineItem(itemLabel(i.qty, i.unit_code, i.name), `-${amount(i.line_total)}`));
    out.push(i.restock ? "  returned to shelf" : "  damaged - written off");
  }

  out.push(solid());
  out.push(boxTop());
  out.push(boxRow("REFUND", `-${amount(cn.total)}`));
  out.push(boxTop());
  out.push(lineItem("VAT included", `-${amount(cn.tax_total)}`));
  out.push("");

  if (cn.refund_method === "account") {
    out.push("Credited to the customer's account");
  } else if (cn.sale_payment_method && cn.sale_payment_method !== "cash") {
    // Said on the paper, because it is the question the customer asks: the
    // till cannot put money back on a card, so the drawer paid out.
    out.push(`Refunded in cash (sale was paid by ${cn.sale_payment_method})`);
  } else {
    out.push("Refunded in cash");
  }
  out.push(`Reason: ${cn.reason}`);
  out.push(`Approved: ${cn.by_name}`);
  out.push(solid());
  out.push(center("Goods received back in store"));
  out.push("");
  out.push(center("Customer signature: ______________"));
  out.push("");
  out.push("");
  return out.join("\n");
}
