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
          <span className="text-stone-300 text-sm">Enter PIN</span>
        ) : (
          Array.from({ length: pin.length }).map((_, i) => (
            <span
              key={i}
              className="w-3.5 h-3.5 rounded-full bg-brand animate-pop shadow-sm"
            />
          ))
        )}
      </div>

      <div className="grid grid-cols-3 gap-3">
        {keys.map((k) => (
          <button
            key={k}
            onClick={() => press(k)}
            className="h-16 rounded-2xl bg-white border border-stone-200 shadow-sm text-2xl font-semibold text-stone-800 active:!scale-90 active:bg-brand-light active:border-brand/40 hover:border-brand/30"
          >
            {k}
          </button>
        ))}
        <button
          onClick={back}
          className="h-16 rounded-2xl bg-stone-100 text-2xl text-stone-500 active:!scale-90 active:bg-stone-200"
        >
          ⌫
        </button>
        <button
          onClick={() => press("0")}
          className="h-16 rounded-2xl bg-white border border-stone-200 shadow-sm text-2xl font-semibold text-stone-800 active:!scale-90 active:bg-brand-light active:border-brand/40 hover:border-brand/30"
        >
          0
        </button>
        <button
          onClick={submit}
          disabled={busy}
          className="h-16 rounded-2xl bg-gradient-to-b from-brand to-brand-dark text-xl font-semibold text-white shadow-md active:!scale-90 disabled:opacity-50"
        >
          {busy ? "…" : "OK"}
        </button>
      </div>
    </div>
  );
}
