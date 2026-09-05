/**
 * A quotation's Sheet, built the same way wherever it is built.
 *
 * Two places make one: the sell screen, the moment a quote is saved and the
 * document is archived, and the Quotes screen, when somebody asks for it
 * again. They start from different things — a cart on one side, the saved
 * quote and its lines on the other — but the arithmetic between them has to
 * agree, or the archived copy and the rebuilt one show different VAT.
 */
import type { Sheet, SheetLine } from "./sheet";

export function quoteSheet(args: {
  number: string;
  /** Already formatted, by lib/dates. */
  date: string;
  validUntil: string;
  customerName: string | null;
  servedBy?: string | null;
  note?: string | null;
  lines: SheetLine[];
  /** Money off the whole sale, if any. */
  discount?: number;
  /** VAT-inclusive, as every price in the till is. */
  total: number;
  /** The rate as a fraction, from settings — never a constant. */
  rate: number;
}): Sheet {
  const vat = Math.round((args.total - args.total / (1 + args.rate)) * 100) / 100;
  return {
    kind: "quote",
    number: args.number,
    date: args.date,
    validUntil: args.validUntil,
    customer: { name: args.customerName },
    lines: args.lines,
    subtotal: Math.round((args.total - vat) * 100) / 100,
    discount: args.discount ?? 0,
    vat,
    total: args.total,
    note: args.note ?? null,
    servedBy: args.servedBy ?? null,
  };
}
