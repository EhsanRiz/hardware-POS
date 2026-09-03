import { useEffect, useState } from "react";

interface Props {
  onSubmit: (pin: string) => void;
  busy?: boolean;
  /** Digits in a PIN — or a manager's code, which is the same length. */
  length?: number;
}

/**
 * On-screen numeric keypad. Big touch targets, animated dots.
 *
 * The last digit submits. Every PIN and every approval code is exactly six
 * digits — the server refuses anything else — so there is nothing for an OK
 * button to add except a seventh tap, and a keypad that waits after the sixth
 * digit reads as broken to anyone who has used a bank card.
 */
export default function PinPad({ onSubmit, busy, length = 6 }: Props) {
  const [pin, setPin] = useState("");

  const press = (d: string) => {
    if (busy) return;
    setPin((p) => (p.length >= length ? p : p + d));
  };
  const back = () => setPin((p) => p.slice(0, -1));

  useEffect(() => {
    if (pin.length === length && !busy) {
      onSubmit(pin);
      setPin("");
    }
    // onSubmit is a fresh closure each render; the pin is the trigger.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pin, length, busy]);

  const keys = ["1", "2", "3", "4", "5", "6", "7", "8", "9"];

  return (
    <div className="w-full max-w-xs mx-auto select-none">
      {/* PIN dots — one per entered digit. */}
      <div className="flex gap-3 justify-center items-center h-6 mb-5">
        {busy ? (
          <span className="kicker">Checking…</span>
        ) : pin.length === 0 ? (
          <span className="kicker">Enter PIN</span>
        ) : (
          Array.from({ length: pin.length }).map((_, i) => (
            <span
              key={i}
              className="w-3.5 h-3.5 rounded-full animate-pop"
              style={{ background: "var(--color-accent)" }}
            />
          ))
        )}
      </div>

      <div className="grid grid-cols-3 gap-3">
        {keys.map((k) => (
          <button key={k} onClick={() => press(k)} className="pin-key" disabled={busy}>
            {k}
          </button>
        ))}
        <button onClick={back} className="pin-key pin-key-quiet" aria-label="Delete last digit" disabled={busy}>
          ⌫
        </button>
        <button onClick={() => press("0")} className="pin-key" disabled={busy}>
          0
        </button>
        {/* Where OK used to be. Left empty rather than filled with something
            that does nothing, so the thumb's map of the pad stays put. */}
        <span aria-hidden="true" />
      </div>
    </div>
  );
}
