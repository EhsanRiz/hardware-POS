import { useState } from "react";
import { buildTestText } from "../lib/receipt";
import {
  printReceipt,
  isAndroid,
  getPrintMode,
  setPrintMode,
  type PrintMode,
} from "../lib/print";
import { RECEIPT_WIDTH } from "../lib/config";

const MODES: { key: PrintMode; label: string; hint: string }[] = [
  { key: "auto", label: "Auto", hint: "Thermal on the tablet, preview elsewhere" },
  { key: "thermal", label: "Thermal (RawBT)", hint: "Always print straight to the printer" },
  { key: "browser", label: "Preview", hint: "Always show the on-screen preview" },
];

export default function PrinterSettings() {
  const sample = buildTestText();
  const [mode, setMode] = useState<PrintMode>(getPrintMode());

  const changeMode = (m: PrintMode) => {
    setPrintMode(m);
    setMode(m);
  };

  return (
    <div className="p-4">
      <div className="max-w-2xl mx-auto space-y-4">
        <div className="bg-white border border-stone-200 rounded-xl p-5">
          <h3 className="font-semibold text-stone-800 mb-1">Printer</h3>
          <p className="text-taupe text-sm mb-4">
            SUNMI NT311 (80mm) · receipts formatted to {RECEIPT_WIDTH} columns ·
            printed via the RawBT app over Bluetooth.
          </p>

          <p className="text-sm font-medium text-stone-700 mb-2">How to print</p>
          <div className="grid grid-cols-3 gap-2 mb-1">
            {MODES.map((m) => (
              <button
                key={m.key}
                onClick={() => changeMode(m.key)}
                className={`h-11 rounded-lg text-sm font-semibold transition-colors ${
                  mode === m.key
                    ? "bg-brand text-white"
                    : "bg-stone-100 text-stone-700 active:bg-stone-200"
                }`}
              >
                {m.label}
              </button>
            ))}
          </div>
          <p className="text-xs text-taupe mb-4">
            {MODES.find((m) => m.key === mode)?.hint}
            {mode === "auto" && !isAndroid()
              ? " · this device isn't detected as the tablet, so choose Thermal (RawBT) on the shop tablet for crisp, dark prints."
              : ""}
          </p>

          <button
            onClick={() => printReceipt(sample, "Printer test")}
            className="h-12 px-5 rounded-lg bg-brand text-white font-semibold active:bg-brand-dark"
          >
            🖨️ Print test receipt
          </button>
        </div>

        <div className="bg-white border border-stone-200 rounded-xl p-5">
          <h3 className="font-semibold text-stone-800 mb-2">
            One-time setup (on the tablet)
          </h3>
          <ol className="list-decimal list-inside text-sm text-stone-600 space-y-1.5">
            <li>
              Android <b>Settings → Bluetooth</b> → pair{" "}
              <b>CloudPrint_0564</b>.
            </li>
            <li>
              Install <b>RawBT Print Service</b> from the Play Store and open it
              once.
            </li>
            <li>
              In RawBT, choose the Bluetooth printer <b>CloudPrint_0564</b> and
              set paper to <b>80mm</b>.
            </li>
            <li>
              Come back here and tap <b>Print test receipt</b> — RawBT will print
              it.
            </li>
          </ol>
        </div>

        <div className="bg-white border border-stone-200 rounded-xl p-5">
          <h3 className="font-semibold text-stone-800 mb-2">
            Print instantly (skip the RawBT preview)
          </h3>
          <p className="text-taupe text-sm mb-2">
            The app already sends bills straight to RawBT — no browser print
            dialog. If RawBT still shows its own preview/confirmation, turn it
            off once:
          </p>
          <ol className="list-decimal list-inside text-sm text-stone-600 space-y-1.5">
            <li>
              Open <b>RawBT</b> → menu <b>☰</b> → <b>Settings</b>.
            </li>
            <li>
              Open <b>Behavior</b> (or <b>Print</b>) and turn <b>off</b> any{" "}
              <b>“Preview before printing”</b> / <b>“Show preview”</b> option.
            </li>
            <li>
              While there, enable <b>“Silent printing”</b> / <b>“Print without
              dialog”</b> if shown, and set <b>Copies</b> to <b>1</b>.
            </li>
          </ol>
          <p className="text-taupe text-xs mt-2">
            After this, tapping <b>Pay</b> prints the receipt immediately and
            cuts the paper.
          </p>
        </div>

        <div className="bg-white border border-stone-200 rounded-xl p-5">
          <h3 className="font-semibold text-stone-800 mb-2">Receipt preview</h3>
          <pre className="font-mono text-xs leading-relaxed bg-stone-50 border border-stone-200 rounded-lg p-3 whitespace-pre-wrap text-stone-800 overflow-x-auto">
            {sample}
          </pre>
        </div>
      </div>
    </div>
  );
}
