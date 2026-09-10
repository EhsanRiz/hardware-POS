/**
 * A purchase order's Sheet: the shop buying, on the same paper it sells on.
 *
 * Costs on an order are what the supplier charges before VAT — the catalogue
 * keeps cost ex VAT — so the sheet shows the lines ex VAT, VAT at the shop's
 * rate, and the total the supplier's invoice should agree with. The supplier
 * stands where a customer would, with their email, so Email opens to them.
 */
import type { Sheet, SheetLine } from "./sheet";

export interface OrderSheetLine {
  sku: string | null;
  name: string;
  unit_code: string;
  qty: number;
  unit_cost: number | null;
}

export function orderSheet(args: {
  number: string;
  /** Already formatted, by lib/dates. */
  date: string;
  supplier: { name: string; address?: string | null; phone?: string | null; vatNumber?: string | null; email?: string | null };
  lines: OrderSheetLine[];
  /** The rate as a fraction, from settings — never a constant. */
  rate: number;
  expectedOn?: string | null;
  note?: string | null;
  raisedBy?: string | null;
  /** Where the goods go: the shop's own address lines. */
  deliverTo?: string | null;
}): Sheet {
  const round = (n: number) => Math.round(n * 100) / 100;
  const lines: SheetLine[] = args.lines.map((l) => ({
    code: l.sku,
    description: l.name,
    qty: l.qty,
    unit: l.unit_code,
    unitPrice: l.unit_cost ?? 0,
    lineTotal: round(l.qty * (l.unit_cost ?? 0)),
  }));
  const subtotal = round(lines.reduce((t, l) => t + l.lineTotal, 0));
  const vat = round(subtotal * args.rate);
  return {
    kind: "order",
    number: args.number,
    date: args.date,
    customer: {
      name: args.supplier.name,
      address: args.supplier.address ?? null,
      phone: args.supplier.phone ?? null,
      vatNumber: args.supplier.vatNumber ?? null,
      email: args.supplier.email ?? null,
    },
    lines,
    subtotal,
    discount: 0,
    vat,
    total: round(subtotal + vat),
    note: [args.deliverTo ? `Please deliver to: ${args.deliverTo}` : "", args.note ?? ""]
      .filter((x) => x.trim()).join("\n") || null,
    servedBy: args.raisedBy ?? null,
    deliverOn: args.expectedOn ?? null,
  };
}
