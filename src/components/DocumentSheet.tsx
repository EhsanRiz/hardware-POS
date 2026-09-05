import { money } from "../lib/money";
import { fmtDate } from "../lib/dates";
import { imageSrc } from "../lib/images";
import { shopSettings } from "../lib/settings";
import { SHEET_PRICED, SHEET_TITLE, shopReach, shopWhere, type Sheet } from "../lib/sheet";
import InnovaMark from "./InnovaMark";
import { emailSheet, saveSheetPdf, sheetMailto, type SendOutcome } from "../lib/sendSheet";
import { primeLogo } from "../lib/logoBytes";
import { useEffect, useState } from "react";

/**
 * An A4 quotation or tax invoice, on screen and on paper.
 *
 * Print goes through the browser; Download and Email hand over a PDF written
 * by lib/pdf.ts. Both exist because they answer different questions: Print is
 * for the copy that goes over the counter, and the PDF is the file that gets
 * emailed, filed and forwarded.
 *
 * Email opens the device's own mail app with the document in the body. That
 * is deliberate rather than sending from a server: it goes out from the
 * shop's own address, lands in the shop's own sent items, and the person
 * pressing the button can add a sentence before it leaves.
 */
export default function DocumentSheet({
  sheet,
  onClose,
}: {
  sheet: Sheet;
  onClose: () => void;
}) {
  const s = shopSettings();
  const logo = imageSrc(s.logo_url);
  const where = shopWhere(s);
  const reach = shopReach(s);
  const priced = SHEET_PRICED[sheet.kind];
  /*
   * A delivery note is printed twice: the customer keeps one and the driver
   * brings the other back signed. Both are on the screen rather than appearing
   * only in the print dialog — a preview that leaves out half of what prints
   * is not a preview.
   */
  const copies: (string | null)[] =
    sheet.kind === "delivery" ? ["Customer copy", "Shop copy"] : [null];
  const terms = (sheet.kind === "quote" ? s.quote_terms : s.receipt_terms) ?? "";
  // Where to pay. A statement is a request for money as much as an unpaid
  // invoice is, and sending one without bank details is asking twice.
  const owed = (sheet.kind === "invoice" && !sheet.paidWith)
    || (sheet.kind === "statement" && sheet.total > 0);
  const banking = [
    ["Bank", s.bank_name],
    ["Account name", s.bank_account_name],
    ["Account no", s.bank_account_number],
    ["Branch code", s.bank_branch_code],
  ].filter(([, v]) => (v ?? "").trim() !== "") as [string, string][];

  const [sent, setSent] = useState<SendOutcome | null>(null);
  // The mark has to be bytes before anybody clicks: a PDF built inside a click
  // cannot stop and fetch a picture.
  useEffect(() => primeLogo(logo), [logo]);

  return (
    <div
      className="vv-fixed bg-black/50 flex items-start justify-center p-4 z-[60] overflow-y-auto"
      role="dialog"
      aria-modal="true"
      aria-label={`${SHEET_TITLE[sheet.kind]} ${sheet.number}`}
      onClick={onClose}
    >
      <div
        className="bg-white rounded-2xl w-full max-w-[900px] my-4 flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 px-4 h-14 border-b border-stone-200 shrink-0">
          <span className="font-semibold">
            {SHEET_TITLE[sheet.kind]} {sheet.number}
          </span>
          {sent === "saved" && (
            <span className="text-sm text-stone-600 hidden sm:inline">
              PDF saved — attach it to the message
            </span>
          )}
          <div className="ml-auto flex gap-2">
            {/* The document goes as a PDF, not as forty lines in the body.
                When the device can attach it itself the mail draft is the
                share sheet's business, so the link must not also fire. */}
            <a
              className="px-4 py-2 rounded-xl border border-stone-300"
              href={sheetMailto(sheet, s)}
              onClick={(e) => {
                if (emailSheet(sheet, s, setSent).attached) e.preventDefault();
              }}
            >
              Email
            </a>
            <button
              className="px-4 py-2 rounded-xl border border-stone-300"
              onClick={() => void saveSheetPdf(sheet, s)}
            >
              Download
            </button>
            <button
              className="px-4 py-2 rounded-xl bg-colophon text-paper"
              onClick={() => window.print()}
            >
              Print
            </button>
            <button
              className="px-4 py-2 rounded-xl bg-stone-100"
              onClick={onClose}
              aria-label="Close document"
            >
              Close
            </button>
          </div>
        </div>

        {/* Its own id, not #print-area: that one is parked 10 000px to the
            left so the till slip can live off-screen until it prints, which
            made this sheet invisible on screen and visible only in the print
            dialog. The print stylesheet knows about both. */}
        <div className="overflow-x-auto p-4 bg-stone-100">
          <div id="doc-sheet">
            {copies.map((copy) => (
          <div key={copy ?? "one"} className="doc-a4">
            {/* The shop, centred: mark, name, then where it is and how to
                reach it — the way a letterhead reads. */}
            <header className="doc-head">
              {logo && <img src={logo} alt="" className="doc-logo" />}
              {/* With a logo the name still prints: a mark is not a name, and
                  a tax invoice must carry the supplier's name. */}
              <div className="doc-shop">{s.shop_name}</div>
              {/* Two lines, not one run: where the shop is, then how to reach
                  it and who it is in law. A telephone number wedged between a
                  street and a VAT number is a number nobody finds. */}
              {where.length > 0 && (
                <div className="doc-shop-where">{where.join(", ")}</div>
              )}
              {reach.length > 0 && (
                <div className="doc-shop-reach">{reach.join(" · ")}</div>
              )}
            </header>

            <div className="doc-title-row">
              <div>
                <h1 className="doc-title">{SHEET_TITLE[sheet.kind]}</h1>
                {copy && <div className="doc-copy">{copy}</div>}
              </div>
              <table className="doc-meta">
                <tbody>
                  <tr><th>Number</th><td>{sheet.number}</td></tr>
                  <tr><th>Date</th><td>{sheet.date}</td></tr>
                  {sheet.validUntil && (
                    <tr><th>Valid until</th><td>{sheet.validUntil}</td></tr>
                  )}
                  {sheet.poNumber && (
                    <tr><th>Your order</th><td>{sheet.poNumber}</td></tr>
                  )}
                  {sheet.deliverOn && (
                    <tr><th>Deliver on</th><td>{sheet.deliverOn}</td></tr>
                  )}
                  {sheet.deliverAt && (
                    <tr><th>Time</th><td>{sheet.deliverAt}</td></tr>
                  )}
                  {sheet.invoiceNumber && (
                    <tr><th>Invoice</th><td>{sheet.invoiceNumber}</td></tr>
                  )}
                  {sheet.servedBy && (
                    <tr><th>Served by</th><td>{sheet.servedBy}</td></tr>
                  )}
                </tbody>
              </table>
            </div>

            <section className="doc-to">
              <span className="doc-label">
                {sheet.kind === "quote" ? "Quotation for"
                  : sheet.kind === "delivery" ? "Deliver to"
                  : sheet.kind === "statement" ? "Statement for" : "Invoiced to"}
              </span>
              <div className="doc-to-name">
                {sheet.customer.name ??
                  (sheet.kind === "quote" ? "Walk-in customer" : "Cash sale")}
              </div>
              {sheet.deliverTo && <div className="doc-address">{sheet.deliverTo}</div>}
              {sheet.customer.address && <div>{sheet.customer.address}</div>}
              {sheet.customer.phone && <div>{sheet.customer.phone}</div>}
              {sheet.customer.vatNumber && <div>VAT No {sheet.customer.vatNumber}</div>}
              {sheet.trade && <div className="doc-trade">Trade pricing</div>}
            </section>

            {sheet.statement ? (
              <table className="doc-lines doc-statement">
                <thead>
                  <tr>
                    <th className="doc-col-code">Date</th>
                    <th>Reference</th>
                    <th>Detail</th>
                    <th className="num">Charge</th>
                    <th className="num">Paid</th>
                    <th className="num">Balance</th>
                  </tr>
                </thead>
                <tbody>
                  {/* The figure the page hangs off. Without it the lines are
                      a list, not a statement. */}
                  <tr className="doc-brought">
                    <td className="doc-col-code" />
                    <td />
                    <td>Balance brought forward</td>
                    <td className="num" />
                    <td className="num" />
                    <td className="num">{money(sheet.statement.opening)}</td>
                  </tr>
                  {sheet.statement.entries.map((e, i) => (
                    <tr key={i}>
                      <td className="doc-col-code">{e.date}</td>
                      <td>{e.ref}</td>
                      <td>{e.detail}</td>
                      <td className="num">{e.charge ? money(e.charge) : ""}</td>
                      <td className="num">{e.payment ? money(e.payment) : ""}</td>
                      <td className="num">{money(e.balance)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
            <table className="doc-lines">
              <thead>
                <tr>
                  <th className="doc-col-code">Code</th>
                  <th>Description</th>
                  <th className="num">Qty</th>
                  {priced && <th className="num">Unit price</th>}
                  {priced && <th className="num">Amount</th>}
                </tr>
              </thead>
              <tbody>
                {sheet.lines.map((l, i) => (
                  <tr key={i}>
                    <td className="doc-col-code">{l.code ?? ""}</td>
                    <td>{l.description}</td>
                    <td className="num">{l.qty} {l.unit}</td>
                    {priced && <td className="num">{money(l.unitPrice)}</td>}
                    {priced && (
                      <td className="num">
                        {money(l.lineTotal)}
                        {l.discount ? (
                          <span className="doc-off"> less {money(l.discount)}</span>
                        ) : null}
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
            )}

            <div className="doc-foot">
              <div className="doc-foot-left">
                {/* How old the money is. The half of a statement that
                    actually gets a shop paid. */}
                {sheet.statement && (
                  <table className="doc-bank doc-ageing">
                    <tbody>
                      <tr><th>Current</th><td>{money(sheet.statement.ageing.current)}</td></tr>
                      <tr><th>30 days</th><td>{money(sheet.statement.ageing.days30)}</td></tr>
                      <tr><th>60 days</th><td>{money(sheet.statement.ageing.days60)}</td></tr>
                      <tr><th>90+ days</th><td>{money(sheet.statement.ageing.days90)}</td></tr>
                    </tbody>
                  </table>
                )}
                {sheet.note && <p className="doc-note">{sheet.note}</p>}
                {terms.trim() && <p className="doc-terms">{terms.trim()}</p>}
                {/* Where to pay, on an invoice that leaves owing. */}
                {owed && banking.length > 0 && (
                  <table className="doc-bank">
                    <tbody>
                      {banking.map(([k, v]) => (
                        <tr key={k}><th>{k}</th><td>{v}</td></tr>
                      ))}
                    </tbody>
                  </table>
                )}
                {/* A builder signs this and sends it back, and the signed page
                    is the order. It is the whole reason a quote wants to be
                    A4 rather than a curl of till roll. */}
                {sheet.kind === "quote" && (
                  <div className="doc-accept">
                    <span className="doc-label">Accepted by</span>
                    <div className="doc-sign-row">
                      <span>Name</span><span>Signature</span><span>Date</span>
                    </div>
                  </div>
                )}
              </div>

              {/* What the customer is actually signing. Quantities and
                  condition — not money, which is the invoice's business. */}
              {sheet.kind === "delivery" && (
                <div className="doc-accept doc-received">
                  <span className="doc-label">Goods received</span>
                  <p className="doc-declare">
                    I confirm that the goods listed above were received in the
                    quantities shown and in good condition, and that any
                    shortage, breakage or damage has been noted below.
                  </p>
                  <span className="doc-label">Notes / exceptions</span>
                  <div className="doc-ruled"><span /><span /><span /></div>
                  <div className="doc-sign-row">
                    <span>Received by (print name)</span>
                    <span>Signature</span>
                    <span>Date</span>
                  </div>
                </div>
              )}

              {sheet.statement ? (
              <table className="doc-totals">
                <tbody>
                  <tr><th>Brought forward</th><td>{money(sheet.statement.opening)}</td></tr>
                  <tr><th>Charged</th><td>{money(sheet.statement.charges)}</td></tr>
                  <tr><th>Paid</th><td>-{money(sheet.statement.payments)}</td></tr>
                  <tr className="doc-total">
                    <th>Balance now due</th><td>{money(sheet.statement.closing)}</td>
                  </tr>
                </tbody>
              </table>
              ) : priced && (
              <table className="doc-totals">
                <tbody>
                  <tr><th>Subtotal</th><td>{money(sheet.subtotal)}</td></tr>
                  {sheet.discount > 0 && (
                    <tr><th>Discount</th><td>-{money(sheet.discount)}</td></tr>
                  )}
                  <tr><th>VAT</th><td>{money(sheet.vat)}</td></tr>
                  <tr className="doc-total"><th>Total</th><td>{money(sheet.total)}</td></tr>
                  {sheet.paidWith && (
                    <tr><th>Paid</th><td>{sheet.paidWith}</td></tr>
                  )}
                </tbody>
              </table>
              )}
            </div>

            {/* The foot of the page, on screen as well as on paper. It used
                to print only, which is exactly the kind of divergence that
                makes a preview worth nothing: what the shop sees is what the
                customer gets. */}
            <footer className="doc-page-foot">
              <div className="doc-ident">
                {s.shop_name} · {SHEET_TITLE[sheet.kind]} {sheet.number}
              </div>
              <div className="doc-disclaim">
                E&amp;OE. This document is computer generated and is valid
                without a signature.
              </div>
              <div className="doc-colophon">
                <InnovaMark size={16} />
                <span>InnovaPOS · a product of InnovaEarth</span>
                <span aria-hidden="true">·</span>
                <span>
                  © {new Date().getFullYear()} InnovaEarth · All rights reserved
                </span>
              </div>
            </footer>
          </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

/** A date as the documents write it. */
export function sheetDate(iso: string): string {
  return fmtDate(iso);
}
