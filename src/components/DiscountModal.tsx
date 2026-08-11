import { useState } from "react";
import { money } from "../lib/format";
import { CURRENCY } from "../lib/config";

interface Props {
  subtotal: number;
  onApply: (amount: number, reason: string) => void;
  onCancel: () => void;
}

export default function DiscountModal({ subtotal, onApply, onCancel }: Props) {
  const [value, setValue] = useState("");
  const [reason, setReason] = useState("");
  const amount = Number(value) || 0;
  const invalid = amount <= 0 || amount > subtotal;

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

        <label className="block text-sm font-medium text-stone-600 mb-1">
          Amount ({CURRENCY})
        </label>
        <input
          type="number"
          inputMode="decimal"
          aria-label="Discount amount"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          autoFocus
          className="w-full h-12 px-3 rounded-lg border border-stone-300 text-lg mb-4"
          placeholder="0.00"
        />

        <label className="block text-sm font-medium text-stone-600 mb-1">
          Reason (optional)
        </label>
        <input
          type="text"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          className="w-full h-12 px-3 rounded-lg border border-stone-300 mb-2"
          placeholder="e.g. staff, loyalty"
        />

        {amount > subtotal && (
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
            onClick={() => onApply(amount, reason.trim())}
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
