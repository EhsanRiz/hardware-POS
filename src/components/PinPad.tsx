import { useEffect, useRef, useState } from "react";

interface Props {
  onSubmit: (pin: string) => void;
  busy?: boolean;
  /** Digits in a PIN — or a manager's code, which is the same length. */
  length?: number;
}

/** Longer than a scanner leaves between keys, shorter than anyone notices. */
const SCAN_GAP_MS = 150;

/**
 * On-screen numeric keypad. Big touch targets, animated dots.
 *
 * The last digit submits. Every PIN and every approval code is exactly six
 * digits — the server refuses anything else — so there is nothing for an OK
 * button to add except a seventh tap, and a keypad that waits after the sixth
 * digit reads as broken to anyone who has used a bank card.
 *
 * The keyboard types into it too — the number row or the number pad, and
 * Backspace — so a till with a keyboard need not reach for the mouse. Not
 * while a text box has the cursor: a reason typed beside the pad is words,
 * not a PIN.
 *
 * THE COUNTER'S SCANNER IS A KEYBOARD. It types a barcode's digits faster
 * than any hand, then Enter, and a scan at a locked till would otherwise
 * arrive as a wrong PIN — five of those in fifteen minutes lock the person
 * out (0033). So a typed PIN waits a moment after its last digit before it
 * is sent, and a seventh digit or a letter in that moment means a scan: the
 * pad empties and ignores the rest of the burst.
 */
export default function PinPad({ onSubmit, busy, length = 6 }: Props) {
  const [pin, setPin] = useState("");
  // Whether the last digit came from the keyboard, which waits for a scan to
  // show itself before sending; a tap on the pad never needs to.
  const typed = useRef(false);
  const pinNow = useRef(pin);
  pinNow.current = pin;

  const press = (d: string) => {
    if (busy) return;
    setPin((p) => (p.length >= length ? p : p + d));
  };
  const back = () => setPin((p) => p.slice(0, -1));

  useEffect(() => {
    if (pin.length !== length || busy) return;
    const send = () => {
      onSubmit(pin);
      setPin("");
    };
    if (!typed.current) {
      send();
      return;
    }
    const t = setTimeout(send, SCAN_GAP_MS);
    return () => clearTimeout(t);
    // onSubmit is a fresh closure each render; the pin is the trigger.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pin, length, busy]);

  useEffect(() => {
    let quietUntil = 0;
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey || e.repeat) return;
      const el = e.target as HTMLElement | null;
      if (el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName))) return;
      const now = Date.now();
      const digit = /^[0-9]$/.test(e.key);
      const other = e.key.length === 1 && !digit;
      if (now < quietUntil || other || (digit && pinNow.current.length >= length)) {
        // A scan, or the rest of one: nothing from it is a PIN.
        if (digit || other || e.key === "Enter") quietUntil = now + SCAN_GAP_MS;
        setPin("");
        return;
      }
      if (digit) {
        e.preventDefault();
        typed.current = true;
        press(e.key);
      } else if (e.key === "Backspace") {
        e.preventDefault();
        back();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // press reads busy and length through its closure; both are listed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [busy, length]);

  const tap = (d: string) => {
    typed.current = false;
    press(d);
  };

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
          <button key={k} onClick={() => tap(k)} className="pin-key" disabled={busy}>
            {k}
          </button>
        ))}
        <button onClick={back} className="pin-key pin-key-quiet" aria-label="Delete last digit" disabled={busy}>
          ⌫
        </button>
        <button onClick={() => tap("0")} className="pin-key" disabled={busy}>
          0
        </button>
        {/* Where OK used to be. Left empty rather than filled with something
            that does nothing, so the thumb's map of the pad stays put. */}
        <span aria-hidden="true" />
      </div>
    </div>
  );
}
