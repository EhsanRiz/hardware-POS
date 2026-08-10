import type { CartLine } from "../lib/types";
import { money } from "../lib/format";
import { lineKey, lineName, linePrice } from "../lib/variants";

interface Props {
  lines: CartLine[];
  subtotal: number;
  discount: number;
  total: number;
  busy: boolean;
  canDiscount: boolean;
  editingLabel?: string | null;
  onInc: (lineKey: string) => void;
  onDec: (lineKey: string) => void;
  onClear: () => void;
  onDiscount: () => void;
  onBill: () => void;
  onSave: () => void;
  onPay: () => void;
}

export default function Cart({
  lines,
  subtotal,
  discount,
  total,
  busy,
  canDiscount,
  editingLabel,
  onInc,
  onDec,
  onClear,
  onDiscount,
  onBill,
  onSave,
  onPay,
}: Props) {
  const empty = lines.length === 0;

  return (
    <div className="flex flex-col h-full bg-white border-l border-stone-200">
      <div className="flex items-center justify-between px-4 py-3 border-b border-stone-200 shrink-0">
        <h2 className="font-semibold text-stone-800 flex items-center gap-2">
          Order
          {!empty &&
            (() => {
              const count = lines.reduce((n, l) => n + l.qty, 0);
              // key on count so the badge re-pops whenever the quantity changes
              return (
                <span
                  key={count}
                  className="inline-flex items-center justify-center min-w-6 h-6 px-1.5 rounded-full bg-brand text-white text-xs font-bold animate-pop"
                >
                  {count}
                </span>
              );
            })()}
        </h2>
        {!empty && (
          <button
            onClick={onClear}
            className={
              editingLabel
                ? "h-8 px-4 rounded-full bg-emerald-400 text-white text-sm font-semibold shadow-sm active:bg-emerald-500"
                : "text-sm text-stone-400 active:text-stone-600"
            }
          >
            {editingLabel ? "Back" : "Clear"}
          </button>
        )}
      </div>

      <div className="flex-1 overflow-y-auto">
        {empty ? (
          <p className="text-stone-400 text-center mt-10">Tap a product to start</p>
        ) : (
          lines.map((l) => {
            const key = lineKey(l);
            const price = linePrice(l);
            return (
              <div
                key={key}
                className="flex items-center gap-2 px-4 py-3 border-b border-stone-100"
              >
                <div className="flex-1 min-w-0">
                  <p className="font-medium text-stone-800 truncate">
                    {lineName(l)}
                  </p>
                  <p className="text-sm text-stone-500">{money(price)}</p>
                </div>
                <button
                  onClick={() => onDec(key)}
                  className="w-9 h-9 rounded-lg bg-stone-100 text-xl text-stone-700 active:bg-stone-200"
                >
                  −
                </button>
                <span className="w-6 text-center font-semibold">{l.qty}</span>
                <button
                  onClick={() => onInc(key)}
                  className="w-9 h-9 rounded-lg bg-stone-100 text-xl text-stone-700 active:bg-stone-200"
                >
                  +
                </button>
                <span className="w-16 text-right font-semibold text-stone-800">
                  {money(price * l.qty)}
                </span>
              </div>
            );
          })
        )}
      </div>

      <div className="border-t border-stone-200 p-4 shrink-0 space-y-1">
        {editingLabel && (
          <div className="mb-2 text-xs font-medium text-brand-dark bg-brand-light rounded-lg px-3 py-1.5">
            Editing open order · {editingLabel}
          </div>
        )}
        <div className="flex justify-between text-stone-600">
          <span>Subtotal</span>
          <span>{money(subtotal)}</span>
        </div>
        {discount > 0 && (
          <div className="flex justify-between text-emerald-700">
            <span>Discount</span>
            <span>−{money(discount)}</span>
          </div>
        )}
        <div className="flex justify-between text-xl font-bold text-stone-900 pt-1">
          <span>Total</span>
          <span>{money(total)}</span>
        </div>

        <div className="grid grid-cols-3 gap-2 pt-3">
          {canDiscount && (
            <button
              onClick={onDiscount}
              disabled={empty || busy}
              className="h-12 rounded-xl bg-stone-100 font-medium text-stone-700 active:bg-stone-200 disabled:opacity-40"
            >
              Discount
            </button>
          )}
          <button
            onClick={onBill}
            disabled={empty || busy}
            className="h-12 rounded-xl bg-stone-100 font-medium text-stone-700 active:bg-stone-200 disabled:opacity-40"
          >
            Bill
          </button>
          <button
            onClick={onSave}
            disabled={empty || busy}
            className={`h-12 rounded-xl bg-stone-100 font-medium text-stone-700 active:bg-stone-200 disabled:opacity-40 ${
              canDiscount ? "" : "col-span-1"
            }`}
          >
            {editingLabel ? "Update" : "Save"}
          </button>
        </div>
        <button
          onClick={onPay}
          disabled={empty || busy}
          className="w-full h-14 mt-2 rounded-xl bg-gradient-to-b from-brand to-brand-dark font-semibold text-white shadow-md active:shadow-sm disabled:opacity-40 disabled:shadow-none"
        >
          {busy ? "…" : `Pay ${money(total)}`}
        </button>
      </div>
    </div>
  );
}
