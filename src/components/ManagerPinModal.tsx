import { useState } from "react";
import PinPad from "./PinPad";
import { errorMessage } from "../lib/errors";

interface Props {
  title: string;
  subtitle?: string;
  onApprove: (pin: string) => Promise<void>;
  onCancel: () => void;
}

// Modal shown when an employee's discounted sale needs a manager to release it.
export default function ManagerPinModal({
  title,
  subtitle,
  onApprove,
  onCancel,
}: Props) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handle = async (pin: string) => {
    setBusy(true);
    setError(null);
    try {
      await onApprove(pin);
    } catch (e) {
      setError(errorMessage(e, "Approval failed"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className="vv-fixed bg-black/50 flex items-center justify-center p-6 z-50 animate-fade-in"
      role="dialog"
      aria-modal="true"
      aria-label={title}
    >
      <div className="bg-white rounded-2xl p-6 w-full max-w-sm animate-scale-in">
        <h2 className="text-xl font-bold text-stone-800 text-center">{title}</h2>
        {subtitle && (
          <p className="text-stone-500 text-center mt-1 mb-4">{subtitle}</p>
        )}
        <PinPad onSubmit={handle} busy={busy} />
        {error && (
          <p className="mt-3 text-red-600 font-medium text-center" role="alert">
            {error}
          </p>
        )}
        <button
          onClick={onCancel}
          disabled={busy}
          className="mt-4 w-full h-12 rounded-lg bg-stone-100 text-stone-600 font-medium active:bg-stone-200 disabled:opacity-50"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}
