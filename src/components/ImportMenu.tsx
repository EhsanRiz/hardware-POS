import { useState } from "react";
import { managerUpsertProduct } from "../lib/api";

interface Props {
  managerPin: string;
  startSort: number;
  onDone: () => void;
  onCancel: () => void;
}

interface Row {
  name: string;
  category: string;
  price: number;
  stock: number | null;
}

function parse(text: string): { rows: Row[]; errors: string[] } {
  const rows: Row[] = [];
  const errors: string[] = [];
  text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .forEach((line, i) => {
      // Skip an optional header row.
      if (i === 0 && /name/i.test(line) && /price/i.test(line)) return;
      const parts = line.split(/[,\t]/).map((p) => p.trim());
      const [name, category, priceRaw, stockRaw] = parts;
      const price = Number(priceRaw);
      if (!name || parts.length < 3 || Number.isNaN(price)) {
        errors.push(`Line ${i + 1}: "${line}" — need Name, Category, Price`);
        return;
      }
      rows.push({
        name,
        category: category || "Other",
        price,
        stock:
          stockRaw === undefined || stockRaw === ""
            ? null
            : Math.max(0, Math.floor(Number(stockRaw)) || 0),
      });
    });
  return { rows, errors };
}

export default function ImportMenu({
  managerPin,
  startSort,
  onDone,
  onCancel,
}: Props) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);

  const { rows, errors } = parse(text);

  const run = async () => {
    setBusy(true);
    setResult(null);
    let ok = 0;
    let failed = 0;
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      try {
        await managerUpsertProduct(managerPin, {
          id: null,
          name: r.name,
          category: r.category,
          price: r.price,
          cost: null,
          image_url: null,
          active: true,
          sort_order: startSort + i,
          stock_qty: r.stock,
        });
        ok++;
      } catch {
        failed++;
      }
    }
    setBusy(false);
    setResult(`Imported ${ok} item${ok === 1 ? "" : "s"}${failed ? `, ${failed} failed` : ""}.`);
    if (ok > 0) onDone();
  };

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center p-4 z-50 animate-fade-in">
      <div className="bg-white rounded-2xl p-6 w-full max-w-lg animate-scale-in max-h-[90vh] overflow-y-auto">
        <h2 className="text-xl font-bold text-stone-800 mb-1">Import menu</h2>
        <p className="text-taupe text-sm mb-3">
          One item per line: <code>Name, Category, Price, Stock</code> (stock
          optional). Paste from a spreadsheet — commas or tabs both work.
        </p>

        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          rows={10}
          className="w-full p-3 rounded-lg border border-stone-300 font-mono text-sm focus:border-brand outline-none"
          placeholder={"Cement 42.5N 50kg, Building, 115\nBrick Plaster NFP, Building, 3.20, 4000\nWood Screw 4x40 (100), Fasteners, 68, 45"}
        />

        <div className="mt-2 text-sm">
          {rows.length > 0 && (
            <p className="text-brand-dark">{rows.length} item(s) ready</p>
          )}
          {errors.slice(0, 4).map((e) => (
            <p key={e} className="text-red-600">
              {e}
            </p>
          ))}
          {result && <p className="text-stone-700 font-medium mt-1">{result}</p>}
        </div>

        <div className="flex gap-2 mt-4">
          <button
            onClick={onCancel}
            disabled={busy}
            className="flex-1 h-12 rounded-lg bg-stone-100 text-stone-600 font-medium active:bg-stone-200 disabled:opacity-50"
          >
            {result ? "Close" : "Cancel"}
          </button>
          <button
            onClick={run}
            disabled={busy || rows.length === 0}
            className="flex-1 h-12 rounded-lg bg-brand text-white font-semibold active:bg-brand-dark disabled:opacity-40"
          >
            {busy ? "Importing…" : `Import ${rows.length || ""}`}
          </button>
        </div>
      </div>
    </div>
  );
}
