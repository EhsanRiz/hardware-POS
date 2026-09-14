import InnovaMark from "../InnovaMark";
import { useDocFit } from "../../lib/docFit";
import { imageSrc } from "../../lib/images";
import { shopReach, shopWhere } from "../../lib/sheet";
import type { ReportSheetData } from "../../lib/reportSheet";
import type { ShopSettings } from "../../lib/types";

/**
 * A report on the shop's own letterhead.
 *
 * The same sheet a quotation and a tax invoice come out on — the same mark,
 * the same name and address, the same foot — because a page that goes to the
 * bank, the accountant or the file should look like it came from the same
 * place as the rest of the shop's paper. What changes is the title and the
 * table; nothing else should.
 *
 * Printing is the browser's own, through #doc-sheet, which is how the A4
 * documents already print. That also means "Save as PDF" in Chrome's dialog
 * produces the file, with no second renderer to disagree with this one.
 */
export default function ReportSheet({
  sheet,
  shop,
  onClose,
}: {
  sheet: ReportSheetData;
  shop: ShopSettings;
  onClose: () => void;
}) {
  const fit = useDocFit();
  const logo = imageSrc(shop.logo_url);
  const where = shopWhere(shop);
  const reach = shopReach(shop);
  const printed = new Date().toLocaleString("en-ZA", {
    day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit",
  });

  return (
    <div className="vv-fixed bg-black/50 flex items-center justify-center p-4 z-[60] animate-fade-in">
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-4xl max-h-[92vh] flex flex-col animate-scale-in">
        <div className="doc-head-bar flex items-center justify-between gap-2 px-4 h-14 border-b border-stone-100 shrink-0">
          <span className="font-semibold text-stone-800">{sheet.title}</span>
          <div className="flex gap-2">
            {/* Chrome's own dialog carries "Save as PDF", so one button is
                both the print and the file. */}
            <button
              onClick={() => window.print()}
              className="h-10 px-4 rounded-lg bg-gold-400 text-colophon font-semibold active:bg-gold"
            >
              🖨️ Print or save as PDF
            </button>
            <button
              onClick={onClose}
              aria-label="Close"
              className="h-10 px-4 rounded-lg bg-stone-100 text-stone-700 font-medium active:bg-stone-200"
            >
              Close
            </button>
          </div>
        </div>

        <div className="doc-fit overflow-auto p-4 bg-stone-100" ref={fit}>
          <div id="doc-sheet">
            <div className="doc-a4">
              <header className="doc-head">
                {logo && <img src={logo} alt="" className="doc-logo" />}
                <div className="doc-shop">{shop.shop_name}</div>
                {where.length > 0 && (
                  <div className="doc-shop-where">{where.join(", ")}</div>
                )}
                {reach.length > 0 && (
                  <div className="doc-shop-reach">{reach.join(" · ")}</div>
                )}
              </header>

              <div className="doc-title-row">
                <div>
                  <h1 className="doc-title">{sheet.title}</h1>
                </div>
                <table className="doc-meta">
                  <tbody>
                    <tr><th>Period</th><td>{sheet.period}</td></tr>
                    {/* When it was run, because a report is true of a moment
                        and somebody will find this page in a drawer in March. */}
                    <tr><th>Printed</th><td>{printed}</td></tr>
                  </tbody>
                </table>
              </div>

              <table className="doc-lines">
                <thead>
                  <tr>
                    {sheet.columns.map((c, i) => (
                      <th key={i} className={c.num ? "num" : undefined}>{c.label}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {sheet.rows.length === 0 && (
                    <tr>
                      <td colSpan={sheet.columns.length} className="doc-empty">
                        Nothing in this period.
                      </td>
                    </tr>
                  )}
                  {sheet.rows.map((row, i) => (
                    <tr key={i}>
                      {row.map((cell, j) => (
                        <td key={j} className={sheet.columns[j]?.num ? "num" : undefined}>
                          {cell}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
                {sheet.total && (
                  <tfoot>
                    <tr className="doc-total-row">
                      {sheet.total.map((cell, j) => (
                        <td key={j} className={sheet.columns[j]?.num ? "num" : undefined}>
                          {cell}
                        </td>
                      ))}
                    </tr>
                  </tfoot>
                )}
              </table>

              {/* The caveat, where the figures have one. A margin worked out
                  over lines with no cost is not a margin, and a printed page
                  is exactly where that becomes a fact somebody quotes back. */}
              {sheet.note && <p className="doc-report-note">{sheet.note}</p>}

              <footer className="doc-page-foot">
                <div className="doc-ident">
                  {shop.shop_name} · {sheet.title} · {sheet.period}
                </div>
                <div className="doc-disclaim">
                  E&amp;OE. This report is computer generated from the till's own
                  records and is valid without a signature.
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
          </div>
        </div>
      </div>
    </div>
  );
}
