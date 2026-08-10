import { useState } from "react";
import { money } from "../lib/format";
import { fmtQty } from "../lib/receipt";
import type { CartLine } from "../lib/types";

/**
 * The cart.
 *
 * The +/- stepper that suits a cafe is wrong for goods sold by the metre, so
 * every line also has a directly editable quantity. Whether a fraction is
 * allowed comes from the product's unit: 2.5 m of chain is a sale, 2.5 padlocks
 * is a typo. The same rule is enforced server-side — this is the courteous
 * version that stops the cashier before the customer is standing there.
 */
export default function Cart({
  lines,
  trade,
  onSetQty,
  onRemove,
}: {
  lines: CartLine[];
  trade: boolean;
  onSetQty: (productId: string, qty: number) => void;
  onRemove: (productId: string) => void;
}) {
  if (lines.length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center text-stone-400 text-sm">
        Scan or search to start a sale
      </div>
    );
  }

  return (
    <ul className="flex-1 overflow-y-auto divide-y divide-stone-100">
      {lines.map((l) => (
        <CartRow
          key={l.product.id}
          line={l}
          trade={trade}
          onSetQty={onSetQty}
          onRemove={onRemove}
        />
      ))}
    </ul>
  );
}

function CartRow({
  line,
  trade,
  onSetQty,
  onRemove,
}: {
  line: CartLine;
  trade: boolean;
  onSetQty: (productId: string, qty: number) => void;
  onRemove: (productId: string) => void;
}) {
  const p = line.product;
  const [draft, setDraft] = useState<string | null>(null);
  const unitPrice = trade && p.price_trade != null ? p.price_trade : p.price_retail;

  // Whole units step by 1; cut goods step by 0.5, which is what a counter
  // actually asks for ("two and a half metres").
  const step = p.allows_fraction ? 0.5 : 1;

  function commit(raw: string) {
    setDraft(null);
    const n = Number(raw.replace(",", "."));
    if (!Number.isFinite(n) || n <= 0) return;
    onSetQty(p.id, clampQty(n, p.allows_fraction));
  }

  return (
    <li className="p-3">
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <div className="font-medium text-stone-900 leading-tight">{p.name}</div>
          <div className="text-xs text-stone-500">
            {money(unitPrice)} / {p.unit_code}
            {trade && p.price_trade != null && (
              <span className="text-emerald-700"> · trade</span>
            )}
          </div>
        </div>
        <div className="font-semibold tabular-nums shrink-0">
          {money(unitPrice * line.qty)}
        </div>
      </div>

      <div className="flex items-center gap-2 mt-2">
        <button
          onClick={() => onSetQty(p.id, clampQty(line.qty - step, p.allows_fraction))}
          className="w-9 h-9 rounded-lg bg-stone-100 text-stone-700 text-lg leading-none"
          aria-label="Less"
        >
          −
        </button>

        <div className="relative">
          <input
            // decimal for cut goods so the tablet shows a point; numeric
            // otherwise so it cannot be typed at all.
            inputMode={p.allows_fraction ? "decimal" : "numeric"}
            value={draft ?? fmtQty(line.qty)}
            onChange={(e) => setDraft(e.target.value)}
            onFocus={(e) => e.currentTarget.select()}
            onBlur={(e) => commit(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") e.currentTarget.blur();
            }}
            className="w-20 h-9 text-center rounded-lg border border-stone-300
                       tabular-nums focus:outline-none focus:ring-2
                       focus:ring-emerald-500"
          />
          <span className="absolute -bottom-4 left-0 right-0 text-center text-[10px] text-stone-400">
            {p.unit_name.toLowerCase()}
          </span>
        </div>

        <button
          onClick={() => onSetQty(p.id, clampQty(line.qty + step, p.allows_fraction))}
          className="w-9 h-9 rounded-lg bg-stone-100 text-stone-700 text-lg leading-none"
          aria-label="More"
        >
          +
        </button>

        <button
          onClick={() => onRemove(p.id)}
          className="ml-auto text-xs text-red-600 px-2 py-1"
        >
          Remove
        </button>
      </div>
    </li>
  );
}

/** Keep quantities sane: positive, and whole for units that can't be split. */
function clampQty(n: number, allowsFraction: boolean): number {
  if (!Number.isFinite(n) || n <= 0) return allowsFraction ? 0.5 : 1;
  const rounded = allowsFraction ? Math.round(n * 1000) / 1000 : Math.round(n);
  return Math.max(allowsFraction ? 0.001 : 1, rounded);
}
