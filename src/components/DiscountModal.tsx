import { useState } from "react";
import { money } from "../lib/format";
import { CURRENCY } from "../lib/config";

interface Props {
  subtotal: number;
  onApply: (amount: number, reason: string) => void;
  onCancel: () => void;
}

/**
 * Taking money off the whole sale.
 *
 * Two ways to say the same thing, because a counter uses both: "give him fifty
 * off" and "give him ten percent". The percentage is worked out here and what
 * travels is an amount — the server stores a figure, the invoice shows a
 * figure, and a percentage recomputed later against a changed total would not
 * be the discount that was actually given.
 *
 * The percentage still reaches the slip, though: it goes into the reason. A
 * customer looking at "Discount -R506.40" wants to see the 10% they were
 * promised, and a manager reading it back next week wants the same.
 */
export default function DiscountModal({ subtotal, onApply, onCancel }: Props) {
  const [mode, setMode] = useState<"amount" | "percent">("amount");
  const [value, setValue] = useState("");
  const [reason, setReason] = useState("");

  const typed = Number(value) || 0;
  const amount =
    mode === "percent"
      ? Math.round(subtotal * (typed / 100) * 100) / 100
      : typed;

  const overSubtotal = amount > subtotal;
  const overHundred = mode === "percent" && typed > 100;
  const invalid = amount <= 0 || overSubtotal || overHundred;

  function apply() {
    // The percentage is the thing worth remembering, so it leads the reason and
    // whatever the cashier typed follows it.
    const said =
      mode === "percent"
        ? [`${typed}% off`, reason.trim()].filter(Boolean).join(" — ")
        : reason.trim();
    onApply(amount, said);
  }

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center p-6 z-50 animate-fade-in">
      <div
        className="bg-white rounded-2xl p-6 w-full max-w-sm animate-scale-in"
        role="dialog"
        aria-modal="true"
        aria-label="Apply discount"
      >
        <h2 className="text-xl font-bold text-stone-800 mb-1">Apply discount</h2>
        <p className="text-stone-500 mb-4">Subtotal {money(subtotal)}</p>

        <div className="flex gap-2 mb-4">
          {([
            ["amount", `Amount (${CURRENCY})`],
            ["percent", "Percent (%)"],
          ] as const).map(([k, label]) => (
            <button
              key={k}
              onClick={() => setMode(k)}
              aria-pressed={mode === k}
              className={`flex-1 h-11 rounded-lg text-sm font-medium ${
                mode === k
                  ? "bg-stone-800 text-white"
                  : "bg-stone-100 text-stone-600"
              }`}
            >
              {label}
            </button>
          ))}
        </div>

        <label className="block text-sm font-medium text-stone-600 mb-1">
          {mode === "percent" ? "Percent off" : `Amount (${CURRENCY})`}
        </label>
        <input
          type="number"
          inputMode="decimal"
          aria-label={mode === "percent" ? "Discount percent" : "Discount amount"}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          autoFocus
          className="w-full h-12 px-3 rounded-lg border border-stone-300 text-lg mb-2"
          placeholder={mode === "percent" ? "0" : "0.00"}
        />

        {/* What the percentage actually comes to, before it is applied. Nobody
            should have to do the arithmetic to find out what they just agreed
            to give away. */}
        {mode === "percent" && typed > 0 && !overHundred && (
          <p className="text-stone-600 text-sm mb-2" role="status">
            {typed}% of {money(subtotal)} is <strong>{money(amount)}</strong>
          </p>
        )}

        <label className="block text-sm font-medium text-stone-600 mb-1 mt-2">
          Reason (optional)
        </label>
        <input
          type="text"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          className="w-full h-12 px-3 rounded-lg border border-stone-300 mb-2"
          placeholder="e.g. staff, loyalty"
        />

        {overHundred && (
          <p className="text-red-600 text-sm mb-2">
            A discount cannot be more than the whole thing.
          </p>
        )}
        {overSubtotal && !overHundred && (
          <p className="text-red-600 text-sm mb-2">
            Discount cannot exceed the subtotal.
          </p>
        )}

        <div className="flex gap-2 mt-4">
          <button
            onClick={onCancel}
            className="flex-1 h-12 rounded-lg bg-stone-100 text-stone-600 font-medium active:bg-stone-200"
          >
            Cancel
          </button>
          <button
            onClick={apply}
            disabled={invalid}
            className="flex-1 h-12 rounded-lg bg-brand text-white font-semibold active:bg-brand-dark disabled:opacity-40"
          >
            Apply
          </button>
        </div>
      </div>
    </div>
  );
}
