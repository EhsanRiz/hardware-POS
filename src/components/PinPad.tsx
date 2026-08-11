import { useState } from "react";

interface Props {
  onSubmit: (pin: string) => void;
  busy?: boolean;
  maxLength?: number;
}

// On-screen numeric keypad. Big touch targets, animated dots + key presses.
export default function PinPad({ onSubmit, busy, maxLength = 6 }: Props) {
  const [pin, setPin] = useState("");

  const press = (d: string) => {
    if (busy) return;
    setPin((p) => (p.length >= maxLength ? p : p + d));
  };
  const back = () => setPin((p) => p.slice(0, -1));
  const submit = () => {
    if (pin.length > 0 && !busy) {
      onSubmit(pin);
      setPin("");
    }
  };

  const keys = ["1", "2", "3", "4", "5", "6", "7", "8", "9"];

  return (
    <div className="w-full max-w-xs mx-auto select-none">
      {/* PIN dots — one per entered digit (variable-length PINs). */}
      <div className="flex gap-3 justify-center items-center h-6 mb-5">
        {pin.length === 0 ? (
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
          <button
            key={k}
            onClick={() => press(k)}
            className="pin-key"
          >
            {k}
          </button>
        ))}
        <button
          onClick={back}
          className="pin-key pin-key-quiet"
        >
          ⌫
        </button>
        <button
          onClick={() => press("0")}
          className="pin-key"
        >
          0
        </button>
        <button
          onClick={submit}
          disabled={busy}
          className="pin-key pin-key-ok"
        >
          {busy ? "…" : "OK"}
        </button>
      </div>
    </div>
  );
}
