import { useEffect, useState, type ReactNode } from "react";
import { setPrintPreviewHandler } from "../lib/printPreview";

// Turn the receipt's emphasis markers (0x01/0x02 bold, 0x03/0x04 underline)
// into styled spans so the preview (and the browser print-out) matches what the
// thermal printer produces.
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
  for (const ch of text) {
    const code = ch.charCodeAt(0);
    if (code === 1) {
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
  const [slip, setSlip] = useState<{ text: string; title: string } | null>(null);

  useEffect(() => {
    setPrintPreviewHandler((text, title) => setSlip({ text, title }));
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
  const { text, title } = slip;

  // The browser prints the whole page, but our @media print CSS hides
  // everything except #print-area — so only the logo + slip text comes out.
  const handlePrint = () => window.print();

  return (
    <>
      {/* Off-screen copy that is the only thing printed. */}
      <div id="print-area" aria-hidden="true">
        <img src="/logo.png" alt="" />
        <pre>{renderMarkup(text)}</pre>
      </div>

      <div
        className="fixed inset-0 bg-black/50 flex items-center justify-center p-4 z-[60] animate-fade-in"
        onClick={() => setSlip(null)}
      >
        <div
          className="bg-white rounded-2xl shadow-xl w-full max-w-[320px] max-h-[90vh] flex flex-col animate-scale-in"
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

          <div className="overflow-y-auto p-4 bg-stone-50">
            <img src="/logo.png" alt="logo" className="w-32 mx-auto mb-3" />
            <pre className="font-mono text-[11px] leading-relaxed whitespace-pre-wrap text-stone-900">
              {renderMarkup(text)}
            </pre>
          </div>

          <div className="p-3 border-t border-stone-100 shrink-0 flex gap-2">
            <button
              onClick={() => setSlip(null)}
              className="flex-1 h-11 rounded-lg bg-stone-100 text-stone-700 font-medium active:bg-stone-200"
            >
              Close
            </button>
            <button
              onClick={handlePrint}
              className="flex-1 h-11 rounded-lg bg-brand text-white font-semibold active:bg-brand-dark"
            >
              🖨️ Print
            </button>
          </div>
        </div>
      </div>
    </>
  );
}
