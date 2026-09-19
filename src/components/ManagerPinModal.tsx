import { useState } from "react";
import PinPad from "./PinPad";
import { errorMessage } from "../lib/errors";
import { useOnline } from "../lib/offline";

interface Props {
  title: string;
  subtitle?: string;
  onApprove: (pin: string) => Promise<void>;
  onCancel: () => void;
  /**
   * A face or a finger instead of retyping, where that is honestly available.
   *
   * Offered only by the doors that ask for YOUR OWN PIN on a phone you have
   * already signed into — the back office and the stock room. Never by the
   * four that ask for SOMEBODY ELSE'S: a discount, a return, a parked sale, a
   * voided payment all exist precisely so another person approves, and this
   * phone's owner's face is not that person. Passing it is the caller's
   * decision for that reason; the modal only draws what it is given.
   *
   * Returns false when the phone refused, said no, or was cancelled, and the
   * keypad below carries on as before.
   */
  onResume?: () => Promise<boolean>;
}

// Modal shown when an employee's discounted sale needs a manager to release it.
export default function ManagerPinModal({
  title,
  subtitle,
  onApprove,
  onCancel,
  onResume,
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
            The line is down. Your PIN is checked against what this device
            already knows, and a screen that needs the server will say so.
          </p>
        )}
        {onResume && (
          <button
            className="btn-primary w-full mb-3"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              setError(null);
              const ok = await onResume();
              setBusy(false);
              // Nothing said on a refusal: cancelling the phone's prompt is
              // somebody choosing the keypad, and it is right underneath.
              if (!ok) return;
            }}
          >
            Unlock with Face ID or fingerprint
          </button>
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
