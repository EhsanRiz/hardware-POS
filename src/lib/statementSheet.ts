/**
 * A customer's statement as an A4 document.
 *
 * The same shape every other document that leaves the building uses, so it
 * prints, emails and saves through the machinery that already exists — but
 * with its own body, because a statement has no quantities and no unit
 * prices, and forcing it into the item table would put "1 ea" against a
 * payment.
 */
import type { CustomerStatement } from "./api";
import { fmtDate } from "./dates";
import type { Sheet } from "./sheet";

export function statementSheet(st: CustomerStatement): Sheet {
  return {
    kind: "statement",
    number: st.reference,
    date: fmtDate(st.to),
    customer: {
      name: st.customer.name,
      address: st.customer.address,
      phone: st.customer.phone,
      vatNumber: st.customer.vat_number,
    },
    // The item table is not used; the statement body below is.
    lines: [],
    subtotal: 0,
    discount: 0,
    vat: 0,
    // What the document is FOR, so anything that reads a sheet's total —
    // a file name, a share sheet, a preview — reads the right number.
    total: st.closing,
    statement: {
      from: fmtDate(st.from),
      to: fmtDate(st.to),
      opening: st.opening,
      entries: st.lines.map((l) => ({
        date: fmtDate(l.at),
        ref: l.ref,
        detail: l.detail,
        charge: l.charge,
        payment: l.payment,
        balance: l.balance,
      })),
      charges: st.charges,
      payments: st.payments,
      closing: st.closing,
      ageing: {
        current: st.ageing.current,
        days30: st.ageing.days30,
        days60: st.ageing.days60,
        days90: st.ageing.days90,
      },
    },
  };
}
