import { useState } from "react";
import PinPad from "./PinPad";
import { errorMessage } from "../lib/errors";
import { useOnline } from "../lib/offline";

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
  // A PIN is proved on the server and never on the device, so this door is
  // shut with the line down. Said here, before the PIN is typed, rather than
  // as a fetch error after it.
  const online = useOnline();

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
        {!online && (
          <p className="text-amber-700 text-center text-sm mb-3 pin-needs-line" role="status">
            The line is down. A PIN is checked on the server, so this needs a
            connection — selling and printing carry on without one.
          </p>
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
          className="btn-cancel mt-4 w-full"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}
