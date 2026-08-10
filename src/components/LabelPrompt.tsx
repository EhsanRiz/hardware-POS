import { useState } from "react";

interface Props {
  title: string;
  initial?: string;
  busy?: boolean;
  onConfirm: (label: string) => void;
  onCancel: () => void;
}

// Small modal to name an open order (table number / tab name).
export default function LabelPrompt({
  title,
  initial = "",
  busy,
  onConfirm,
  onCancel,
}: Props) {
  const [label, setLabel] = useState(initial);
  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center p-4 z-50 animate-fade-in">
      <div className="bg-white rounded-2xl p-6 w-full max-w-xs animate-scale-in">
        <h2 className="text-lg font-bold text-stone-800 mb-3">{title}</h2>
        <input
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          autoFocus
          placeholder="e.g. Table 4 or John"
          className="w-full h-12 px-3 rounded-lg border border-stone-300 mb-4 focus:border-brand outline-none"
          onKeyDown={(e) => e.key === "Enter" && onConfirm(label.trim())}
        />
        <div className="flex gap-2">
          <button
            onClick={onCancel}
            disabled={busy}
            className="flex-1 h-12 rounded-lg bg-stone-100 text-stone-600 font-medium active:bg-stone-200 disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            onClick={() => onConfirm(label.trim())}
            disabled={busy}
            className="flex-1 h-12 rounded-lg bg-brand text-white font-semibold active:bg-brand-dark disabled:opacity-50"
          >
            {busy ? "Saving…" : "Save"}
          </button>
        </div>
      </div>
    </div>
  );
}
