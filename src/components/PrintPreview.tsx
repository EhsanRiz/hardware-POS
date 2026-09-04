import { useEffect, useState, type ReactNode } from "react";
import { setPrintPreviewHandler, type PreviewAction } from "../lib/printPreview";

// Turn the receipt's emphasis markers (0x01/0x02 bold, 0x03/0x04 underline)
// into styled spans so the preview (and the browser print-out) matches what the
// thermal printer produces.
import { code128Svg } from "../lib/code128";

function renderMarkup(text: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  let buf = "";
  let boldOn = false;
  let underlineOn = false;
  let key = 0;
  const flush = () => {
    if (!buf) return;
    const style = {
      fontWeight: boldOn ? 700 : undefined,
      textDecoration: underlineOn ? "underline" : undefined,
    };
    nodes.push(
      <span key={key++} style={style}>
        {buf}
      </span>
    );
    buf = "";
  };
  let bar: string | null = null;
  for (const ch of text) {
    const code = ch.charCodeAt(0);
    if (bar !== null) {
      // Inside a barcode marker: collect the number, draw it at the close.
      if (code === 6) {
        flush();
        nodes.push(
          <span
            key={key++}
            className="block text-center py-1"
            data-barcode={bar}
            // Bars only. The number is already on the line above the barcode,
            // and printing it again beneath read as the invoice number twice.
            dangerouslySetInnerHTML={{ __html: code128Svg(bar) }}
          />
        );
        bar = null;
      } else {
        bar += ch;
      }
      continue;
    }
    if (code === 5) {
      bar = "";
    } else if (code === 1) {
      flush();
      boldOn = true;
    } else if (code === 2) {
      flush();
      boldOn = false;
    } else if (code === 3) {
      flush();
      underlineOn = true;
    } else if (code === 4) {
      flush();
      underlineOn = false;
    } else {
      buf += ch;
    }
  }
  flush();
  return nodes;
}

// In-app popup that previews a bill / receipt on desktop (where there's no
// thermal printer). On the tablet, printing goes straight to RawBT and this
// never shows.
export default function PrintPreview() {
  const [slip, setSlip] = useState<{ text: string; title: string; action?: PreviewAction } | null>(null);

  useEffect(() => {
    setPrintPreviewHandler((text, title, action) => setSlip({ text, title, action }));
    return () => setPrintPreviewHandler(null);
  }, []);

  // Close on Escape for convenience.
  useEffect(() => {
    if (!slip) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setSlip(null);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [slip]);

  if (!slip) return null;
  const { text, title, action } = slip;

  // The browser prints the whole page, but our @media print CSS hides
  // everything except #print-area — so only the logo + slip text comes out.
  const handlePrint = () => window.print();

  return (
    <>
      {/* Off-screen copy that is the only thing printed. */}
      <div id="print-area" aria-hidden="true">
        <pre>{renderMarkup(text)}</pre>
      </div>

      <div
        className="vv-fixed bg-black/50 flex items-center justify-center p-4 z-[60] animate-fade-in"
        onClick={() => setSlip(null)}
      >
        {/* Wide enough for the full 48 columns at this size, so a desk does not
            have to scroll sideways to read a slip. A phone still scrolls. */}
        <div
          className="bg-white rounded-2xl shadow-xl w-full max-w-[min(94vw,26rem)] max-h-[90vh] flex flex-col animate-scale-in"
          onClick={(e) => e.stopPropagation()}
        >
          <div className="flex items-center justify-between px-4 h-12 border-b border-stone-100 shrink-0">
            <span className="font-semibold text-stone-800">{title}</span>
            <button
              onClick={() => setSlip(null)}
              aria-label="Close"
              className="w-8 h-8 rounded-full flex items-center justify-center text-stone-500 hover:bg-stone-100 active:bg-stone-200 text-lg leading-none"
            >
              ✕
            </button>
          </div>

          {/* overflow-x too: the slip is a fixed 48-column document and must
              not be reflowed to fit — what is previewed has to be what the
              printer puts on paper. On a phone that is wider than the screen,
              so it scrolls inside its own box rather than pushing the page.
              `whitespace-pre`, NOT pre-wrap: pre-wrap said the opposite of this
              comment and broke every line that used the full width, so an
              amount padded to the right margin dropped onto a line of its own
              and the box rule around the total came apart in the middle. The
              paper was always right; only the preview lied. */}
          <div className="overflow-y-auto overflow-x-auto p-4 bg-stone-50">
            <pre className="font-mono text-[11px] leading-relaxed whitespace-pre text-stone-900">
              {renderMarkup(text)}
            </pre>
          </div>

          <div className="p-3 border-t border-stone-100 shrink-0 flex gap-2">
            {/* "Actually, no." — offered here because this popup is what the
                cashier is looking at when the customer says it. */}
            {action && (
              <button
                onClick={() => {
                  setSlip(null);
                  action.run();
                }}
                className="h-11 px-4 rounded-lg border border-red-200 text-red-700 font-medium active:bg-red-50"
              >
                {action.label}
              </button>
            )}
            <button
              onClick={() => setSlip(null)}
              className="flex-1 h-11 rounded-lg bg-stone-100 text-stone-700 font-medium active:bg-stone-200"
            >
              Close
            </button>
            <button
              onClick={handlePrint}
              className="flex-1 h-11 rounded-lg bg-gold-400 text-colophon font-semibold active:bg-gold"
            >
              🖨️ Print
            </button>
          </div>
        </div>
      </div>
    </>
  );
}
