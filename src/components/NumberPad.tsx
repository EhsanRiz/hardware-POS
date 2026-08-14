import { BackspaceIcon } from "./sell/Icons";

interface Props {
  value: string;
  onChange: (next: string) => void;
  /** Hidden when the field takes whole numbers only, like a percentage. */
  decimal?: boolean;
}

/**
 * Digits for a dialog that asks for money.
 *
 * The till already refuses to send a cashier to the OS keyboard for a PIN, and
 * the tender panel has had its own keys since the beginning. The discount
 * dialog did not, and on an iPad that was the difference between a working
 * screen and a title bar: the keyboard opens over a centred dialog and covers
 * the box it was opened for, along with Apply and Cancel.
 *
 * The field beside this keeps `inputMode="none"`, which suppresses the
 * software keyboard without suppressing a real one — a desk with a keyboard
 * types as it always did, and a tablet never sees the thing.
 */
export default function NumberPad({ value, onChange, decimal = true }: Props) {
  const press = (k: string) => {
    if (k === "⌫") return onChange(value.slice(0, -1));
    // One decimal point, and never as the first character: ".5" is a typo
    // waiting to be read as 5.
    if (k === ".") return value.includes(".") || !value ? undefined : onChange(value + ".");
    // Two decimals is as fine as money gets; more is a mis-tap.
    if (value.includes(".") && value.split(".")[1].length >= 2) return;
    onChange(value === "0" ? k : value + k);
  };

  const keys = ["7", "8", "9", "4", "5", "6", "1", "2", "3"];

  return (
    <div className="numpad" role="group" aria-label="Number keys">
      {keys.map((k) => (
        <button key={k} type="button" onClick={() => press(k)} aria-label={k}>
          {k}
        </button>
      ))}
      <button type="button" onClick={() => press("0")} aria-label="0">
        0
      </button>
      {decimal ? (
        <button type="button" onClick={() => press(".")} aria-label="Decimal point">
          .
        </button>
      ) : (
        <span />
      )}
      <button type="button" onClick={() => press("⌫")} aria-label="Backspace">
        <BackspaceIcon />
      </button>
    </div>
  );
}
